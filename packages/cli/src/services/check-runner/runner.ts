import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from '@devai-nyx/authority';
import { CheckCache } from './cache.js';
import { sha256Hex } from './canonical.js';
import { buildTaskPlan, currentRepositoryState, readTaskDescriptor } from './policy.js';
import type {
  CandidateReceipt,
  CheckRunnerOptions,
  CheckRunnerReport,
  ExecutedTask,
  PlannedTask,
  TaskDescriptorNode,
  TaskExecutionResult,
  TaskOutcome,
  TaskResult,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

function commandVersion(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8', timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `CHECK_RUNNER_TOOLCHAIN_MISSING: ${command}: ${result.error?.message ?? String(result.stderr).trim()}`,
    );
  }
  return String(result.stdout).trim();
}

function packageVersion(repoRoot: string, packageName: string): string {
  try {
    const value = JSON.parse(
      readFileSync(join(repoRoot, 'node_modules', packageName, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof value.version !== 'string' || value.version === '')
      throw new Error('version missing');
    return `${packageName}@${value.version}`;
  } catch (error) {
    throw new Error(
      `CHECK_RUNNER_TOOLCHAIN_MISSING: ${packageName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function resolveRunnerToolchain(
  repoRoot: string,
  requiredKeys: readonly string[],
): Readonly<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const key of [...new Set(requiredKeys)].sort()) {
    if (key === 'node') resolved[key] = process.version;
    else if (key === 'pnpm') resolved[key] = commandVersion('pnpm', ['--version'], repoRoot);
    else if (key === 'vitest') resolved[key] = packageVersion(repoRoot, 'vitest');
    else if (key === 'typescript') resolved[key] = packageVersion(repoRoot, 'typescript');
    else if (key === 'postgres') {
      resolved[key] = commandVersion('psql', ['--version'], repoRoot);
    } else {
      throw new Error(`CHECK_RUNNER_TOOLCHAIN_MISSING: unsupported key ${key}`);
    }
  }
  return resolved;
}

function defaultExecute(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  environment: Readonly<Record<string, string>>,
): TaskExecutionResult {
  const executionEnvironment: NodeJS.ProcessEnv = {
    ...(process.env.PATH !== undefined && { PATH: process.env.PATH }),
    ...(process.env.HOME !== undefined && { HOME: process.env.HOME }),
    ...(process.env.TMPDIR !== undefined && { TMPDIR: process.env.TMPDIR }),
    CI: '1',
    NO_COLOR: '1',
    ...environment,
  };
  const result = spawnSync(argv[0] ?? '', argv.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: executionEnvironment,
    shell: false,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    ...(result.error !== undefined && {
      errorCode:
        'code' in result.error && typeof result.error.code === 'string'
          ? result.error.code
          : result.error.name,
    }),
  };
}

function executionOutcome(result: TaskExecutionResult): TaskOutcome {
  if (result.status === 0 && result.errorCode === undefined && result.signal === null)
    return 'PASS';
  if (result.errorCode === 'ETIMEDOUT') return 'TIMEOUT';
  if (result.signal !== null) return 'KILLED';
  return 'FAIL';
}

function outputDigests(
  repoRoot: string,
  task: PlannedTask,
  execution: TaskExecutionResult,
): Readonly<Record<string, string>> {
  const digests: Record<string, string> = {
    stdout: sha256Hex(Buffer.from(execution.stdout, 'utf8')),
    stderr: sha256Hex(Buffer.from(execution.stderr, 'utf8')),
  };
  const paths = task.outputContract.paths;
  if (paths !== undefined) {
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string'))
      throw new Error(`CHECK_RUNNER_OUTPUT_CONTRACT: ${task.nodeId} has malformed paths`);
    for (const path of paths as string[]) {
      try {
        digests[path] = sha256Hex(readFileSync(join(repoRoot, path)));
      } catch {
        throw new Error(`CHECK_RUNNER_OUTPUT_MISSING: ${task.nodeId}: ${path}`);
      }
    }
  }
  return digests;
}

function planWithCache(
  options: CheckRunnerOptions,
  cache: CheckCache,
  toolchain: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string>>,
) {
  const descriptorPath = resolve(
    options.descriptorPath ?? join(options.repoRoot, 'test-tasks.json'),
  );
  const descriptor = readTaskDescriptor(descriptorPath);
  const reusableDigests = new Map<string, string>();
  return buildTaskPlan({
    repoRoot: options.repoRoot,
    descriptor,
    target: options.target,
    ...(options.baseCommit !== undefined && { baseCommit: options.baseCommit }),
    toolchain,
    environment,
    cacheState(task) {
      const dependencies: Record<string, string> = {};
      for (const dependency of task.dependencies) {
        const digest = reusableDigests.get(dependency);
        if (digest === undefined) {
          return { cacheState: 'execute' as const, reason: 'dependency-not-reusable' };
        }
        dependencies[dependency] = digest;
      }
      const inspection = cache.inspect(task as PlannedTask, dependencies);
      if (inspection.cachedResultDigest !== undefined) {
        reusableDigests.set(task.nodeId, inspection.cachedResultDigest);
      }
      return {
        cacheState: inspection.cacheState,
        reason: inspection.reason,
        ...(inspection.cachedResultDigest !== undefined && {
          cachedResultDigest: inspection.cachedResultDigest,
        }),
      };
    },
  });
}

function requiredTaskNodes(options: CheckRunnerOptions): readonly TaskDescriptorNode[] {
  const descriptor = readTaskDescriptor(
    resolve(options.descriptorPath ?? join(options.repoRoot, 'test-tasks.json')),
  );
  if (options.target === 'affected') {
    const profile = descriptor.profiles.find((entry) => entry.profileId === 'affected');
    const eligible = new Set(profile?.eligibleNodes ?? []);
    return descriptor.tasks.filter((task) => eligible.has(task.nodeId));
  }
  const roots =
    options.target === 'local'
      ? [descriptor.fallbackNodeId]
      : (descriptor.profiles.find((entry) => entry.profileId === 'rc')?.requiredNodes ?? []);
  const byId = new Map(descriptor.tasks.map((task) => [task.nodeId, task]));
  const selected = new Set<string>();
  const pending = roots.filter((nodeId): nodeId is string => nodeId !== null);
  for (let index = 0; index < pending.length; index += 1) {
    const nodeId = pending[index];
    if (nodeId === undefined || selected.has(nodeId)) continue;
    selected.add(nodeId);
    pending.push(...(byId.get(nodeId)?.dependencies ?? []));
  }
  return descriptor.tasks.filter((task) => selected.has(task.nodeId));
}

function requiredToolchainKeys(options: CheckRunnerOptions): readonly string[] {
  return requiredTaskNodes(options).flatMap((task) => task.toolchainKeys);
}

function requiredEnvironmentKeys(options: CheckRunnerOptions): readonly string[] {
  return requiredTaskNodes(options).flatMap((task) => task.allowlistedEnv);
}

export function runCheckTasks(options: CheckRunnerOptions): CheckRunnerReport {
  const cacheRoot = resolve(
    options.cacheRoot ?? join(options.repoRoot, '.devai/state/check-cache/v1'),
  );
  const cache = new CheckCache(options.repoRoot, cacheRoot);
  const toolchain =
    options.toolchain ?? resolveRunnerToolchain(options.repoRoot, requiredToolchainKeys(options));
  const environment: Record<string, string> = { ...(options.environment ?? {}) };
  for (const key of requiredEnvironmentKeys(options)) {
    const inheritedValue = process.env[key];
    if (environment[key] === undefined && inheritedValue !== undefined) {
      environment[key] = inheritedValue;
    }
  }
  const plan = planWithCache(options, cache, toolchain, environment);
  if (options.operation !== 'run') {
    return { schemaVersion: '1.0.0', operation: options.operation, plan, exitCode: 0 };
  }

  const execute =
    options.executeTask ??
    ((argv: readonly string[], cwd: string, selectedTimeoutMs: number) =>
      defaultExecute(argv, cwd, selectedTimeoutMs, environment));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('CHECK_RUNNER_TIMEOUT: timeout must be a positive integer');
  }
  const now = options.now ?? (() => new Date().toISOString());
  const initialState = currentRepositoryState(options.repoRoot);
  const resultDigests = new Map<string, string>();
  const execution: ExecutedTask[] = [];

  for (const task of plan.tasks) {
    const dependencyResultDigests: Record<string, string> = {};
    let dependencyMissing = false;
    for (const dependency of task.dependencies) {
      const digest = resultDigests.get(dependency);
      if (digest === undefined) dependencyMissing = true;
      else dependencyResultDigests[dependency] = digest;
    }
    if (dependencyMissing) {
      const at = now();
      cache.writeAttempt(task.nodeId, task.taskKey, 'ABORTED', at);
      execution.push({
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        disposition: 'aborted',
        outcome: 'ABORTED',
        reason: 'dependency-not-pass',
        durationMs: 0,
      });
      continue;
    }
    const cached = cache.inspect(task, dependencyResultDigests);
    if (cached.cacheState === 'reusable' && cached.cachedResultDigest !== undefined) {
      resultDigests.set(task.nodeId, cached.cachedResultDigest);
      execution.push({
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        disposition: 'reused',
        outcome: 'PASS',
        reason: cached.reason,
        durationMs: 0,
        resultDigest: cached.cachedResultDigest,
      });
      continue;
    }

    const startedAt = now();
    const started = Date.now();
    const result = execute(task.argv, resolve(options.repoRoot, task.cwd), timeoutMs);
    const durationMs = Math.max(0, Date.now() - started);
    const finishedAt = now();
    const outcome = executionOutcome(result);
    if (outcome !== 'PASS') {
      const reason =
        result.errorCode !== undefined
          ? `process-${result.errorCode}`
          : result.signal !== null
            ? `process-signal-${result.signal}`
            : `process-exit-${String(result.status)}`;
      const diagnosticPath = cache.writeFailureDiagnostic(
        task,
        outcome,
        finishedAt,
        reason,
        result,
      );
      cache.writeAttempt(task.nodeId, task.taskKey, outcome, finishedAt);
      execution.push({
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        disposition: 'executed',
        outcome,
        reason,
        durationMs,
        ...(result.status !== null && { exitCode: result.status }),
        ...(result.signal !== null && { signal: result.signal }),
        diagnosticPath,
      });
      continue;
    }

    let taskResult: TaskResult;
    try {
      taskResult = {
        schemaVersion: '1.0.0',
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        status: 'PASS',
        inputDigest: task.inputDigest,
        dependencyResultDigests,
        outputDigests: outputDigests(options.repoRoot, task, result),
        startedAt,
        finishedAt,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const diagnosticPath = cache.writeFailureDiagnostic(task, 'FAIL', finishedAt, reason, result);
      cache.writeAttempt(task.nodeId, task.taskKey, 'FAIL', finishedAt);
      execution.push({
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        disposition: 'executed',
        outcome: 'FAIL',
        reason,
        durationMs,
        diagnosticPath,
      });
      continue;
    }
    const resultDigest = cache.writeResult(taskResult);
    cache.writeAttempt(task.nodeId, task.taskKey, 'PASS', finishedAt, resultDigest);
    resultDigests.set(task.nodeId, resultDigest);
    execution.push({
      nodeId: task.nodeId,
      taskKey: task.taskKey,
      disposition: 'executed',
      outcome: 'PASS',
      reason: cached.reason,
      durationMs,
      resultDigest,
      exitCode: 0,
    });
  }

  let receipt: CheckRunnerReport['receipt'];
  let receiptRefusal: string | undefined;
  const allPass = execution.every((task) => task.outcome === 'PASS');
  const finalState = currentRepositoryState(options.repoRoot);
  if (options.target === 'local') receiptRefusal = 'local-target-not-attestable';
  else if (!plan.clean || !initialState.clean) receiptRefusal = 'dirty-start';
  else if (!allPass) receiptRefusal = 'task-population-not-pass';
  else if (
    !finalState.clean ||
    finalState.commit !== initialState.commit ||
    finalState.tree !== initialState.tree ||
    finalState.commit !== plan.repository.commit ||
    finalState.tree !== plan.repository.tree
  ) {
    receiptRefusal = 'repository-changed-during-run';
  } else {
    const candidateReceipt: CandidateReceipt = {
      schemaVersion: '1.0.0',
      repository: plan.repository,
      profile: options.target,
      taskPolicyDigest: plan.taskPolicyDigest,
      createdAt: now(),
      tasks: plan.tasks.map((task) => {
        const resultDigest = resultDigests.get(task.nodeId);
        if (resultDigest === undefined)
          throw new Error('CHECK_RUNNER_INTERNAL: missing task result');
        return { nodeId: task.nodeId, taskKey: task.taskKey, resultDigest };
      }),
    };
    const written = cache.writeReceipt(candidateReceipt);
    receipt = { ...written, value: candidateReceipt };
  }
  return {
    schemaVersion: '1.0.0',
    operation: options.operation,
    plan,
    execution,
    ...(receipt !== undefined && { receipt }),
    ...(receiptRefusal !== undefined && { receiptRefusal }),
    exitCode: allPass ? 0 : 1,
  };
}
