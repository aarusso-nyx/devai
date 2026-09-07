import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { boundaryApi, expectBoundaryFailure } from './authority-boundary-testkit.js';

// Repository-scan contract cases for validateDirectMutatorInventory, written against the
// retained authority mutation diagnostic (candidate 3dfdc316, report 414957d9). The
// existing inventory tests scan virtual sources or the live repository; none pins how a
// repo_root is walked, so the walker's survivors (report lines 862-875, 1000-1025) are
// covered here against a purpose-built tree.

const INVENTORY = { entries: [], totals: { exemptions: 0 } };
const roots: string[] = [];

function repository(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-inventory-scan-'));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const DIRECT_WRITE = "import { writeFileSync } from 'node:fs';\nwriteFileSync('x', 'y');\n";
const CLEAN = 'export const answer = 42;\n';

type Unauthorized = {
  readonly unauthorized?: readonly { path: string; line: number; symbol: string }[];
};

describe('direct mutator inventory repository scan', () => {
  // Mutants 3273, 3274, 3275, 3281, 3284, 3285: the walker descends into nested directories
  // in sorted order, and inspects only .ts files.
  it('walks nested canonical sources in sorted order and inspects only .ts files', async () => {
    const api = await boundaryApi();
    const root = repository({
      'packages/authority/src/zeta.ts': DIRECT_WRITE,
      'packages/authority/src/alpha/deep/inner.ts': DIRECT_WRITE,
      'packages/authority/src/alpha/skipped.js': DIRECT_WRITE,
      'packages/authority/src/alpha/skipped.tsx': DIRECT_WRITE,
      'packages/authority/src/notes.md.ts.txt': DIRECT_WRITE,
      'packages/authority/src/clean.ts': CLEAN,
    });
    const result = api.validateDirectMutatorInventory({ inventory: INVENTORY, repo_root: root });
    expectBoundaryFailure(result, 'refused', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE');
    expect((result as Unauthorized).unauthorized).toEqual([
      { path: 'packages/authority/src/alpha/deep/inner.ts', line: 2, symbol: 'writeFileSync' },
      { path: 'packages/authority/src/zeta.ts', line: 2, symbol: 'writeFileSync' },
    ]);
  });

  // Mutants 3282, 3283: a directory is descended, never treated as a file.
  it('does not treat a directory named like a source file as a file', async () => {
    const api = await boundaryApi();
    const root = repository({
      'packages/authority/src/dir.ts/inner.ts': DIRECT_WRITE,
    });
    const result = api.validateDirectMutatorInventory({ inventory: INVENTORY, repo_root: root });
    expectBoundaryFailure(result, 'refused', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE');
    expect((result as Unauthorized).unauthorized).toEqual([
      { path: 'packages/authority/src/dir.ts/inner.ts', line: 2, symbol: 'writeFileSync' },
    ]);
  });

  // Mutants 3426-3431, 3434: only the canonical source roots that exist are scanned, files
  // outside them are ignored, and a clean population succeeds.
  it('scans only existing canonical roots and ignores sources outside them', async () => {
    const api = await boundaryApi();
    const root = repository({
      'packages/utils/src/helper.ts': CLEAN,
      'packages/other/src/direct.ts': DIRECT_WRITE,
      'scripts/direct.ts': DIRECT_WRITE,
      'packages/authority/tests/direct.ts': DIRECT_WRITE,
    });
    expect(api.validateDirectMutatorInventory({ inventory: INVENTORY, repo_root: root })).toEqual({
      ok: true,
      value: { unauthorized_call_sites: 0, wildcard_exemptions: 0 },
    });
  });

  it('succeeds for a repository root without any canonical source root', async () => {
    const api = await boundaryApi();
    const root = repository({ 'README.md': '# empty\n' });
    expect(api.validateDirectMutatorInventory({ inventory: INVENTORY, repo_root: root })).toEqual({
      ok: true,
      value: { unauthorized_call_sites: 0, wildcard_exemptions: 0 },
    });
  });

  // Mutant 3441: a virtual source that is not a string is skipped, not scanned or thrown on.
  it('skips virtual sources that are not strings', async () => {
    const api = await boundaryApi();
    expect(
      api.validateDirectMutatorInventory({
        inventory: INVENTORY,
        virtual_sources: { 'packages/cli/src/a.ts': 42, 'packages/cli/src/b.ts': null },
      }),
    ).toEqual({ ok: true, value: { unauthorized_call_sites: 0, wildcard_exemptions: 0 } });
    expectBoundaryFailure(
      api.validateDirectMutatorInventory({
        inventory: INVENTORY,
        virtual_sources: { 'packages/cli/src/a.ts': 42, 'packages/cli/src/b.ts': DIRECT_WRITE },
      }),
      'refused',
      'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE',
    );
  });

  // Mutants 3454, 3455: declared wildcard exemptions are reported as given, and default to
  // zero when the inventory carries no totals.
  it.each([
    [{ entries: [], totals: { exemptions: 3 } }, 3],
    [{ entries: [], totals: {} }, 0],
    [{ entries: [] }, 0],
  ])('reports wildcard exemptions from inventory %j as %i', async (inventory, exemptions) => {
    const api = await boundaryApi();
    expect(api.validateDirectMutatorInventory({ inventory, virtual_sources: {} })).toEqual({
      ok: true,
      value: { unauthorized_call_sites: 0, wildcard_exemptions: exemptions },
    });
  });

  // Mutant 3420: a malformed inventory is a usage error before any scan.
  it.each([undefined, null, {}, { inventory: {} }, { inventory: { entries: 'none' } }])(
    'refuses malformed inventory input %s before scanning',
    async (input) => {
      const api = await boundaryApi();
      expectBoundaryFailure(
        api.validateDirectMutatorInventory(input),
        'usage-error',
        'AUTHORITY_DIRECT_MUTATOR_INVENTORY_INVALID',
      );
    },
  );
});
