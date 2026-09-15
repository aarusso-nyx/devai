import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

const controls = vi.hoisted(() => {
  const sensorReading = vi.fn(() => true) as ReturnType<typeof vi.fn> & {
    errors?: readonly unknown[];
  };
  const triageVerdict = vi.fn(() => true) as ReturnType<typeof vi.fn> & {
    errors?: readonly unknown[];
  };
  return {
    append: vi.fn<(...args: unknown[]) => { ok: boolean; id?: string; error?: string }>(() => ({
      ok: true,
      id: 'EV-NEW',
    })),
    classify: vi.fn((..._args: unknown[]) => ({
      schemaVersion: '1.0.0',
      id: 'TRG-0123456789abcdef',
      subject_evidence_ref: 'EV-89f7974460e256a3',
      classification: 'plant_bug',
      confidence: { score: 0.45, method: 'rule-based-mvp' },
      recommended_route: { discipline: 'engineer', action: 'feedback_iteration' } as {
        discipline: string;
        action?: string;
      },
    })),
    declaredRole: vi.fn<() => string | undefined>(() => 'inspector'),
    load: vi.fn((..._args: unknown[]) => ({ records: [] as unknown[] })),
    sensorReading,
    track: vi.fn(),
    triageVerdict,
    localOnly: {
      enabled: false,
      errors: [] as string[],
      violations: [] as string[],
      forbiddenScripts: [] as string[],
    },
  };
});

vi.mock('#runtime-core', () => ({
  appendVerbEvidence: (...args: unknown[]) => controls.append(...args),
  loadChain: (...args: unknown[]) => controls.load(...args),
}));

vi.mock('@devai-nyx/loop', () => ({
  classifyFailure: (...args: unknown[]) => controls.classify(...args),
  trackGovernanceEvent: (...args: unknown[]) => controls.track(...args),
}));

vi.mock('@devai-nyx/schemas', () => ({
  validators: { sensorReading: controls.sensorReading },
  getValidator: vi.fn(() => controls.triageVerdict),
}));

vi.mock('../../src/authority/index.js', () => ({
  declaredInvocationRole: () => controls.declaredRole(),
}));

vi.mock('../../src/commands/check/ci-local-only.js', () => ({
  inspectRemoteLocalOnlyNodes: vi.fn(() => controls.localOnly),
}));

import {
  checkCiEconomy,
  checkCiEconomyCmd,
  parseTriggers,
} from '../../src/commands/check/ci-economy.js';
import { coverageAggregate } from '../../src/commands/coverage/aggregate.js';
import { triageClassify } from '../../src/commands/triage/classify.js';

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

const roots: string[] = [];

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

function reading(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: 'SR-89f7974460e256a3',
    sensor: { name: 'unit_test', kind: 'unit_test' },
    timestamp: '2026-08-27T12:00:00.000Z',
    status: 'fail',
    deterministic: true,
    command: 'pnpm run test',
    command_hash: 'c'.repeat(64),
  };
}

function captureRegistration(command: { register(cli: CAC): void }) {
  const options: [string, string][] = [];
  let action: ((options: never) => unknown) | undefined;
  const chain = {
    option: (flag: string, description: string) => {
      options.push([flag, description]);
      return chain;
    },
    action: (callback: (options: never) => unknown) => {
      action = callback;
      return chain;
    },
  };
  const invoke = vi.fn(() => chain);
  command.register({ command: invoke } as unknown as CAC);
  return { invoke, options, action };
}

beforeEach(() => {
  controls.append.mockReset().mockReturnValue({ ok: true, id: 'EV-NEW' });
  controls.classify.mockClear();
  controls.declaredRole.mockReset().mockReturnValue('inspector');
  controls.load.mockReset().mockReturnValue({ records: [] });
  controls.sensorReading.mockReset().mockReturnValue(true);
  controls.sensorReading.errors = undefined;
  controls.track.mockClear();
  controls.triageVerdict.mockReset().mockReturnValue(true);
  controls.triageVerdict.errors = undefined;
  controls.localOnly.enabled = false;
  controls.localOnly.errors = [];
  controls.localOnly.violations = [];
  controls.localOnly.forbiddenScripts = [];
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('S06-C residual command registration', () => {
  it('exposes exact command metadata', () => {
    expect(coverageAggregate).toMatchObject({
      name: 'coverage aggregate',
      description:
        'Aggregate per-package Istanbul coverage-summary.json files into one composite summary feeding `render matrix` and `score compute`. Example: `devai evidence coverage aggregate --in coverage --out .devai/state/coverage/summary.json --per-package`.',
      authority: 'mesh_controller',
    });
    expect(triageClassify).toMatchObject({
      name: 'triage classify',
      description:
        'Deterministically classify one SensorReading and record the verdict; inconclusive always escalates to a human.',
      authority: 'mesh_controller',
    });
    expect(checkCiEconomyCmd).toMatchObject({
      name: 'check ci-economy',
      description:
        'Validate .github/workflows/ against the cheap remote ledger-verification contract: cancel-in-progress concurrency on PR workflows, no macOS on pull_request, no pull_request+push+schedule triple triggers, and a protected provenance-bound DEVAI package verifier. Rules 1-3 always hard-fail; rule 4 is hard under the default "full" profile and advisory under an explicit "gate-staged" profile. Path-filter, cron, macOS-cost, and DB-isolation findings remain advisory.',
      authority: 'policy_firewall',
    });
  });

  it('binds every coverage option and description exactly', () => {
    const registration = captureRegistration(coverageAggregate);
    expect(registration.invoke).toHaveBeenCalledWith(
      'coverage-aggregate',
      'Aggregate per-package Istanbul coverage summaries into a composite',
    );
    expect(registration.options).toEqual([
      ['--repo-root <path>', 'Repo root (default: cwd)'],
      [
        '--in <dir>',
        'Root dir to search for coverage-summary.json / coverage-final.json (default: coverage)',
      ],
      ['--out <path>', 'Output composite path (default: .devai/state/coverage/summary.json)'],
      ['--per-package', 'Include per-scope breakdown under `scopes` in the output (default: off)'],
      [
        '--final',
        'STYNX-parity mode: walk for coverage-final.json (per-file raw counters) and emit a merged istanbul-shape coverage-final.json. Input + output shape change.',
      ],
      ['--human', 'Human-readable banner; otherwise the composite JSON goes to stdout'],
    ]);
    expect(registration.action).toBeTypeOf('function');
  });

  it('binds every CI-economy option and description exactly', () => {
    const registration = captureRegistration(checkCiEconomyCmd);
    expect(registration.invoke).toHaveBeenCalledWith(
      'check-ci-economy',
      'Validate the documented CI-economy rules',
    );
    expect(registration.options).toEqual([
      ['--repo-root <path>', 'Repo root (default: .)'],
      [
        '--workflows-dir <path>',
        'Workflows directory relative to repo root (default: .github/workflows)',
      ],
      ['--human', 'Human-readable output'],
    ]);
    expect(registration.action).toBeTypeOf('function');
  });

  it('binds every triage option and description exactly', () => {
    const registration = captureRegistration(triageClassify);
    expect(registration.invoke).toHaveBeenCalledWith(
      'triage-classify',
      'Classify one schema-valid SensorReading',
    );
    expect(registration.options).toEqual([
      ['--input <path>', 'SensorReading JSON path relative to the repository'],
      ['--repo-root <path>', 'Repository root (default: cwd)'],
      ['--task <task-id>', 'Optional TASK-N identity'],
      [
        '--round <round_id>',
        'Optional governed round to attribute this classification to for tracking',
      ],
      ['--human', 'Human-readable output'],
    ]);
    expect(registration.action).toBeTypeOf('function');
  });
});

describe('S06-C residual CI parsing and fact boundaries', () => {
  it('rejects bracket, quote, nesting, and block-boundary near misses', () => {
    expect([...parseTriggers('on: [push], pull_request]')]).toEqual(['push]', 'pull_request']);
    expect([...parseTriggers("on: ['push', pull_request\"]")]).toEqual(['push', 'pull_request']);
    expect([...parseTriggers('on:\n  push:\n   pull_request:\n  schedule:\nname: x')]).toEqual([
      'push',
      'schedule',
    ]);
    expect([...parseTriggers('on:\n  # comment\n  workflow_run:\nname: x')]).toEqual([
      'workflow_run',
    ]);
    expect([...parseTriggers('on:\n  push:\nnot_a_trigger:\n  pull_request:')]).toEqual(['push']);
    expect([...parseTriggers('on: [push, "", pu"sh]')]).toEqual(['push', 'pu"sh']);
  });

  it('distinguishes each protected evidence marker and workflow fact', () => {
    const root = temporary('devai-s06c-residual-ci-');
    const marker = `on: pull_request
concurrency:
  cancel-in-progress: \${{ github.event_name == "pull_request" }}
jobs:
  verify:
    runs-on: macos-14
    services:
      db:
        image: postgres
    steps:
      - run: |
          actual_provenance_sha256=x
          VERIFIER_PROVENANCE_SHA256=\${{ vars.DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256 }}
          test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"
          cp -R "$source_root/schemas" "$source_root/src" "$verifier_root/"
          node "$DEVAI_EVIDENCE_BUNDLE_VERIFY"
`;
    put(root, '.github/workflows/only.yml', marker);
    const report = checkCiEconomy({ repoRoot: root });
    expect(report).toMatchObject({
      verdict: 'fail',
      workflows_scanned: 1,
      fail_count: 1,
      warn_count: 2,
    });
    expect(
      report.findings.map(({ ruleId, severity, locations }) => [ruleId, severity, locations]),
    ).toEqual([
      ['ci-economy.concurrency-cancel', 'pass', undefined],
      ['ci-economy.no-macos-on-pr', 'fail', ['only.yml']],
      ['ci-economy.no-triple-trigger', 'pass', undefined],
      ['ci-economy.evidence-gate-wired', 'pass', undefined],
      ['ci-economy.path-filters', 'warn', ['only.yml']],
      ['ci-economy.db-isolation', 'warn', ['only.yml']],
    ]);
    expect(report.findings[3]?.message).toBe(
      'evidence substrate is wired into at least one workflow',
    );
  });

  it('accepts exact protected-marker whitespace while rejecting broadened near misses', () => {
    const valid = temporary('devai-s06c-residual-marker-valid-');
    const base = `on: pull_request
concurrency:
  cancel-in-progress:true
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: |
          actual_provenance_sha256=x
          VERIFIER_PROVENANCE_SHA256=\${{ vars.DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256 }}
          test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"
          cp -R "$source_root/schemas" "$source_root/src" "$verifier_root/"
          node  "$DEVAI_EVIDENCE_VERIFY"
`;
    put(valid, '.github/workflows/gate.yml', base);
    expect(
      checkCiEconomy({ repoRoot: valid })
        .findings.slice(0, 4)
        .map((f) => f.severity),
    ).toEqual(['pass', 'pass', 'pass', 'pass']);

    const invalid = temporary('devai-s06c-residual-marker-invalid-');
    put(
      invalid,
      '.github/workflows/gate.yml',
      base.replace(
        'cp -R "$source_root/schemas" "$source_root/src" "$verifier_root/"',
        'cp -R "$source_root/schemas""$source_root/src" "$verifier_root/"',
      ),
    );
    expect(
      checkCiEconomy({ repoRoot: invalid }).findings.find(
        (f) => f.ruleId === 'ci-economy.evidence-gate-wired',
      )?.severity,
    ).toBe('fail');
  });

  it('extracts quoted cron content without swallowing comments or spacing', () => {
    const root = temporary('devai-s06c-residual-cron-');
    put(
      root,
      '.github/workflows/cron.yml',
      'on: schedule\nschedule:\n  - cron: \'0 0 * * *\' # daily\n  - cron: "0 0 1 * *"\n',
    );
    const report = checkCiEconomy({ repoRoot: root });
    const cron = report.findings.find((entry) => entry.ruleId === 'ci-economy.cron-cadence');
    expect(cron).toEqual({
      ruleId: 'ci-economy.cron-cadence',
      severity: 'warn',
      message: '1 workflow(s) carry a cron firing daily or more often',
      remediation:
        'The RC CI contract has no scheduled lane; remove the cron unless it is independently authorized.',
      locations: ['cron.yml'],
    });
  });

  it('does not require both macOS token shapes and recognizes quoted Postgres images', () => {
    const root = temporary('devai-s06c-residual-facts-');
    put(
      root,
      '.github/workflows/token.yml',
      'on: workflow_dispatch\n# macos-14\nimage: "postgres:16"\n',
    );
    const report = checkCiEconomy({ repoRoot: root });
    expect(report.findings.find((entry) => entry.ruleId === 'ci-economy.macos-cost')).toMatchObject(
      {
        message: '1 non-PR workflow(s) reference macOS runners (10× Linux pricing)',
        locations: ['token.yml'],
      },
    );
    expect(
      report.findings.find((entry) => entry.ruleId === 'ci-economy.db-isolation')?.locations,
    ).toEqual(['token.yml']);
  });

  it('keeps schedule-only workflows out of the triple-trigger failure', () => {
    const root = temporary('devai-s06c-residual-schedule-only-');
    put(root, '.github/workflows/schedule.yml', 'on: schedule\n');
    expect(
      checkCiEconomy({ repoRoot: root }).findings.find(
        (entry) => entry.ruleId === 'ci-economy.no-triple-trigger',
      ),
    ).toEqual({
      ruleId: 'ci-economy.no-triple-trigger',
      severity: 'pass',
      message: 'no workflow is triggered by all of pull_request + push + schedule',
    });
  });

  it('warns for push-only workflows but exempts workflow-call wrappers', () => {
    const root = temporary('devai-s06c-residual-unfiltered-');
    put(root, '.github/workflows/push.yml', 'on: push\n');
    put(root, '.github/workflows/wrapper.yml', 'on: [push, workflow_call]\n');
    expect(
      checkCiEconomy({ repoRoot: root }).findings.find(
        (entry) => entry.ruleId === 'ci-economy.path-filters',
      ),
    ).toMatchObject({ locations: ['push.yml'] });
  });

  it('recognizes zero-space cron, path-comment near misses, and zero-space images exactly', () => {
    const root = temporary('devai-s06c-residual-regex-');
    put(
      root,
      '.github/workflows/exact.yml',
      "on: [push, schedule]\n# paths: docs/**\nschedule:\n  -cron:'0 0 * * *'\nservices:\n  db:\n    image:postgres:16\n",
    );
    const report = checkCiEconomy({ repoRoot: root });
    expect(report.findings.find((f) => f.ruleId === 'ci-economy.path-filters')?.locations).toEqual([
      'exact.yml',
    ]);
    expect(report.findings.find((f) => f.ruleId === 'ci-economy.cron-cadence')?.locations).toEqual([
      'exact.yml',
    ]);
    expect(report.findings.find((f) => f.ruleId === 'ci-economy.db-isolation')?.locations).toEqual([
      'exact.yml',
    ]);
  });

  it('keeps hard-failure messages, remediation, and locations exact', () => {
    const root = temporary('devai-s06c-residual-hard-');
    put(
      root,
      '.github/workflows/triple.yml',
      'on: [pull_request, push, schedule]\njobs:\n  test:\n    runs-on: macos-14\n',
    );
    const report = checkCiEconomy({ repoRoot: root });
    expect(report.findings.slice(0, 4)).toEqual([
      {
        ruleId: 'ci-economy.concurrency-cancel',
        severity: 'fail',
        message: '1 pull_request-triggered workflow(s) do not cancel superseded pull-request runs',
        remediation:
          "Add `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }`. A workflow that also runs on push to a protected branch may instead set `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` so main runs are never cancelled; see docs/adopters/ci-economy.md#remote-workflow-posture.",
        locations: ['triple.yml'],
      },
      {
        ruleId: 'ci-economy.no-macos-on-pr',
        severity: 'fail',
        message: '1 pull_request-triggered workflow(s) reference macOS runners (10× Linux pricing)',
        remediation:
          'The remote ledger verifier must use the Linux runner; product validation remains local.',
        locations: ['triple.yml'],
      },
      {
        ruleId: 'ci-economy.no-triple-trigger',
        severity: 'fail',
        message: '1 workflow(s) run the same content on pull_request + push + schedule',
        remediation:
          'Keep the single pull_request + push ledger-verification workflow and remove scheduled product validation.',
        locations: ['triple.yml'],
      },
      {
        ruleId: 'ci-economy.evidence-gate-wired',
        severity: 'fail',
        message: 'no workflow invokes the verifier from a protected provenance-bound DEVAI package',
        remediation:
          'Add the single ledger-verification workflow with a protected verifier-provenance SHA-256 and runner-temp execution boundary. Incremental adopters may declare ci_economy.profile: "gate-staged" until that verifier is wired.',
      },
    ]);
  });

  it('renders every human finding field and honors a custom workflows directory', () => {
    const root = temporary('devai-s06c-residual-human-');
    put(root, 'custom/risk.yml', 'on: pull_request\njobs:\n  x:\n    runs-on: ubuntu-latest\n');
    const registration = captureRegistration(checkCiEconomyCmd);
    if (registration.action === undefined) throw new Error('CI action missing');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    registration.action({ repoRoot: root, workflowsDir: 'custom', human: true } as never);
    expect(output).toHaveBeenCalledTimes(1);
    expect(String(output.mock.calls[0]?.[0])).toBe(
      'check ci-economy: FAIL (1 workflow(s), 4 mechanical rules, 2 fail, 1 advisory, profile: full)\n' +
        '  [✗] ci-economy.concurrency-cancel: 1 pull_request-triggered workflow(s) do not cancel superseded pull-request runs\n' +
        "      Remediation: Add `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }`. A workflow that also runs on push to a protected branch may instead set `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` so main runs are never cancelled; see docs/adopters/ci-economy.md#remote-workflow-posture.\n" +
        '      Locations: risk.yml\n' +
        '  [✓] ci-economy.no-macos-on-pr: no macOS runner reference in any pull_request-triggered workflow\n' +
        '  [✓] ci-economy.no-triple-trigger: no workflow is triggered by all of pull_request + push + schedule\n' +
        '  [✗] ci-economy.evidence-gate-wired: no workflow invokes the verifier from a protected provenance-bound DEVAI package\n' +
        '      Remediation: Add the single ledger-verification workflow with a protected verifier-provenance SHA-256 and runner-temp execution boundary. Incremental adopters may declare ci_economy.profile: "gate-staged" until that verifier is wired.\n' +
        '  [!] ci-economy.path-filters: 1 pull_request/push workflow(s) declare no paths/paths-ignore filters\n' +
        '      Remediation: Advisory: add filters only for content the gates do not consume; DEVAI stays unfiltered because Markdown is tested. See docs/adopters/ci-economy.md#remote-workflow-posture.\n' +
        '      Locations: risk.yml\n',
    );
    expect(process.exitCode).toBe(2);
  });
});

function counted(total: number, covered: number) {
  return {
    lines: { total, covered },
    branches: { total, covered },
    functions: { total, covered },
    statements: { total, covered },
  };
}

async function runCoverage(options: CoverageOptions) {
  const registration = captureRegistration(coverageAggregate);
  if (registration.action === undefined) throw new Error('coverage action missing');
  let stdout = '';
  let stderr = '';
  let exit = 0;
  const original = {
    exit: process.exit,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
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
    await withAuthorityHostTestScope(() => registration.action?.(options as never));
  } catch (error) {
    if (error instanceof ExitSignal) exit = error.code;
    else throw error;
  } finally {
    exit = process.exitCode === undefined ? exit : Number(process.exitCode);
    process.exit = original.exit;
    process.stdout.write = original.stdout;
    process.stderr.write = original.stderr;
  }
  return { stdout, stderr, exit };
}

describe('S06-C residual coverage aggregate boundaries', () => {
  it('keeps root coverage scope distinct and omits scopes when explicitly disabled', async () => {
    const root = temporary('devai-s06c-residual-coverage-');
    put(root, 'coverage/coverage-summary.json', { total: counted(4, 3) });
    put(root, '.git/coverage-summary.json', { total: counted(100, 100) });
    const scoped = await runCoverage({
      repoRoot: root,
      in: '.',
      out: 'scoped.json',
      perPackage: true,
    });
    expect(JSON.parse(scoped.stdout)).toMatchObject({
      inputs: ['coverage/coverage-summary.json'],
      scopes: { 'coverage/coverage-summary.json': { lines: 75 } },
    });
    const unscoped = await runCoverage({
      repoRoot: root,
      in: '.',
      out: 'plain.json',
      perPackage: false,
    });
    const unscopedReport = JSON.parse(unscoped.stdout);
    expect(unscopedReport).not.toHaveProperty('scopes');
    expect(unscoped.stdout).toBe(`${JSON.stringify(unscopedReport)}\n`);
    expect(readFileSync(join(root, 'plain.json'), 'utf8')).toBe(
      `${JSON.stringify(unscopedReport, null, 2)}\n`,
    );
  });

  it('omits an explicitly requested empty scope population', async () => {
    const root = temporary('devai-s06c-residual-empty-scopes-');
    const result = await runCoverage({ repoRoot: root, perPackage: true });
    expect(JSON.parse(result.stdout)).not.toHaveProperty('scopes');
  });

  it('uses exact default final output and machine report fields while skipping malformed inputs', async () => {
    const root = temporary('devai-s06c-residual-final-');
    put(root, 'coverage/coverage-final.json', '{');
    const result = await runCoverage({ repoRoot: root, final: true, human: false });
    expect(result).toEqual({
      stderr: '',
      exit: 0,
      stdout: expect.any(String),
    });
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      schemaVersion: '1.0.0',
      mode: 'final',
      inputs: ['coverage/coverage-final.json'],
      out: 'coverage/coverage-final.json',
      files: 0,
      summary: {
        lines: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' },
        branches: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' },
        functions: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' },
        statements: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' },
      },
    });
    expect(result.stdout).toBe(`${JSON.stringify(report)}\n`);
    expect(readFileSync(join(root, 'coverage/coverage-final.json'), 'utf8')).toBe('{}\n');
  });

  it('reports non-Error output failures through the exact command prefix', async () => {
    const root = temporary('devai-s06c-residual-output-');
    mkdirSync(join(root, 'occupied'));
    const result = await runCoverage({ repoRoot: root, out: 'occupied' });
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^devai evidence coverage aggregate: EISDIR:/u);
  });
});

function triageBytes(task?: string): string {
  const classified = controls.classify();
  const verdict = { ...classified, ...(task === undefined ? {} : { subject_task_id: task }) };
  return `${JSON.stringify(verdict, null, 2)}\n`;
}

function runTriage(options: TriageOptions) {
  const registration = captureRegistration(triageClassify);
  if (registration.action === undefined) throw new Error('triage action missing');
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  withAuthorityHostTestScope(() => registration.action?.(options as never));
  return { stdout, stderr, exit: process.exitCode ?? 0 };
}

describe('S06-C residual triage evidence and tracking boundaries', () => {
  it.each(['TASK-', 'TASK-1x', 'xTASK-1', 'TASK-12\nTAIL'])(
    'rejects near-miss task identity %j',
    (task) => {
      const root = temporary('devai-s06c-residual-task-');
      put(root, 'reading.json', reading());
      expect(runTriage({ repoRoot: root, input: 'reading.json', task })).toEqual({
        stdout: '',
        stderr: 'devai triage classify: --task must match TASK-N\n',
        exit: 2,
      });
    },
  );

  it('accepts multi-digit task identities and preserves the exact verdict key', () => {
    const root = temporary('devai-s06c-residual-task-valid-');
    put(root, 'reading.json', reading());
    const result = runTriage({ repoRoot: root, input: 'reading.json', task: 'TASK-12' });
    expect(result).toMatchObject({ stderr: '', exit: 0 });
    expect(JSON.parse(result.stdout).verdict.subject_task_id).toBe('TASK-12');
  });

  it('keeps the repository-escape diagnostic exact', () => {
    const root = temporary('devai-s06c-residual-escape-');
    expect(runTriage({ repoRoot: root, input: '../outside.json' })).toEqual({
      stdout: '',
      stderr: 'devai triage classify: input path escapes repository\n',
      exit: 2,
    });
    expect(runTriage({ repoRoot: root, input: '..' })).toEqual({
      stdout: '',
      stderr: 'devai triage classify: input path escapes repository\n',
      exit: 2,
    });
  });

  it('reuses matching evidence and attributes an exact non-inconclusive event', () => {
    const root = temporary('devai-s06c-residual-reuse-');
    put(root, 'reading.json', reading());
    const bytes = triageBytes('TASK-8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    controls.load.mockReturnValue({
      records: [
        { action: 'other', artifacts: [{ sha256: digest }], id: 'EV-WRONG-ACTION' },
        { action: 'triage.classify', artifacts: [{ sha256: '0'.repeat(64) }], id: 'EV-WRONG-HASH' },
        {
          action: 'triage.classify',
          artifacts: [{ sha256: 'f'.repeat(64) }, { sha256: digest }],
          id: 'EV-PRIOR',
        },
      ],
    });
    const result = runTriage({
      repoRoot: root,
      input: 'reading.json',
      task: 'TASK-8',
      round: 'R-8',
    });
    expect(result).toMatchObject({ stderr: '', exit: 0 });
    expect(JSON.parse(result.stdout)).toMatchObject({ evidence_ref: 'EV-PRIOR' });
    expect(controls.append).not.toHaveBeenCalled();
    expect(controls.load).toHaveBeenCalledWith(join(root, 'record/proofs/chain.json'));
    expect(controls.track).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: root,
        round: 'R-8',
        role: 'inspector',
        kind: 'finding_classified',
        status: 'review',
        taskId: 'TASK-8',
        summary: 'Sensor failure classified as plant_bug; route feedback_iteration.',
        evidenceRefs: ['EV-PRIOR'],
      }),
    );
  });

  it('creates complete evidence notes and omits tracking when no round is supplied', () => {
    const root = temporary('devai-s06c-residual-new-');
    put(root, 'reading.json', reading());
    controls.load.mockImplementation(() => {
      throw new Error('missing chain');
    });
    const result = runTriage({ repoRoot: root, input: 'reading.json' });
    expect(result).toMatchObject({ stderr: '', exit: 0 });
    expect(controls.append).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: root,
        action: 'triage.classify',
        status: 'completed',
        notes: ['classification=plant_bug', 'route=feedback_iteration'],
        artifacts: [expect.objectContaining({ kind: 'triage' })],
      }),
    );
    expect(controls.track).not.toHaveBeenCalled();
    expect(
      Object.hasOwn(controls.triageVerdict.mock.calls[0]?.[0] as object, 'subject_task_id'),
    ).toBe(false);
  });

  it('accepts exact replay bytes without rewriting evidence identity', () => {
    const root = temporary('devai-s06c-residual-replay-');
    put(root, 'reading.json', reading());
    expect(runTriage({ repoRoot: root, input: 'reading.json' })).toMatchObject({
      stderr: '',
      exit: 0,
    });
    controls.append.mockClear();
    expect(runTriage({ repoRoot: root, input: 'reading.json' })).toMatchObject({
      stderr: '',
      exit: 0,
    });
    expect(controls.append).toHaveBeenCalledTimes(1);
  });

  it('tracks inconclusive discipline fallback, auditor role fallback, and absent evidence ID', () => {
    const root = temporary('devai-s06c-residual-inconclusive-');
    put(root, 'reading.json', reading());
    controls.classify.mockReturnValue({
      schemaVersion: '1.0.0',
      id: 'TRG-fedcba9876543210',
      subject_evidence_ref: 'EV-89f7974460e256a3',
      classification: 'inconclusive',
      confidence: { score: 0, method: 'rule-based-mvp' },
      recommended_route: { discipline: 'human' },
    });
    controls.declaredRole.mockReturnValue(undefined);
    controls.append.mockReturnValue({ ok: true, id: undefined });
    const result = runTriage({ repoRoot: root, input: 'reading.json', round: 'R-9', human: true });
    expect(result).toEqual({
      stdout: 'triage classify: inconclusive → human\n',
      stderr: '',
      exit: 0,
    });
    expect(controls.track).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'auditor',
        status: 'inconclusive',
        summary: 'Sensor failure classified as inconclusive; route human.',
        evidenceRefs: [],
      }),
    );
    expect(controls.append).toHaveBeenCalledWith(
      expect.objectContaining({ notes: ['classification=inconclusive', 'route=none'] }),
    );
    const tracked = controls.track.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(tracked, 'taskId')).toBe(false);
  });

  it('fails with exact validator and evidence diagnostics', () => {
    const invalidRoot = temporary('devai-s06c-residual-invalid-verdict-');
    put(invalidRoot, 'reading.json', reading());
    controls.triageVerdict.errors = [{ keyword: 'required' }];
    controls.triageVerdict.mockReturnValue(false);
    expect(runTriage({ repoRoot: invalidRoot, input: 'reading.json' })).toEqual({
      stdout: '',
      stderr: 'devai triage classify: TRIAGE_VERDICT_INVALID:[{"keyword":"required"}]\n',
      exit: 2,
    });

    controls.triageVerdict.mockReturnValue(true);
    const evidenceRoot = temporary('devai-s06c-residual-invalid-evidence-');
    put(evidenceRoot, 'reading.json', reading());
    controls.append.mockReturnValue({ ok: false, error: 'ledger refused' });
    expect(runTriage({ repoRoot: evidenceRoot, input: 'reading.json' })).toEqual({
      stdout: '',
      stderr: 'devai triage classify: TRIAGE_EVIDENCE_FAILED:ledger refused\n',
      exit: 2,
    });
  });

  it('preserves empty evidence errors and non-Error thrown values', () => {
    const empty = temporary('devai-s06c-residual-empty-error-');
    put(empty, 'reading.json', reading());
    controls.append.mockReturnValue({ ok: false });
    expect(runTriage({ repoRoot: empty, input: 'reading.json' }).stderr).toBe(
      'devai triage classify: TRIAGE_EVIDENCE_FAILED:\n',
    );

    const thrown = temporary('devai-s06c-residual-thrown-');
    put(thrown, 'reading.json', reading());
    controls.classify.mockImplementation(() => {
      throw 'plain refusal';
    });
    expect(runTriage({ repoRoot: thrown, input: 'reading.json' })).toEqual({
      stdout: '',
      stderr: 'devai triage classify: plain refusal\n',
      exit: 2,
    });
  });
});
