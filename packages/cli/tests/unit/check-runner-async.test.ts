import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { runCheckTasks, runCheckTasksAsync } from '../../src/services/check-runner/runner.js';
import type {
  CheckRunnerOptions,
  TaskDescriptor,
  TaskExecutionResult,
} from '../../src/services/check-runner/types.js';

const roots: string[] = [];
const PASS: TaskExecutionResult = { status: 0, signal: null, stdout: '', stderr: '' };
let ordinal = 0;

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

function file(root: string, path: string, bytes: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, 'utf8');
}

function descriptor(): TaskDescriptor {
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'async-runner-v1',
    repositoryId: 'example/async-runner',
    fallbackNodeId: 'test:local-full',
    dynamicFallbackSelectors: [],
    tasks: [
      {
        nodeId: 'build',
        dependencies: [],
        argv: ['node', 'build'],
        cwd: '.',
        runner: 'node-v1',
        inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
        toolchainKeys: ['node'],
        allowlistedEnv: ['CI'],
        outputContract: { kind: 'build', paths: ['dist/build.json'] },
      },
      {
        nodeId: 'test:unit',
        dependencies: ['build'],
        argv: ['node', 'unit'],
        cwd: '.',
        runner: 'node-v1',
        inputSelectors: [{ kind: 'prefix', pattern: 'tests/' }],
        toolchainKeys: ['node'],
        allowlistedEnv: ['CI'],
        outputContract: { kind: 'test', requiredResult: 'pass' },
      },
      {
        nodeId: 'test:local-full',
        dependencies: ['test:unit'],
        argv: ['node', 'local'],
        cwd: '.',
        runner: 'node-v1',
        inputSelectors: [{ kind: 'glob', pattern: '**' }],
        toolchainKeys: ['node'],
        allowlistedEnv: ['CI'],
        outputContract: { kind: 'marker', value: 'local' },
      },
    ],
    profiles: [
      {
        profileId: 'affected',
        mode: 'affected',
        requiredNodes: ['build'],
        eligibleNodes: ['build', 'test:unit', 'test:local-full'],
      },
      { profileId: 'rc', mode: 'fixed', requiredNodes: ['test:local-full'] },
    ],
  };
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-check-runner-async-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Async Runner']);
  git(root, ['config', 'user.email', 'async-runner@example.invalid']);
  file(root, '.gitignore', '.devai/state/*\ndist/\n');
  file(root, 'package.json', '{"name":"example-async-runner","version":"1.0.0"}\n');
  file(root, 'src/main.ts', 'export const value = 1;\n');
  file(root, 'tests/main.test.ts', 'test(value);\n');
  file(root, 'test-tasks.json', `${JSON.stringify(descriptor(), null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

async function withScope<T>(callback: () => Promise<T>): Promise<T> {
  ordinal += 1;
  const id = `check-runner-async-${String(ordinal)}`;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'check-runner-async-test',
    issuer_version: '1.0.0',
    invocation_id: id,
    canonicalSha256: () => 'c'.repeat(64),
    randomId: () => `${id}-receipt`,
    now: () => '2026-09-04T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'check',
    invocation_id: id,
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return await runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

type RunnerExecutor = (
  ...args: Parameters<NonNullable<CheckRunnerOptions['executeTask']>>
) =>
  | ReturnType<NonNullable<CheckRunnerOptions['executeTask']>>
  | Promise<ReturnType<NonNullable<CheckRunnerOptions['executeTask']>>>;

function options<T extends RunnerExecutor>(
  root: string,
  executeTask: T,
): Omit<CheckRunnerOptions, 'executeTask'> & { readonly executeTask: T } {
  return {
    repoRoot: root,
    target: 'local',
    operation: 'run',
    descriptorDocument: descriptor(),
    toolchain: { node: 'v-test' },
    environment: { CI: '1' },
    executeTask,
    now: () => '2026-09-04T00:00:00.000Z',
  };
}

function writeBuild(root: string): void {
  file(root, 'dist/build.json', '{"built":true}\n');
}

function executionSemantics(report: Awaited<ReturnType<typeof runCheckTasksAsync>>) {
  return report.execution?.map(
    ({ durationMs: _durationMs, diagnosticPath: _diagnosticPath, ...entry }) => entry,
  );
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

describe('internal asynchronous check runner', () => {
  it('awaits each task before its dependent and snapshots caller-owned options across the wait', async () => {
    const root = repository();
    const order: string[] = [];
    const environments: string[] = [];
    let releaseBuild: (() => void) | undefined;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const input = options(root, async (argv, _cwd, _timeout, environment) => {
      const task = argv[1] ?? '';
      order.push(task);
      environments.push(environment.CI ?? 'missing');
      if (task === 'build') {
        writeBuild(root);
        await buildGate;
      }
      return PASS;
    });
    const pending = withScope(() => runCheckTasksAsync(input));
    await Promise.resolve();
    expect(order).toEqual(['build']);
    (input.environment as Record<string, string>).CI = 'mutated';
    ((input.descriptorDocument?.tasks[1]?.argv as string[]) ?? []).splice(1, 1, 'mutated-unit');
    if (releaseBuild === undefined) throw new Error('async build was not started');
    releaseBuild();
    const report = await pending;
    expect(order).toEqual(['build', 'unit', 'local']);
    expect(environments).toEqual(['1', '1', '1']);
    expect(report.execution?.map((entry) => entry.outcome)).toEqual(['PASS', 'PASS', 'PASS']);
  });

  it('records a failed dependency and aborts its dependents without a receipt', async () => {
    const root = repository();
    const calls: string[] = [];
    const report = await withScope(() =>
      runCheckTasksAsync({
        ...options(root, async (argv) => {
          calls.push(argv[1] ?? '');
          return { ...PASS, status: 1 };
        }),
      }),
    );
    expect(calls).toEqual(['build']);
    expect(report.execution).toMatchObject([
      { nodeId: 'build', outcome: 'FAIL', disposition: 'executed' },
      { nodeId: 'test:unit', outcome: 'ABORTED', disposition: 'aborted' },
      { nodeId: 'test:local-full', outcome: 'ABORTED', disposition: 'aborted' },
    ]);
    expect(report.receipt).toBeUndefined();
    expect(report.receiptRefusal).toBe('local-target-not-attestable');
  });

  it('does not turn a rejected executor promise into a pass or receipt', async () => {
    const root = repository();
    await expect(
      withScope(() =>
        runCheckTasksAsync({
          ...options(root, async () => Promise.reject(new Error('transport-rejected'))),
        }),
      ),
    ).rejects.toThrow('transport-rejected');
    expect(existsSync(join(root, '.devai/state/check-cache/v1/results'))).toBe(false);
  });

  it('validates a resolved successful task output before allowing a dependent', async () => {
    const root = repository();
    const calls: string[] = [];
    const report = await withScope(() =>
      runCheckTasksAsync({
        ...options(root, async (argv) => {
          calls.push(argv[1] ?? '');
          return PASS;
        }),
      }),
    );
    expect(calls).toEqual(['build']);
    expect(report.execution).toMatchObject([
      {
        nodeId: 'build',
        outcome: 'FAIL',
        reason: expect.stringContaining('CHECK_RUNNER_OUTPUT_MISSING'),
      },
      { nodeId: 'test:unit', outcome: 'ABORTED' },
      { nodeId: 'test:local-full', outcome: 'ABORTED' },
    ]);
  });

  it('shares synchronous planning, reports, and reusable cache behavior', async () => {
    const root = repository();
    const syncReport = await withScope(async () =>
      runCheckTasks(
        options(root, (argv) => {
          if (argv[1] === 'build') writeBuild(root);
          return PASS;
        }),
      ),
    );
    rmSync(join(root, '.devai/state/check-cache'), { recursive: true, force: true });
    const asyncReport = await withScope(() =>
      runCheckTasksAsync({
        ...options(root, async (argv) => {
          if (argv[1] === 'build') writeBuild(root);
          return PASS;
        }),
      }),
    );
    expect(asyncReport.plan).toEqual(syncReport.plan);
    expect(executionSemantics(asyncReport)).toEqual(executionSemantics(syncReport));

    const syncReuse = await withScope(async () => runCheckTasks(options(root, () => PASS)));
    const asyncReuse = await withScope(() =>
      runCheckTasksAsync({ ...options(root, async () => PASS) }),
    );
    expect(executionSemantics(asyncReuse)).toEqual(executionSemantics(syncReuse));
    expect(asyncReuse.execution?.every((entry) => entry.disposition === 'reused')).toBe(true);
  });

  it('keeps plan-only execution callback-free and preserves the mutation-required refusal', async () => {
    const root = repository();
    let callbacks = 0;
    const plan = await withScope(() =>
      runCheckTasksAsync({
        ...options(root, async () => {
          callbacks += 1;
          return PASS;
        }),
        operation: 'plan',
      }),
    );
    expect(plan.execution).toBeUndefined();
    expect(callbacks).toBe(0);

    file(root, 'package.json', '{"name":"example-async-runner","version":"1.0.1"}\n');
    git(root, ['add', 'package.json']);
    git(root, ['commit', '-qm', 'release']);
    const candidate = {
      commit: git(root, ['rev-parse', 'HEAD']),
      tree: git(root, ['rev-parse', 'HEAD^{tree}']),
    };
    const base = git(root, ['rev-parse', 'HEAD~1']);
    const releaseProfile = {
      schemaVersion: '1.0.0',
      policy_id: 'example.release',
      policy_version: '1.0.0',
      release_unit: 'example/async-runner',
      version_source: 'package.json',
      default_support: 'current',
      capability_tasks: Object.fromEntries(
        [
          'formatting-hygiene',
          'lint',
          'type-integrity',
          'schema-consistency',
          'secret-scan',
          'path-portability',
          'package-integrity',
          'exact-candidate',
          'affected-checks',
          'dependent-checks',
          'build-integrity',
        ].map((capability) => [capability, ['test:unit']]),
      ),
      risk_capabilities: {},
      mutation_roster: [
        {
          id: 'unit',
          package: 'example-async-runner',
          task_node: 'test:unit',
          source_selectors: ['src/'],
          test_selectors: ['tests/'],
          manifest_path: 'package.json',
          config_paths: ['test-tasks.json'],
          sanitizer_paths: ['tools/mutation-sanitizer.mjs'],
          orchestration_paths: ['test-tasks.json'],
          lockfile_path: 'package.json',
          toolchain_keys: ['node'],
          thresholds: { score_min: 90 },
        },
      ],
    };
    await expect(
      withScope(() =>
        runCheckTasksAsync({
          ...options(root, async () => {
            callbacks += 1;
            return PASS;
          }),
          target: 'release',
          baseCommit: base,
          releaseStage: 'certify',
          releaseIntent: {
            schemaVersion: '1.0.0',
            release_unit: 'example/async-runner',
            current_version: '1.0.0',
            target_version: '1.0.1',
            support: 'current',
            change_kind: 'behavioral',
            changed_paths: ['package.json'],
            changed_packages: [],
            candidate,
            base: { commit: base, tree: git(root, ['rev-parse', `${base}^{tree}`]) },
          },
          releaseProfile,
        }),
      ),
    ).rejects.toThrow('CHECK_RELEASE_MUTATION_EVIDENCE_UNAVAILABLE');
    expect(callbacks).toBe(0);
  });
});
