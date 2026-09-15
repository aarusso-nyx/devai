import { resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { analyzeEffectProgram, type EffectReport } from '../../src/index.js';

// Invariants: INV-DEVAI-020. Each supported host write must block a read-only contract.
const filesystem = [
  'appendFile',
  'appendFileSync',
  'chmod',
  'chmodSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'mkdir',
  'mkdirSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'symlink',
  'symlinkSync',
  'unlink',
  'unlinkSync',
  'write',
  'writeFile',
  'writeFileSync',
  'writeSync',
];
const processes = ['exec', 'execFile', 'execFileSync', 'fork', 'spawn', 'spawnSync'];
let report: EffectReport;
let declaredReport: EffectReport;
beforeAll(async () => {
  const catalog = [
    ...filesystem.map((name) => `fs ${name}`),
    ...processes.map((name) => `proc ${name}`),
    'fs readFileSync',
  ];
  report = await analyzeEffectProgram({
    tsconfigPath: resolve(import.meta.dirname, 'fixtures/primitives/tsconfig.json'),
    catalog,
    contracts: catalog.map((action_id) => ({ action_id, effect: 'read', capabilities: [] })),
    subprocessRegistry: { templates: [] },
  });
  declaredReport = await analyzeEffectProgram({
    tsconfigPath: resolve(import.meta.dirname, 'fixtures/primitives/tsconfig.json'),
    catalog,
    contracts: catalog.map((action_id) => ({
      action_id,
      effect: action_id === 'fs readFileSync' ? 'read' : 'local-write',
      capabilities:
        action_id === 'fs readFileSync'
          ? []
          : action_id.startsWith('fs ')
            ? ['net:unrelated', 'fs:workspace-write']
            : ['fs:unrelated', 'proc:git'],
    })),
    subprocessRegistry: {
      templates: [
        { executable: 'git', argv_shape: ['<none>'] },
        { executable: 'git', argv_shape: ['status'] },
      ],
    },
  });
});

it.each(filesystem)('requires write capability for fs.%s', (name) => {
  const action_id = `fs ${name}`;
  expect(report.actions[action_id]?.capabilities).toEqual(['fs:unknown-write']);
  expect(report.findings).toContainEqual(
    expect.objectContaining({ code: 'EFFECT_UNDER_DECLARED', action_id }),
  );
});

it.each(processes)('requires a registered subprocess capability for %s', (name) => {
  const action_id = `proc ${name}`;
  expect(report.actions[action_id]?.capabilities).toEqual(['proc:git']);
  expect(report.findings).toContainEqual(
    expect.objectContaining({ code: 'SPAWN_EFFECT_UNDECLARED', action_id }),
  );
});

it('does not classify reading a file as a host write', () => {
  expect(report.actions['fs readFileSync']?.capabilities).toEqual([]);
  expect(report.findings.filter((finding) => finding.action_id === 'fs readFileSync')).toEqual([]);
});

it('normalizes filesystem capabilities to the declared filesystem scope', () => {
  for (const name of filesystem) {
    expect(declaredReport.actions[`fs ${name}`]).toMatchObject({
      declared_effect: 'local-write',
      declared_capabilities: ['net:unrelated', 'fs:workspace-write'],
      capabilities: ['fs:workspace-write'],
      unresolved_edges: [],
    });
  }
  expect(declaredReport.findings).toEqual([]);
});

it('retains exact subprocess templates and sorted action ownership', () => {
  const expected = [
    { executable: 'git', argv_shape: ['<none>'], actions: ['proc exec'] },
    {
      executable: 'git',
      argv_shape: ['status'],
      actions: ['proc execFile', 'proc execFileSync', 'proc fork', 'proc spawn', 'proc spawnSync'],
    },
  ];
  expect(report.subprocess_templates).toEqual(expected);
  expect(declaredReport.subprocess_templates).toEqual(expected);
});

it('keeps under-declaration findings separate from advisory-pattern violations', () => {
  expect(report.findings.length).toBeGreaterThan(0);
  expect(report.advisory_patterns).toEqual({ violations: 0, dispositions: [] });
  expect(report.metrics).toMatchObject({
    program_files: 1,
    catalog_actions: 29,
    extracted_actions: 29,
    unresolved_edges: 0,
  });
});
