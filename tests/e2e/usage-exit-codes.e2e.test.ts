import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { subprocessCoverageEnvironment } from '../helpers/subprocess-coverage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const BIN = join(
  HERE,
  '..',
  '..',
  'packages',
  'cli',
  'tests',
  'fixtures',
  'authorized-cli-test-driver.mjs',
);

const CLI_TIMEOUT_MS = 30_000;

function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env: subprocessCoverageEnvironment(),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Every usage failure exits 2 with a structured message and no stack.

const USAGE_CASES: ReadonlyArray<{
  label: string;
  actionId: string;
  args: readonly string[];
}> = [
  {
    label: 'round plan --blueprint plan (missing --file)',
    actionId: 'round plan',
    args: [
      'round',
      'plan',
      '--blueprint',
      'plan',
      '--round',
      'R-1234',
      '--repo-root',
      ROOT,
      '--as-role',
      'architect',
      '--write',
    ],
  },
  {
    label: 'round plan --blueprint diff (missing --file)',
    actionId: 'round plan',
    args: [
      'round',
      'plan',
      '--blueprint',
      'diff',
      '--round',
      'R-1234',
      '--repo-root',
      ROOT,
      '--as-role',
      'architect',
      '--write',
    ],
  },
  {
    label: 'check --only blueprint (missing --file)',
    actionId: 'check',
    args: [
      'check',
      '--only',
      'blueprint',
      '--repo-root',
      ROOT,
      '--as-role',
      'inspector',
      '--write',
    ],
  },
  {
    label: 'task start --with-db (missing --database-url)',
    actionId: 'task start',
    args: [
      'task',
      'start',
      '--round',
      'R-1234',
      '--task',
      'TASK-0042',
      '--with-db',
      '--repo-root',
      ROOT,
      '--as-role',
      'engineer',
      '--write',
    ],
  },
  {
    label: 'task finish --drop-db (missing --database-url)',
    actionId: 'task finish',
    args: [
      'task',
      'finish',
      '--round',
      'R-1234',
      '--task',
      'TASK-0042',
      '--drop-db',
      '--repo-root',
      ROOT,
      '--as-role',
      'engineer',
      '--write',
    ],
  },
];

describe('command-layer usage failures exit 2 without stack traces', () => {
  for (const c of USAGE_CASES) {
    it(
      c.label,
      () => {
        const r = run([...c.args, '--format', 'json']);
        const combined = r.stdout + r.stderr;
        expect(r.status, `${c.label}: usage failures exit 2`).toBe(2);
        expect(r.stdout, `${c.label}: failure output stays on stderr`).toBe('');
        expect(JSON.parse(r.stderr)).toMatchObject({
          schemaVersion: '1.0.0',
          action_id: c.actionId,
          ok: false,
          error: { exit: 2 },
        });
        expect(combined, `${c.label}: no raw stack trace`).not.toMatch(/^\s+at /m);
        expect(combined, `${c.label}: says what is missing or how to use it`).toMatch(
          /required|usage|missing/i,
        );
        expect(combined, `${c.label}: reaches usage rather than authority refusal`).not.toMatch(
          /AUTHORITY_/i,
        );
      },
      CLI_TIMEOUT_MS,
    );
  }

  it(
    'mutation help remains a non-authorizing read',
    () => {
      const r = run(['init', 'apply', 'owner', '--help']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Usage: devai init apply owner [options]');
      expect(r.stdout).toContain(
        'Apply the Owner-owned initialization projection with explicit write consent.',
      );
      expect(r.stdout).toContain('--as-role <role>');
      expect(r.stdout).toContain('--write');
      expect(r.stdout).not.toContain('<command>');
      expect(r.stdout + r.stderr).not.toMatch(/AUTHORITY_|required for this invocation/i);
    },
    CLI_TIMEOUT_MS,
  );
});

// Invariants: INV-DEVAI-001
