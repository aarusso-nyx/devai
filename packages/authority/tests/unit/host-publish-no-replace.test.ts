// ADR-AUT-0005: the governed atomic no-replace publication. A target appears only with its
// complete bytes, an existing target is never replaced, and a crash between the link and
// the staged unlink leaves the complete target plus a stray staged name no reader lists.
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publishFileNoReplaceSync,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
} from '../../src/boundaries/host-effects.js';
import {
  PUBLISH_INDETERMINATE,
  PUBLISH_STAGED_SUFFIX,
  PublishIndeterminateError,
  publishNoReplaceSteps,
} from '../../src/boundaries/host-publish.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';
import { boundaryApi, expectBoundaryFailure } from './authority-boundary-testkit.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-publish-'));
  roots.push(root);
  return root;
}

const staged = (root: string) =>
  readdirSync(root).filter((name) => name.endsWith(PUBLISH_STAGED_SUFFIX));

describe('atomic no-replace publication steps', () => {
  it('publishes the exact bytes and leaves no staged name behind', () => {
    const root = directory();
    const target = join(root, 'record.json');
    publishNoReplaceSteps(target, '{"id":"R-1"}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"id":"R-1"}\n');
    expect(lstatSync(target).nlink).toBe(1);
    expect(readdirSync(root)).toEqual(['record.json']);
  });

  it('refuses with EEXIST when the target exists and leaves it byte for byte', () => {
    const root = directory();
    const target = join(root, 'record.json');
    writeFileSync(target, 'first\n');
    expect(() => publishNoReplaceSteps(target, 'second\n')).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
    expect(readFileSync(target, 'utf8')).toBe('first\n');
    expect(staged(root)).toEqual([]);
  });

  it('lets exactly one of two interleaved publishers win, never replacing the winner', () => {
    const root = directory();
    const target = join(root, 'lock.json');
    let inner: unknown;
    publishNoReplaceSteps(target, 'winner\n', {
      unlinkStaged: (name) => {
        try {
          publishNoReplaceSteps(target, 'loser\n');
        } catch (error) {
          inner = error;
        }
        unlinkSync(name);
      },
    });
    expect(inner).toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(target, 'utf8')).toBe('winner\n');
    expect(readdirSync(root)).toEqual(['lock.json']);
  });

  it('leaves the complete target and an unlisted staged link after a crash between link and unlink', () => {
    const root = directory();
    const target = join(root, 'record.json');
    expect(() => publishNoReplaceSteps(target, 'complete\n', { crashAfterLink: true })).toThrow(
      'AUTHORITY_PUBLISH_SIMULATED_CRASH',
    );
    expect(readFileSync(target, 'utf8')).toBe('complete\n');
    const [stray] = staged(root);
    expect(stray).toMatch(/^\.record\.json\..+\.publish-staged$/u);
    // The stray name is a second link to the published inode, never a partial record.
    expect(lstatSync(join(root, stray ?? '')).ino).toBe(lstatSync(target).ino);
    expect(readdirSync(root).filter((name) => name.endsWith('.json'))).toEqual(['record.json']);
    // A retry refuses rather than replacing the published record.
    expect(() => publishNoReplaceSteps(target, 'retry\n')).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
    expect(readFileSync(target, 'utf8')).toBe('complete\n');
  });

  it.each([
    [
      'the staged unlink',
      {
        unlinkStaged: () => {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        },
      },
    ],
    [
      'the directory fsync',
      {
        fsyncDirectory: () => {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        },
      },
    ],
  ])('reports a failure of %s after the link as an indeterminate publication', (_, hooks) => {
    const root = directory();
    const target = join(root, 'record.json');
    let failure: unknown;
    try {
      publishNoReplaceSteps(target, 'published\n', hooks);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PublishIndeterminateError);
    expect(failure).toMatchObject({
      code: PUBLISH_INDETERMINATE,
      path: target,
      staged_remaining: false,
      cause: { code: 'EIO' },
    });
    // The target holds the caller's complete bytes, and the staged name was recovered.
    expect(readFileSync(target, 'utf8')).toBe('published\n');
    expect(readdirSync(root)).toEqual(['record.json']);
  });

  it('removes its staged file when the link fails for any reason', () => {
    const root = directory();
    expect(() => publishNoReplaceSteps(join(root, 'missing', 'record.json'), 'x')).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('the guarded publication effect', () => {
  it('needs an authority scope', () => {
    const root = directory();
    expect(() => publishFileNoReplaceSync(join(root, 'record.json'), 'x')).toThrow();
    expect(readdirSync(root)).toEqual([]);
  });

  it('crosses the seam as one filesystem effect naming only its target', async () => {
    const root = directory();
    const target = join(root, 'record.json');
    const issuer = createIssuer(await runtimeApi(), { invocation_id: 'publish-effect' });
    const requests: AuthorityHostEffectRequest[] = [];
    const apply_effect = vi.fn((request: AuthorityHostEffectRequest, apply: () => unknown) => {
      requests.push(request);
      return apply();
    });
    try {
      runWithAuthorityHostEffects(
        {
          action_id: 'publish acceptance',
          invocation_id: 'publish-effect',
          effect: 'local-write',
          receipt_store: issuer,
          apply_effect,
        },
        () => {
          publishFileNoReplaceSync(target, 'bytes\n');
          expect(() => publishFileNoReplaceSync(target, 'other\n')).toThrow(
            expect.objectContaining({ code: 'EEXIST' }),
          );
        },
      );
    } finally {
      issuer.dispose();
    }
    expect(requests.map((request) => [request.kind, request.symbol, request.arguments[0]])).toEqual(
      [
        ['filesystem', 'publishFileNoReplaceSync', target],
        ['filesystem', 'publishFileNoReplaceSync', target],
      ],
    );
    expect(readFileSync(target, 'utf8')).toBe('bytes\n');
  });

  it('applies nothing when the broker refuses the effect', async () => {
    const root = directory();
    const target = join(root, 'record.json');
    const issuer = createIssuer(await runtimeApi(), { invocation_id: 'publish-denied' });
    try {
      expect(() =>
        runWithAuthorityHostEffects(
          {
            action_id: 'publish acceptance',
            invocation_id: 'publish-denied',
            effect: 'local-write',
            receipt_store: issuer,
            apply_effect: () => {
              throw new Error('AUTHORITY_POLICY_DENIED');
            },
          },
          () => publishFileNoReplaceSync(target, 'bytes\n'),
        ),
      ).toThrow('AUTHORITY_POLICY_DENIED');
    } finally {
      issuer.dispose();
    }
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('the directory flush exception', () => {
  it('is allowed only in the state-root initializer, imported from the authority module', async () => {
    const api = await boundaryApi();
    const call = (from: string) =>
      `import { flushDirectoryEntrySync } from '${from}';\nflushDirectoryEntrySync('.');\n`;
    const inventory = { entries: [], totals: { exemptions: 0 } };
    expect(
      api.validateDirectMutatorInventory({
        inventory,
        virtual_sources: { 'packages/loop/src/loop/state-root.ts': call('@devai-nyx/authority') },
      }),
    ).toMatchObject({ ok: true });
    for (const [path, from] of [
      ['packages/loop/src/loop/worktrees.ts', '@devai-nyx/authority'],
      ['packages/loop/src/loop/state-root.ts', './elsewhere.js'],
    ] as const) {
      const result = api.validateDirectMutatorInventory({
        inventory,
        virtual_sources: { [path]: call(from) },
      });
      expectBoundaryFailure(result, 'refused', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE');
      expect(result).toMatchObject({
        unauthorized: [{ path, line: 2, symbol: 'flushDirectoryEntrySync' }],
      });
    }
  });
});
