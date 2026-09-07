import { resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { analyzeEffectProgram, type EffectReport } from '../../src/index.js';

// Invariants: INV-DEVAI-020. Registration and command factories retain effect attribution.
const catalog = [
  'method register',
  'arrow register',
  'expression register',
  'quoted run',
  'named run',
  'property run',
  'wrapped run',
  'factory shorthand',
  'factory template',
];
const input = {
  tsconfigPath: resolve(import.meta.dirname, 'fixtures/factories/tsconfig.json'),
  catalog,
  contracts: catalog.map((action_id) => ({ action_id, effect: 'read', capabilities: [] })),
  subprocessRegistry: { templates: [] },
};
let report: EffectReport;
beforeAll(async () => {
  report = await analyzeEffectProgram(input);
});

it.each(catalog)('attributes the filesystem write to %s', (action_id) => {
  expect(report.actions[action_id]?.capabilities).toEqual(['fs:unknown-write']);
  expect(report.findings).toContainEqual({
    code: 'EFFECT_UNDER_DECLARED',
    action_id,
    message: 'Inferred capabilities not covered by the declaration: fs:unknown-write.',
  });
});

it('keeps only selected commands and ignores unrelated calls with command-shaped arguments', () => {
  expect(Object.keys(report.actions).sort()).toEqual([...catalog].sort());
  expect(report.metrics).toMatchObject({
    catalog_actions: 9,
    extracted_actions: 9,
    program_files: 1,
  });
});

it('names only the missing commands when extraction cannot satisfy the catalog', async () => {
  await expect(
    analyzeEffectProgram({ ...input, catalog: [...catalog, 'missing one', 'missing two'] }),
  ).rejects.toThrow(
    new Error('EFFECT_EXTRACTOR_CATALOG_MISMATCH missing=[missing one,missing two] extra=[]'),
  );
});
