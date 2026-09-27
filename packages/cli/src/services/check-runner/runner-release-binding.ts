import { getValidator } from '@devai-nyx/schemas';
import {
  resolveReleaseMutationTaskNodes,
  resolveReleaseTaskNodes,
  resolveReleaseVerification,
  type MutationRosterEntry,
} from '../release-profile.js';
import { PREFLIGHT_CAPABILITIES } from '../release-preflight.js';
import { sha256Hex } from './canonical.js';
import { exactCandidateRepositoryState, exactCommitFile, exactCommitTree } from './policy.js';
import type { CheckRunnerOptions } from './types.js';
import { descriptorFor } from './runner-plan.js';

/** Exact declaration a protected host producer must return; nothing else lifts the refusal. */
export const PROTECTED_MUTATION_PRODUCER = 'protected-mutation-producer-v21';

export function bindReleaseRequest(input: CheckRunnerOptions): Readonly<{
  options: CheckRunnerOptions;
  binding?: Readonly<{
    digest: string;
    profileDigest: string;
    decision: ReturnType<typeof resolveReleaseVerification>;
    base: Readonly<{ commit: string; tree: string }>;
    preflightCapabilityTasks: Readonly<Record<string, readonly string[]>>;
  }>;
}> {
  if (input.releaseIntent === undefined && input.releaseProfile === undefined) {
    return { options: input };
  }
  if (input.releaseIntent === undefined || input.releaseProfile === undefined) {
    throw new Error('CHECK_RELEASE_INTENT_AND_PROFILE_REQUIRED');
  }
  const validateIntent = getValidator('release-intent.schema.json');
  const validateProfile = getValidator('release-verification-profile.schema.json');
  if (!validateIntent(input.releaseIntent)) {
    throw new Error(`CHECK_RELEASE_INTENT_INVALID:${JSON.stringify(validateIntent.errors)}`);
  }
  if (!validateProfile(input.releaseProfile)) {
    throw new Error(`CHECK_RELEASE_PROFILE_INVALID:${JSON.stringify(validateProfile.errors)}`);
  }
  const intent = input.releaseIntent as {
    release_unit: string;
    current_version: string;
    target_version: string;
    support: 'preview' | 'current' | 'lts';
    support_promotion?: boolean;
    change_kind?: 'documentation' | 'metadata' | 'behavioral';
    channel?: 'alpha' | 'beta' | 'rc' | 'stable';
    changed_paths?: string[];
    changed_packages?: string[];
    risks?: string[];
    owner_escalations?: import('../release-profile.js').ReleaseCapability[];
    candidate: { commit: string; tree: string };
    base: { commit: string; tree: string };
  };
  const profile = input.releaseProfile as {
    release_unit: string;
    version_source: string;
    capability_tasks: Record<string, string[]>;
    risk_capabilities: Record<string, import('../release-profile.js').ReleaseCapability[]>;
    mutation_roster: readonly MutationRosterEntry[];
  };
  if (intent.release_unit !== profile.release_unit) {
    throw new Error('CHECK_RELEASE_UNIT_MISMATCH');
  }
  const candidate = exactCandidateRepositoryState(input.repoRoot, intent.candidate);
  if (!candidate.clean) {
    throw new Error('CHECK_RELEASE_CANDIDATE_WORKTREE_MISMATCH');
  }
  if (input.baseCommit === undefined || intent.base.commit !== input.baseCommit) {
    throw new Error('CHECK_RELEASE_INTENT_BASE_MISMATCH');
  }
  if (exactCommitTree(input.repoRoot, intent.base.commit) !== intent.base.tree) {
    throw new Error('CHECK_RELEASE_INTENT_BASE_TREE_MISMATCH');
  }
  const versionAt = (commit: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(exactCommitFile(input.repoRoot, commit, profile.version_source));
    } catch (error) {
      if (error instanceof Error && error.message === 'CHECK_RELEASE_VERSION_SOURCE_UNREADABLE') {
        throw error;
      }
      throw new Error('CHECK_RELEASE_VERSION_SOURCE_INVALID');
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as { version?: unknown }).version !== 'string'
    ) {
      throw new Error('CHECK_RELEASE_VERSION_SOURCE_INVALID');
    }
    return (parsed as { version: string }).version;
  };
  if (versionAt(intent.base.commit) !== intent.current_version) {
    throw new Error('CHECK_RELEASE_CURRENT_VERSION_SOURCE_MISMATCH');
  }
  if (versionAt(intent.candidate.commit) !== intent.target_version) {
    throw new Error('CHECK_RELEASE_TARGET_VERSION_SOURCE_MISMATCH');
  }
  const decision = resolveReleaseVerification({
    currentVersion: intent.current_version,
    targetVersion: intent.target_version,
    support: intent.support,
    riskCapabilities: profile.risk_capabilities,
    mutationRosterSize: profile.mutation_roster.length,
    ...(intent.support_promotion !== undefined && { supportPromotion: intent.support_promotion }),
    ...(intent.change_kind !== undefined && { changeKind: intent.change_kind }),
    ...(intent.channel !== undefined && { channel: intent.channel }),
    ...(intent.risks !== undefined && { risks: intent.risks }),
    ...(intent.owner_escalations !== undefined && { ownerEscalations: intent.owner_escalations }),
  });
  if (decision.verdict !== 'ready') {
    throw new Error(`CHECK_RELEASE_INTENT_BLOCKED:${decision.blockingReasons.join(',')}`);
  }
  const descriptor = descriptorFor(input);
  const allRoots = resolveReleaseTaskNodes(
    decision,
    profile.capability_tasks,
    descriptor.tasks.map((task) => task.nodeId),
  );
  const mutationSelection = resolveReleaseMutationTaskNodes(
    decision,
    profile.mutation_roster,
    intent.changed_packages ?? [],
    intent.changed_paths ?? [],
    intent.risks ?? [],
    descriptor.tasks.map((task) => task.nodeId),
  );
  const selectedRoots = [...new Set([...allRoots, ...mutationSelection.taskNodes])].sort();
  const profileDigest = sha256Hex(input.releaseProfile);
  const mutationTaskBindings = Object.fromEntries(
    mutationSelection.taskNodes.map((nodeId) => [
      nodeId,
      {
        schemaVersion: '1.0.0',
        mutation: decision.mutation,
        profileDigest,
        rosterEntries: profile.mutation_roster
          .filter((entry) => mutationSelection.rosterEntryIds.includes(entry.id))
          .filter((entry) => entry.task_node === nodeId),
      },
    ]),
  );
  const preflightDecision = {
    ...decision,
    capabilities: decision.capabilities.filter((capability) =>
      (PREFLIGHT_CAPABILITIES as readonly string[]).includes(capability),
    ),
  };
  const preflightRoots = resolveReleaseTaskNodes(
    preflightDecision,
    profile.capability_tasks,
    descriptor.tasks.map((task) => task.nodeId),
  );
  const stage = input.releaseStage ?? 'preflight';
  // Exit codes and output digests alone cannot satisfy required mutation. Required
  // mutation may be planned for execution only when a protected semantic producer
  // declares it will retain the evidence; read-only planning and the unconditional
  // preflight floor stay usable either way.
  if (
    stage === 'certify' &&
    input.operation === 'run' &&
    decision.mutation !== 'none' &&
    input.resolveProtectedMutationProducer?.() !== PROTECTED_MUTATION_PRODUCER
  )
    throw new Error('CHECK_RELEASE_MUTATION_EVIDENCE_UNAVAILABLE');
  return {
    options: {
      ...input,
      target: 'release',
      releaseStage: stage,
      releaseCandidate: intent.candidate,
      releaseRequiredNodes: stage === 'preflight' ? preflightRoots : selectedRoots,
      releaseAllNodes: selectedRoots,
      releaseTaskBindings: stage === 'preflight' ? {} : mutationTaskBindings,
      releaseAffectedSelection:
        stage === 'certify' && decision.capabilities.includes('affected-checks'),
    },
    binding: {
      digest: sha256Hex(input.releaseIntent),
      profileDigest,
      decision,
      base: intent.base,
      preflightCapabilityTasks: Object.fromEntries(
        PREFLIGHT_CAPABILITIES.map((capability) => [
          capability,
          profile.capability_tasks[capability] ?? [],
        ]),
      ),
    },
  };
}
