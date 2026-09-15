import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
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
  applyAuthorityHostEffectsAtomically,
  runAuthorityHostEffectsWithRollback,
  type AtomicAuthorityHostEffect,
} from '../../src/boundaries/host-effects.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai rollback ação-'));
  roots.push(root);
  return root;
}
const effect = (
  symbol: string,
  args: readonly unknown[],
  apply: () => unknown,
): AtomicAuthorityHostEffect => ({
  request: { kind: 'filesystem', symbol, arguments: args },
  apply,
});
const failure = new Error('later authorized effect failed');
const fail = () => {
  throw failure;
};

describe('authorized atomic host unit recovery', () => {
  it('retains ordered return values on success', () => {
    const root = fixture(),
      file = join(root, 'file');
    expect(
      applyAuthorityHostEffectsAtomically([
        effect('writeFileSync', [file], () => {
          writeFileSync(file, 'first');
          return 'one';
        }),
        effect('appendFileSync', [file], () => {
          writeFileSync(file, 'second');
          return 'two';
        }),
      ]),
    ).toEqual(['one', 'two']);
    expect(readFileSync(file, 'utf8')).toBe('second');
  });
  it('restores original bytes and permissions once for repeated writes', () => {
    const root = fixture(),
      file = join(root, 'file'),
      untouched = join(root, 'unrelated');
    const original = Buffer.from([0, 255, 10, 127]);
    writeFileSync(file, original);
    chmodSync(file, 0o640);
    writeFileSync(untouched, 'keep');
    expect(() =>
      applyAuthorityHostEffectsAtomically([
        effect('writeFileSync', [file], () => {
          writeFileSync(file, 'first');
          chmodSync(file, 0o600);
        }),
        effect('writeFileSync', [file], () => {
          writeFileSync(file, 'second');
        }),
        effect('writeFileSync', [file], fail),
      ]),
    ).toThrow(failure);
    expect(readFileSync(file)).toEqual(original);
    expect(lstatSync(file).mode & 0o777).toBe(0o640);
    expect(readFileSync(untouched, 'utf8')).toBe('keep');
  });
  it('restores both sides of a rename that replaced a destination', () => {
    const root = fixture(),
      source = join(root, 'source'),
      destination = join(root, 'destination');
    writeFileSync(source, 'source');
    writeFileSync(destination, 'destination');
    expect(() =>
      applyAuthorityHostEffectsAtomically([
        effect('renameSync', [source, destination], () => renameSync(source, destination)),
        effect('writeFileSync', [destination], fail),
      ]),
    ).toThrow(failure);
    expect(readFileSync(source, 'utf8')).toBe('source');
    expect(readFileSync(destination, 'utf8')).toBe('destination');
  });
  it('restores a copy destination while preserving source bytes', () => {
    const root = fixture(),
      source = join(root, 'source'),
      destination = join(root, 'destination');
    writeFileSync(source, 'source');
    writeFileSync(destination, 'destination');
    expect(() =>
      applyAuthorityHostEffectsAtomically([
        effect('copyFileSync', [source, destination], () => copyFileSync(source, destination)),
        effect('writeFileSync', [destination], fail),
      ]),
    ).toThrow(failure);
    expect(readFileSync(source, 'utf8')).toBe('source');
    expect(readFileSync(destination, 'utf8')).toBe('destination');
  });
  it('removes a newly created link without changing its target', () => {
    const root = fixture(),
      source = join(root, 'source'),
      link = join(root, 'link');
    writeFileSync(source, 'source');
    expect(() =>
      applyAuthorityHostEffectsAtomically([
        effect('symlinkSync', [source, link], () => symlinkSync(source, link)),
        effect('writeFileSync', [link], fail),
      ]),
    ).toThrow(failure);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(source, 'utf8')).toBe('source');
  });
  it.each([true, false])(
    'preserves an existing symlink when its target exists=%s',
    (targetExists) => {
      const root = fixture(),
        target = join(root, 'target'),
        link = join(root, 'link');
      if (targetExists) writeFileSync(target, 'untouched');
      symlinkSync('target', link);
      expect(() =>
        applyAuthorityHostEffectsAtomically([
          effect('unlinkSync', [link], () => rmSync(link)),
          effect('writeFileSync', [link], fail),
        ]),
      ).toThrow(failure);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe('target');
      if (targetExists) expect(readFileSync(target, 'utf8')).toBe('untouched');
      else expect(existsSync(target)).toBe(false);
    },
  );
  it('refuses process effects before any captured operation executes', () => {
    const apply = vi.fn();
    expect(() =>
      applyAuthorityHostEffectsAtomically([
        { request: { kind: 'process', symbol: 'spawnSync', arguments: [] }, apply },
      ]),
    ).toThrow('AUTHORITY_ATOMIC_UNIT_FILESYSTEM_ONLY');
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('authorized projection rollback', () => {
  it('returns a successful callback value without reverting the authorized writes', () => {
    const root = fixture(),
      file = join(root, 'file');
    expect(
      runAuthorityHostEffectsWithRollback([file], () => {
        writeFileSync(file, 'success');
        return 42;
      }),
    ).toBe(42);
    expect(readFileSync(file, 'utf8')).toBe('success');
  });
  it('removes newly created parent directories and restores existing file mode and content', () => {
    const root = fixture(),
      original = join(root, 'original'),
      nested = join(root, 'new/sub/file');
    writeFileSync(original, 'keep');
    chmodSync(original, 0o640);
    expect(() =>
      runAuthorityHostEffectsWithRollback([original, nested, original], () => {
        writeFileSync(original, 'changed');
        chmodSync(original, 0o600);
        mkdirSync(join(root, 'new/sub'), { recursive: true });
        writeFileSync(nested, 'new');
        fail();
      }),
    ).toThrow(failure);
    expect(readFileSync(original, 'utf8')).toBe('keep');
    expect(lstatSync(original).mode & 0o777).toBe(0o640);
    expect(existsSync(join(root, 'new'))).toBe(false);
  });
  it.each([true, false])(
    'preserves a symlink on projection failure when target exists=%s',
    (targetExists) => {
      const root = fixture(),
        target = join(root, 'target'),
        link = join(root, 'link');
      if (targetExists) writeFileSync(target, 'untouched');
      symlinkSync('target', link);
      expect(() =>
        runAuthorityHostEffectsWithRollback([link], () => {
          rmSync(link);
          writeFileSync(link, 'replacement');
          fail();
        }),
      ).toThrow(failure);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe('target');
      if (targetExists) expect(readFileSync(target, 'utf8')).toBe('untouched');
    },
  );
  it('refuses directory and empty targets before the callback executes', () => {
    const root = fixture(),
      callback = vi.fn();
    expect(() => runAuthorityHostEffectsWithRollback([''], callback)).toThrow(
      'AUTHORITY_ROLLBACK_TARGET_INVALID',
    );
    expect(() => runAuthorityHostEffectsWithRollback([root], callback)).toThrow(
      'AUTHORITY_ROLLBACK_FILE_TARGET_REQUIRED',
    );
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('directory effects are recoverable as complete authorized units', () => {
  it.each(['rmSync', 'renameSync'] as const)(
    'restores directory contents and modes after %s and a later failure',
    (symbol) => {
      const root = fixture(),
        original = join(root, 'original'),
        moved = join(root, 'moved');
      mkdirSync(join(original, 'nested'), { recursive: true });
      writeFileSync(join(original, 'nested/data'), 'original bytes');
      chmodSync(join(original, 'nested/data'), 0o640);
      symlinkSync('missing', join(original, 'dangling'));
      chmodSync(join(original, 'nested'), 0o750);
      const args = symbol === 'rmSync' ? [original, { recursive: true }] : [original, moved];
      expect(() =>
        applyAuthorityHostEffectsAtomically([
          effect(symbol, args, () =>
            symbol === 'rmSync'
              ? rmSync(original, { recursive: true })
              : renameSync(original, moved),
          ),
          effect('writeFileSync', [join(root, 'new')], fail),
        ]),
      ).toThrow(failure);
      expect(readFileSync(join(original, 'nested/data'), 'utf8')).toBe('original bytes');
      expect(lstatSync(join(original, 'nested/data')).mode & 0o777).toBe(0o640);
      expect(lstatSync(join(original, 'nested')).mode & 0o777).toBe(0o750);
      expect(readlinkSync(join(original, 'dangling'))).toBe('missing');
      expect(existsSync(moved)).toBe(false);
    },
  );
});

it('restores the complete directory population after a failed recursive copy', () => {
  const root = fixture(),
    source = join(root, 'source'),
    destination = join(root, 'destination');
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, 'replace'), 'new');
  writeFileSync(join(source, 'added'), 'new file');
  writeFileSync(join(destination, 'replace'), 'original');
  writeFileSync(join(destination, 'keep'), 'keep');
  expect(() =>
    applyAuthorityHostEffectsAtomically([
      effect('cpSync', [source, destination, { recursive: true }], () =>
        cpSync(source, destination, { recursive: true }),
      ),
      effect('writeFileSync', [join(destination, 'replace')], fail),
    ]),
  ).toThrow(failure);
  expect(readdirSync(destination).sort()).toEqual(['keep', 'replace']);
  expect(readFileSync(join(destination, 'replace'), 'utf8')).toBe('original');
  expect(readFileSync(join(destination, 'keep'), 'utf8')).toBe('keep');
  expect(readFileSync(join(source, 'replace'), 'utf8')).toBe('new');
});

it('restores the prior empty rename destination and the populated source', () => {
  const root = fixture(),
    source = join(root, 'source'),
    destination = join(root, 'destination');
  mkdirSync(source);
  mkdirSync(destination);
  chmodSync(destination, 0o750);
  writeFileSync(join(source, 'keep'), 'source data');
  expect(() =>
    applyAuthorityHostEffectsAtomically([
      effect('renameSync', [source, destination], () => renameSync(source, destination)),
      effect('writeFileSync', [join(root, 'later')], fail),
    ]),
  ).toThrow(failure);
  expect(readdirSync(destination)).toEqual([]);
  expect(lstatSync(destination).mode & 0o777).toBe(0o750);
  expect(readFileSync(join(source, 'keep'), 'utf8')).toBe('source data');
});

it('restores directory mode without rewriting untouched children for metadata-only effects', () => {
  const root = fixture(),
    directory = join(root, 'directory'),
    file = join(directory, 'untouched');
  mkdirSync(directory);
  chmodSync(directory, 0o750);
  writeFileSync(file, 'keep');
  const before = lstatSync(file);
  expect(() =>
    applyAuthorityHostEffectsAtomically([
      effect('chmodSync', [directory, 0o700], () => chmodSync(directory, 0o700)),
      effect('writeFileSync', [join(root, 'later')], fail),
    ]),
  ).toThrow(failure);
  expect(lstatSync(directory).mode & 0o777).toBe(0o750);
  expect(lstatSync(file).ino).toBe(before.ino);
  expect(lstatSync(file).mtimeMs).toBe(before.mtimeMs);
  expect(readFileSync(file, 'utf8')).toBe('keep');
});
