import { describe, expect, it } from 'vitest';
import { processIsReadOnlyForTest } from './authority-host-test-scope.js';

// Invariants: INV-DEVAI-001, INV-DEVAI-017, INV-DEVAI-020

const processRequest = (args: readonly string[]) => ({
  kind: 'process' as const,
  symbol: 'spawnSync',
  arguments: ['pnpm', args],
});

describe('authority test host read-only pnpm boundary', () => {
  it('accepts only the governed fixed Vitest argv shapes', () => {
    expect(processIsReadOnlyForTest(processRequest(['vitest', 'run']))).toBe(true);
    for (const config of [
      'tests/config/t1.unit.config.ts',
      'tests/config/t2.contract.config.ts',
      'tests/config/t3.integration.config.ts',
      'tests/config/t4.regression.config.ts',
      'tests/config/t5.e2e.config.ts',
      'tests/config/t6.containment.config.ts',
    ]) {
      expect(processIsReadOnlyForTest(processRequest(['vitest', 'run', '--config', config]))).toBe(
        true,
      );
    }
  });

  it.each([
    ['vitest', 'run', '--config', '../vitest.config.ts'],
    ['vitest', 'run', '--config', 'tests/config/nested/t2.ts'],
    ['vitest', 'run', '--config', 'tests/config/t1-t3.coverage.config.ts'],
    ['vitest', 'run', '--config', 'tests/config/arbitrary.ts'],
    ['vitest', 'run', '--watch'],
    ['vitest', 'run', '--config', 'tests/config/t2.contract.config.ts', '--update'],
    ['run', 'arbitrary'],
    ['exec', 'sh', '-c', 'echo unsafe'],
  ])('rejects non-governed pnpm argv %j', (...args) => {
    expect(processIsReadOnlyForTest(processRequest(args))).toBe(false);
  });
});
