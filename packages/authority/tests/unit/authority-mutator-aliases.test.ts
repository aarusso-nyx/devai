import { describe, expect, it } from 'vitest';
import { boundaryApi, expectBoundaryFailure } from './authority-boundary-testkit.js';

const path = 'packages/cli/src/services/untrusted.ts';
async function inventory(source: string) {
  return (await boundaryApi()).validateDirectMutatorInventory({
    inventory: { entries: [], totals: { exemptions: 0 } },
    virtual_sources: { [path]: source },
  });
}

describe('direct mutation import aliases', () => {
  it('refuses a renamed raw filesystem mutation with its original symbol', async () => {
    const result = await inventory("import { writeFileSync as write } from 'node:fs';\nwrite();");
    expectBoundaryFailure(result, 'refused', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE');
    expect(result).toMatchObject({ unauthorized: [{ path, line: 2, symbol: 'writeFileSync' }] });
  });
});

describe('raw mutation imports remain covered across call forms', () => {
  it.each([
    'appendFile',
    'appendFileSync',
    'chmodSync',
    'closeSync',
    'copyFileSync',
    'cpSync',
    'execFile',
    'execFileSync',
    'fsyncSync',
    'mkdir',
    'mkdirSync',
    'mkdtempSync',
    'openSync',
    'rename',
    'renameSync',
    'rm',
    'rmSync',
    'spawn',
    'spawnSync',
    'symlinkSync',
    'unlink',
    'unlinkSync',
    'writeFile',
    'writeFileSync',
    'writeSync',
  ])('refuses raw %s in named, aliased, and namespace forms', async (symbol) => {
    const module = ['execFile', 'execFileSync', 'spawn', 'spawnSync'].includes(symbol)
      ? 'node:child_process'
      : 'node:fs';
    for (const source of [
      `import { ${symbol} } from '${module}';\n${symbol}();`,
      `import { ${symbol} as operation } from '${module}';\noperation();`,
      `import * as raw from '${module}';\nraw.${symbol}();`,
    ]) {
      const result = await inventory(source);
      expectBoundaryFailure(result, 'refused', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE');
      expect(result).toMatchObject({ unauthorized: [{ path, line: 2, symbol }] });
    }
  });

  it('allows renamed guarded operations from the authority module', async () => {
    expect(
      await inventory(
        "import { writeFileSync as guardedWrite } from '@devai-nyx/authority';\nguardedWrite();",
      ),
    ).toMatchObject({ ok: true, value: { unauthorized_call_sites: 0 } });
  });

  it('uses imported identity rather than a misleading local mutator name', async () => {
    expect(
      await inventory("import { readFileSync as writeFileSync } from 'node:fs';\nwriteFileSync();"),
    ).toMatchObject({ ok: true, value: { unauthorized_call_sites: 0 } });
  });
});
