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

// ADR-AUT-0006 (#381): `pnpm -r typecheck` prefixes each package's output with
// `<package dir> typecheck: `, so the parser reads the diagnostic behind that prefix and never
// takes the prefix for part of the file path.
describe('type-check diagnostics behind the pnpm -r prefix (ADR-AUT-0006 IA-001)', () => {
  it('runs the declared argv exactly and parses every prefixed diagnostic', () => {
    runCommand.mockReturnValue({
      stdout:
        'Scope: 2 of 3 workspace projects\n' +
        "packages/x typecheck: a.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
        'packages/y typecheck: src/b.ts(10,20): error TS7006: Parameter implicitly has an any type.\n' +
        'packages/x typecheck: Failed\n',
      stderr: ' ELIFECYCLE  Command failed with exit code 2.\n',
      exit_code: 2,
      duration_ms: 40,
      killed: false,
    } satisfies RunResult);

    const result = senseTypeCheck({ cwd: root, argv: ['pnpm', '-r', 'typecheck'] });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0]?.[0]).toEqual(['pnpm', '-r', 'typecheck']);
    expect(result.perProject).toEqual([]);
    expect(result.aggregate).toMatchObject({
      status: 'fail',
      exit_code: 2,
      metrics: { error_count: 2 },
    });
    const findings = result.aggregate.findings ?? [];
    expect(findings.map(({ code, line, message }) => ({ code, line, message }))).toEqual([
      { code: 'TS2322', line: 1, message: "Type 'string' is not assignable to type 'number'." },
      { code: 'TS7006', line: 10, message: 'Parameter implicitly has an any type.' },
    ]);
    const files = findings.map((finding) => String(finding.file));
    expect(files[0]).toMatch(/(?:^|\/)a\.ts$/u);
    expect(files[1]).toMatch(/(?:^|\/)src\/b\.ts$/u);
    for (const file of files) {
      expect(file).not.toContain('typecheck:');
      expect(file).not.toContain(' ');
    }
  });

  it('keeps reading unprefixed tsc diagnostics the same way', () => {
    runCommand.mockReturnValue(failedTsc);
    const result = senseTypeCheck({ cwd: root, argv: ['npx', 'tsc', '--noEmit'] });
    expect(result.aggregate.findings?.map((finding) => finding.file)).toEqual([
      'src/example.ts',
      'src/example.ts',
    ]);
  });
});

// #386 review: stripping the pnpm -r prefix never costs a plain tsc diagnostic whose file name
// holds a space, and a prefixed diagnostic still parses.
describe('type-check diagnostics with spaces and prefixes (#386)', () => {
  const run = (stdout: string, argv: readonly string[]) => {
    runCommand.mockReturnValue({
      stdout,
      stderr: '',
      exit_code: 2,
      duration_ms: 5,
      killed: false,
    } satisfies RunResult);
    return senseTypeCheck({ cwd: root, argv }).aggregate.findings ?? [];
  };

  it('reads a plain tsc diagnostic for a file name with a space', () => {
    const findings = run(
      "src/my file.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.\n",
      ['npx', 'tsc', '--noEmit'],
    );
    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'TS2322',
        file: 'src/my file.ts',
        line: 1,
        message: "Type 'string' is not assignable to type 'number'.",
      }),
    ]);
  });

  it('reads a spaced file name from the default tsc run too', () => {
    runCommand.mockReturnValue({
      stdout: 'lib/a b/c d.ts(3,4): error TS7006: Parameter implicitly has an any type.\n',
      stderr: '',
      exit_code: 2,
      duration_ms: 5,
      killed: false,
    } satisfies RunResult);
    const findings = senseTypeCheck({ cwd: root }).aggregate.findings ?? [];
    expect(findings.map(({ file, line, code }) => ({ file, line, code }))).toEqual([
      { file: 'lib/a b/c d.ts', line: 3, code: 'TS7006' },
    ]);
  });

  it('still parses a pnpm-prefixed diagnostic', () => {
    const findings = run('packages/x typecheck: src/a.ts(1,2): error TS2322: Type mismatch.\n', [
      'pnpm',
      '-r',
      'typecheck',
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'TS2322', line: 1, message: 'Type mismatch.' });
    expect(String(findings[0]?.file)).toMatch(/(?:^|\/)src\/a\.ts$/u);
    expect(String(findings[0]?.file)).not.toContain('typecheck:');
  });
});
