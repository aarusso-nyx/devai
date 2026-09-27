import {
  PREFLIGHT_CAPABILITIES,
  verifyReleasePreflightReceipt,
  type ReleasePreflightReceipt,
} from '../release-preflight.js';
import { CheckCache } from './cache.js';
import { sha256Hex } from './canonical.js';
import type {
  CandidateReceipt,
  CheckRunnerOptions,
  CheckRunnerReport,
  ExecutedTask,
  TaskPlan,
} from './types.js';
import { bindReleaseRequest } from './runner-release-binding.js';
import { descriptorFor } from './runner-plan.js';

/** Decide whether the finished run is attestable and, when it is, write its receipt (and its preflight receipt); otherwise name the refusal. */
export function attestCheckRun(input: {
  readonly execution: ExecutedTask[];
  readonly repositoryState: () => Readonly<{ commit: string; tree: string; clean: boolean }>;
  readonly requiresProtectedOutputCapture: boolean;
  readonly protectedOutputCapture: boolean;
  readonly plan: TaskPlan;
  readonly options: CheckRunnerOptions;
  readonly initialState: Readonly<{ commit: string; tree: string; clean: boolean }>;
  readonly releaseBinding: ReturnType<typeof bindReleaseRequest>['binding'];
  readonly resultDigests: Map<string, string>;
  readonly toolchainDigest: string;
  readonly now: () => string;
  readonly cache: CheckCache;
}) {
  const {
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
  } = input;
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
  return { receipt, preflightReceipt, receiptRefusal, blocked, allPass };
}

/** Per-descriptor-task release verification status of a release run, in descriptor order. */
export function releaseVerificationEntries(
  options: CheckRunnerOptions,
  execution: readonly ExecutedTask[],
) {
  return descriptorFor(options).tasks.map((task) => {
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
  });
}
