import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CAC } from 'cac';

const mocks = vi.hoisted(() => ({
  localOnly: {
    enabled: false,
    errors: [] as string[],
    violations: [] as string[],
    forbiddenScripts: [] as string[],
  },
  inspect: vi.fn(),
}));

vi.mock('../../src/commands/check/ci-local-only.js', () => ({
  inspectRemoteLocalOnlyNodes: (...args: unknown[]) => {
    mocks.inspect(...args);
    return mocks.localOnly;
  },
}));

import {
  checkCiEconomy,
  checkCiEconomyCmd,
  cronIsDailyOrMore,
  parseTriggers,
  readCiEconomyProfile,
} from '../../src/commands/check/ci-economy.js';

const roots: string[] = [];

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-ci-economy-depth-'));
  roots.push(root);
  return root;
}

function workflow(root: string, name: string, text: string, directory = '.github/workflows'): void {
  const destination = join(root, directory);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, name), text);
}

function project(root: string, value: unknown): void {
  const directory = join(root, '.devai/config');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'project.json'), JSON.stringify(value));
}

function protectedWorkflow(): string {
  return `name: protected verifier
on:
  pull_request:
  push:
concurrency:
  group: verifier
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: |
          actual_provenance_sha256=value
          VERIFIER_PROVENANCE_SHA256=\${{ vars.DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256 }}
          test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"
          cp -R "$source_root/schemas" "$source_root/src" "$verifier_root/"
          node "$DEVAI_EVIDENCE_VERIFY"
`;
}

function finding(report: ReturnType<typeof checkCiEconomy>, ruleId: string) {
  const value = report.findings.find((entry) => entry.ruleId === ruleId);
  expect(value, `missing ${ruleId}`).toBeDefined();
  return value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.localOnly = { enabled: false, errors: [], violations: [], forbiddenScripts: [] };
  mocks.inspect.mockClear();
});

describe('CI economy direct contract', () => {
  it('parses every supported trigger spelling without accepting nested workflow keys', () => {
    expect([...parseTriggers('on: push')]).toEqual(['push']);
    expect([...parseTriggers("'on': ['push', \"pull_request\"] # comment")]).toEqual([
      'push',
      'pull_request',
    ]);
    expect([
      ...parseTriggers(
        '"on":\n  pull_request:\n    paths:\n      - src/**\n  workflow_dispatch:\nname: x',
      ),
    ]).toEqual(['pull_request', 'workflow_dispatch']);
    expect([...parseTriggers('name: no trigger')]).toEqual([]);
    expect([...parseTriggers('prefix on: push')]).toEqual([]);
    expect([...parseTriggers('on: push, pull_request')]).toEqual(['push, pull_request']);
    expect([...parseTriggers('on: [push, "", pull_request]')]).toEqual(['push', 'pull_request']);
    expect([...parseTriggers('on:\n    push:\n  pull_request_target:\n')]).toEqual([
      'pull_request_target',
    ]);
  });

  it.each([
    ['0 0 * * *', true],
    ['*/10 * * * *', true],
    ['0 0 1 * *', false],
    ['0 0 * * 1', false],
    ['0 0 * *', false],
  ])('classifies cron cadence %s', (cron, expected) => {
    expect(cronIsDailyOrMore(cron)).toBe(expected);
  });

  it('defaults malformed, missing, and unknown profiles to strict full', () => {
    const missing = temporary();
    expect(readCiEconomyProfile(missing)).toBe('full');

    const malformed = temporary();
    mkdirSync(join(malformed, '.devai/config'), { recursive: true });
    writeFileSync(join(malformed, '.devai/config/project.json'), '{');
    expect(readCiEconomyProfile(malformed)).toBe('full');

    const unknown = temporary();
    project(unknown, { ci_economy: { profile: 'advisory' } });
    expect(readCiEconomyProfile(unknown)).toBe('full');

    const staged = temporary();
    project(staged, { ci_economy: { profile: 'gate-staged' } });
    expect(readCiEconomyProfile(staged)).toBe('gate-staged');
  });

  it('returns the exact clean report for a provenance-bound Linux workflow', () => {
    const root = temporary();
    workflow(root, 'z-ignore.txt', 'not a workflow');
    workflow(root, 'gate.yml', protectedWorkflow());
    const report = checkCiEconomy({ repoRoot: root });

    expect(report).toMatchObject({
      verdict: 'warn',
      rules_checked: 4,
      workflows_scanned: 1,
      ci_economy_profile: 'full',
      fail_count: 0,
      warn_count: 1,
    });
    expect(report.findings.map((entry) => [entry.ruleId, entry.severity])).toEqual([
      ['ci-economy.concurrency-cancel', 'pass'],
      ['ci-economy.no-macos-on-pr', 'pass'],
      ['ci-economy.no-triple-trigger', 'pass'],
      ['ci-economy.evidence-gate-wired', 'pass'],
      ['ci-economy.path-filters', 'warn'],
    ]);
    expect(mocks.inspect).toHaveBeenCalledWith(root, [
      { file: 'gate.yml', text: protectedWorkflow() },
    ]);
  });

  it('uses custom workflow directory and reports a fully passing filtered workflow', () => {
    const root = temporary();
    workflow(
      root,
      'custom.yaml',
      `${protectedWorkflow()}      paths-ignore:\n        - docs/**\n`,
      'ci',
    );
    const report = checkCiEconomy({ repoRoot: root, workflowsDir: 'ci' });
    expect(report).toMatchObject({
      verdict: 'pass',
      workflows_scanned: 1,
      fail_count: 0,
      warn_count: 0,
    });
    expect(report.findings).toHaveLength(4);
  });

  it('aggregates hard failures and advisories in filename order', () => {
    const root = temporary();
    workflow(
      root,
      'z-risk.yml',
      `on: [pull_request, push, schedule]
jobs:
  test:
    runs-on: macos-14
    services:
      db:
        image: postgres:16
schedule:
  - cron: '0 0 * * *'
`,
    );
    workflow(root, 'a-cost.yaml', 'on: workflow_dispatch\njobs:\n  test:\n    runs-on: macos-13\n');
    const report = checkCiEconomy({ repoRoot: root });

    expect(report).toMatchObject({
      verdict: 'fail',
      workflows_scanned: 2,
      fail_count: 4,
      warn_count: 4,
    });
    for (const rule of [
      'ci-economy.concurrency-cancel',
      'ci-economy.no-macos-on-pr',
      'ci-economy.no-triple-trigger',
      'ci-economy.evidence-gate-wired',
    ]) {
      expect(finding(report, rule)?.severity).toBe('fail');
    }
    expect(finding(report, 'ci-economy.concurrency-cancel')?.locations).toEqual(['z-risk.yml']);
    expect(finding(report, 'ci-economy.path-filters')?.locations).toEqual(['z-risk.yml']);
    expect(finding(report, 'ci-economy.cron-cadence')?.locations).toEqual(['z-risk.yml']);
    expect(finding(report, 'ci-economy.macos-cost')?.locations).toEqual(['a-cost.yaml']);
    expect(finding(report, 'ci-economy.db-isolation')?.locations).toEqual(['z-risk.yml']);
  });

  it('makes missing verifier evidence advisory only under an exact staged declaration', () => {
    const root = temporary();
    project(root, { ci_economy: { profile: 'gate-staged' } });
    const report = checkCiEconomy({ repoRoot: root });
    expect(report).toMatchObject({
      verdict: 'warn',
      workflows_scanned: 0,
      ci_economy_profile: 'gate-staged',
      fail_count: 0,
      warn_count: 1,
    });
    expect(finding(report, 'ci-economy.evidence-gate-wired')).toMatchObject({
      severity: 'warn',
      message: expect.stringContaining('no workflow files found under .github/workflows'),
      remediation: expect.stringContaining('graduate ci_economy.profile to "full"'),
    });
  });

  it('tells staged adopters to graduate after verifier evidence is wired', () => {
    const root = temporary();
    project(root, { ci_economy: { profile: 'gate-staged' } });
    workflow(
      root,
      'gate.yml',
      protectedWorkflow().replace('  push:\n', '  push:\n    paths:\n      - src/**\n'),
    );
    const report = checkCiEconomy({ repoRoot: root });
    expect(finding(report, 'ci-economy.evidence-gate-wired')).toMatchObject({
      severity: 'pass',
      message: expect.stringContaining('gate-staged declaration is no longer needed'),
    });
  });

  it('fails closed and combines local-only configuration errors with sorted violations', () => {
    const root = temporary();
    workflow(root, 'gate.yml', protectedWorkflow());
    mocks.localOnly = {
      enabled: true,
      errors: ['config missing task'],
      violations: ['z.yml: local-only', 'a.yml: direct Stryker'],
      forbiddenScripts: ['test:mutation'],
    };
    const report = checkCiEconomy({ repoRoot: root });
    expect(report).toMatchObject({ verdict: 'fail', rules_checked: 5, fail_count: 1 });
    expect(finding(report, 'ci-economy.local-only-nodes')).toMatchObject({
      severity: 'fail',
      message: '3 attested-RC local-only violation(s) found',
      locations: ['config missing task', 'z.yml: local-only', 'a.yml: direct Stryker'],
    });
  });

  it('reports the enabled local-only floor as passing when no defects exist', () => {
    const root = temporary();
    workflow(
      root,
      'gate.yml',
      protectedWorkflow().replace('  push:\n', '  push:\n    paths:\n      - src/**\n'),
    );
    mocks.localOnly = { enabled: true, errors: [], violations: [], forbiddenScripts: [] };
    const report = checkCiEconomy({ repoRoot: root });
    expect(report).toMatchObject({
      verdict: 'pass',
      rules_checked: 5,
      fail_count: 0,
      warn_count: 0,
    });
    expect(finding(report, 'ci-economy.local-only-nodes')?.severity).toBe('pass');
  });

  it('activates strict profile and fail-closed evidence behavior in a fresh module', async () => {
    vi.resetModules();
    const fresh = await (import(
      '../../src/commands/check/ci-economy.js' + '?fresh-ci-economy'
    ) as Promise<typeof import('../../src/commands/check/ci-economy.js')>);
    const root = temporary();
    const report = fresh.checkCiEconomy({ repoRoot: root });
    expect(report).toMatchObject({ verdict: 'fail', ci_economy_profile: 'full', fail_count: 1 });
    expect(report.findings.map((entry) => entry.ruleId)).toEqual([
      'ci-economy.concurrency-cancel',
      'ci-economy.no-macos-on-pr',
      'ci-economy.no-triple-trigger',
      'ci-economy.evidence-gate-wired',
    ]);
  });

  it('registers deterministic human and JSON adapters with hard-failure exit status', () => {
    let action:
      | ((options: { repoRoot?: string; workflowsDir?: string; human?: boolean }) => void)
      | undefined;
    const chain = {
      option: () => chain,
      action: (value: typeof action) => {
        action = value;
        return chain;
      },
    };
    const cli = {
      command: vi.fn(() => chain),
    } as unknown as CAC;
    checkCiEconomyCmd.register(cli);
    expect(cli.command).toHaveBeenCalledWith(
      'check-ci-economy',
      'Validate the documented CI-economy rules',
    );
    expect(action).toBeTypeOf('function');
    if (action === undefined) throw new Error('CI-economy action was not registered');

    const passRoot = temporary();
    workflow(
      passRoot,
      'gate.yml',
      protectedWorkflow().replace('  push:\n', '  push:\n    paths:\n      - src/**\n'),
    );
    const warnRoot = temporary();
    workflow(warnRoot, 'warning.yml', protectedWorkflow());
    const failRoot = temporary();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    try {
      action({ repoRoot: passRoot, human: true });
      expect(output).toHaveBeenLastCalledWith(
        expect.stringContaining('check ci-economy: PASS (1 workflow(s), 4 mechanical rules'),
      );
      expect(process.exitCode).toBe(0);

      action({ repoRoot: warnRoot, human: true });
      const warning = String(output.mock.calls.at(-1)?.[0]);
      expect(warning).toContain('check ci-economy: WARN');
      expect(warning).toContain('[!] ci-economy.path-filters');
      expect(warning).toContain('Remediation: Advisory: add filters');
      expect(warning).toContain('Locations: warning.yml');
      expect(process.exitCode).toBe(0);

      action({ repoRoot: failRoot, human: true });
      const failure = String(output.mock.calls.at(-1)?.[0]);
      expect(failure).toContain('check ci-economy: FAIL');
      expect(failure).toContain('[✗] ci-economy.evidence-gate-wired');
      expect(failure).toContain('Remediation: Add the single ledger-verification workflow');
      expect(process.exitCode).toBe(2);

      action({ repoRoot: failRoot });
      const serialized = String(output.mock.calls.at(-1)?.[0]);
      expect(serialized.endsWith('\n')).toBe(true);
      expect(JSON.parse(serialized)).toMatchObject({ verdict: 'fail', fail_count: 1 });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = previousExitCode;
      output.mockRestore();
    }
  });
});
