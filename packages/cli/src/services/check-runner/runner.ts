import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { resolveReleaseTaskNodes } from '../release-profile.js';
import {
  PREFLIGHT_CAPABILITIES,
  verifyReleasePreflightReceipt,
  type ReleasePreflightReceipt,
} from '../release-preflight.js';
import { CheckCache } from './cache.js';
import { sha256Hex } from './canonical.js';

import {
  currentRepositoryState,
  exactCandidateRepositoryState,
  isPreflightNode,
  runnerToolchainDigest,
} from './policy.js';
import {
  evaluatePreflightProbes,
  resolveBaseCommit,
  type PreflightEvaluation,
} from './preflight.js';
import type {
  CandidateReceipt,
  CheckRunnerOptions,
  CheckRunnerReport,
  ExecutedTask,
  TaskExecutionResult,
  TaskResult,
} from './types.js';
import {
  descriptorFor,
  requiredEnvironmentKeys,
  requiredTaskNodes,
  resolvedRunnerToolchain,
  planWithCache,
  unattestedNodeIds,
  taskEnvironment,
} from './runner-plan.js';
import { bindReleaseRequest } from './runner-release-binding.js';
import {
  type TaskExecutionEffect,
  defaultExecute,
  probeEffect,
  executionOutcome,
  outputDigests,
} from './runner-execution.js';
export { PROTECTED_MUTATION_PRODUCER } from './runner-release-binding.js';
export { resolveRunnerToolchain } from './runner-plan.js';

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const protectedCompletedTaskResults = new WeakMap<CheckRunnerReport, readonly TaskResult[]>();

function snapshotTaskResult(value: TaskResult): TaskResult {
  return Object.freeze({
    ...value,
    dependencyResultDigests: Object.freeze({ ...value.dependencyResultDigests }),
    outputDigests: Object.freeze({ ...value.outputDigests }),
  });
}

/**
 * A protected certification host may retain the canonical task-result population
 * while it is still live. This never consults a cache path and is unavailable for
 * reports that did not produce an attestable candidate receipt.
 */
export function readProtectedCompletedTaskResults(
  report: CheckRunnerReport,
): readonly TaskResult[] {
  const results = protectedCompletedTaskResults.get(report);
  if (results === undefined) throw new Error('release-certification-task-results-unavailable');
  return results.map(snapshotTaskResult);
}

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
  const requiredEnvironment = requiredEnvironmentKeys(options);
  // Protected execution binds the complete selected DAG, including dependencies, but does
  // not require credentials or tools belonging only to unselected task nodes. Refuse before
  // ambient environment/toolchain resolution; those values are not protected host inputs.
  if (
    options.protectedExecutionIdentity !== undefined &&
    requiredTaskNodes(options, 'selected').some(
      (task) =>
        task.allowlistedEnv.some((key) => options.environment?.[key] === undefined) ||
        task.toolchainKeys.some((key) => options.toolchain?.[key] === undefined),
    )
  ) {
    throw new Error('release-certification-environment-unbound');
  }
  const configuredDbTests = options.environment?.['DEVAI_DB_TESTS'] ?? process.env.DEVAI_DB_TESTS;
  if (
    (options.target === 'rc' || options.target === 'release') &&
    requiredEnvironment.includes('DEVAI_DB_TESTS') &&
    configuredDbTests !== '1'
  ) {
    throw new Error(
      'CHECK_RC_DB_TESTS_REQUIRED: RC and release profiles require DEVAI_DB_TESTS=1 when database tasks are selected so cases cannot silently skip',
    );
  }
  const cacheRoot = resolve(
    options.cacheRoot ?? join(options.repoRoot, '.devai/state/check-cache/v1'),
  );
  const cache = new CheckCache(options.repoRoot, cacheRoot);
  const toolchain = options.toolchain ?? resolvedRunnerToolchain(options);
  const toolchainDigest = runnerToolchainDigest(options.repoRoot, toolchain);
  const environment: Record<string, string> = { ...(options.environment ?? {}) };
  const authorityDigestKey = 'DEVAI_AUTHORITY_POLICY_SHA256';
  if (requiredEnvironment.includes(authorityDigestKey)) {
    const authorityPolicyPath = join(options.repoRoot, '.devai/config/authority-policy.json');
    if (!existsSync(authorityPolicyPath)) {
      throw new Error(
        'CHECK_AUTHORITY_POLICY_REQUIRED: materialize .devai/config/authority-policy.json before planning release evidence',
      );
    }
    const authorityDigest = sha256Hex(readFileSync(authorityPolicyPath));
    if (
      options.protectedExecutionIdentity !== undefined &&
      environment[authorityDigestKey] !== authorityDigest
    )
      throw new Error('release-certification-environment-unbound');
    environment[authorityDigestKey] = authorityDigest;
  }
  for (const key of requiredEnvironment) {
    const inheritedValue = process.env[key];
    if (environment[key] === undefined && inheritedValue !== undefined) {
      environment[key] = inheritedValue;
    }
  }
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
  if (options.target === 'release' && options.releaseStage === 'certify') {
    if (options.preflightReceipt === undefined || releaseBinding === undefined) {
      throw new Error('CHECK_RELEASE_PREFLIGHT_REQUIRED');
    }
    const knownNodes = descriptorFor(options).tasks.map((task) => task.nodeId);
    const preflightPlan = planWithCache(
      {
        ...options,
        releaseStage: 'preflight',
        releaseAffectedSelection: false,
        releaseTaskBindings: {},
        releaseRequiredNodes: resolveReleaseTaskNodes(
          {
            ...releaseBinding.decision,
            capabilities: releaseBinding.decision.capabilities.filter((capability) =>
              (PREFLIGHT_CAPABILITIES as readonly string[]).includes(capability),
            ),
          },
          releaseBinding.preflightCapabilityTasks,
          knownNodes,
        ),
      },
      cache,
      toolchain,
      environment,
    );
    verifyReleasePreflightReceipt(options.preflightReceipt, {
      repository: plan.repository,
      base: releaseBinding.base,
      releaseIntentDigest: releaseBinding.digest,
      releaseProfileDigest: releaseBinding.profileDigest,
      taskPolicyDigest: preflightPlan.taskPolicyDigest,
      toolchainDigest,
    });
  }
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
    const started = Date.now();
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
      const durationMs = Math.max(0, Date.now() - started);
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

  let receipt: CheckRunnerReport['receipt'];
  let preflightReceipt: CheckRunnerReport['preflightReceipt'];
  let receiptRefusal: string | undefined;
  const allPass = execution.every((task) => task.outcome === 'PASS');
  const blocked = execution
    .filter((task) => task.outcome === 'BLOCKED')
    .map((task) => ({
      nodeId: task.nodeId,
      disposition:
        task.disposition === 'blocked-environment'
          ? ('blocked-environment' as const)
          : ('executed' as const),
      reason: task.reason,
      remediation: task.remediation ?? [],
    }));
  const finalState = repositoryState();
  if (
    requiresProtectedOutputCapture &&
    !protectedOutputCapture &&
    plan.tasks.some((task) => task.outputContract.generated_namespaces !== undefined)
  )
    receiptRefusal = 'protected-namespace-closure-unproven';
  else if (options.target === 'local') receiptRefusal = 'local-target-not-attestable';
  else if (options.target === 'preflight') receiptRefusal = 'preflight-target-not-attestable';
  else if (blocked.length > 0) receiptRefusal = 'environment-blocked';
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
  } else if (
    options.target === 'release' &&
    options.releaseStage === 'preflight' &&
    releaseBinding !== undefined
  ) {
    const checks = PREFLIGHT_CAPABILITIES.map((capability) => {
      const nodes = releaseBinding.preflightCapabilityTasks[capability] ?? [];
      const digests = nodes.map((nodeId) => {
        const digest = resultDigests.get(nodeId);
        if (digest === undefined)
          throw new Error(`CHECK_RELEASE_PREFLIGHT_RESULT_MISSING:${nodeId}`);
        return { nodeId, digest };
      });
      const reused = nodes.every((nodeId) =>
        execution.some((entry) => entry.nodeId === nodeId && entry.disposition === 'reused'),
      );
      return {
        capability,
        status: reused ? ('reused' as const) : ('executed' as const),
        reasonCode: 'required-floor',
        resultDigest: sha256Hex(digests),
      };
    });
    const value: ReleasePreflightReceipt = {
      schemaVersion: '1.0.0',
      repository: plan.repository,
      base: releaseBinding.base,
      releaseIntentDigest: releaseBinding.digest,
      releaseProfileDigest: releaseBinding.profileDigest,
      taskPolicyDigest: plan.taskPolicyDigest,
      toolchainDigest,
      checks,
      verdict: 'pass',
      blockingReasons: [],
      createdAt: now(),
    };
    verifyReleasePreflightReceipt(value, {
      repository: plan.repository,
      base: releaseBinding.base,
      releaseIntentDigest: releaseBinding.digest,
      releaseProfileDigest: releaseBinding.profileDigest,
      taskPolicyDigest: plan.taskPolicyDigest,
      toolchainDigest,
    });
    const written = cache.writePreflightReceipt(value);
    preflightReceipt = { ...written, value };
    receiptRefusal = 'release-preflight-only';
  } else {
    const candidateReceipt: CandidateReceipt = {
      schemaVersion: '1.1.0',
      repository: plan.repository,
      profile: options.target === 'affected' ? 'affected' : 'rc',
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
  const report: CheckRunnerReport = {
    schemaVersion: '1.0.0',
    operation: options.operation,
    plan,
    execution,
    ...(receipt !== undefined && { receipt }),
    ...(preflightReceipt !== undefined && { preflightReceipt }),
    ...(options.target === 'release' && {
      releaseVerification: descriptorFor(options).tasks.map((task) => {
        const result = execution.find((entry) => entry.nodeId === task.nodeId);
        if (result === undefined) {
          return {
            nodeId: task.nodeId,
            status: 'not-required' as const,
            reasonCode: 'capability-not-selected',
          };
        }
        const status =
          result.outcome === 'PASS'
            ? result.disposition === 'reused'
              ? ('reused' as const)
              : ('executed' as const)
            : result.disposition === 'aborted' || result.outcome === 'BLOCKED'
              ? ('blocked' as const)
              : result.outcome === 'FAIL'
                ? ('failed' as const)
                : ('unknown' as const);
        return {
          nodeId: task.nodeId,
          status,
          reasonCode: result.reason,
          ...(['failed', 'blocked', 'unknown'].includes(status) && {
            failureClass:
              status === 'failed'
                ? ('product-regression' as const)
                : status === 'blocked'
                  ? ('environment-drift' as const)
                  : ('unknown' as const),
          }),
          ...(result.resultDigest !== undefined && { resultDigest: result.resultDigest }),
        };
      }),
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
    protectedCompletedTaskResults.set(
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
