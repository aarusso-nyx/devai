import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { boundaryApi, expectBoundaryFailure } from './authority-boundary-testkit.js';

const INVENTORY = { entries: [], totals: { exemptions: 0 } };
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function inventoryFor(virtual_sources: Readonly<Record<string, string>>) {
  const api = await boundaryApi();
  return api.validateDirectMutatorInventory({ inventory: INVENTORY, virtual_sources });
}

describe('immutable Git read helper ownership', () => {
  it('finds no unapproved Git helper caller in the canonical source population', async () => {
    const api = await boundaryApi();
    const result = api.validateDirectMutatorInventory({ inventory: INVENTORY, repo_root: ROOT });

    const unauthorized =
      result.ok === false
        ? ((result as { readonly unauthorized?: readonly { readonly symbol: string }[] })
            .unauthorized ?? [])
        : [];
    expect(
      unauthorized.filter(
        ({ symbol }) => symbol === 'readExactGitTreeSync' || symbol === 'readGitObjectSync',
      ),
    ).toEqual([]);
  });

  it('allows readExactGitTreeSync only in its two named production owners', async () => {
    const result = await inventoryFor({
      'packages/cli/src/services/check-runner/authority-process.ts': [
        "import { readExactGitTreeSync as readTree } from '@devai-nyx/authority';",
        'readTree();',
      ].join('\n'),
      'packages/cli/src/services/release-certification-provider.ts': [
        "import { readExactGitTreeSync } from '@devai-nyx/authority';",
        'readExactGitTreeSync();',
      ].join('\n'),
    });

    expect(result).toMatchObject({ ok: true, value: { unauthorized_call_sites: 0 } });
  });

  it.each([
    [
      'an unauthorized owner',
      'packages/cli/src/services/untrusted-git-reader.ts',
      "import { readExactGitTreeSync } from '@devai-nyx/authority';\nreadExactGitTreeSync();",
      'readExactGitTreeSync',
    ],
    [
      'an unauthorized aliased owner',
      'packages/cli/src/services/untrusted-git-reader.ts',
      "import { readExactGitTreeSync as readTree } from '@devai-nyx/authority';\nreadTree();",
      'readExactGitTreeSync',
    ],
    [
      'readGitObjectSync, which has no production owner',
      'packages/cli/src/services/untrusted-git-reader.ts',
      "import { readGitObjectSync as readObject } from '@devai-nyx/authority';\nreadObject();",
      'readGitObjectSync',
    ],
    [
      'a lookalike named import even in an allowed path',
      'packages/cli/src/services/check-runner/authority-process.ts',
      "import { readExactGitTreeSync } from './lookalike.js';\nreadExactGitTreeSync();",
      'readExactGitTreeSync',
    ],
    [
      'a lookalike namespace import even in an allowed path',
      'packages/cli/src/services/check-runner/authority-process.ts',
      "import * as authority from './lookalike.js';\nauthority.readExactGitTreeSync();",
      'readExactGitTreeSync',
    ],
  ])('%s is refused', async (_label, path, source, symbol) => {
    const result = await inventoryFor({ [path]: source });

    expectBoundaryFailure(result, 'refused', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE');
    expect(result).toMatchObject({ unauthorized: [{ path, line: 2, symbol }] });
  });
});
