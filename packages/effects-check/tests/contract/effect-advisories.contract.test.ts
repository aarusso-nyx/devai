import { resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { analyzeEffectProgram, type EffectReport } from '../../src/index.js';

// Invariants: INV-DEVAI-020. Advisory diagnostics must explain the actual unanalyzable pattern.
let report: EffectReport;
beforeAll(async () => {
  report = await analyzeEffectProgram({
    tsconfigPath: resolve(import.meta.dirname, 'fixtures/advisories/tsconfig.json'),
    catalog: [],
    contracts: [],
    subprocessRegistry: { templates: [] },
  });
});

it.each([
  'non-literal dynamic import',
  'eval',
  'new Function',
  'Reflect.apply with a non-literal target',
  'Reflect.construct with a non-literal target',
])('reports %s with its source location and review reason', (pattern) => {
  const finding = report.findings.find((item) => item.message.startsWith(`${pattern} at `));
  expect(finding?.code).toBe('EFFECT_UNANALYZABLE_PATTERN');
  expect(finding?.message).toMatch(
    /packages\/effects-check\/tests\/contract\/fixtures\/advisories\/commands\.ts:\d+:/u,
  );
  expect(finding?.message).toContain(`:${pattern} is outside the audited advisory allowlist.`);
});

it('does not add advisory findings for literal imports or unrelated calls and constructors', () => {
  expect(report.findings).toHaveLength(5);
  expect(report.advisory_patterns).toEqual({ violations: 5, dispositions: [] });
  expect(report.actions).toEqual({});
  expect(report.metrics).toMatchObject({
    program_files: 1,
    catalog_actions: 0,
    extracted_actions: 0,
  });
});
