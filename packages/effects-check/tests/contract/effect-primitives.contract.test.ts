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
