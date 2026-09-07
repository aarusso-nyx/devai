import { describe, expect, it } from 'vitest';
import { boundaryApi, expectBoundaryFailure } from './authority-boundary-testkit.js';

const cases = [
  ['runWithAuthorityHostEffects', 'packages/cli/src/authority/index.ts'],
  ['runWithAuthorityHostEffects', 'packages/cli/src/authority/broker.ts'],
  ['applyAuthorityHostEffectsAtomically', 'packages/cli/src/authority/broker.ts'],
  ['readProcessSync', 'packages/cli/src/version.ts'],
  ['readProcessSync', 'packages/loop/src/governance-ledger/index.ts'],
  ['writeGovernanceProjectionSync', 'packages/cli/src/commands/docs/governance-render.ts'],
] as const;

async function inventory(path: string, source: string) {
  return (await boundaryApi()).validateDirectMutatorInventory({
    inventory: { entries: [], totals: { exemptions: 0 } },
    virtual_sources: { [path]: source },
  });
}

describe('privileged host helper module ownership', () => {
  it.each(cases)('refuses a namespace lookalike for %s in %s', async (symbol, path) => {
    const result = await inventory(
      path,
      `import * as host from './lookalike.js';\nhost.${symbol}();`,
    );
    expectBoundaryFailure(result, 'refused', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE');
    expect(result).toMatchObject({ unauthorized: [{ path, line: 2, symbol }] });
  });
});

describe('privileged host helper caller and module pairs', () => {
  it.each(cases)('accepts authentic %s in %s across import forms', async (symbol, path) => {
    for (const source of [
      `import { ${symbol} } from '@devai-nyx/authority';\n${symbol}();`,
      `import { ${symbol} as invoke } from '@devai-nyx/authority';\ninvoke();`,
      `import * as host from '@devai-nyx/authority';\nhost.${symbol}();`,
    ])
      expect(await inventory(path, source)).toMatchObject({
        ok: true,
        value: { unauthorized_call_sites: 0 },
      });
  });

  it.each(cases)('does not grant %s to a sibling of %s', async (symbol, owner) => {
    const path = owner.replace(/\.ts$/, '-lookalike.ts');
    for (const source of [
      `import { ${symbol} as invoke } from '@devai-nyx/authority';\ninvoke();`,
      `import * as host from '@devai-nyx/authority';\nhost.${symbol}();`,
    ]) {
      const result = await inventory(path, source);
      expectBoundaryFailure(result, 'refused', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE');
      expect(result).toMatchObject({ unauthorized: [{ path, line: 2, symbol }] });
    }
  });

  it.each(cases)('refuses an aliased lookalike %s even in %s', async (symbol, path) => {
    const result = await inventory(
      path,
      `import { ${symbol} as invoke } from './lookalike.js';\ninvoke();`,
    );
    expectBoundaryFailure(result, 'refused', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE');
    expect(result).toMatchObject({ unauthorized: [{ path, line: 2, symbol }] });
  });
});
