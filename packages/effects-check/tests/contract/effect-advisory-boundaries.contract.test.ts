import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { analyzeEffectProgram, type EffectReport } from '../../src/index.js';

// Invariants: INV-DEVAI-020. An audited disposition needs its exact boundary and rationale.
const boundaries = [
  ['packages/cli/src/authority/index.ts', /receiver semantics.*verified host-effect scope/u],
  ['packages/authority/src/boundaries/host-effects.ts', /audited implementation boundary/u],
  ['packages/cli/src/commands/mutation/run.ts', /runtime charter and authority checks/u],
  ['packages/cli/src/release-host-bootstrap.ts', /loader hook denies every other importer/u],
] as const;
const lookalikes = [
  'packages/other/src/authority/index.ts',
  'packages/cli/src/authority/index-copy.ts',
  'packages/cli/src/release-host-bootstrap-copy.ts',
];
let root: string | undefined;
let report: EffectReport;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'devai-advisory-boundaries-'));
  const files = [...boundaries.map(([path]) => path), ...lookalikes].reverse();
  for (const path of files) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, 'export const load = (target: string) => import(target);\n');
  }
  const tsconfigPath = join(root, 'tsconfig.json');
  writeFileSync(
    tsconfigPath,
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' }, files }),
  );
  report = await analyzeEffectProgram({
    tsconfigPath,
    catalog: [],
    contracts: [],
    subprocessRegistry: { templates: [] },
  });
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

it.each(boundaries)('retains the audited explanation for %s', (path, rationale) => {
  const disposition = report.advisory_patterns.dispositions.find(
    (item) => item.edge === `${path}:1:non-literal dynamic import`,
  );
  expect(disposition?.reason).toMatch(rationale);
  expect(report.findings.some((finding) => finding.message.includes(`${path}:1:`))).toBe(false);
});

it.each(lookalikes)('does not extend an audited exception to %s', (path) => {
  expect(report.findings).toContainEqual({
    code: 'EFFECT_UNANALYZABLE_PATTERN',
    message: `non-literal dynamic import at ${path}:1:non-literal dynamic import is outside the audited advisory allowlist.`,
  });
  expect(report.advisory_patterns.dispositions.some((item) => item.edge.startsWith(path))).toBe(
    false,
  );
});

it('keeps every disposition in deterministic source-edge order without hiding violations', () => {
  expect(report.advisory_patterns.violations).toBe(lookalikes.length);
  expect(report.advisory_patterns.dispositions.map((item) => item.edge)).toEqual(
    boundaries.map(([path]) => `${path}:1:non-literal dynamic import`).sort(),
  );
});
