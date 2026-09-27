import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readExactGitTreeSync } from '@devai-nyx/authority';
import { canonicalJson } from '@devai-nyx/utils';
import { parseTaskDescriptor } from './check-runner/policy.js';
import { runCheckTasks } from './check-runner/runner.js';
import type { CheckRunnerOptions, TaskDescriptor } from './check-runner/types.js';
import type { ContainerArchiveEntry } from './container-archive.js';
import { createProtectedCandidateGitMetadata } from './release-certification-git.js';
import { resolveProtectedGeneratedNamespaces } from './release-production-outputs.js';
import type {
  GitReleaseBlobLocator,
  ReleaseLifecycleRequest,
} from './release-lifecycle-execution.js';
import { verifyGitCertificationSource } from './release-prepare-kernel.js';
import { digest, object } from './release-certification-provider-state.js';
import type { ContainerReleaseScope } from './release-certification-provider-execution.js';

/** Binder of a lifecycle request to the selected plans and the exact candidate task descriptor. */
export function releaseRequestBinder(
  scope: Pick<ContainerReleaseScope, 'input' | 'selected' | 'root'>,
) {
  const { input, selected, root } = scope;
  return function bindRequest(request: ReleaseLifecycleRequest): TaskDescriptor {
    if (
      request.repository_locator.id !== input.repository_id ||
      request.candidate_locator.release_units.length !== selected.length ||
      !['release preflight', 'release certify'].includes(request.action_id)
    )
      throw new Error('release-certification-plan-binding-invalid');
    for (const [index, unit] of request.candidate_locator.release_units.entries()) {
      const entry = selected[index];
      const receipt = entry?.receipt;
      if (
        entry === undefined ||
        receipt === undefined ||
        canonicalJson(receipt.repository) !== canonicalJson(request.repository_locator) ||
        receipt.candidate.release_unit !== unit.release_unit ||
        receipt.candidate.version !== unit.version ||
        canonicalJson(receipt.candidate.commit) !==
          canonicalJson(request.candidate_locator.commit) ||
        receipt.candidate.tree !== request.candidate_locator.tree ||
        !request.receipt_locators?.some(
          (locator) =>
            locator.kind === 'release-plan-receipt' &&
            locator.receipt_id === receipt.receipt_id &&
            locator.receipt_digest_sha256 === receipt.receipt_digest_sha256,
        ) ||
        canonicalJson(entry.plan.packages.map((pkg) => pkg.package_id)) !==
          canonicalJson(unit.package_roster.map((pkg) => pkg.package_id))
      )
        throw new Error('release-certification-plan-binding-invalid');
    }
    const entries = readExactGitTreeSync(
      root,
      request.candidate_locator.commit,
      request.candidate_locator.tree,
      'test-tasks.json',
    );
    if (
      entries.length !== 1 ||
      entries[0]?.path !== 'test-tasks.json' ||
      entries[0].mode === '120000'
    )
      throw new Error('release-task-policy-identity-mismatch');
    const descriptor = parseTaskDescriptor(
      JSON.parse(entries[0].bytes.toString('utf8')) as unknown,
    );
    return descriptor;
  };
}

/** Protected check runner options of one selected plan at one release stage. */
export function releaseTaskOptions(
  scope: Pick<
    ContainerReleaseScope,
    'selected' | 'root' | 'toolchain' | 'environment' | 'input' | 'bindingIdentity' | 'controls'
  >,
) {
  const { selected, root, toolchain, environment, input, bindingIdentity, controls } = scope;
  return function optionsFor(
    request: ReleaseLifecycleRequest,
    descriptor: TaskDescriptor,
    index: number,
    stage: 'preflight' | 'certify',
  ): CheckRunnerOptions {
    const entry = selected[index];
    if (entry === undefined) throw new Error('release-certification-plan-binding-invalid');
    const base = object(entry.intent.base);
    if (typeof base.commit !== 'string')
      throw new Error('release-certification-plan-binding-invalid');
    const exactSource = readExactGitTreeSync(
      root,
      request.candidate_locator.commit,
      request.candidate_locator.tree,
      '.',
    ).map((entry): ContainerArchiveEntry => {
      if (entry.mode === '120000') throw new Error('release-certification-source-mode-unsupported');
      return { path: entry.path, mode: entry.mode, bytes: entry.bytes };
    });
    const namespaces = resolveProtectedGeneratedNamespaces(descriptor, exactSource);
    return {
      repoRoot: root,
      target: 'release',
      operation: 'plan',
      baseCommit: base.commit,
      descriptorDocument: descriptor,
      releaseIntent: entry.plan.intent,
      releaseProfile: entry.plan.release_verification_profile,
      releaseStage: stage,
      ...(stage === 'certify' ? { preflightReceipt: entry.preflight } : {}),
      releaseCandidate: request.candidate_locator,
      toolchain,
      environment,
      timeoutMs: input.timeout_ms,
      cacheRoot: resolve(root, '.devai/state/check-cache/protected', randomUUID()),
      protectedExecutionIdentity: { ...bindingIdentity, generated_namespaces: namespaces },
      resolveExecutable: (name) => {
        const executable = controls.executables[name];
        if (executable === undefined)
          throw new Error('release-certification-container-toolchain-mismatch');
        return { ...executable };
      },
    };
  };
}

/** Reader of the exact candidate source, its Git metadata and blob locators. */
export function releaseSourceReader(
  scope: Pick<ContainerReleaseScope, 'root' | 'input' | 'controls'>,
) {
  const { root, input, controls } = scope;
  return async function sourcesFor(request: ReleaseLifecycleRequest) {
    const entries = readExactGitTreeSync(
      root,
      request.candidate_locator.commit,
      request.candidate_locator.tree,
      '.',
    );
    const source: ContainerArchiveEntry[] = [];
    const locators = new Map<string, GitReleaseBlobLocator>();
    for (const entry of entries) {
      if (entry.mode === '120000') throw new Error('release-certification-source-mode-unsupported');
      const locator: GitReleaseBlobLocator = {
        kind: 'git-object',
        repository: request.repository_locator.id,
        commit: request.candidate_locator.commit,
        tree: request.candidate_locator.tree,
        object_format: request.candidate_locator.commit.length === 40 ? 'sha1' : 'sha256',
        path: entry.path,
        mode: entry.mode,
        object_id: entry.object_id,
        size_bytes: entry.bytes.length,
        content_digest_sha256: digest(entry.bytes),
      };
      const bytes = await verifyGitCertificationSource(input.content_source, request, locator);
      source.push({ path: entry.path, mode: entry.mode, bytes });
      locators.set(entry.path, locator);
    }
    const gitMetadata = await createProtectedCandidateGitMetadata({
      request,
      source,
      locators,
      content_source: input.content_source,
      maximum_bytes: controls.maximum_archive_bytes,
    });
    return { source, gitMetadata, locators };
  };
}

/** Certification planner: per-unit runner options, plans and task policies of a request. */
export function certificationPlanner(
  scope: Pick<ContainerReleaseScope, 'bindRequest' | 'selected' | 'optionsFor'>,
) {
  const { bindRequest, selected, optionsFor } = scope;
  return (request: ReleaseLifecycleRequest) => {
    const descriptor = bindRequest(request);
    const options = selected.map((_entry, index) =>
      optionsFor(request, descriptor, index, 'certify'),
    );
    const policies = options.map((option, index) => ({
      release_unit: request.candidate_locator.release_units[index]?.release_unit ?? '',
      ...runCheckTasks(option).plan,
    }));
    const task_policies = policies.map((policy) => ({
      release_unit: policy.release_unit,
      task_policy_digest_sha256: policy.taskPolicyDigest,
      document: policy.taskPolicy,
    }));
    return { options, policies, task_policies };
  };
}
