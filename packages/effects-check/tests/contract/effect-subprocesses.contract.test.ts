import { resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { analyzeEffectProgram, type EffectReport } from '../../src/index.js';

// Invariants: INV-DEVAI-020. Template matching must preserve argv and executable identity.
const catalog = [
  'empty argv',
  'omitted argv',
  'dynamic element',
  'dynamic argv',
  'dynamic executable',
  'unregistered argv',
  'unregistered executable',
  'unresolved body',
];
let report: EffectReport;
beforeAll(async () => {
  report = await analyzeEffectProgram({
    tsconfigPath: resolve(import.meta.dirname, 'fixtures/subprocesses/tsconfig.json'),
    catalog,
    contracts: catalog.map((action_id) => ({
      action_id,
      effect: 'read',
      capabilities: ['proc:git'],
    })),
    subprocessRegistry: {
      templates: [
        { executable: 'git', argv_shape: ['<none>'] },
        { executable: 'git', argv_shape: ['show', '<dynamic>'] },
        { executable: 'git', argv_shape: ['<dynamic-argv>'] },
        { executable: 'git', argv_shape: ['status'] },
      ],
    },
  });
});

it('coalesces empty and absent argv without losing the owning actions', () => {
  expect(report.subprocess_templates).toContainEqual({
    executable: 'git',
    argv_shape: ['<none>'],
    actions: ['empty argv', 'omitted argv'],
  });
});

it.each([
  ['dynamic element', ['show', '<dynamic>']],
  ['dynamic argv', ['<dynamic-argv>']],
] as const)('preserves the declared uncertainty in %s', (action, argv_shape) => {
  expect(report.subprocess_templates).toContainEqual({
    executable: 'git',
    argv_shape,
    actions: [action],
  });
  expect(report.findings.filter((finding) => finding.action_id === action)).toEqual([]);
});

it.each(['unregistered argv', 'unregistered executable'])(
  'refuses to match a partially matching template for %s',
  (action_id) => {
    expect(report.findings).toContainEqual(
      expect.objectContaining({ action_id, code: 'SPAWN_EFFECT_UNDECLARED' }),
    );
  },
);

it('reports a dynamic executable as unresolved runtime identity without inventing a static template', () => {
  const action = report.actions['dynamic executable'];
  expect(action?.capabilities).toEqual(['proc:dynamic']);
  expect(action?.dispositions).toHaveLength(1);
  expect(action?.dispositions[0]?.reason).toBe(
    'Dynamic subprocess executable with argv shape ["status"]; conservatively classified proc:dynamic and requires runtime-seam enforcement.',
  );
  expect(report.subprocess_templates.flatMap((template) => template.actions)).not.toContain(
    'dynamic executable',
  );
});

it('retains the precise unresolved call location and reason', () => {
  const dispositions = report.actions['unresolved body']?.dispositions;
  expect(dispositions).toHaveLength(1);
  expect(dispositions?.[0]?.edge).toMatch(/\/commands\.ts:\d+:unknownHandler$/u);
  expect(dispositions?.[0]?.reason).toBe(
    'In-program declaration has no executable body; conservatively classified through same-name method expansion when available.',
  );
  expect(report.metrics.dispositioned_edges).toBe(2);
});
