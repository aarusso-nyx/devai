import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
  type AuthorityHostEffectRequest,
} from '@devai-nyx/authority';
import { afterEach, describe, expect, it } from 'vitest';
import { invocationIsNonMutating } from '../../src/command-router.js';
import {
  buildTaskPlan,
  matchDeclaredCheckTaskProcess,
  readTaskDescriptor,
  runCheckTasks,
  sha256Hex,
  type CheckRunnerOptions,
  type TaskExecutionResult,
} from '../../src/services/check-runner/index.js';

const roots: string[] = [];
const TOOLCHAIN = { node: 'v-test' } as const;
const PASS: TaskExecutionResult = {
  status: 0,
  signal: null,
  stdout: 'ok\n',
  stderr: '',
};
let invocationOrdinal = 0;

function withRunnerScope<T>(callback: () => T): T {
  invocationOrdinal += 1;
  const invocationId = `check-runner-test-${String(invocationOrdinal)}`;
  let receiptOrdinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'check-runner-test',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256: () => 'c'.repeat(64),
    randomId: () => `${invocationId}-${String(++receiptOrdinal)}`,
    now: () => '2026-08-10T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'check',
    invocation_id: invocationId,
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

function file(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function descriptor() {
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'test-v1',
    repositoryId: 'example/repo',
    fallbackNodeId: 'test:local-full',
    dynamicFallbackSelectors: [{ kind: 'prefix', pattern: 'scripts/dynamic/' }],
    tasks: [
      {
        nodeId: 'generate',
        dependencies: [],
        argv: ['node', '-e', 'process.stdout.write("generated")'],
        cwd: '.',
        runner: 'node-v1',
        inputSelectors: [
          { kind: 'exact', pattern: 'config.json' },
          { kind: 'exact', pattern: 'lock.yaml' },
        ],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'tracked-files', paths: ['generated.txt'] },
      },
      {
        nodeId: 'test:unit',
        dependencies: ['generate'],
        argv: ['node', '-e', 'process.stdout.write("unit")'],
        cwd: '.',
        runner: 'node-v1',
        inputSelectors: [
          { kind: 'prefix', pattern: 'src/' },
          { kind: 'prefix', pattern: 'tests/' },
          { kind: 'exact', pattern: 'helpers.ts' },
          { kind: 'exact', pattern: 'config.json' },
          { kind: 'exact', pattern: 'lock.yaml' },
        ],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'test', requiredResult: 'pass' },
      },
      {
        nodeId: 'test:local-full',
        dependencies: ['test:unit'],
        argv: ['node', '-e', "process.stdout.write('local test dependency closure complete\\n')"],
        cwd: '.',
        runner: 'node-v1',
        inputSelectors: [{ kind: 'glob', pattern: '**' }],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'marker', value: 'local' },
      },
      {
        nodeId: 'test:rc',
        dependencies: ['test:unit'],
        argv: ['node', '-e', 'process.stdout.write("rc")'],
        cwd: '.',
        runner: 'node-v1',
        inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'test', requiredResult: 'pass' },
      },
    ],
    profiles: [
      {
        profileId: 'affected',
        mode: 'affected',
        requiredNodes: ['generate'],
        eligibleNodes: ['generate', 'test:unit', 'test:local-full'],
      },
      { profileId: 'rc', mode: 'fixed', requiredNodes: ['test:rc'] },
    ],
  } as const;
}

function repository(): Readonly<{ root: string; base: string }> {
  const root = mkdtempSync(join(tmpdir(), 'devai-check-runner-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Runner Test']);
  git(root, ['config', 'user.email', 'runner@example.invalid']);
  file(root, '.gitignore', '.devai/state/*\n');
  file(root, 'test-tasks.json', `${JSON.stringify(descriptor(), null, 2)}\n`);
  file(root, 'src/app.ts', 'export const value = 1;\n');
  file(root, 'tests/app.test.ts', 'test(value);\n');
  file(root, 'helpers.ts', 'export const helper = true;\n');
  file(root, 'config.json', '{"enabled":true}\n');
  file(root, 'lock.yaml', 'version: 1\n');
  file(root, 'generated.txt', 'generated\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return { root, base: git(root, ['rev-parse', 'HEAD']) };
}

function commit(root: string, path: string, content: string): string {
  file(root, path, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', `change ${path}`]);
  return git(root, ['rev-parse', 'HEAD']);
}

function plan(root: string, target: 'affected' | 'local' | 'rc', baseCommit?: string) {
  const cacheResults = new Map<string, string>();
  return withRunnerScope(() =>
    buildTaskPlan({
      repoRoot: root,
      descriptor: readTaskDescriptor(join(root, 'test-tasks.json')),
      target,
      ...(baseCommit !== undefined && { baseCommit }),
      toolchain: TOOLCHAIN,
      environment: {},
      cacheState(task) {
        const dependenciesReady = task.dependencies.every((dependency) =>
          cacheResults.has(dependency),
        );
        return {
          cacheState: dependenciesReady ? ('execute' as const) : ('execute' as const),
          reason: dependenciesReady ? 'cache-miss' : 'dependency-not-reusable',
        };
      },
    }),
  );
}

function run(root: string, overrides: Partial<CheckRunnerOptions> = {}) {
  return withRunnerScope(() =>
    runCheckTasks({
      repoRoot: root,
      target: 'local',
      operation: 'run',
      toolchain: TOOLCHAIN,
      environment: {},
      executeTask: () => PASS,
      now: () => '2026-08-10T00:00:00.000Z',
      ...overrides,
    }),
  );
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

describe('content-addressed check runner', () => {
  it('builds the runtime before every local lane that executes built artifacts', () => {
    const actual = readTaskDescriptor(
      fileURLToPath(new URL('../../../../test-tasks.json', import.meta.url)),
    );
    for (const nodeId of ['test:cli', 'test:skills', 'test:root']) {
      expect(actual.tasks.find((task) => task.nodeId === nodeId)?.dependencies).toContain('build');
    }
    expect(actual.tasks.find((task) => task.nodeId === 'test:schemas')).toMatchObject({
      argv: ['pnpm', 'run', 'test:schemas'],
    });
    expect(actual.tasks.find((task) => task.nodeId === 'test:local-full')?.dependencies).toContain(
      'test:schemas',
    );
    expect(actual.tasks.find((task) => task.nodeId === 'build')?.outputContract).toMatchObject({
      paths: ['scratch/coverage/rc-reachable-sources.json'],
    });
    expect(actual.tasks.find((task) => task.nodeId === 'test:coverage:rc')?.dependencies).toEqual([
      'build',
    ]);
  });

  it.each([
    ['source', 'src/app.ts', 'export const value = 2;\n'],
    ['test', 'tests/app.test.ts', 'test(newValue);\n'],
    ['helper', 'helpers.ts', 'export const helper = false;\n'],
    ['config', 'config.json', '{"enabled":false}\n'],
    ['lockfile', 'lock.yaml', 'version: 2\n'],
  ])('invalidates the owning concern for a %s change', (_label, path, content) => {
    const state = repository();
    commit(state.root, path, content);
    const affected = plan(state.root, 'affected', state.base);
    expect(affected.changedPaths).toEqual([path]);
    expect(affected.tasks.map((task) => task.nodeId)).toContain('test:unit');
    expect(affected.tasks.map((task) => task.nodeId)).not.toContain('test:rc');
    expect(
      affected.tasks.find((task) => task.nodeId === 'test:unit')?.matchedChangedPaths,
    ).toContain(path);
    expect(affected.tasks.map((task) => task.nodeId)).not.toContain('test:local-full');
  });

  it('accounts for both sides of renames and for deleted paths', () => {
    const renamed = repository();
    git(renamed.root, ['mv', 'src/app.ts', 'src/renamed.ts']);
    git(renamed.root, ['commit', '-qm', 'rename']);
    expect(plan(renamed.root, 'affected', renamed.base).changedPaths).toEqual([
      'src/app.ts',
      'src/renamed.ts',
    ]);

    const deleted = repository();
    rmSync(join(deleted.root, 'helpers.ts'));
    git(deleted.root, ['add', '-A']);
    git(deleted.root, ['commit', '-qm', 'delete']);
    const deletedPlan = plan(deleted.root, 'affected', deleted.base);
    expect(deletedPlan.changedPaths).toEqual(['helpers.ts']);
    expect(deletedPlan.tasks.map((task) => task.nodeId)).toContain('test:unit');
  });

  it('widens dynamic and unknown changes to the declared full local fallback', () => {
    const dynamic = repository();
    commit(dynamic.root, 'scripts/dynamic/load.mjs', 'export {};\n');
    const dynamicPlan = plan(dynamic.root, 'affected', dynamic.base);
    expect(dynamicPlan.tasks.map((task) => task.nodeId)).toContain('test:local-full');
    expect(dynamicPlan.tasks.map((task) => task.nodeId)).toContain('test:unit');

    const unknown = repository();
    commit(unknown.root, 'notes/new.txt', 'unknown\n');
    const unknownPlan = plan(unknown.root, 'affected', unknown.base);
    expect(unknownPlan.tasks.map((task) => task.nodeId)).toContain('test:local-full');
    expect(unknownPlan.tasks.map((task) => task.nodeId)).toContain('test:unit');
  });

  it('propagates dependency-key invalidation without commit identity in reusable keys', () => {
    const state = repository();
    const initial = plan(state.root, 'local');
    const initialUnit = initial.tasks.find((task) => task.nodeId === 'test:unit');
    const initialGenerate = initial.tasks.find((task) => task.nodeId === 'generate');
    commit(state.root, 'config.json', '{"enabled":false}\n');
    const changed = plan(state.root, 'local');
    expect(changed.tasks.find((task) => task.nodeId === 'generate')?.taskKey).not.toBe(
      initialGenerate?.taskKey,
    );
    expect(changed.tasks.find((task) => task.nodeId === 'test:unit')?.taskKey).not.toBe(
      initialUnit?.taskKey,
    );

    commit(state.root, 'config.json', '{"enabled":true}\n');
    const restored = plan(state.root, 'local');
    expect(restored.tasks.find((task) => task.nodeId === 'generate')?.taskKey).toBe(
      initialGenerate?.taskKey,
    );
    expect(restored.tasks.find((task) => task.nodeId === 'test:unit')?.taskKey).toBe(
      initialUnit?.taskKey,
    );
    expect(restored.repository.commit).not.toBe(initial.repository.commit);
  });

  it('does not require release-candidate toolchains for the cheap local closure', () => {
    const state = repository();
    const declared = JSON.parse(readFileSync(join(state.root, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<{ nodeId: string; toolchainKeys: string[] }>;
    };
    const rcTask = declared.tasks.find((task) => task.nodeId === 'test:rc');
    if (rcTask === undefined) throw new Error('test fixture is missing test:rc');
    rcTask.toolchainKeys = ['rc-only-toolchain'];
    writeFileSync(join(state.root, 'test-tasks.json'), `${JSON.stringify(declared, null, 2)}\n`);

    expect(() => run(state.root)).not.toThrow();
    expect(() => plan(state.root, 'rc')).toThrow(/CHECK_RUNNER_TOOLCHAIN_MISSING/u);
  });

  it('preserves absent allowlisted environment and binds it distinctly from explicit empty', () => {
    const state = repository();
    const environmentKey = 'DEVAI_CHECK_RUNNER_OPTIONAL_FIXTURE';
    const declared = JSON.parse(readFileSync(join(state.root, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<{
        nodeId: string;
        argv: string[];
        allowlistedEnv: string[];
      }>;
    };
    const rcTask = declared.tasks.find((task) => task.nodeId === 'test:rc');
    if (rcTask === undefined) throw new Error('test fixture is missing test:rc');
    rcTask.allowlistedEnv = [environmentKey];
    rcTask.argv = [
      'node',
      '-e',
      `process.exit(process.env.${environmentKey} === undefined ? 0 : 7)`,
    ];
    writeFileSync(join(state.root, 'test-tasks.json'), `${JSON.stringify(declared, null, 2)}\n`);

    const previousValue = process.env[environmentKey];
    delete process.env[environmentKey];
    try {
      const absent = withRunnerScope(() =>
        runCheckTasks({
          repoRoot: state.root,
          target: 'rc',
          operation: 'run',
          cacheRoot: join(state.root, '.devai/state/absent-cache'),
          toolchain: TOOLCHAIN,
          environment: {},
          now: () => '2026-08-10T00:00:00.000Z',
        }),
      );
      const explicitEmpty = withRunnerScope(() =>
        runCheckTasks({
          repoRoot: state.root,
          target: 'rc',
          operation: 'run',
          cacheRoot: join(state.root, '.devai/state/empty-cache'),
          toolchain: TOOLCHAIN,
          environment: { [environmentKey]: '' },
          now: () => '2026-08-10T00:00:00.000Z',
        }),
      );
      const absentTask = absent.plan.tasks.find((task) => task.nodeId === 'test:rc');
      const emptyTask = explicitEmpty.plan.tasks.find((task) => task.nodeId === 'test:rc');

      expect(absent.exitCode).toBe(0);
      expect(absent.execution?.find((task) => task.nodeId === 'test:rc')).toMatchObject({
        outcome: 'PASS',
        exitCode: 0,
      });
      expect(explicitEmpty.exitCode).toBe(1);
      expect(explicitEmpty.execution?.find((task) => task.nodeId === 'test:rc')).toMatchObject({
        outcome: 'FAIL',
        exitCode: 7,
      });
      expect(absentTask?.taskKey).not.toBe(emptyTask?.taskKey);
      expect(absentTask?.inputDigest).not.toBe(emptyTask?.inputDigest);
    } finally {
      if (previousValue === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = previousValue;
    }
  });

  it('reuses PASS only, binds output digests, and detects changed durable output', () => {
    const state = repository();
    const first = run(state.root);
    expect(first.execution?.every((task) => task.disposition === 'executed')).toBe(true);
    const generateResult = first.execution?.find((task) => task.nodeId === 'generate');
    expect(generateResult?.resultDigest).toMatch(/^[0-9a-f]{64}$/u);
    const stored = JSON.parse(
      readFileSync(
        join(
          state.root,
          '.devai/state/check-cache/v1/results',
          `${generateResult?.resultDigest}.json`,
        ),
        'utf8',
      ),
    ) as { outputDigests: Record<string, string> };
    expect(Object.keys(stored).sort()).toEqual(
      [
        'dependencyResultDigests',
        'finishedAt',
        'inputDigest',
        'nodeId',
        'outputDigests',
        'schemaVersion',
        'startedAt',
        'status',
        'taskKey',
      ].sort(),
    );
    expect(stored.outputDigests.stdout).toBe(sha256Hex(Buffer.from('ok\n')));
    expect(stored.outputDigests['generated.txt']).toBe(
      sha256Hex(readFileSync(join(state.root, 'generated.txt'))),
    );

    const second = run(state.root);
    expect(second.execution?.every((task) => task.disposition === 'reused')).toBe(true);
    file(state.root, 'generated.txt', 'tampered\n');
    const status = run(state.root, { operation: 'status' });
    expect(status.plan.tasks.find((task) => task.nodeId === 'generate')).toMatchObject({
      cacheState: 'stale',
      reason: 'output-digest-changed',
    });
  });

  it('binds declared generated artifacts for non-file-specific output contracts', () => {
    const state = repository();
    const declared = JSON.parse(readFileSync(join(state.root, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<{ nodeId: string; outputContract: Record<string, unknown> }>;
    };
    const generate = declared.tasks.find((task) => task.nodeId === 'generate');
    if (generate === undefined) throw new Error('test fixture is missing generate');
    generate.outputContract = {
      kind: 'workspace-build',
      requiredResult: 'pass',
      paths: ['generated.txt'],
    };
    writeFileSync(join(state.root, 'test-tasks.json'), `${JSON.stringify(declared, null, 2)}\n`);

    const first = run(state.root);
    expect(first.execution?.every((task) => task.outcome === 'PASS')).toBe(true);
    file(state.root, 'generated.txt', 'changed outside the build result\n');
    const status = run(state.root, { operation: 'status' });
    expect(status.plan.tasks.find((task) => task.nodeId === 'generate')).toMatchObject({
      cacheState: 'stale',
      reason: 'output-digest-changed',
    });
  });

  it('persists bounded private failure diagnostics without adding content to the report', () => {
    const state = repository();
    const marker = 'private-diagnostic-marker';
    const failed: TaskExecutionResult = {
      status: 9,
      signal: null,
      stdout: `stdout-${marker}-${'x'.repeat(20_000)}`,
      stderr: `stderr-${marker}-${'y'.repeat(20_000)}`,
    };
    const report = run(state.root, { executeTask: () => failed });
    const diagnosticPath = report.execution?.[0]?.diagnosticPath;

    expect(report.execution?.[0]).toMatchObject({
      outcome: 'FAIL',
      reason: 'process-exit-9',
      exitCode: 9,
    });
    expect(diagnosticPath).toBeDefined();
    expect(statSync(diagnosticPath ?? '').mode & 0o777).toBe(0o600);
    const diagnosticBytes = readFileSync(diagnosticPath ?? '');
    const diagnostic = JSON.parse(diagnosticBytes.toString('utf8')) as {
      stdoutTail: string;
      stderrTail: string;
    };
    expect(Buffer.byteLength(diagnostic.stdoutTail)).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(diagnostic.stderrTail)).toBeLessThanOrEqual(8 * 1024);
    expect(JSON.stringify(report)).not.toContain(marker);
    expect(report.receipt).toBeUndefined();
  });

  it.each([
    ['FAIL', { status: 1, signal: null, stdout: '', stderr: 'failed' }],
    [
      'TIMEOUT',
      { status: null, signal: 'SIGTERM', stdout: '', stderr: '', errorCode: 'ETIMEDOUT' },
    ],
    ['KILLED', { status: null, signal: 'SIGKILL', stdout: '', stderr: '' }],
  ] as const)('never reuses a %s attempt', (outcome, failed) => {
    const state = repository();
    const first = run(state.root, { executeTask: () => failed });
    expect(first.execution?.[0]).toMatchObject({ outcome, disposition: 'executed' });
    const second = run(state.root);
    expect(second.execution?.[0]).toMatchObject({ outcome: 'PASS', disposition: 'executed' });
    expect(second.execution?.[0]?.reason).toBe(`previous-${outcome.toLowerCase()}`);
  });

  it('allows dirty iteration but refuses every candidate receipt from a dirty tree', () => {
    const state = repository();
    file(state.root, 'src/app.ts', 'export const value = 99;\n');
    const report = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
    });
    expect(report.plan.clean).toBe(false);
    expect(report.execution?.every((task) => task.outcome === 'PASS')).toBe(true);
    expect(report.receipt).toBeUndefined();
    expect(report.receiptRefusal).toBe('dirty-start');
  });

  it('refuses a candidate receipt when execution changes the committed tree', () => {
    const state = repository();
    commit(state.root, 'src/app.ts', 'export const value = 2;\n');
    let ordinal = 0;
    const report = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
      executeTask: () => {
        ordinal += 1;
        if (ordinal === 1) file(state.root, 'src/app.ts', 'export const value = 3;\n');
        return PASS;
      },
    });
    expect(report.execution?.every((task) => task.outcome === 'PASS')).toBe(true);
    expect(report.receipt).toBeUndefined();
    expect(report.receiptRefusal).toBe('repository-changed-during-run');
  });

  it('emits verifier-shaped unsigned results and a clean exact-tree candidate receipt', () => {
    const state = repository();
    commit(state.root, 'src/app.ts', 'export const value = 2;\n');
    const report = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
    });
    expect(report.receiptRefusal).toBeUndefined();
    expect(report.receipt?.value).toMatchObject({
      schemaVersion: '1.0.0',
      profile: 'affected',
      repository: {
        id: 'example/repo',
        commit: git(state.root, ['rev-parse', 'HEAD']),
        tree: git(state.root, ['show', '-s', '--format=%T', 'HEAD']),
      },
      taskPolicyDigest: report.plan.taskPolicyDigest,
    });
    expect(report.receipt?.value.tasks).toHaveLength(report.plan.tasks.length);
    const receiptBytes = readFileSync(report.receipt?.path ?? '', 'utf8');
    expect(Object.keys(JSON.parse(receiptBytes) as object).sort()).toEqual(
      ['createdAt', 'profile', 'repository', 'schemaVersion', 'taskPolicyDigest', 'tasks'].sort(),
    );
    expect(receiptBytes).not.toContain('signature');
  });

  it('authorizes only exact descriptor argv and repository-contained cwd for --run', () => {
    const state = repository();
    const request = (
      executable: string,
      argv: readonly string[],
      cwd: string,
      shell: boolean | undefined = undefined,
    ): AuthorityHostEffectRequest => ({
      kind: 'process',
      symbol: 'spawnSync',
      arguments: [executable, argv, { cwd, ...(shell !== undefined && { shell }) }],
    });
    const invocation = ['node', 'devai', 'check', '--local', '--run', '--write'];
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request(
          'node',
          ['-e', "process.stdout.write('local test dependency closure complete\\n')"],
          state.root,
          false,
        ),
      ),
    ).toMatchObject({ nodeId: 'test:local-full', cwd: realpathSync(state.root) });
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        ['node', 'devai', 'check', '--suite', 'quick', '--write'],
        request(
          'node',
          ['-e', "process.stdout.write('local test dependency closure complete\\n')"],
          state.root,
          false,
        ),
      ),
    ).toMatchObject({ nodeId: 'test:local-full', cwd: realpathSync(state.root) });
    const declared = JSON.parse(readFileSync(join(state.root, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<Record<string, unknown>>;
    };
    declared.tasks.push({
      nodeId: 'build',
      dependencies: [],
      argv: ['pnpm', '-r', 'build'],
      cwd: '.',
      runner: 'pnpm-v1',
      inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
      toolchainKeys: ['pnpm'],
      allowlistedEnv: [],
      outputContract: { kind: 'build', requiredResult: 'pass' },
    });
    writeFileSync(join(state.root, 'test-tasks.json'), `${JSON.stringify(declared, null, 2)}\n`);
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request('pnpm', ['-r', 'build'], state.root, false),
      ),
    ).toMatchObject({ nodeId: 'build', cwd: realpathSync(state.root) });
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request('sh', ['-c', 'node test'], state.root),
      ),
    ).toBeUndefined();
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request('node', ['-e', 'process.stdout.write("different")'], state.root),
      ),
    ).toBeUndefined();
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request(
          'node',
          ['-e', "process.stdout.write('local test dependency closure complete\\n')"],
          dirname(state.root),
        ),
      ),
    ).toBeUndefined();
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request(
          'node',
          ['-e', "process.stdout.write('local test dependency closure complete\\n')"],
          state.root,
          true,
        ),
      ),
    ).toBeUndefined();
  });

  it('keeps planning/status/explain read-only while --run requires write consent', () => {
    for (const operation of ['--task-plan', '--status', '--explain']) {
      expect(invocationIsNonMutating('check', ['--local', operation])).toBe(true);
    }
    expect(invocationIsNonMutating('check', ['--local', '--run'])).toBe(false);
  });
});
