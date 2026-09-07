import {
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAuthorityHostEffectsAtomically,
  closeReadOnlySync,
  openReadOnlyNoFollowSync,
  runWithAuthorityHostEffects,
  spawnSync as guardedSpawnSync,
  writeFileSync as guardedWriteFileSync,
  writeGovernanceProjectionSync,
  type AtomicAuthorityHostEffect,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '../../src/boundaries/host-effects.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';

// Host seam contracts written against the retained authority mutation diagnostic (round 3,
// candidate 3175bd2); mutant ids below are that report's. Every case uses a disposable
// temporary fixture and valid inputs; no effect leaves the fixture directory.

const roots: string[] = [];
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai host seam ç-'));
  roots.push(root);
  return root;
}

async function scopeFor(
  invocationId: string,
  overrides: Partial<AuthorityHostEffectScope> = {},
): Promise<AuthorityHostEffectScope> {
  const issuer = createIssuer(await runtimeApi(), {
    issuer_id: `host-seam-${invocationId}`,
    invocation_id: invocationId,
  });
  disposers.push(() => {
    issuer.dispose();
  });
  return {
    action_id: 'release prepare',
    invocation_id: invocationId,
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
    ...overrides,
  };
}

describe('guarded host seam requests', () => {
  // Mutants 1126, 1127, 1129, 1130, 1131: every guarded call reaches the broker as one
  // request labelled by the seam it crosses — 'filesystem' for the mutation roster and
  // 'process' for the process roster — carrying its own symbol and arguments, and the
  // broker's `apply` performs the real host call.
  it('labels each guarded call by its seam and applies the real host effect', async () => {
    const root = fixture();
    const file = join(root, 'projection.txt');
    const requests: AuthorityHostEffectRequest[] = [];
    const scope = await scopeFor('invocation-seam', {
      apply_effect: (request, apply) => {
        requests.push(request);
        return apply();
      },
    });
    runWithAuthorityHostEffects(scope, () => {
      guardedWriteFileSync(file, 'projection bytes');
      expect(guardedSpawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).status).toBe(0);
    });
    expect(requests.map((request) => ({ kind: request.kind, symbol: request.symbol }))).toEqual([
      { kind: 'filesystem', symbol: 'writeFileSync' },
      { kind: 'process', symbol: 'spawnSync' },
    ]);
    expect(requests[0]?.arguments).toEqual([file, 'projection bytes']);
    expect(readFileSync(file, 'utf8')).toBe('projection bytes');
  });
});

describe('read-only directory descriptor seam', () => {
  // Mutant 1516: `directory` requests O_DIRECTORY, so the descriptor names a directory and
  // the same request against a regular file is refused by the kernel instead of opening it.
  it('opens a directory only for a directory request', () => {
    const root = fixture();
    const file = join(root, 'record.json');
    writeFileSync(file, '{}\n');
    const descriptor = openReadOnlyNoFollowSync(root, true);
    try {
      expect(fstatSync(descriptor).isDirectory()).toBe(true);
    } finally {
      closeReadOnlySync(descriptor);
    }
    expect(() => openReadOnlyNoFollowSync(file, true)).toThrow('ENOTDIR');
  });
});

describe('governance projection writer', () => {
  // Mutants 1552, 1553, 1554: the exception writes the exact body at the target and creates
  // the target's missing parent chain, so a projection two directories deep is written.
  it('writes the exact body under a missing parent chain', () => {
    const root = fixture();
    const target = join(root, 'docs', 'governance', 'projection ç.md');
    const body = '# Governance\n\nprojected\n';
    writeGovernanceProjectionSync(target, body);
    expect(readFileSync(target, 'utf8')).toBe(body);
    expect(lstatSync(dirname(target)).isDirectory()).toBe(true);
  });
});

describe('atomic unit rollback restores a tree in any declaration order', () => {
  // Mutants 1425, 1426: a captured directory is recreated together with its missing
  // ancestors. Here the unit declares the parent before the directory nested inside it, so
  // the nested snapshot is restored first, while its parent is still removed.
  it('restores a nested directory declared after its parent', () => {
    const root = fixture();
    const parent = join(root, 'parent');
    const nested = join(parent, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'data'), 'nested bytes');
    writeFileSync(join(parent, 'sibling'), 'sibling bytes');
    const failure = new Error('later authorized effect failed');
    const effect = (
      symbol: string,
      args: readonly unknown[],
      apply: () => unknown,
    ): AtomicAuthorityHostEffect => ({
      request: { kind: 'filesystem', symbol, arguments: args },
      apply,
    });
    expect(() =>
      applyAuthorityHostEffectsAtomically([
        effect('rmSync', [parent, { recursive: true }], () => rmSync(parent, { recursive: true })),
        effect('rmSync', [nested, { recursive: true, force: true }], () =>
          rmSync(nested, { recursive: true, force: true }),
        ),
        effect('writeFileSync', [join(root, 'unrelated failure')], () => {
          throw failure;
        }),
      ]),
    ).toThrow(failure);
    expect(readFileSync(join(nested, 'data'), 'utf8')).toBe('nested bytes');
    expect(readFileSync(join(parent, 'sibling'), 'utf8')).toBe('sibling bytes');
  });
});
