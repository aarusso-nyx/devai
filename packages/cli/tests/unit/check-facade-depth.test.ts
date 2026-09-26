import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cac } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_FAIL, EXIT_PRECONDITION, EXIT_USAGE } from '@devai-nyx/utils';

const boundary = vi.hoisted(() => ({
  executeCheckMember: vi.fn(),
  resolveCheckPlan: vi.fn(),
  runCheckPlan: vi.fn(),
  runCheckTasks: vi.fn(),
}));

vi.mock('../../src/services/check-runner/index.js', () => ({
  runCheckTasks: boundary.runCheckTasks,
}));

vi.mock('../../src/commands/check/adapters.js', () => ({
  executeCheckMember: boundary.executeCheckMember,
}));

vi.mock('../../src/commands/check/contracts.js', () => ({
  resolveCheckPlan: boundary.resolveCheckPlan,
  runCheckPlan: boundary.runCheckPlan,
}));

import { checkCmd } from '../../src/commands/check/facade.js';

const roots: string[] = [];
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-check-facade-depth-'));
  roots.push(root);
  return root;
}

function put(root: string, path: string, value: unknown): string {
  const absolute = join(root, path);
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value)}\n`);
  return absolute;
}

function taskReport(overrides: Record<string, unknown> = {}) {
  return {
    plan: {
      target: 'affected',
      clean: false,
      tasks: [
        { nodeId: 'lint', cacheState: 'miss', reason: 'source changed' },
        { nodeId: 'test', cacheState: 'hit', reason: 'inputs match' },
      ],
    },
    operation: 'plan',
    exitCode: 0,
    ...overrides,
  };
}

function checkReport(overrides: Record<string, unknown> = {}) {
  return {
    selection: { kind: 'suite', suite: 'standard' },
    execution_status: 'pass',
    readiness_status: 'pass',
    results: [
      {
        id: 'lint',
        status: 'pass',
        duration_ms: 7,
        effect: 'read',
        message: 'clean',
        value: { status: 'pass', detail: 'retained' },
      },
    ],
    exit_code: 0,
    ...overrides,
  };
}

async function invoke(args: readonly string[]) {
  const cli = cac('devai-check-facade-depth');
  checkCmd.register(cli);
  let stdout = '';
  let stderr = '';
  process.argv = ['node', 'devai', 'check', ...args];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
  return { stdout, stderr, exit: process.exitCode ?? 0 };
}

beforeEach(() => {
  boundary.executeCheckMember.mockReset();
  boundary.resolveCheckPlan.mockReset();
  boundary.runCheckPlan.mockReset();
  boundary.runCheckTasks.mockReset();
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check facade task-runner boundary', () => {
  it('registers the complete documented public command surface', () => {
    const options: [string, string][] = [];
    let action: unknown;
    const command = {
      option(flags: string, description: string) {
        options.push([flags, description]);
        return command;
      },
      action(callback: unknown) {
        action = callback;
        return command;
      },
    };
    const cli = {
      command(name: string, description: string) {
        expect(name).toBe('check');
        expect(description).toBe(
          'Run a canonical check suite or one named check with fail-closed aggregate output',
        );
        return command;
      },
    };

    checkCmd.register(cli as never);

    expect(checkCmd).toMatchObject({
      name: 'check',
      description:
        'Run a canonical check suite or one named check with fail-closed aggregate output.',
      authority: 'policy_firewall',
    });
    expect(options).toEqual([
      ['--suite <name>', 'quick | standard | full | release (default: standard)'],
      ['--only <member>', 'Run one named canonical check member'],
      ['--repo-root <path>', 'Repository root (default: .)'],
      ['--schema <path>', 'Schema path for --only schema'],
      ['--instance <path>', 'Instance path for --only schema'],
      ['--file <path>', 'Input file for --only blueprint'],
      ['--witness <path>', 'Translation witness for --only translation'],
      ['--database-url <url>', 'Administrative database URL for translation isolation'],
      ['--pr-body-file <path>', 'PR body file for --only pr-compliance'],
      ['--optional', 'Permit a missing compliance trailer for --only pr-compliance'],
      ['--strict', "Enable the named check's strict posture where supported"],
      ['--since-ref <ref>', 'Verified lower commit bound for forbidden-action history'],
      ['--max-commits <n>', 'Bound forbidden-action history when --since-ref is absent'],
      ['--skip-publish-check', 'Skip the docs-governance publication-branch probe'],
      ['--mutation-baseline <path>', 'Mutation baseline for --only mutation'],
      ['--mutation-current <path>', 'Mutation current report for --only mutation'],
      ['--mutation-thresholds <path>', 'Mutation thresholds for --only mutation'],
      ['--affected', 'Select tasks affected since the exact --base commit'],
      ['--preflight', 'Select the preflight probe nodes; --base names the freshly fetched base'],
      ['--local', 'Select the complete cheap local task closure'],
      ['--rc', 'Select the fixed release-candidate task closure'],
      [
        '--release-intent <path>',
        'Select a capability-driven release DAG from a candidate-bound intent',
      ],
      [
        '--release-profile <path>',
        'Release verification profile (default: .devai/config/release-verification.json)',
      ],
      ['--release-stage <stage>', 'Release stage: preflight | certify (default: preflight)'],
      ['--preflight-receipt <path>', 'Exact preflight receipt required for certification'],
      ['--task-plan', 'Task operation (choose one): plan without executing'],
      ['--run', 'Task operation (choose one): execute or reuse selected tasks'],
      ['--status', 'Task operation (choose one): show freshness status'],
      ['--explain', 'Task operation (choose one): explain selection and reuse'],
      ['--base <commit>', 'Exact ancestor commit required with --affected'],
      ['--task-timeout-ms <n>', 'Per-task timeout in milliseconds for --run'],
      ['--human', 'Human-readable aggregate'],
    ]);
    expect(action).toEqual(expect.any(Function));
  });

  it('normalizes affected planning arguments and emits the runner report', async () => {
    const root = temporaryRoot();
    const report = taskReport();
    boundary.runCheckTasks.mockReturnValueOnce(report);

    const result = await invoke([
      '--affected',
      '--task-plan',
      '--base',
      'abc123',
      '--task-timeout-ms',
      '4200',
      '--repo-root',
      root,
    ]);

    expect(boundary.runCheckTasks).toHaveBeenCalledWith({
      repoRoot: root,
      target: 'affected',
      operation: 'plan',
      baseCommit: 'abc123',
      timeoutMs: 4200,
    });
    expect(JSON.parse(result.stdout)).toEqual(report);
    expect(result).toMatchObject({ stderr: '', exit: 0 });
  });

  it('loads and binds release inputs while preserving certification selection', async () => {
    const root = temporaryRoot();
    put(root, 'intent.json', { candidate: 'deadbeef' });
    put(root, 'profiles/custom.json', { profile: 'strict' });
    put(root, 'receipts/preflight.json', { digest: 'a'.repeat(64) });
    boundary.runCheckTasks.mockReturnValueOnce(taskReport({ operation: 'run' }));

    await invoke([
      '--release-intent',
      'intent.json',
      '--release-profile',
      'profiles/custom.json',
      '--release-stage',
      'certify',
      '--preflight-receipt',
      'receipts/preflight.json',
      '--run',
      '--repo-root',
      root,
    ]);

    expect(boundary.runCheckTasks).toHaveBeenCalledWith({
      repoRoot: root,
      target: 'release',
      operation: 'run',
      releaseIntent: { candidate: 'deadbeef' },
      releaseProfile: { profile: 'strict' },
      releaseStage: 'certify',
      preflightReceipt: { digest: 'a'.repeat(64) },
    });
  });

  it('uses the default release profile and preflight stage', async () => {
    const root = temporaryRoot();
    put(root, 'intent.json', { candidate: 'cafe' });
    put(root, '.devai/config/release-verification.json', { profile: 'default' });
    boundary.runCheckTasks.mockReturnValueOnce(taskReport());

    await invoke(['--release-intent', 'intent.json', '--task-plan', '--repo-root', root]);

    expect(boundary.runCheckTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'release',
        operation: 'plan',
        releaseIntent: { candidate: 'cafe' },
        releaseProfile: { profile: 'default' },
        releaseStage: 'preflight',
      }),
    );
  });

  it('renders execution dispositions, fallback cache states, and receipt outcomes for humans', async () => {
    boundary.runCheckTasks
      .mockReturnValueOnce(
        taskReport({
          operation: 'run',
          execution: [{ nodeId: 'lint', disposition: 'executed', reason: 'ran now' }],
          receipt: { digest: 'receipt-digest' },
        }),
      )
      .mockReturnValueOnce(
        taskReport({ operation: 'status', receiptRefusal: 'candidate tree is dirty' }),
      );

    const completed = await invoke(['--local', '--run', '--human']);
    const refused = await invoke(['--rc', '--status', '--human']);

    expect(completed.stdout).toBe(
      'check affected run: 2 task(s), tree=dirty\n' +
        '  EXECUTED lint: ran now\n' +
        '  HIT test: inputs match\n' +
        '  RECEIPT receipt-digest\n',
    );
    expect(refused.stdout).toContain('NO RECEIPT: candidate tree is dirty');
  });

  it('reports a clean empty task plan without inventing task lines', async () => {
    boundary.runCheckTasks.mockReturnValueOnce(
      taskReport({
        plan: { target: 'local', clean: true, tasks: [] },
        operation: 'status',
      }),
    );
    const result = await invoke(['--local', '--status', '--human']);
    expect(result.stdout).toBe('check local status: 0 task(s), tree=clean\n');
  });

  it.each([
    [['--local', '--status'], 'local', 'status'],
    [['--rc', '--explain'], 'rc', 'explain'],
  ] as const)('preserves target and operation for %j', async (args, target, operation) => {
    boundary.runCheckTasks.mockReturnValueOnce(taskReport({ operation }));
    await invoke(args);
    expect(boundary.runCheckTasks.mock.calls[0]?.[0]).toStrictEqual({
      repoRoot: process.cwd(),
      target,
      operation,
    });
  });

  it.each([
    [['--local'], 'select exactly one task operation'],
    [['--run'], 'select exactly one task target'],
    [['--local', '--rc', '--run'], 'select exactly one task target'],
    [['--local', '--run', '--status'], 'select exactly one task operation'],
    [['--local', '--run', '--suite', 'quick'], 'task flags conflict with --suite/--only'],
    [['--local', '--run', '--only', 'lint'], 'task flags conflict with --suite/--only'],
    [['--local', '--run', '--release-stage', 'publish'], 'expected preflight or certify'],
    [['--release-intent', 'absent.json'], 'select exactly one task operation'],
  ] as const)('rejects conflicting task selection %j', async (args, message) => {
    const result = await invoke(args);
    expect(result).toEqual({
      stdout: '',
      stderr: expect.stringContaining(message),
      exit: EXIT_USAGE,
    });
    expect(boundary.runCheckTasks).not.toHaveBeenCalled();
  });

  it.each([
    [
      'CHECK_RUNNER_DESCRIPTOR: local target requires a node named test:local-full',
      'CHECK_RUNNER_DESCRIPTOR',
      'docs/adopters/test-tasks.md#local-closure-root',
    ],
    [
      'CHECK_TASK_DESCRIPTOR_MISSING: descriptor absent',
      'CHECK_TASK_DESCRIPTOR_MISSING',
      'docs/adopters/test-tasks.md',
    ],
    [
      'CHECK_RC_DB_TESTS_REQUIRED: database lane absent',
      'CHECK_RC_DB_TESTS_REQUIRED',
      'docs/dev/operations/testing.md',
    ],
  ] as const)('emits structured %s preconditions', async (message, code, doc) => {
    boundary.runCheckTasks.mockImplementationOnce(() => {
      throw new Error(message);
    });

    const result = await invoke(['--local', '--run']);
    const payload = JSON.parse(result.stderr) as {
      code: string;
      message: string;
      remediation: string;
      refs: { doc: string };
    };
    expect(result).toMatchObject({ stdout: '', exit: EXIT_PRECONDITION });
    expect(payload).toMatchObject({ code, refs: { doc } });
    expect(payload.message).toBe(message.replace(/^[A-Z0-9_]+:\s*/u, ''));
    expect(payload.remediation.length).toBeGreaterThan(10);
  });

  it('renders human preconditions and maps ordinary runner failures', async () => {
    boundary.runCheckTasks
      .mockImplementationOnce(() => {
        throw new Error('CHECK_TASK_DESCRIPTOR_MISSING: descriptor absent');
      })
      .mockImplementationOnce(() => {
        throw new Error('CHECK_RUNNER_TIMEOUT: must be positive');
      })
      .mockImplementationOnce(() => {
        throw 'opaque failure';
      });

    const human = await invoke(['--local', '--run', '--human']);
    const usage = await invoke(['--local', '--run']);
    const failure = await invoke(['--local', '--run']);

    expect(human.exit).toBe(EXIT_PRECONDITION);
    expect(human.stderr).toContain('descriptor absent');
    expect(human.stderr).toContain('Create the adopter-owned test-tasks.json');
    expect(() => JSON.parse(human.stderr)).toThrow();
    expect(usage).toMatchObject({
      exit: EXIT_USAGE,
      stderr: expect.stringContaining('must be positive'),
    });
    expect(failure).toEqual({
      stdout: '',
      stderr: 'devai check: opaque failure\n',
      exit: EXIT_FAIL,
    });
  });

  it('recognizes the local-root precondition when diagnostic detail follows it', async () => {
    boundary.runCheckTasks.mockImplementationOnce(() => {
      throw new Error(
        'CHECK_RUNNER_DESCRIPTOR: local target requires a node named test:local-full: profile local',
      );
    });
    const result = await invoke(['--local', '--run']);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: 'CHECK_RUNNER_DESCRIPTOR',
      message: 'local target requires a node named test:local-full: profile local',
    });
    expect(result.exit).toBe(EXIT_PRECONDITION);
  });
});

describe('check facade canonical-member boundary', () => {
  it('forwards every member option with normalized numeric bounds and emits only-member values', async () => {
    const root = temporaryRoot();
    const plan = { selection: { kind: 'only', member: 'mutation' }, members: [{ id: 'mutation' }] };
    const report = checkReport({
      selection: { kind: 'only', member: 'mutation' },
      results: [
        { id: 'mutation', status: 'pass', duration_ms: 3, effect: 'read', value: { score: 81 } },
      ],
    });
    boundary.resolveCheckPlan.mockReturnValueOnce(plan);
    boundary.runCheckPlan.mockImplementationOnce(async (_plan, execute) => {
      await execute({ id: 'mutation' });
      return report;
    });
    boundary.executeCheckMember.mockResolvedValueOnce({ status: 'pass' });

    const result = await invoke([
      '--only',
      'mutation',
      '--repo-root',
      root,
      '--schema',
      'schema.json',
      '--instance',
      'instance.json',
      '--file',
      'blueprint.json',
      '--witness',
      'witness.json',
      '--database-url',
      'postgres://fixture',
      '--pr-body-file',
      'body.md',
      '--optional',
      '--strict',
      '--since-ref',
      'base',
      '--max-commits',
      '17',
      '--skip-publish-check',
      '--mutation-baseline',
      'baseline.json',
      '--mutation-current',
      'current.json',
      '--mutation-thresholds',
      'thresholds.json',
    ]);

    expect(boundary.resolveCheckPlan).toHaveBeenCalledWith(root, { only: 'mutation' });
    expect(boundary.executeCheckMember).toHaveBeenCalledWith(
      { id: 'mutation' },
      {
        repoRoot: root,
        schema: 'schema.json',
        instance: 'instance.json',
        file: 'blueprint.json',
        witness: 'witness.json',
        databaseUrl: 'postgres://fixture',
        prBodyFile: 'body.md',
        optional: true,
        strict: true,
        sinceRef: 'base',
        maxCommits: 17,
        skipPublishCheck: true,
        mutationBaseline: 'baseline.json',
        mutationCurrent: 'current.json',
        mutationThresholds: 'thresholds.json',
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({ score: 81 });
    expect(result.exit).toBe(0);
  });

  it('emits the aggregate for suites and formats result messages for humans', async () => {
    const report = checkReport();
    boundary.resolveCheckPlan.mockReturnValue({ selection: { kind: 'suite', suite: 'quick' } });
    boundary.runCheckPlan.mockResolvedValue(report);

    const machine = await invoke(['--suite', 'quick']);
    const human = await invoke(['--suite', 'quick', '--human']);

    expect(JSON.parse(machine.stdout)).toEqual(report);
    expect(human.stdout).toBe(
      'check (suite standard): execution=PASS readiness=PASS\n' +
        '  PASS lint (7ms, read)\n' +
        '    clean\n',
    );
  });

  it('uses default selection/options and preserves a value-less only report', async () => {
    const defaultPlan = { selection: { kind: 'suite', suite: 'standard' } };
    const onlyPlan = { selection: { kind: 'only', member: 'lint' } };
    const onlyReport = checkReport({
      selection: { kind: 'only', member: 'lint' },
      results: [{ id: 'lint', status: 'pass', duration_ms: 1, effect: 'read' }],
    });
    boundary.resolveCheckPlan
      .mockReturnValueOnce(defaultPlan)
      .mockReturnValueOnce(onlyPlan)
      .mockReturnValueOnce(onlyPlan);
    boundary.runCheckPlan
      .mockResolvedValueOnce(checkReport())
      .mockResolvedValueOnce(onlyReport)
      .mockResolvedValueOnce(onlyReport);

    await invoke([]);
    const machine = await invoke(['--only', 'lint']);
    const human = await invoke(['--only', 'lint', '--human']);

    expect(boundary.resolveCheckPlan.mock.calls[0]).toEqual([process.cwd(), {}]);
    expect(boundary.resolveCheckPlan.mock.calls[1]).toEqual([process.cwd(), { only: 'lint' }]);
    expect(JSON.parse(machine.stdout)).toEqual(onlyReport);
    expect(human.stdout).toBe(
      'check (only lint): execution=PASS readiness=PASS\n' + '  PASS lint (1ms, read)\n',
    );
    expect(boundary.runCheckPlan.mock.calls[0]?.[0]).toBe(defaultPlan);
    const execute = boundary.runCheckPlan.mock.calls[0]?.[1] as (
      member: unknown,
    ) => Promise<unknown>;
    await execute({ id: 'lint' });
    expect(boundary.executeCheckMember).toHaveBeenLastCalledWith(
      { id: 'lint' },
      { repoRoot: process.cwd() },
    );
    expect(boundary.executeCheckMember.mock.lastCall?.[1]).toStrictEqual({
      repoRoot: process.cwd(),
    });
  });

  it.each([
    ['CHECK_SUITE_UNKNOWN: nope', EXIT_USAGE],
    ['CHECK_MEMBER_UNKNOWN: nope', EXIT_USAGE],
    ['CHECK_SELECTION_CONFLICT: both selected', EXIT_USAGE],
    ['CHECK_RUNNER_BASE_REQUIRED: exact base missing', EXIT_USAGE],
    ['CHECK_RUNNER_TIMEOUT: must be positive', EXIT_USAGE],
    ['unexpected plan failure', EXIT_FAIL],
  ] as const)('maps canonical-plan error %s', async (message, exit) => {
    boundary.resolveCheckPlan.mockImplementationOnce(() => {
      throw new Error(message);
    });
    const result = await invoke([]);
    expect(result).toEqual({ stdout: '', stderr: `devai check: ${message}\n`, exit });
  });

  it.each([
    'prefix CHECK_SUITE_UNKNOWN',
    'suffix CHECK_MEMBER_UNKNOWN',
    'almost CHECK_SELECTION_CONFLICT',
    'CHECK_RUNNER_SELECTION',
    'CHECK_RUNNER_BASE_REQUIRED',
    'CHECK_RUNNER_TIMEOUT',
  ])('does not misclassify non-prefixed or incomplete usage code %s', async (message) => {
    boundary.resolveCheckPlan.mockImplementationOnce(() => {
      throw new Error(message);
    });
    const result = await invoke([]);
    expect(result.exit).toBe(EXIT_FAIL);
  });
});
