import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveReleaseTaskNodes } from '../release-profile.js';
import { PREFLIGHT_CAPABILITIES, verifyReleasePreflightReceipt } from '../release-preflight.js';
import { CheckCache } from './cache.js';
import { sha256Hex } from './canonical.js';
import { runnerToolchainDigest } from './policy.js';
import type { CheckRunnerOptions, TaskPlan } from './types.js';
import {
  descriptorFor,
  requiredEnvironmentKeys,
  requiredTaskNodes,
  resolvedRunnerToolchain,
  planWithCache,
} from './runner-plan.js';
import { bindReleaseRequest } from './runner-release-binding.js';

/** A release certify run requires the preflight receipt of the same repository, base, intent, profile, preflight task policy and toolchain. */
export function verifyCertifyPreflightReceipt(input: {
  readonly options: CheckRunnerOptions;
  readonly releaseBinding: ReturnType<typeof bindReleaseRequest>['binding'];
  readonly cache: CheckCache;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly environment: Record<string, string>;
  readonly plan: TaskPlan;
  readonly toolchainDigest: string;
}) {
  const { options, releaseBinding, cache, toolchain, environment, plan, toolchainDigest } = input;
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
}

/** Refuse unbound protected or database-test environments, then open the cache and resolve the toolchain and the task environment. */
export function prepareCheckRunInputs(input: { readonly options: CheckRunnerOptions }) {
  const { options } = input;
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
  return { cache, toolchain, environment, toolchainDigest };
}
