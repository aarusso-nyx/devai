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
