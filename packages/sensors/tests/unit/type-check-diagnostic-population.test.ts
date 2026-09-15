import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../src/run-command.js';

const runCommand = vi.hoisted(() => vi.fn());
vi.mock('../../src/run-command.js', () => ({ runCommand }));

import { senseTypeCheck } from '../../src/type-check.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-type-check-diagnostics-'));
  runCommand.mockReset();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const failedTsc: RunResult = {
  stdout:
    "src/example.ts(12,34): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
    'src/example.ts(123,456): error TS7006: Parameter implicitly has an any type.\n',
  stderr: 'tsc reported errors\n',
  exit_code: 2,
  duration_ms: 31,
  killed: false,
};

describe('type-check diagnostic population', () => {
  it('parses multi-digit compiler diagnostics and preserves failure metadata', () => {
    runCommand.mockReturnValue(failedTsc);

    const result = senseTypeCheck({ cwd: root, timeoutMs: 7_500 });

    expect(runCommand).toHaveBeenCalledWith(['npx', 'tsc', '--noEmit'], {
      cwd: root,
      timeoutMs: 7_500,
    });
    expect(result.perProject).toEqual([]);
    expect(result.aggregate).toMatchObject({
      status: 'fail',
      command: 'npx tsc --noEmit',
      exit_code: 2,
      duration_ms: 31,
      out_head: failedTsc.stdout,
      err_head: failedTsc.stderr,
      killed: false,
      metrics: { error_count: 2 },
    });
    expect(result.aggregate.findings).toEqual([
      {
        severity: 'error',
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
        file: 'src/example.ts',
        line: 12,
      },
      {
        severity: 'error',
        code: 'TS7006',
        message: 'Parameter implicitly has an any type.',
        file: 'src/example.ts',
        line: 123,
      },
    ]);
  });

  it('keeps explicit root strategy from discovering per-package projects', () => {
    mkdirSync(join(root, 'packages/demo'), { recursive: true });
    writeFileSync(join(root, 'packages/demo/tsconfig.json'), '{}');
    runCommand.mockReturnValue({
      stdout: '',
      stderr: '',
      exit_code: 0,
      duration_ms: 5,
      killed: false,
    } satisfies RunResult);

    const result = senseTypeCheck({ cwd: root, strategy: 'root' });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(['npx', 'tsc', '--noEmit'], {
      cwd: root,
      timeoutMs: 120_000,
    });
    expect(result.perProject).toEqual([]);
    expect(result.aggregate.status).toBe('pass');
    expect(result.aggregate.metrics).toMatchObject({ error_count: 0 });
  });

  it('discovers one project under each default per-package scan directory', () => {
    const scanDirs = ['packages', 'apps', 'reference', 'domain', 'tools'];
    for (const dir of scanDirs) {
      mkdirSync(join(root, dir, 'demo'), { recursive: true });
      writeFileSync(join(root, dir, 'demo', 'tsconfig.json'), '{}');
    }
    runCommand.mockReturnValue({
      stdout: '',
      stderr: '',
      exit_code: 0,
      duration_ms: 5,
      killed: false,
    } satisfies RunResult);

    const result = senseTypeCheck({ cwd: root, strategy: 'per-package' });

    expect(runCommand).toHaveBeenCalledTimes(5);
    expect(result.perProject).toHaveLength(5);
    expect(result.perProject.map((reading) => reading.metrics?.project)).toEqual(
      scanDirs.map((dir) => `${dir}/demo`),
    );
    expect(result.aggregate).toMatchObject({
      status: 'pass',
      metrics: {
        projects_total: 5,
        projects_passed: 5,
        projects_failed: 0,
        error_count_total: 0,
        project_paths: 'packages/demo,apps/demo,reference/demo,domain/demo,tools/demo',
      },
    });
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['npx', 'tsc', '--noEmit', '-p', join(root, 'packages/demo/tsconfig.json')],
      { cwd: root, timeoutMs: 120_000 },
    );
  });
});
