import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

const ciLocalOnly = vi.hoisted(() => ({
  enabled: false,
  errors: [] as string[],
  violations: [] as string[],
  forbiddenScripts: [] as string[],
}));

vi.mock('../../src/commands/check/ci-local-only.js', () => ({
  inspectRemoteLocalOnlyNodes: vi.fn(() => ciLocalOnly),
}));

import {
  checkCiEconomy,
  checkCiEconomyCmd,
  cronIsDailyOrMore,
  parseTriggers,
  readCiEconomyProfile,
} from '../../src/commands/check/ci-economy.js';
import { coverageAggregate } from '../../src/commands/coverage/aggregate.js';
import { triageClassify } from '../../src/commands/triage/classify.js';

const roots: string[] = [];

interface CoverageOptions {
  readonly repoRoot: string;
  readonly in?: string;
  readonly out?: string;
  readonly perPackage?: boolean;
  readonly human?: boolean;
  readonly final?: boolean;
}

interface TriageOptions {
  readonly input?: string;
  readonly repoRoot?: string;
  readonly task?: string;
  readonly round?: string;
  readonly human?: boolean;
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
  }
}

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function put(root: string, path: string, value: unknown): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function workflow(root: string, name: string, text: string, directory = '.github/workflows'): void {
  put(root, join(directory, name), text);
}

function project(root: string, value: unknown): void {
  put(root, '.devai/config/project.json', value);
}

function finding(report: ReturnType<typeof checkCiEconomy>, ruleId: string) {
  const result = report.findings.find((entry) => entry.ruleId === ruleId);
  expect(result, `missing ${ruleId}`).toBeDefined();
  return result;
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

let coverageAction: ((options: CoverageOptions) => Promise<void>) | undefined;
let triageAction: ((options: TriageOptions) => void) | undefined;

beforeAll(() => {
  const coverageChain = {
    command: () => coverageChain,
    option: () => coverageChain,
    action: (callback: typeof coverageAction) => {
      coverageAction = callback;
      return coverageChain;
    },
  };
  coverageAggregate.register({ command: () => coverageChain } as unknown as CAC);

  const triageChain = {
    command: () => triageChain,
    option: () => triageChain,
    action: (callback: typeof triageAction) => {
      triageAction = callback;
      return triageChain;
    },
  };
  triageClassify.register({ command: () => triageChain } as unknown as CAC);
});

beforeEach(() => {
  ciLocalOnly.enabled = false;
  ciLocalOnly.errors = [];
  ciLocalOnly.violations = [];
  ciLocalOnly.forbiddenScripts = [];
});

afterEach(() => {
  process.exitCode = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('S06-C CI economy public result seam', () => {
  it('keeps trigger parsing exact at inline, block, comment, and nested-key boundaries', () => {
    expect([...parseTriggers('on: [push, pull_request] # comment')]).toEqual([
      'push',
      'pull_request',
    ]);
    expect([...parseTriggers('on: [push\nname: unrelated')]).toEqual(['push']);
    expect([
      ...parseTriggers(
        'on:\n  pull_request:\n    paths:\n      - src/**\n  workflow_dispatch:\n# not a trigger\nname: x',
      ),
    ]).toEqual(['pull_request', 'workflow_dispatch']);
    expect([...parseTriggers('prefix on: push')]).toEqual([]);
    expect([
      ...parseTriggers(
        'on:\n  push:\n    branches:\n      - main\n  schedule:\n    - cron: "0 0 * * *"\nname: x',
      ),
    ]).toEqual(['push', 'schedule']);
  });

  it('classifies only five-field daily cron schedules', () => {
    expect(cronIsDailyOrMore('0 0 * * *')).toBe(true);
    expect(cronIsDailyOrMore('*/10 * * * *')).toBe(true);
    expect(cronIsDailyOrMore('0 0 1 * *')).toBe(false);
    expect(cronIsDailyOrMore('0 0 * * 1')).toBe(false);
    expect(cronIsDailyOrMore('0 0 * *')).toBe(false);
    expect(cronIsDailyOrMore('0 0 * * * extra')).toBe(false);
  });

  it('returns an exact strict report when no workflow exists', () => {
    const root = temporary('devai-s06c-ci-empty-');
    expect(checkCiEconomy({ repoRoot: root })).toEqual({
      verdict: 'fail',
      rules_checked: 4,
      workflows_scanned: 0,
      ci_economy_profile: 'full',
      findings: [
        {
          ruleId: 'ci-economy.concurrency-cancel',
          severity: 'pass',
          message: 'every pull_request-triggered workflow cancels superseded pull-request runs',
        },
        {
          ruleId: 'ci-economy.no-macos-on-pr',
          severity: 'pass',
          message: 'no macOS runner reference in any pull_request-triggered workflow',
        },
        {
          ruleId: 'ci-economy.no-triple-trigger',
          severity: 'pass',
          message: 'no workflow is triggered by all of pull_request + push + schedule',
        },
        {
          ruleId: 'ci-economy.evidence-gate-wired',
          severity: 'fail',
          message: 'no workflow files found under .github/workflows',
          remediation:
            'Add the single ledger-verification workflow with a protected verifier-provenance SHA-256 and runner-temp execution boundary. Incremental adopters may declare ci_economy.profile: "gate-staged" until that verifier is wired.',
        },
      ],
      fail_count: 1,
      warn_count: 0,
    });
  });

  it('reports every hard and advisory finding with exact locations and severity', () => {
    const root = temporary('devai-s06c-ci-risk-');
    workflow(
      root,
      'risk.yml',
      `on: [pull_request, push, schedule]\njobs:\n  test:\n    runs-on: macos-14\n    services:\n      db:\n        image: postgres:16\nschedule:\n  - cron: '0 0 * * *'\n`,
    );
    workflow(root, 'cost.yaml', 'on: workflow_dispatch\njobs:\n  test:\n    runs-on: macos-13\n');
    const report = checkCiEconomy({ repoRoot: root });
    expect(report.verdict).toBe('fail');
    expect(report.fail_count).toBe(4);
    expect(report.warn_count).toBe(4);
    expect(report.findings.map((entry) => [entry.ruleId, entry.severity])).toEqual([
      ['ci-economy.concurrency-cancel', 'fail'],
      ['ci-economy.no-macos-on-pr', 'fail'],
      ['ci-economy.no-triple-trigger', 'fail'],
      ['ci-economy.evidence-gate-wired', 'fail'],
      ['ci-economy.path-filters', 'warn'],
      ['ci-economy.cron-cadence', 'warn'],
      ['ci-economy.macos-cost', 'warn'],
      ['ci-economy.db-isolation', 'warn'],
    ]);
    expect(finding(report, 'ci-economy.concurrency-cancel')?.locations).toEqual(['risk.yml']);
    expect(finding(report, 'ci-economy.no-macos-on-pr')?.locations).toEqual(['risk.yml']);
    expect(finding(report, 'ci-economy.no-triple-trigger')?.locations).toEqual(['risk.yml']);
    expect(finding(report, 'ci-economy.path-filters')?.locations).toEqual(['risk.yml']);
    expect(finding(report, 'ci-economy.cron-cadence')?.locations).toEqual(['risk.yml']);
    expect(finding(report, 'ci-economy.macos-cost')?.locations).toEqual(['cost.yaml']);
    expect(finding(report, 'ci-economy.db-isolation')?.locations).toEqual(['risk.yml']);
  });

  it('keeps gate-staged evidence advisory while preserving the reported rule', () => {
    const root = temporary('devai-s06c-ci-staged-');
    project(root, { ci_economy: { profile: 'gate-staged' } });
    const report = checkCiEconomy({ repoRoot: root });
    expect(report).toEqual({
      verdict: 'warn',
      rules_checked: 4,
      workflows_scanned: 0,
      ci_economy_profile: 'gate-staged',
      findings: [
        {
          ruleId: 'ci-economy.concurrency-cancel',
          severity: 'pass',
          message: 'every pull_request-triggered workflow cancels superseded pull-request runs',
        },
        {
          ruleId: 'ci-economy.no-macos-on-pr',
          severity: 'pass',
          message: 'no macOS runner reference in any pull_request-triggered workflow',
        },
        {
          ruleId: 'ci-economy.no-triple-trigger',
          severity: 'pass',
          message: 'no workflow is triggered by all of pull_request + push + schedule',
        },
        {
          ruleId: 'ci-economy.evidence-gate-wired',
          severity: 'warn',
          message:
            'no workflow files found under .github/workflows — ADVISORY, not FAIL: ci_economy.profile = "gate-staged" declared in .devai/config/project.json',
          remediation:
            'Wire the protected verifier-provenance SHA-256, runner-temp copy, and packaged verifier invocation, then graduate ci_economy.profile to "full".',
        },
      ],
      fail_count: 0,
      warn_count: 1,
    });
  });

  it('defaults malformed and unknown profile declarations to full', () => {
    const missing = temporary('devai-s06c-profile-missing-');
    expect(readCiEconomyProfile(missing)).toBe('full');
    const malformed = temporary('devai-s06c-profile-malformed-');
    put(malformed, '.devai/config/project.json', '{');
    expect(readCiEconomyProfile(malformed)).toBe('full');
    const unknown = temporary('devai-s06c-profile-unknown-');
    project(unknown, { ci_economy: { profile: 'advisory' } });
    expect(readCiEconomyProfile(unknown)).toBe('full');
  });

  it('emits exact human and machine command results with hard-rule exit codes', () => {
    let action:
      | ((options: { repoRoot?: string; workflowsDir?: string; human?: boolean }) => void)
      | undefined;
    const chain = {
      option: () => chain,
      action: (callback: typeof action) => {
        action = callback;
        return chain;
      },
    };
    const cli = { command: vi.fn(() => chain) } as unknown as CAC;
    checkCiEconomyCmd.register(cli);
    expect(cli.command).toHaveBeenCalledWith(
      'check-ci-economy',
      'Validate the documented CI-economy rules',
    );
    if (action === undefined) throw new Error('CI-economy action was not registered');

    const root = temporary('devai-s06c-ci-command-');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    try {
      action({ repoRoot: root, human: true });
      expect(output).toHaveBeenLastCalledWith(
        expect.stringContaining('check ci-economy: FAIL (0 workflow(s), 4 mechanical rules'),
      );
      expect(process.exitCode).toBe(2);
      action({ repoRoot: root });
      expect(String(output.mock.calls.at(-1)?.[0])).toBe(
        `${JSON.stringify(checkCiEconomy({ repoRoot: root }))}\n`,
      );
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = previousExitCode;
      output.mockRestore();
    }
  });
});

async function runCoverage(
  options: CoverageOptions,
): Promise<{ stdout: string; stderr: string; exit: number }> {
  if (coverageAction === undefined) throw new Error('coverage aggregate action was not registered');
  let stdout = '';
  let stderr = '';
  let exit = 0;
  process.exitCode = undefined;
  const previousExit = process.exit;
  const previousStdout = process.stdout.write;
  const previousStderr = process.stderr.write;
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
    await withAuthorityHostTestScope(() => coverageAction?.(options));
  } catch (error) {
    if (error instanceof ExitSignal) exit = error.code;
    else throw error;
  } finally {
    exit = process.exitCode ?? exit;
    process.exit = previousExit;
    process.stdout.write = previousStdout;
    process.stderr.write = previousStderr;
  }
  return { stdout, stderr, exit };
}

describe('S06-C coverage aggregate public result seam', () => {
  it('aggregates exact counts and scopes while filtering excluded directories', async () => {
    const root = temporary('devai-s06c-coverage-');
    put(root, 'input/packages/a/coverage/coverage-summary.json', { total: counted(10, 8) });
    put(root, 'input/packages/b/coverage/coverage-summary.json', { total: counted(5, 2) });
    put(root, 'input/packages/b/coverage/bad/coverage-summary.json', '{');
    put(root, 'input/node_modules/ignored/coverage-summary.json', { total: counted(100, 100) });
    put(root, 'input/dist/ignored/coverage-summary.json', { total: counted(100, 100) });
    const result = await runCoverage({
      repoRoot: root,
      in: 'input',
      out: 'out/summary.json',
      perPackage: true,
    });
    expect(result).toMatchObject({ exit: 0, stderr: '' });
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      schemaVersion: '1.0.0',
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
        'input/packages/a': { lines: 80 },
        'input/packages/b': { lines: 40 },
      },
    });
    expect((output.inputs as string[]).sort()).toEqual([
      'input/packages/a/coverage/coverage-summary.json',
      'input/packages/b/coverage/bad/coverage-summary.json',
      'input/packages/b/coverage/coverage-summary.json',
    ]);
    expect(JSON.parse(readFileSync(join(root, 'out/summary.json'), 'utf8'))).toEqual(output);
  });

  it('keeps zero-safe default human output exact', async () => {
    const root = temporary('devai-s06c-coverage-empty-');
    await expect(runCoverage({ repoRoot: root, human: true })).resolves.toEqual({
      exit: 0,
      stderr: '',
      stdout:
        'devai evidence coverage aggregate: 0 summary file(s) → .devai/state/coverage/summary.json\n' +
        '  lines 0.0%  branches 0.0%  functions 0.0%  statements 0.0%\n',
    });
  });

  it('emits exact final-mode summary and human banner for merged file coverage', async () => {
    const root = temporary('devai-s06c-coverage-final-');
    put(root, 'input/a/coverage/coverage-final.json', finalCoverage('/src/a.ts', 1));
    put(root, 'input/b/coverage/coverage-final.json', finalCoverage('/src/b.ts', 0));
    const result = await runCoverage({
      repoRoot: root,
      in: 'input',
      out: 'merged/coverage-final.json',
      final: true,
      human: true,
    });
    expect(result).toEqual({
      exit: 0,
      stderr: '',
      stdout:
        'devai evidence coverage aggregate (--final): 2 coverage-final.json file(s) → merged/coverage-final.json\n' +
        '  lines 50.0%  branches 100.0%  functions 100.0%  statements 50.0%\n',
    });
    expect(
      Object.keys(JSON.parse(readFileSync(join(root, 'merged/coverage-final.json'), 'utf8'))),
    ).toEqual(['/src/a.ts', '/src/b.ts']);
  });
});

function reading(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: 'SR-89f7974460e256a3',
    sensor: { name: 'unit_test', kind: 'unit_test' },
    timestamp: '2026-08-27T12:00:00.000Z',
    status: 'fail',
    deterministic: true,
    command: 'pnpm run test',
    command_hash: 'c'.repeat(64),
    ...overrides,
  };
}

function runTriage(options: TriageOptions): { stdout: string; stderr: string; exit: number } {
  if (triageAction === undefined) throw new Error('triage classify action was not registered');
  let stdout = '';
  let stderr = '';
  let exit = 0;
  process.exitCode = undefined;
  const previousExit = process.exit;
  const previousStdout = process.stdout.write;
  const previousStderr = process.stderr.write;
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
    withAuthorityHostTestScope(() => triageAction?.(options));
  } catch (error) {
    if (error instanceof ExitSignal) exit = error.code;
    else throw error;
  } finally {
    exit = process.exitCode ?? exit;
    process.exit = previousExit;
    process.stdout.write = previousStdout;
    process.stderr.write = previousStderr;
  }
  return { stdout, stderr, exit };
}

describe('S06-C triage classify public result seam', () => {
  it('refuses missing input, malformed task, and repository escape with usage results', () => {
    const root = temporary('devai-s06c-triage-usage-');
    expect(runTriage({ repoRoot: root })).toEqual({
      stdout: '',
      stderr: 'devai triage classify: --input is required\n',
      exit: 2,
    });
    expect(runTriage({ repoRoot: root, input: 'reading.json', task: 'TASK-x' })).toEqual({
      stdout: '',
      stderr: 'devai triage classify: --task must match TASK-N\n',
      exit: 2,
    });
    expect(runTriage({ repoRoot: root, input: '../outside.json' })).toEqual({
      stdout: '',
      stderr: 'devai triage classify: input path escapes repository\n',
      exit: 2,
    });
  });

  it('returns a schema error for invalid sensor readings and exact machine verdict fields for valid input', () => {
    const invalid = temporary('devai-s06c-triage-invalid-');
    put(invalid, 'reading.json', { status: 'fail' });
    expect(runTriage({ repoRoot: invalid, input: 'reading.json' })).toMatchObject({
      stdout: '',
      exit: 2,
    });
    expect(runTriage({ repoRoot: invalid, input: 'reading.json' }).stderr).toMatch(
      /^devai triage classify: SENSOR_READING_INVALID:/u,
    );

    const root = temporary('devai-s06c-triage-valid-');
    put(
      root,
      'reading.json',
      reading({ findings: [{ severity: 'error', code: 'E', message: 'broken' }] }),
    );
    const result = runTriage({ repoRoot: root, input: 'reading.json', task: 'TASK-7' });
    expect(result.stderr).toBe('');
    expect(result.exit).toBe(0);
    const output = JSON.parse(result.stdout) as {
      verdict: { subject_evidence_ref: string; subject_task_id: string; classification: string };
      artifact: { path: string; kind: string; sha256: string };
      evidence_ref: string;
    };
    expect(output).toMatchObject({
      verdict: {
        schemaVersion: '1.0.0',
        subject_evidence_ref: 'EV-89f7974460e256a3',
        subject_task_id: 'TASK-7',
        classification: 'plant_bug',
        confidence: { score: 0.45, method: 'rule-based-mvp' },
        recommended_route: { discipline: 'engineer', action: 'feedback_iteration' },
      },
      artifact: {
        path: expect.stringMatching(/^\.devai\/state\/triage\/TRG-[0-9a-f]{16}\.json$/u),
        kind: 'triage',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      evidence_ref: expect.any(String),
    });
    expect(JSON.parse(readFileSync(join(root, output.artifact.path), 'utf8'))).toEqual(
      output.verdict,
    );
  });

  it('renders the exact human route and fails closed on replay drift', () => {
    const root = temporary('devai-s06c-triage-human-');
    put(root, 'reading.json', reading());
    expect(runTriage({ repoRoot: root, input: 'reading.json', human: true })).toEqual({
      stdout: 'triage classify: inconclusive → escalate_to_human\n',
      stderr: '',
      exit: 0,
    });
    const [triageFile] = readdirSync(join(root, '.devai/state/triage'));
    if (triageFile === undefined) throw new Error('triage artifact was not written');
    put(root, join('.devai/state/triage', triageFile), 'drift\n');
    const result = runTriage({ repoRoot: root, input: 'reading.json' });
    expect(result).toMatchObject({
      stdout: '',
      exit: 2,
    });
    expect(result.stderr).toMatch(/^devai triage classify: TRIAGE_REPLAY_DRIFT\n$/u);
  });
});
