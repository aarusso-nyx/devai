import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  currentRepositoryState,
  exactCandidateRepositoryState,
  isPreflightNode,
} from './policy.js';
import {
  evaluatePreflightProbes,
  resolveBaseCommit,
  type PreflightEvaluation,
} from './preflight.js';
import type {
  CheckRunnerOptions,
  CheckRunnerReport,
  ExecutedTask,
  TaskExecutionResult,
  TaskResult,
} from './types.js';
import { descriptorFor, planWithCache, unattestedNodeIds, taskEnvironment } from './runner-plan.js';
import { bindReleaseRequest } from './runner-release-binding.js';
import {
  type TaskExecutionEffect,
  defaultExecute,
  probeEffect,
  executionOutcome,
  outputDigests,
} from './runner-execution.js';
import { attestCheckRun, releaseVerificationEntries } from './runner-attestation.js';
import { prepareCheckRunInputs, verifyCertifyPreflightReceipt } from './runner-inputs.js';
import { retainProtectedCompletedTaskResults, snapshotTaskResult } from './runner-results.js';
export { readProtectedCompletedTaskResults } from './runner-results.js';

export { PROTECTED_MUTATION_PRODUCER } from './runner-release-binding.js';
export { resolveRunnerToolchain } from './runner-plan.js';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

type AsyncTaskExecutor = (
  ...args: Parameters<NonNullable<CheckRunnerOptions['executeTask']>>
) => TaskExecutionResult | Promise<TaskExecutionResult>;

/** The synchronous API and protected asynchronous host share every planning/result rule. */
export function runCheckTasks(inputOptions: CheckRunnerOptions): CheckRunnerReport {
  const steps = runCheckTaskSteps(inputOptions);
  let step = steps.next();
  while (!step.done) {
    let result: TaskExecutionResult | Promise<TaskExecutionResult>;
    try {
      result = step.value();
      if (result !== null && typeof result === 'object' && 'then' in result)
        throw new Error('CHECK_RUNNER_ASYNC_EXECUTOR_REQUIRES_ASYNC_HOST');
    } catch (error) {
      steps.throw(error);
      throw error;
    }
    step = steps.next(result);
  }
  return step.value;
}

/**
 * Internal host orchestration only: await a task's complete execution/retention
 * before processing its result or advancing to a dependent task. This adds no
 * release action, receipt authority, or exception to the mutation producer guard.
 */
export async function runCheckTasksAsync(
  inputOptions: Omit<CheckRunnerOptions, 'executeTask'> & {
    readonly executeTask?: AsyncTaskExecutor;
  },
): Promise<CheckRunnerReport> {
  const {
    executeTask,
    resolveExecutable,
    readTaskOutput,
    capturedTaskOutputPaths,
    resolveProtectedMutationProducer,
    now,
    ...data
  } = inputOptions;
  // Host functions are captured once; caller-owned documents cannot drift while
  // a task is awaited. None of these callbacks is resolved from candidate data.
  const captured: CheckRunnerOptions = {
    ...structuredClone(data),
    ...(resolveExecutable === undefined ? {} : { resolveExecutable }),
    ...(readTaskOutput === undefined ? {} : { readTaskOutput }),
    ...(capturedTaskOutputPaths === undefined ? {} : { capturedTaskOutputPaths }),
    ...(resolveProtectedMutationProducer === undefined ? {} : { resolveProtectedMutationProducer }),
    ...(now === undefined ? {} : { now }),
  };
  const steps = runCheckTaskSteps(
    captured,
    executeTask === undefined
      ? undefined
      : (argv, cwd, timeout, environment, taskIdentity) =>
          executeTask([...argv], cwd, timeout, { ...environment }, { ...taskIdentity }),
  );
  let step = steps.next();
  while (!step.done) {
    let result: TaskExecutionResult;
    try {
      result = await step.value();
    } catch (error) {
      steps.throw(error);
      throw error;
    }
    step = steps.next(result);
  }
  return step.value;
}

function* runCheckTaskSteps(
  inputOptions: CheckRunnerOptions,
  asyncExecutor?: AsyncTaskExecutor,
): Generator<TaskExecutionEffect, CheckRunnerReport, TaskExecutionResult> {
  // The preflight target accepts a named base (the freshly fetched origin/main)
  // and binds the exact commit it resolves to before planning.
  const request = bindReleaseRequest(
    inputOptions.target === 'preflight' && inputOptions.baseCommit !== undefined
      ? {
          ...inputOptions,
          baseCommit: resolveBaseCommit(inputOptions.repoRoot, inputOptions.baseCommit),
        }
      : inputOptions,
  );
  const options = request.options;
  const protectedOutputCapture =
    options.protectedExecutionIdentity !== undefined &&
    options.readTaskOutput !== undefined &&
    options.capturedTaskOutputPaths !== undefined;
  // Ordinary policy 1.1 receipts attest task outcomes and explicit output paths.
  // Namespace sealing belongs to the protected policy 1.2 execution boundary;
  // an ordinary receipt never grants access to protected completed results.
  const requiresProtectedOutputCapture =
    options.target === 'release' || options.protectedExecutionIdentity !== undefined;
  const { cache, toolchain, environment, toolchainDigest } = prepareCheckRunInputs({ options });
  const rawPlan = planWithCache(options, cache, toolchain, environment);
  const releaseBinding = request.binding;
  if (releaseBinding !== undefined) {
    const intent = inputOptions.releaseIntent as { changed_paths?: string[] };
    const declared = [...(intent.changed_paths ?? [])].sort();
    if (JSON.stringify(declared) !== JSON.stringify(rawPlan.changedPaths)) {
      throw new Error('CHECK_RELEASE_INTENT_CHANGED_PATHS_MISMATCH');
    }
  }
  const plan =
    releaseBinding === undefined
      ? rawPlan
      : {
          ...rawPlan,
          releaseIntentDigest: releaseBinding.digest,
          releaseProfileDigest: releaseBinding.profileDigest,
          toolchainDigest,
          releaseDecision: releaseBinding.decision,
        };
  verifyCertifyPreflightReceipt({
    options,
    releaseBinding,
    cache,
    toolchain,
    environment,
    plan,
    toolchainDigest,
  });
  if (options.operation !== 'run') {
    return { schemaVersion: '1.0.0', operation: options.operation, plan, exitCode: 0 };
  }

  const descriptor = descriptorFor(options);
  const descriptorById = new Map(descriptor.tasks.map((task) => [task.nodeId, task]));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('CHECK_RUNNER_TIMEOUT: timeout must be a positive integer');
  }
  const now = options.now ?? (() => new Date().toISOString());
  const repositoryState = (): Readonly<{ commit: string; tree: string; clean: boolean }> =>
    options.target === 'release' && options.releaseCandidate !== undefined
      ? exactCandidateRepositoryState(options.repoRoot, options.releaseCandidate)
      : currentRepositoryState(options.repoRoot);
  const initialState = repositoryState();
  const resultDigests = new Map<string, string>();
  const taskResults = new Map<string, TaskResult>();
  const execution: ExecutedTask[] = [];
  const blockedNodes = new Set<string>();
  const unattested = unattestedNodeIds(options);

  for (const task of plan.tasks) {
    const blockedBy = task.dependencies.find((dependency) => blockedNodes.has(dependency));
    if (blockedBy !== undefined) {
      // blocked-environment: never executed and never cached as a result.
      blockedNodes.add(task.nodeId);
      cache.writeAttempt(task.nodeId, task.taskKey, 'BLOCKED', now());
      execution.push({
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        disposition: 'blocked-environment',
        outcome: 'BLOCKED',
        reason: `blocked-environment:${blockedBy}`,
        durationMs: 0,
      });
      continue;
    }
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
    const cached = unattested.includes(task.nodeId)
      ? { cacheState: 'execute' as const, reason: 'preflight-always-executes' }
      : cache.inspect(task, dependencyResultDigests);
    if (
      cached.cacheState === 'reusable' &&
      cached.cachedResultDigest !== undefined &&
      'result' in cached
    ) {
      if (cached.result === undefined)
        throw new Error('CHECK_RUNNER_INTERNAL: reusable task result missing');
      resultDigests.set(task.nodeId, cached.cachedResultDigest);
      taskResults.set(task.nodeId, snapshotTaskResult(cached.result));
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
    const started = performance.now();
    const descriptorTask = descriptorById.get(task.nodeId);
    if (descriptorTask === undefined) {
      throw new Error(`CHECK_RUNNER_INTERNAL: planned task ${task.nodeId} is not declared`);
    }
    const taskCwd = realpathSync(resolve(options.repoRoot, task.cwd));
    const taskEnv = taskEnvironment(descriptorTask, environment);
    const executeArgv =
      (argv: readonly string[]): TaskExecutionEffect =>
      () =>
        asyncExecutor !== undefined
          ? asyncExecutor(argv, taskCwd, timeoutMs, taskEnv, {
              nodeId: task.nodeId,
              taskKey: task.taskKey,
            })
          : options.executeTask === undefined
            ? defaultExecute(argv, taskCwd, timeoutMs, taskEnv)
            : options.executeTask(argv, taskCwd, timeoutMs, taskEnv, {
                nodeId: task.nodeId,
                taskKey: task.taskKey,
              });
    let preflight: PreflightEvaluation | undefined;
    if (isPreflightNode(descriptorTask)) {
      const probeSteps = evaluatePreflightProbes(descriptorTask.probes ?? [], {
        repoRoot: taskCwd,
        ...(plan.baseCommit !== undefined && { baseCommit: plan.baseCommit }),
        environment: taskEnv,
      });
      let probeStep = probeSteps.next();
      while (!probeStep.done) {
        const probeResult: TaskExecutionResult = yield probeEffect(executeArgv(probeStep.value));
        probeStep = probeSteps.next(probeResult);
      }
      preflight = probeStep.value;
    }
    if (preflight !== undefined && preflight.outcome !== 'PASS') {
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      const finishedAt = now();
      const probeResult: TaskExecutionResult = {
        status: preflight.outcome === 'FAIL' ? 1 : null,
        signal: null,
        stdout: preflight.stdout,
        stderr: preflight.stderr,
      };
      const diagnosticPath = cache.writeFailureDiagnostic(
        task,
        preflight.outcome,
        finishedAt,
        preflight.reason,
        probeResult,
        preflight.remediation,
      );
      // An extrinsic BLOCKED is recorded only as an attempt, never as a result.
      cache.writeAttempt(task.nodeId, task.taskKey, preflight.outcome, finishedAt);
      if (preflight.outcome === 'BLOCKED') blockedNodes.add(task.nodeId);
      execution.push({
        nodeId: task.nodeId,
        taskKey: task.taskKey,
        disposition: 'executed',
        outcome: preflight.outcome,
        reason: preflight.reason,
        durationMs,
        diagnosticPath,
        probes: preflight.observations,
        remediation: preflight.remediation,
      });
      continue;
    }
    const result: TaskExecutionResult =
      preflight !== undefined
        ? { status: 0, signal: null, stdout: preflight.stdout, stderr: preflight.stderr }
        : yield () =>
            asyncExecutor !== undefined
              ? asyncExecutor(task.argv, taskCwd, timeoutMs, taskEnv, {
                  nodeId: task.nodeId,
                  taskKey: task.taskKey,
                })
              : options.executeTask === undefined
                ? defaultExecute(
                    [task.executable.path, ...task.argv.slice(1)],
                    taskCwd,
                    timeoutMs,
                    taskEnv,
                    options.target === 'release'
                      ? {
                          candidate: {
                            commit: plan.repository.commit,
                            tree: plan.repository.tree,
                          },
                          descriptor_digest: plan.descriptorDigest,
                          task_policy_digest: plan.taskPolicyDigest,
                          node_id: task.nodeId,
                          executable: task.executable,
                          argv: task.argv,
                          cwd: task.cwd,
                        }
                      : undefined,
                  )
                : options.executeTask(task.argv, taskCwd, timeoutMs, taskEnv, {
                    nodeId: task.nodeId,
                    taskKey: task.taskKey,
                  });
    const durationMs = Math.max(0, Math.round(performance.now() - started));
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
        outputDigests: outputDigests(
          options.repoRoot,
          task,
          result,
          options.readTaskOutput,
          options.capturedTaskOutputPaths,
        ),
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
    taskResults.set(task.nodeId, snapshotTaskResult(taskResult));
    execution.push({
      nodeId: task.nodeId,
      taskKey: task.taskKey,
      disposition: 'executed',
      outcome: 'PASS',
      reason:
        requiresProtectedOutputCapture &&
        task.outputContract.generated_namespaces !== undefined &&
        !protectedOutputCapture
          ? 'executed;protected-namespace-closure-unproven'
          : cached.reason,
      durationMs,
      resultDigest,
      exitCode: 0,
      ...(preflight !== undefined && { probes: preflight.observations }),
    });
  }

  const { receipt, preflightReceipt, receiptRefusal, blocked, allPass } = attestCheckRun({
    execution,
    repositoryState,
    requiresProtectedOutputCapture,
    protectedOutputCapture,
    plan,
    options,
    initialState,
    releaseBinding,
    resultDigests,
    toolchainDigest,
    now,
    cache,
  });
  const report: CheckRunnerReport = {
    schemaVersion: '1.0.0',
    operation: options.operation,
    plan,
    execution,
    ...(receipt !== undefined && { receipt }),
    ...(preflightReceipt !== undefined && { preflightReceipt }),
    ...(options.target === 'release' && {
      releaseVerification: releaseVerificationEntries(options, execution),
    }),
    ...(receiptRefusal !== undefined && { receiptRefusal }),
    ...(blocked.length > 0 && { blocked }),
    exitCode: allPass ? 0 : 1,
  };
  if (
    protectedOutputCapture &&
    receipt !== undefined &&
    taskResults.size === plan.tasks.length &&
    plan.tasks.every((task) => taskResults.get(task.nodeId)?.taskKey === task.taskKey)
  ) {
    retainProtectedCompletedTaskResults(
      report,
      Object.freeze(
        plan.tasks.map((task) => {
          const result = taskResults.get(task.nodeId);
          if (result === undefined)
            throw new Error('CHECK_RUNNER_INTERNAL: retained task result missing');
          return snapshotTaskResult(result);
        }),
      ),
    );
  }
  return report;
}
