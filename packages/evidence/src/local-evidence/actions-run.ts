import { getValidator } from '@devai-nyx/schemas';

const validateLocalEvidenceManifest = getValidator('local-evidence-manifest.schema.json');

export const ACTIONS_REUSABLE_JOBS = [
  'merged-coverage',
  'regression',
  'contract',
  'smoke',
  'supported-e2e',
  'experimental-containment',
  'gate-invariant-verb-smoke',
  'inventory-spec-validation',
] as const;

export const ACTIONS_FRESHNESS_JOBS = [
  'build',
  'lint',
  'format',
  'typecheck',
  'evidence-chain',
  'changeset-version-contract',
  'dependency-policy',
] as const;

export type ActionsEvidenceDisposition =
  | 'promotion-hit'
  | 'fallback-no-evidence'
  | 'fallback-tree-mismatch'
  | 'fallback-base-moved'
  | 'fallback-policy-changed'
  | 'fallback-lockfile-changed'
  | 'fallback-toolchain-changed'
  | 'fallback-job-incomplete'
  | 'invalid-claim';

export interface ActionsEvidenceDigests {
  readonly workflowPolicySha256: string;
  readonly lockfileSha256: string;
  readonly toolchainContractSha256: string;
  readonly testContractSha256: string;
  readonly serviceContractSha256: string;
}

export interface ActionsSourceHash {
  readonly algorithm: 'sha256';
  readonly value: string;
  readonly fileCount: number;
}

export interface ActionsTreeIdentity {
  readonly algorithm: 'sha1' | 'sha256';
  readonly value: string;
}

export interface ActionsRunIdentity {
  readonly repository: string;
  readonly workflowRef: string;
  readonly eventName: 'pull_request' | 'merge_group';
  readonly runId: string;
  readonly runAttempt: number;
  readonly actor: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly testedCommitSha: string;
  readonly testedTree: ActionsTreeIdentity;
  readonly digests: ActionsEvidenceDigests;
}

export interface ActionsRunEvidenceManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly expiresAt: string;
  readonly subject: {
    readonly repository: string;
    readonly commitSha: string;
    readonly tree: ActionsTreeIdentity;
  };
  readonly origin: 'actions-run';
  readonly sourceHash: ActionsSourceHash;
  readonly policy: {
    readonly maxAgeHours: number;
    readonly requiredJobs: readonly string[];
    readonly allowedPlatforms: readonly string[];
  };
  readonly tools: Readonly<
    Record<string, { readonly expected?: string; readonly observed: string[] }>
  >;
  readonly platforms: readonly string[];
  readonly jobs: Readonly<Record<string, { readonly result: 'success' }>>;
  readonly actionsRun: ActionsRunIdentity;
}

export interface CurrentActionsCheckout {
  readonly repository: string;
  readonly workflowRef: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly basePolicySatisfied: boolean;
  readonly headIsMergeInput: boolean;
  readonly mergedTree: ActionsTreeIdentity;
  readonly recomputedSourceHash: ActionsSourceHash;
  readonly digests: ActionsEvidenceDigests;
  readonly successfulJobs: readonly string[];
}

export interface VerifyActionsRunEvidenceInputs {
  readonly mode: 'shadow' | 'gate';
  readonly gateAuthorization?: {
    readonly authorized: boolean;
    readonly status: 'active' | 'revoked' | 'unavailable';
    readonly source: 'base-parent';
    readonly reason: string;
  };
  readonly manifest: unknown | null;
  readonly current: CurrentActionsCheckout;
}

export interface ActionsEvidenceDecision {
  readonly disposition: ActionsEvidenceDisposition;
  readonly reason: string;
  readonly executeFullCi: boolean;
  readonly hardFailure: boolean;
  readonly reusableJobs: readonly string[];
  readonly freshnessJobs: readonly string[];
}

export interface ActionsEvidenceWindowObservation {
  readonly mergeSha: string;
  readonly disposition: ActionsEvidenceDisposition | 'UNKNOWN';
  readonly shadowFullEquivalent: boolean;
  readonly durable: boolean;
  readonly mechanismDefect?: boolean;
}

export interface ActionsEvidenceWindowDecision {
  readonly qualifies: boolean;
  readonly consecutiveMerges: number;
  readonly promotionHits: number;
  readonly resetAfterMerge?: string;
  readonly reason: string;
}

export interface ActionsEvidenceFullResult {
  readonly schemaVersion: 1;
  readonly kind: 'actions-run-full-result';
  readonly repository: string;
  readonly workflowRef: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly testedCommitSha: string;
  readonly testedTree: ActionsTreeIdentity;
  readonly result: 'success';
  readonly fullCiAuthoritative: true;
  readonly jobs: Readonly<Record<string, 'success'>>;
}

export interface ActionsEvidenceSourceBundle {
  readonly schemaVersion: 1;
  readonly kind: 'actions-evidence-source';
  readonly manifest: ActionsRunEvidenceManifest;
  readonly fullResult: ActionsEvidenceFullResult;
}

export interface ActionsEvidenceShadowDecision {
  readonly schemaVersion: 1;
  readonly kind: 'actions-evidence-shadow-decision';
  readonly mainRunId: string;
  readonly mainRunAttempt: number;
  readonly mergedCommitSha: string;
  readonly fullCiResult: 'success';
  readonly shadowFullEquivalent: boolean;
  readonly disposition: ActionsEvidenceDisposition | 'UNKNOWN';
  readonly reason: string;
  readonly executeFullCi: true;
  readonly reusableJobs?: readonly string[];
  readonly freshnessJobs?: readonly string[];
}

export interface ValidateActionsEvidenceShadowTupleInputs {
  readonly manifest: unknown;
  readonly fullResult: unknown;
  readonly decision: unknown;
  readonly mergeParents: readonly string[];
}

export class ActionsEvidenceError extends Error {
  readonly actionsEvidenceFailure = true;
}

function decision(
  mode: 'shadow' | 'gate',
  disposition: ActionsEvidenceDisposition,
  reason: string,
): ActionsEvidenceDecision {
  return {
    disposition,
    reason,
    executeFullCi: mode === 'shadow' || disposition !== 'promotion-hit',
    hardFailure: disposition === 'invalid-claim',
    reusableJobs: ACTIONS_REUSABLE_JOBS,
    freshnessJobs: ACTIONS_FRESHNESS_JOBS,
  };
}

function asActionsManifest(value: unknown): ActionsRunEvidenceManifest | null {
  if (!validateLocalEvidenceManifest(value)) return null;
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { origin?: unknown }).origin !== 'actions-run' ||
    typeof (value as { actionsRun?: unknown }).actionsRun !== 'object'
  ) {
    return null;
  }
  const manifest = value as ActionsRunEvidenceManifest;
  const generatedAt = Date.parse(manifest.generatedAt);
  const expiresAt = Date.parse(manifest.expiresAt);
  if (
    !Number.isFinite(generatedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt !== generatedAt + manifest.policy.maxAgeHours * 60 * 60 * 1000 ||
    manifest.subject.repository !== manifest.actionsRun.repository ||
    manifest.subject.commitSha !== manifest.actionsRun.testedCommitSha ||
    !sameTree(manifest.subject.tree, manifest.actionsRun.testedTree)
  ) {
    return null;
  }
  return manifest;
}

function sameTree(left: ActionsTreeIdentity, right: ActionsTreeIdentity): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function sameSourceHash(left: ActionsSourceHash, right: ActionsSourceHash): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.value === right.value &&
    left.fileCount === right.fileCount
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameStringArray(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) && JSON.stringify(left) === JSON.stringify(right);
}

function requireTuple(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ActionsEvidenceError(`actions evidence tuple: ${message}`);
}

/**
 * Validate an Auditor-imported shadow tuple before it becomes durable
 * Article-32 evidence. This intentionally validates the three transported
 * values together; a generic evidence append cannot establish that the
 * manifest, authoritative full result, merge decision, and actual merge
 * parents describe one observation.
 */
export function validateActionsEvidenceShadowTuple(
  inputs: ValidateActionsEvidenceShadowTupleInputs,
): ActionsEvidenceWindowObservation {
  const manifest = asActionsManifest(inputs.manifest);
  requireTuple(manifest !== null, 'manifest is not a valid actions-run claim');
  requireTuple(isRecord(inputs.fullResult), 'full result is not an object');
  requireTuple(isRecord(inputs.decision), 'shadow decision is not an object');

  const full = inputs.fullResult;
  const shadow = inputs.decision;
  const claimed = manifest.actionsRun;
  requireTuple(full['schemaVersion'] === 1, 'full result schemaVersion is invalid');
  requireTuple(full['kind'] === 'actions-run-full-result', 'full result kind is invalid');
  requireTuple(full['result'] === 'success', 'full result is not successful');
  requireTuple(full['fullCiAuthoritative'] === true, 'full result is not authoritative');
  for (const [field, expected] of [
    ['repository', claimed.repository],
    ['workflowRef', claimed.workflowRef],
    ['runId', claimed.runId],
    ['runAttempt', claimed.runAttempt],
    ['testedCommitSha', claimed.testedCommitSha],
  ] as const) {
    requireTuple(full[field] === expected, `full result ${field} does not match the manifest`);
  }
  requireTuple(
    JSON.stringify(full['testedTree']) === JSON.stringify(claimed.testedTree),
    'full result tested tree does not match the manifest',
  );
  requireTuple(isRecord(full['jobs']), 'full result jobs are missing');
  for (const job of ACTIONS_REUSABLE_JOBS) {
    requireTuple(full['jobs'][job] === 'success', `full result is missing successful job ${job}`);
  }

  requireTuple(shadow['schemaVersion'] === 1, 'shadow decision schemaVersion is invalid');
  requireTuple(
    shadow['kind'] === 'actions-evidence-shadow-decision',
    'shadow decision kind is invalid',
  );
  requireTuple(
    typeof shadow['mainRunId'] === 'string' && shadow['mainRunId'].length > 0,
    'shadow decision main run id is invalid',
  );
  requireTuple(
    Number.isSafeInteger(shadow['mainRunAttempt']) && Number(shadow['mainRunAttempt']) > 0,
    'shadow decision main run attempt is invalid',
  );
  requireTuple(
    typeof shadow['mergedCommitSha'] === 'string' &&
      /^[0-9a-f]{40,64}$/.test(shadow['mergedCommitSha']),
    'shadow decision merge SHA is invalid',
  );
  requireTuple(shadow['fullCiResult'] === 'success', 'shadow decision full CI is not successful');
  requireTuple(shadow['executeFullCi'] === true, 'shadow decision did not execute full CI');
  requireTuple(
    typeof shadow['reason'] === 'string' && shadow['reason'].length > 0,
    'shadow reason is missing',
  );

  const dispositions = new Set<string>([
    'UNKNOWN',
    'promotion-hit',
    'fallback-no-evidence',
    'fallback-tree-mismatch',
    'fallback-base-moved',
    'fallback-policy-changed',
    'fallback-lockfile-changed',
    'fallback-toolchain-changed',
    'fallback-job-incomplete',
    'invalid-claim',
  ]);
  requireTuple(
    typeof shadow['disposition'] === 'string' && dispositions.has(shadow['disposition']),
    'shadow disposition is invalid',
  );
  const disposition = shadow['disposition'] as ActionsEvidenceDisposition | 'UNKNOWN';
  const equivalent = shadow['shadowFullEquivalent'];
  requireTuple(typeof equivalent === 'boolean', 'shadow/full equivalence is invalid');
  if (disposition === 'UNKNOWN' || disposition === 'invalid-claim') {
    requireTuple(equivalent === false, `${disposition} cannot claim shadow/full equivalence`);
  } else {
    requireTuple(equivalent === true, `${disposition} must record shadow/full equivalence`);
    requireTuple(
      sameStringArray(shadow['reusableJobs'], ACTIONS_REUSABLE_JOBS),
      'shadow reusable-job set does not match the current contract',
    );
    requireTuple(
      sameStringArray(shadow['freshnessJobs'], ACTIONS_FRESHNESS_JOBS),
      'shadow freshness-job set does not match the current contract',
    );
  }
  if (disposition === 'promotion-hit') {
    requireTuple(
      inputs.mergeParents.length === 2 &&
        inputs.mergeParents[0] === claimed.baseSha &&
        inputs.mergeParents[1] === claimed.headSha,
      'promotion hit does not have the exact tested base and head merge inputs',
    );
  }

  return {
    mergeSha: shadow['mergedCommitSha'] as string,
    disposition,
    shadowFullEquivalent: equivalent,
    durable: true,
  };
}

export function verifyActionsRunEvidence(
  inputs: VerifyActionsRunEvidenceInputs,
): ActionsEvidenceDecision {
  if (inputs.mode === 'gate' && inputs.gateAuthorization?.authorized !== true) {
    return decision(
      inputs.mode,
      'fallback-no-evidence',
      'active graduation authorization from the base parent is unavailable',
    );
  }
  if (inputs.manifest === null) {
    return decision(inputs.mode, 'fallback-no-evidence', 'no Actions-run evidence claim exists');
  }

  const manifest = asActionsManifest(inputs.manifest);
  if (manifest === null) {
    return decision(
      inputs.mode,
      'invalid-claim',
      'Actions-run evidence manifest or schema claim is invalid',
    );
  }

  const claimed = manifest.actionsRun;
  const current = inputs.current;
  if (claimed.repository !== current.repository) {
    return decision(inputs.mode, 'invalid-claim', 'repository identity does not match the claim');
  }
  if (claimed.workflowRef !== current.workflowRef) {
    return decision(inputs.mode, 'invalid-claim', 'workflow identity does not match the claim');
  }
  if (claimed.runId !== current.runId) {
    return decision(
      inputs.mode,
      'invalid-claim',
      'run id does not match the selected evidence run',
    );
  }
  if (claimed.runAttempt !== current.runAttempt) {
    return decision(
      inputs.mode,
      'invalid-claim',
      'run attempt does not match the selected evidence run',
    );
  }
  if (claimed.headSha !== current.headSha) {
    return decision(inputs.mode, 'invalid-claim', 'PR head is not the claimed merge input');
  }
  if (claimed.mergeBaseSha !== current.mergeBaseSha) {
    return decision(inputs.mode, 'invalid-claim', 'merge-base identity does not match the claim');
  }
  if (!current.headIsMergeInput) {
    return decision(
      inputs.mode,
      'invalid-claim',
      'PR head is not an input to the configured merge method',
    );
  }
  if (claimed.baseSha !== current.baseSha || !current.basePolicySatisfied) {
    return decision(
      inputs.mode,
      'fallback-base-moved',
      'protected base moved or required up-to-date/merge-queue policy was not satisfied',
    );
  }
  if (!sameTree(claimed.testedTree, current.mergedTree)) {
    return decision(
      inputs.mode,
      'fallback-tree-mismatch',
      'actual merged tree differs from tested tree',
    );
  }
  if (!sameSourceHash(manifest.sourceHash, current.recomputedSourceHash)) {
    return decision(
      inputs.mode,
      'fallback-tree-mismatch',
      'merged-checkout sourceHash or source file count differs from the claim',
    );
  }
  if (claimed.digests.lockfileSha256 !== current.digests.lockfileSha256) {
    return decision(inputs.mode, 'fallback-lockfile-changed', 'lockfile digest changed');
  }
  if (claimed.digests.toolchainContractSha256 !== current.digests.toolchainContractSha256) {
    return decision(inputs.mode, 'fallback-toolchain-changed', 'toolchain contract digest changed');
  }
  for (const [name, left, right] of [
    ['workflow policy', claimed.digests.workflowPolicySha256, current.digests.workflowPolicySha256],
    ['test contract', claimed.digests.testContractSha256, current.digests.testContractSha256],
    [
      'service contract',
      claimed.digests.serviceContractSha256,
      current.digests.serviceContractSha256,
    ],
  ] as const) {
    if (left !== right) {
      return decision(inputs.mode, 'fallback-policy-changed', `${name} digest changed`);
    }
  }

  const successful = new Set(current.successfulJobs);
  const missingJob = manifest.policy.requiredJobs.find((job) => !successful.has(job));
  if (missingJob !== undefined) {
    return decision(
      inputs.mode,
      'fallback-job-incomplete',
      `required heavy job is incomplete: ${missingJob}`,
    );
  }

  return decision(inputs.mode, 'promotion-hit', 'exact tested value is eligible for promotion');
}

export function selectActionsEvidenceJobs(decisionValue: ActionsEvidenceDecision): {
  readonly runJobs: readonly string[];
  readonly skippedJobs: readonly string[];
} {
  if (!decisionValue.executeFullCi && !decisionValue.hardFailure) {
    return { runJobs: ACTIONS_FRESHNESS_JOBS, skippedJobs: ACTIONS_REUSABLE_JOBS };
  }
  return {
    runJobs: [...ACTIONS_FRESHNESS_JOBS, ...ACTIONS_REUSABLE_JOBS],
    skippedJobs: [],
  };
}

type RequiredCheckResult = 'success' | 'failure' | 'skipped';

export function aggregateActionsEvidenceRequiredCheck(inputs: {
  readonly preflight: RequiredCheckResult;
  readonly evidenceGate: RequiredCheckResult;
  readonly freshness: RequiredCheckResult;
  readonly reusable: RequiredCheckResult;
  readonly decision: ActionsEvidenceDecision;
}): 'success' | 'failure' {
  if (
    inputs.decision.hardFailure ||
    inputs.preflight !== 'success' ||
    inputs.evidenceGate !== 'success' ||
    inputs.freshness !== 'success'
  ) {
    return 'failure';
  }
  if (inputs.reusable === 'success') return 'success';
  const promotionJustifiesSkip =
    inputs.reusable === 'skipped' &&
    inputs.decision.disposition === 'promotion-hit' &&
    !inputs.decision.executeFullCi;
  return promotionJustifiesSkip ? 'success' : 'failure';
}

export function evaluateActionsEvidenceWindow(
  observations: readonly ActionsEvidenceWindowObservation[],
): ActionsEvidenceWindowDecision {
  let consecutiveMerges = 0;
  let promotionHits = 0;
  let resetAfterMerge: string | undefined;
  let resetReason = 'no complete candidate window exists';

  for (const observation of observations) {
    const reset =
      observation.disposition === 'UNKNOWN' ||
      observation.disposition === 'invalid-claim' ||
      !observation.shadowFullEquivalent ||
      !observation.durable ||
      observation.mechanismDefect === true;
    if (reset) {
      consecutiveMerges = 0;
      promotionHits = 0;
      resetAfterMerge = observation.mergeSha;
      resetReason =
        observation.disposition === 'UNKNOWN'
          ? 'UNKNOWN observation is non-skippable and resets the candidate window'
          : observation.mechanismDefect === true
            ? 'promotion mechanism defect resets the candidate window'
            : !observation.durable
              ? 'undurable observation resets the candidate window'
              : 'shadow/full disagreement or invalid claim resets the candidate window';
      continue;
    }
    consecutiveMerges += 1;
    if (observation.disposition === 'promotion-hit') promotionHits += 1;
  }

  const hitRate = consecutiveMerges === 0 ? 0 : promotionHits / consecutiveMerges;
  const qualifies = consecutiveMerges >= 5 && promotionHits >= 3 && hitRate >= 0.5;
  const result: ActionsEvidenceWindowDecision = {
    qualifies,
    consecutiveMerges,
    promotionHits,
    reason: qualifies
      ? 'candidate window satisfies consecutive merge, promotion-hit, and hit-rate thresholds'
      : resetAfterMerge === undefined
        ? 'candidate window has not reached every graduation threshold'
        : resetReason,
  };
  return resetAfterMerge === undefined ? result : { ...result, resetAfterMerge };
}
