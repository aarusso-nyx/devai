import { resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { analyzeEffectProgram, type EffectReport } from '../../src/index.js';

// Invariants: INV-DEVAI-020. An import rename cannot hide an effect or manufacture one.
const cases = [
  ['aliased write', ['fs:unknown-write']],
  ['aliased read', []],
  ['aliased shell', ['proc:git']],
  ['aliased process', ['proc:git']],
  ['local names', []],
] as const;
let report: EffectReport;
beforeAll(async () => {
  const catalog = cases.map(([name]) => name);
  report = await analyzeEffectProgram({
    tsconfigPath: resolve(import.meta.dirname, 'fixtures/aliases/tsconfig.json'),
    catalog,
    contracts: catalog.map((action_id) => ({ action_id, effect: 'read', capabilities: [] })),
    subprocessRegistry: { templates: [] },
  });
});

it.each(cases)('identifies the actual declaration for %s', (action_id, capabilities) => {
  expect(report.actions[action_id]?.capabilities).toEqual(capabilities);
  expect(
    report.findings.some(
      (finding) => finding.action_id === action_id && finding.code === 'EFFECT_UNDER_DECLARED',
    ),
  ).toBe(capabilities.length > 0);
});

it('preserves subprocess template registration requirements through an alias', () => {
  for (const action_id of ['aliased shell', 'aliased process']) {
    expect(report.findings).toContainEqual(
      expect.objectContaining({ action_id, code: 'SPAWN_EFFECT_UNDECLARED' }),
    );
  }
  expect(report.subprocess_templates).toEqual([
    { executable: 'git', argv_shape: ['<none>'], actions: ['aliased shell'] },
    { executable: 'git', argv_shape: ['status'], actions: ['aliased process'] },
  ]);
});
