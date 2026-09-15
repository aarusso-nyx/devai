import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { coverageAggregate } from '../../src/commands/coverage/aggregate.js';

interface Options {
  readonly repoRoot: string;
  readonly in?: string;
  readonly out?: string;
  readonly perPackage?: boolean;
  readonly human?: boolean;
  readonly final?: boolean;
}

interface Capture {
  command(): Capture;
  option(): Capture;
  action(callback: (options: Options) => Promise<void>): Capture;
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
  }
}

const roots: string[] = [];
let invoke: (options: Options) => Promise<void>;
let originalExit: typeof process.exit;
let originalExitCode: typeof process.exitCode;
let originalStdout: typeof process.stdout.write;
let originalStderr: typeof process.stderr.write;

beforeAll(() => {
  const command: Capture = {
    command: () => command,
    option: () => command,
    action: (callback) => {
      invoke = callback;
      return command;
    },
  };
  coverageAggregate.register({ command: () => command } as unknown as CAC);
  originalExit = process.exit;
  originalExitCode = process.exitCode;
  originalStdout = process.stdout.write;
  originalStderr = process.stderr.write;
});

afterEach(() => {
  process.exit = originalExit;
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-coverage-aggregate-'));
  roots.push(value);
  return value;
}

function put(base: string, path: string, value: unknown): void {
  const target = join(base, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}

function counted(total: number, covered: number) {
  return {
    lines: { total, covered },
    branches: { total: total * 2, covered: covered * 2 },
    functions: { total: total + 1, covered: covered + 1 },
    statements: { total: total * 3, covered: covered * 3 },
  };
}

function finalCoverage(path: string, covered: number) {
  return {
    [path]: {
      path,
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
      fnMap: {},
      branchMap: {},
      s: { '0': covered },
      f: {},
      b: {},
    },
  };
}

async function run(options: Options): Promise<{ stdout: string; stderr: string; exit: number }> {
  let stdout = '';
  let stderr = '';
  let exit = 0;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  try {
    await withAuthorityHostTestScope(() => invoke(options));
  } catch (error) {
    if (error instanceof ExitSignal) exit = error.code;
    else throw error;
  } finally {
    exit = process.exitCode ?? exit;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  return { stdout, stderr, exit };
}

describe('coverage aggregate command boundaries', () => {
  it('combines valid summaries, preserves scopes, and skips malformed or excluded inputs', async () => {
    const repoRoot = root();
    put(repoRoot, 'results/packages/a/coverage/coverage-summary.json', {
      total: counted(10, 8),
    });
    put(repoRoot, 'results/packages/b/coverage/coverage-summary.json', {
      total: counted(5, 2),
    });
    put(repoRoot, 'results/packages/b/coverage/malformed/coverage-summary.json', '{');
    put(repoRoot, 'results/node_modules/ignored/coverage-summary.json', {
      total: counted(100, 100),
    });

    const result = await run({
      repoRoot,
      in: 'results',
      out: 'record/summary.json',
      perPackage: true,
    });

    expect(result).toMatchObject({ exit: 0, stderr: '' });
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      schemaVersion: '1.0.0',
      inputs: [
        'results/packages/a/coverage/coverage-summary.json',
        'results/packages/b/coverage/coverage-summary.json',
        'results/packages/b/coverage/malformed/coverage-summary.json',
      ],
      counts: {
        lines: { total: 15, covered: 10 },
        branches: { total: 30, covered: 20 },
        functions: { total: 17, covered: 12 },
        statements: { total: 45, covered: 30 },
      },
      total: {
        lines: (10 / 15) * 100,
        branches: (20 / 30) * 100,
        functions: (12 / 17) * 100,
        statements: (30 / 45) * 100,
      },
      scopes: {
        'results/packages/a': { lines: 80 },
        'results/packages/b': { lines: 40 },
      },
    });
    expect(JSON.parse(readFileSync(join(repoRoot, 'record/summary.json'), 'utf8'))).toEqual(output);
  });

  it('reports an empty default input in human form with zero-safe percentages', async () => {
    const repoRoot = root();
    const result = await run({ repoRoot, human: true });

    expect(result).toEqual({
      exit: 0,
      stderr: '',
      stdout:
        'devai evidence coverage aggregate: 0 summary file(s) → .devai/state/coverage/summary.json\n' +
        '  lines 0.0%  branches 0.0%  functions 0.0%  statements 0.0%\n',
    });
  });

  it('merges final-mode file coverage and reports the exact composite', async () => {
    const repoRoot = root();
    put(repoRoot, 'input/a/coverage/coverage-final.json', finalCoverage('/src/a.ts', 1));
    put(repoRoot, 'input/b/coverage/coverage-final.json', finalCoverage('/src/b.ts', 0));
    put(repoRoot, 'input/b/coverage/bad/coverage-final.json', '{');

    const result = await run({
      repoRoot,
      in: 'input',
      out: 'merged/coverage-final.json',
      final: true,
    });

    expect(result).toMatchObject({ exit: 0, stderr: '' });
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      schemaVersion: '1.0.0',
      mode: 'final',
      files: 2,
      out: 'merged/coverage-final.json',
      summary: { statements: { total: 2, covered: 1, pct: 50 } },
    });
    expect(
      Object.keys(JSON.parse(readFileSync(join(repoRoot, 'merged/coverage-final.json'), 'utf8'))),
    ).toEqual(['/src/a.ts', '/src/b.ts']);
  });

  it('fails closed when the output target cannot be written', async () => {
    const repoRoot = root();
    mkdirSync(join(repoRoot, 'occupied'));
    const result = await run({ repoRoot, out: 'occupied' });

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^devai evidence coverage aggregate: /u);
  });
});
