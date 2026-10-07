// Invariants: INV-DEVAI-001
// #338 follow-up: task and round failures are schema-valid refusal envelopes that carry their own
// code. This drives the BUILT CLI as a subprocess against a bound fixture repository, so the
// action wrapper's --format json handling is exercised, and checks each code's reference row.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BIN = resolve(import.meta.dirname, '../../dist/runtime/index/bin.js');
const ROOT = resolve(import.meta.dirname, '../../../..');
let repo = '';

function run(args: readonly string[]): { exit: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 60_000,
  });
  return { exit: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function git(args: readonly string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=DEVAI Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd: repo, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

function referenceCell(code: string): string | undefined {
  const row = readFileSync(join(ROOT, 'docs/reference/error-codes.md'), 'utf8')
    .split('\n')
    .find((line) => line.startsWith(`| \`${code}\` |`));
  return row?.split('|').at(-2)?.trim();
}

/** The refusal envelope of one failed --format json invocation, checked against the schema. */
function refusal(result: { exit: number; stderr: string }): {
  code: string;
  class: string;
  exit: number;
  context?: Record<string, unknown>;
} {
  const envelope = JSON.parse(result.stderr) as {
    ok: boolean;
    error: { code: string; class: string; exit: number; context?: Record<string, unknown> };
  };
  expect(envelope.ok).toBe(false);
  expect(validators.error(envelope.error), result.stderr).toBe(true);
  expect(result.exit).toBe(envelope.error.exit);
  return envelope.error;
}

beforeAll(() => {
  expect(existsSync(BIN), 'run pnpm run build').toBe(true);
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'devai-task-round-refusals-')));
  git(['init', '--quiet']);
  git(['config', 'maintenance.auto', 'false']);
  git(['config', 'gc.auto', '0']);
  writeFileSync(join(repo, 'README.md'), '# task and round refusal fixture\n');
  git(['add', 'README.md']);
  git(['commit', '--quiet', '-m', 'test: seed task and round refusal fixture']);
  for (const segment of [
    ['--tier', 'tier1', '--constitution'],
    ['--operational-law'],
    ['--subprocess-effects'],
    [],
  ]) {
    const bound = run([
      'init',
      'bind',
      '--target',
      repo,
      ...segment,
      '--as-role',
      'architect',
      '--write',
    ]);
    expect(bound.exit, `init bind ${segment.join(' ')}: ${bound.stderr}`).toBe(0);
  }
}, 180_000);

afterAll(() => {
  if (repo !== '') rmSync(repo, { recursive: true, force: true });
});

describe('#338: task and round refusal envelopes through the built CLI', () => {
  it('refuses a task on an inactive round with its own code, class and exit', () => {
    const error = refusal(
      run(['task', 'status', '--round', 'R-9999', '--task', 'TASK-0001', '--format', 'json']),
    );
    expect(error).toMatchObject({
      code: 'TASK_ROUND_INACTIVE',
      class: 'precondition',
      exit: 5,
      context: { operation: 'status' },
    });
    expect(referenceCell(error.code)).toBe('precondition / 5');
  }, 60_000);

  it('refuses an unknown round record with its own code, class and exit', () => {
    const error = refusal(run(['round', 'status', '--round', 'R-9999', '--format', 'json']));
    expect(error).toMatchObject({
      code: 'ROUND_RECORD_NOT_FOUND',
      class: 'routing-authority',
      exit: 2,
      context: { operation: 'status' },
    });
    expect(referenceCell(error.code)).toBe('routing-authority / 2');
  }, 60_000);
});
