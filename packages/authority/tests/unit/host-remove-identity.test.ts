// #317: the governed identity-bound removal. An entry is quarantined under a private name
// before its identity is checked, so a swapped-in entry is put back and never removed.
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  removeEntryIfIdentitySync,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
} from '../../src/boundaries/host-effects.js';
import {
  REMOVE_QUARANTINE_SUFFIX,
  REMOVE_RESTORE_INCOMPLETE,
  entryIdentityKey,
  parseEntryIdentityKey,
  removeEntryIfIdentitySteps,
  type EntryIdentity,
} from '../../src/boundaries/host-remove.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-remove-'));
  roots.push(root);
  return root;
}

function identityOf(path: string): EntryIdentity {
  const stat = lstatSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

const quarantined = (root: string) =>
  readdirSync(root).filter((name) => name.endsWith(REMOVE_QUARANTINE_SUFFIX));

describe('identity-bound removal steps', () => {
  it('removes the file that is the identity and reports an absent path', () => {
    const root = directory();
    const path = join(root, 'record.json');
    writeFileSync(path, 'mine\n');
    const identity = identityOf(path);

    expect(removeEntryIfIdentitySteps(path, identity)).toBe('removed');
    expect(readdirSync(root)).toEqual([]);
    expect(removeEntryIfIdentitySteps(path, identity)).toBe('absent');
  });

  it('leaves a file that replaced the identity untouched, with no quarantine', () => {
    const root = directory();
    const path = join(root, 'record.json');
    writeFileSync(path, 'mine\n');
    const identity = identityOf(path);
    // A second link keeps the original inode alive, so its number cannot be reused.
    linkSync(path, join(root, 'kept-original'));
    rmSync(path);
    writeFileSync(path, 'another writer\n');

    expect(removeEntryIfIdentitySteps(path, identity)).toBe('mismatch');
    expect(readFileSync(path, 'utf8')).toBe('another writer\n');
    expect(quarantined(root)).toEqual([]);
  });

  it('checks the entry under its private name, so a swap at the public name after the rename is not removed', () => {
    const root = directory();
    const path = join(root, 'record.json');
    writeFileSync(path, 'mine\n');
    const identity = identityOf(path);

    expect(
      removeEntryIfIdentitySteps(path, identity, {
        // Another writer puts its file at the public name once the entry is quarantined.
        afterQuarantine: () => writeFileSync(path, 'arrived later\n'),
      }),
    ).toBe('removed');
    expect(readFileSync(path, 'utf8')).toBe('arrived later\n');
    expect(quarantined(root)).toEqual([]);
  });

  it('refuses to replace an entry that took the path while a foreign file was quarantined', () => {
    const root = directory();
    const path = join(root, 'record.json');
    writeFileSync(path, 'mine\n');
    const identity = identityOf(path);
    linkSync(path, join(root, 'kept-original'));

    let failure: unknown;
    try {
      removeEntryIfIdentitySteps(path, identity, {
        // A foreign file replaces the matching one after the precheck, before the rename.
        afterPrecheck: () => {
          rmSync(path);
          writeFileSync(path, 'foreign\n');
        },
        afterQuarantine: () => writeFileSync(path, 'newest\n'),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: REMOVE_RESTORE_INCOMPLETE, path });
    const [left] = quarantined(root);
    expect(readFileSync(path, 'utf8')).toBe('newest\n');
    expect(readFileSync(join(root, left ?? ''), 'utf8')).toBe('foreign\n');
  });

  it('removes its own empty directory and leaves a non-empty one or a replacement untouched', () => {
    const root = directory();
    const empty = join(root, 'empty');
    mkdirSync(empty);
    expect(removeEntryIfIdentitySteps(empty, identityOf(empty))).toBe('removed');

    const full = join(root, 'full');
    mkdirSync(full);
    writeFileSync(join(full, 'entry'), 'x');
    expect(removeEntryIfIdentitySteps(full, identityOf(full))).toBe('not-empty');
    expect(readdirSync(full)).toEqual(['entry']);

    const replaced = join(root, 'replaced');
    mkdirSync(replaced);
    const created = identityOf(replaced);
    // An open descriptor keeps the removed directory's inode from being reused.
    const pin = openSync(replaced, 'r');
    try {
      rmSync(replaced, { recursive: true });
      mkdirSync(replaced);
      expect(removeEntryIfIdentitySteps(replaced, created)).toBe('mismatch');
    } finally {
      closeSync(pin);
    }
    expect(lstatSync(replaced).isDirectory()).toBe(true);
    expect(quarantined(root)).toEqual([]);
  });

  it('acts on a final symbolic link itself and never on what it points to', () => {
    const root = directory();
    const target = join(root, 'target');
    writeFileSync(target, 'outside\n');
    const link = join(root, 'link');
    symlinkSync(target, link);

    expect(removeEntryIfIdentitySteps(link, identityOf(target))).toBe('mismatch');
    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('outside\n');
    expect(removeEntryIfIdentitySteps(link, identityOf(link))).toBe('removed');
    expect(readFileSync(target, 'utf8')).toBe('outside\n');
  });

  it.each([
    ['a directory', (path: string) => mkdirSync(path)],
    ['a symbolic link', (path: string) => symlinkSync('/nonexistent-target', path)],
  ])(
    'never moves back %s swapped in during the removal: it stays in quarantine and refuses',
    (_, make) => {
      const root = directory();
      const path = join(root, 'entry');
      make(path);
      const identity = identityOf(path);
      const kept = join(root, 'kept-original');

      let failure: unknown;
      try {
        removeEntryIfIdentitySteps(path, identity, {
          // The matching entry is replaced by another of the same kind after the precheck.
          afterPrecheck: () => {
            renameSync(path, kept);
            make(path);
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: REMOVE_RESTORE_INCOMPLETE, path });
      const [left] = quarantined(root);
      expect(left).toBeDefined();
      expect((failure as { quarantine: string }).quarantine).toBe(join(root, left ?? ''));
      expect(existsSync(path)).toBe(false);
      expect(lstatSync(kept, { bigint: true }).ino).toBe(identity.ino);
    },
  );

  it('leaves a directory and a link that do not match untouched', () => {
    const root = directory();
    const folder = join(root, 'folder');
    mkdirSync(folder);
    writeFileSync(join(folder, 'inside'), 'x');
    const link = join(root, 'link');
    symlinkSync('/nonexistent-target', link);
    const foreign = { dev: 0n, ino: 0n, birthtimeNs: 0n };

    expect(removeEntryIfIdentitySteps(folder, foreign)).toBe('mismatch');
    expect(readdirSync(folder)).toEqual(['inside']);
    expect(removeEntryIfIdentitySteps(link, foreign)).toBe('mismatch');
    expect(readlinkSync(link)).toBe('/nonexistent-target');
    expect(quarantined(root)).toEqual([]);
  });

  it('round-trips the identity text form and rejects any other value', () => {
    const identity = { dev: 1n, ino: 2n, birthtimeNs: 3n };
    expect(parseEntryIdentityKey(entryIdentityKey(identity))).toEqual(identity);
    for (const value of ['1:2', '1:2:x', 7, undefined]) {
      expect(parseEntryIdentityKey(value)).toBeUndefined();
    }
  });
});

describe('the guarded removal effect', () => {
  it('needs an authority scope', () => {
    const root = directory();
    const path = join(root, 'record.json');
    writeFileSync(path, 'mine\n');
    expect(() => removeEntryIfIdentitySync(path, identityOf(path))).toThrow();
    expect(readdirSync(root)).toEqual(['record.json']);
  });

  it('crosses the seam as one filesystem effect naming its path and the identity text', async () => {
    const root = directory();
    const path = join(root, 'record.json');
    writeFileSync(path, 'mine\n');
    const identity = identityOf(path);
    const issuer = createIssuer(await runtimeApi(), { invocation_id: 'remove-effect' });
    const requests: AuthorityHostEffectRequest[] = [];
    const apply_effect = vi.fn((request: AuthorityHostEffectRequest, apply: () => unknown) => {
      requests.push(request);
      return apply();
    });
    try {
      runWithAuthorityHostEffects(
        {
          action_id: 'remove acceptance',
          invocation_id: 'remove-effect',
          effect: 'local-write',
          receipt_store: issuer,
          apply_effect,
        },
        () => {
          expect(removeEntryIfIdentitySync(path, identity)).toBe('removed');
        },
      );
    } finally {
      issuer.dispose();
    }
    expect(requests).toEqual([
      {
        kind: 'filesystem',
        symbol: 'removeEntryIfIdentitySync',
        arguments: [path, entryIdentityKey(identity)],
      },
    ]);
    expect(readdirSync(root)).toEqual([]);
  });
});
