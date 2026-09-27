import type {
  UnitMutationEvidenceBinding,
  ReleaseUnitMutationEvidenceClosure,
} from './release-unit-mutation-evidence.js';

export const RELEASE_ACTIONS = [
  'release plan',
  'release preflight',
  'release certify',
  'release prepare',
  'release export',
  'release offline-verify',
  'release evidence-publish',
  'release publish',
  'release resume',
] as const;

export type ReleaseAction = (typeof RELEASE_ACTIONS)[number];
export type PersistedReleaseAction = Exclude<
  ReleaseAction,
  'release plan' | 'release offline-verify' | 'release resume'
>;
export type PersistedReleaseState =
  | 'preflight_passed'
  | 'certified'
  | 'prepared'
  | 'exported'
  | 'evidence_published'
  | 'publication_dispatched';

export interface LegacyArtifactIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export interface OpaqueArtifactIdentity {
  readonly kind:
    | 'package-manifest'
    | 'package-tarball'
    | 'package-sbom'
    | 'evidence-manifest'
    | 'provider-result';
  readonly sink_id: string;
  readonly opaque_handle: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export type ArtifactIdentity = LegacyArtifactIdentity | OpaqueArtifactIdentity;

export interface ArtifactSinkCommitIdentity {
  readonly sink_id: string;
  readonly transaction_handle: string;
  readonly committed_manifest_handle: string;
  readonly committed_manifest_sha256: string;
  readonly committed_manifest_size_bytes: number;
  readonly commit_protocol: 'devai.artifact-sink.two-phase.v1';
}

export interface CertificationPackageEntry {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly size_bytes: number;
  readonly sha256: string;
  readonly immutable_blob_locator:
    | GitReleaseBlobLocator
    | {
        readonly kind: 'generated-output';
        readonly output_blob_sha256: string;
        readonly output_blob_handle: CertificationOutputBlobHandle;
        readonly certification_evidence_receipt: {
          readonly kind: 'release-certification-evidence-receipt-v1';
          readonly receipt_digest_sha256: string;
          readonly canonicalization: 'utf-8-rfc8785-jcs-sha256';
          readonly referent: {
            readonly candidate_commit: string;
            readonly candidate_tree: string;
            readonly task_policy_digest_sha256: string;
            readonly package_id: string;
            readonly output_blob_sha256: string;
            readonly output_blob_handle: CertificationOutputBlobHandle;
          };
        };
      };
}

export interface GitReleaseBlobLocator {
  readonly kind: 'git-object';
  readonly repository: string;
  readonly commit: string;
  readonly tree: string;
  readonly object_format: 'sha1' | 'sha256';
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly object_id: string;
  readonly size_bytes: number;
  readonly content_digest_sha256: string;
}

export interface CertificationOutputBlobHandle {
  readonly evidence_sink_id: string;
  readonly opaque_handle: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export interface CertificationPackageEntryManifest {
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly task_policy_digest_sha256: string;
  readonly package_id: string;
  readonly package_version: string;
  readonly entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse';
  readonly manifest_digest_contract: {
    readonly domain: 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\0';
    readonly payload: 'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes';
    readonly canonicalization: 'rfc8785-jcs';
    readonly algorithm: 'sha256';
  };
  readonly entries: readonly CertificationPackageEntry[];
  readonly manifest_digest_sha256: string;
}

export interface TrustIdentity {
  readonly trust_root_id: string;
  readonly trust_store_digest_sha256: string;
  readonly key_id: string;
  readonly signature_algorithm: 'ed25519' | 'ecdsa-p256-sha256' | 'rsa-pss-sha256';
}

export interface ReleaseLifecycleRequest extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly request_kind: 'release-lifecycle-request';
  readonly action_id: ReleaseAction;
  readonly repository_locator: {
    readonly id: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly candidate_locator: {
    readonly commit: string;
    readonly tree: string;
    readonly release_units: readonly {
      readonly release_unit: string;
      readonly version: string;
      readonly package_roster: readonly {
        readonly package_id: string;
        readonly manifest_path: string;
        readonly manifest_digest_sha256: string;
      }[];
    }[];
  };
  readonly receipt_locators?: readonly {
    readonly kind: 'release-plan-receipt' | 'release-offline-verification-receipt';
    readonly receipt_id: string;
    readonly receipt_digest_sha256: string;
    readonly path: string;
  }[];
  readonly provider?: { readonly kind: string; readonly provider_id: string };
  readonly destination?: {
    readonly kind: string;
    readonly exact_identifier: string;
    readonly trust?: TrustIdentity;
  };
}

export interface PackageEvidence {
  readonly package_id: string;
  readonly manifest?: LegacyArtifactIdentity | null;
  readonly tarball?: LegacyArtifactIdentity | null;
  readonly sbom?: LegacyArtifactIdentity | null;
  readonly package_manifest?: OpaqueArtifactIdentity | null;
  readonly package_tarball?: OpaqueArtifactIdentity | null;
  readonly package_sbom?: OpaqueArtifactIdentity | null;
  readonly evidence_manifest: ArtifactIdentity | null;
  readonly provider_result: ArtifactIdentity | null;
  readonly trust: TrustIdentity | null;
  readonly certification_manifest?: CertificationPackageEntryManifest | null;
}

export interface ReleaseUnitEvidence {
  readonly release_unit: string;
  readonly version: string;
  readonly packages: readonly PackageEvidence[];
  readonly mutation_evidence?: ReleaseUnitMutationEvidenceClosure | null;
}

export interface ReleaseStateMaterial {
  readonly release_units: readonly ReleaseUnitEvidence[];
  readonly inputs: readonly {
    readonly kind: string;
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly evidence: {
    readonly manifest_digest_sha256: string;
    readonly receipt_digests: readonly string[];
    readonly independently_checkable: true;
  };
  readonly artifacts: readonly (
    (LegacyArtifactIdentity & { readonly kind: string }) | OpaqueArtifactIdentity
  )[];
  readonly artifact_sink?: ArtifactSinkCommitIdentity | null;
}

export interface TrustedReleaseAuthority {
  readonly actor: {
    readonly kind: 'human';
    readonly role: 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
    readonly declaration_source: 'cli-flag' | 'session-state';
  };
  readonly consent: {
    readonly write: true;
    readonly allow_publish: boolean;
    readonly experimental: false;
  };
}

export interface PublicationControls {
  readonly destination: {
    readonly system_id: string;
    readonly exact_identifier: string;
    readonly operation: 'publish';
  };
  readonly workflow: {
    readonly repository: string;
    readonly workflow_path: string;
    readonly workflow_sha: string;
    readonly protected_environment: string;
    readonly protected: true;
  };
  readonly trust: TrustIdentity;
}

export interface ReleaseLifecycleStateV2 extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '2.0.0' | '2.1.0';
  readonly state_id: string;
  readonly state: PersistedReleaseState;
  readonly action_id: PersistedReleaseAction;
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: {
    readonly release_unit: string;
    readonly version: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly release_units: readonly ReleaseUnitEvidence[];
  readonly inputs: ReleaseStateMaterial['inputs'];
  readonly prior_state: StateReference | null;
  readonly storage: { readonly generation: number; readonly head_before: StateStorageHead | null };
  readonly record_digest_sha256: string;
  readonly artifact_sink?: ArtifactSinkCommitIdentity | null;
}

export interface StateReference {
  readonly state: PersistedReleaseState;
  readonly state_id: string;
  readonly record_digest_sha256: string;
}

export interface StateStorageHead {
  readonly generation: number;
  readonly record_digest_sha256: string;
}

export interface StoreHead extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '2.0.0';
  readonly canonicalization: Readonly<Record<string, unknown>>;
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly generation: number;
  readonly state_id: string;
  readonly state_digest_sha256: string;
  readonly completion_record: StoreRecordReference & { readonly attempt_id: string };
  readonly head_digest_sha256: string;
}

export interface StoreRecord extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly record_kind: 'attempt' | 'completion' | 'failure' | 'unknown-provider-result';
  readonly record_id: string;
  readonly record_digest_sha256: string;
  readonly sequence: number;
  readonly predecessor_record: StoreRecordReference | null;
  readonly observed_head_before: StoreHead | null;
  readonly attempt_id: string;
  readonly action_id: PersistedReleaseAction;
  readonly request_digest_sha256: string;
  readonly authorization_event_id: string | null;
  readonly provider_handle: string | null;
  readonly provider_dispatch: {
    readonly status: 'not-dispatched' | 'failed-before-dispatch' | 'dispatched' | 'unknown';
    readonly handle_observed: boolean;
  };
  readonly completion: {
    readonly state_id: string;
    readonly state_digest_sha256: string;
    readonly state: PersistedReleaseState;
  } | null;
  readonly failure: { readonly code: string; readonly retryable: false } | null;
  readonly unknown: {
    readonly code: 'release-provider-result-unknown';
    readonly redispatch_permitted: false;
    readonly artifact_sink?: ArtifactSinkCommitIdentity;
    readonly artifacts?: readonly OpaqueArtifactIdentity[];
  } | null;
}

export interface StoreRecordReference {
  readonly sequence: number;
  readonly record_id: string;
  readonly record_digest_sha256: string;
}

export interface ReleaseProviderResult {
  readonly outcome: 'success' | 'failure' | 'unknown';
  readonly dispatch_status?: 'failed-before-dispatch' | 'dispatched' | 'unknown';
  readonly provider_handle?: string;
  readonly material?: ReleaseStateMaterial;
  readonly code?: string;
  readonly transaction?: {
    readonly commit: () => void | Promise<void>;
    readonly rollback: () => void | Promise<void>;
    readonly dispose: () => void | Promise<void>;
  };
}

export type ReleaseProvider = (
  request: ReleaseLifecycleRequest,
  context?: ReleaseProviderInvocationContext,
) => ReleaseProviderResult | Promise<ReleaseProviderResult>;

/**
 * Core-derived data for one live provider invocation, not a request field or an
 * execution/signing grant. The durable attempt and verified parent already exist.
 */
export interface ReleaseProviderInvocationContext {
  readonly action_id: PersistedReleaseAction;
  readonly request_digest_sha256: string;
  readonly attempt_id: string;
  readonly attempt_record: StoreRecordReference;
  readonly prior_state: ReleaseLifecycleStateV2 | null;
}

export interface TrustedArtifactReader {
  readonly readArtifact: (input: {
    readonly sink_id: string;
    readonly opaque_handle: string;
  }) => Buffer | Promise<Buffer>;
}

export type OfflineVerificationProvider = (
  request: ReleaseLifecycleRequest,
  exportedState: ReleaseLifecycleStateV2,
  context?: VerifiedReleaseOfflineContext,
) => unknown | Promise<unknown>;

/** A completed validation pass, issued only by executeOfflineVerification. */
export interface VerifiedReleaseOfflineContext {
  readonly kind: 'verified-release-offline-context';
}
export interface OfflineContextCapture {
  readonly request: ReleaseLifecycleRequest;
  readonly state: ReleaseLifecycleStateV2;
  readonly plan_receipts: readonly Readonly<Record<string, unknown>>[];
}

export type ReleasePlanInputResolver = (input: Readonly<Record<string, unknown>>) => unknown;

export interface TrustedOfflineReceiptVerifier {
  readonly verify: (input: {
    readonly repository: ReleaseLifecycleRequest['repository_locator'];
    readonly candidate_locator: ReleaseLifecycleRequest['candidate_locator'];
    readonly exported_state: ReleaseLifecycleStateV2;
    readonly receipt: Readonly<Record<string, unknown>>;
  }) => unknown | Promise<unknown>;
}

export interface AuthorizationLedgerHead {
  readonly ledger_id: string;
  readonly sequence: number;
  readonly event_id: string;
  readonly event_digest_sha256: string;
}

export type AuthorizationResolution =
  | {
      readonly ok: true;
      readonly ledger: unknown;
      readonly events: readonly unknown[];
    }
  | { readonly ok: false; readonly code: string };

export interface AuthorizationConsumptionProof {
  readonly durable: true;
  readonly ledger: unknown;
  readonly events: readonly unknown[];
}

export interface AuthorizationBridge {
  readonly resolve: (
    binding: AuthorizationAttemptBinding,
  ) => AuthorizationResolution | Promise<AuthorizationResolution>;
  readonly consume: (
    binding: AuthorizationAttemptBinding & { readonly grant_event_id: string },
  ) => AuthorizationConsumptionProof | Promise<AuthorizationConsumptionProof>;
}

export interface AuthorizationAttemptBinding {
  readonly attempt_id: string;
  readonly action_id: PersistedReleaseAction;
  readonly request_digest_sha256: string;
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: ReleaseLifecycleStateV2['candidate'];
  readonly destination: {
    readonly system_id: string;
    readonly exact_identifier: string;
    readonly operation: 'create' | 'publish';
  };
}

export type ReceiptResolver = (
  locator: NonNullable<ReleaseLifecycleRequest['receipt_locators']>[number],
) => unknown;

export interface VerifiedReceipt {
  readonly kind: 'release-plan-receipt' | 'release-offline-verification-receipt';
  readonly value: Readonly<Record<string, unknown>>;
}

export interface ReleaseMutationRequirement {
  readonly release_unit: string;
  readonly binding: Readonly<
    Omit<UnitMutationEvidenceBinding, 'task_policy_digests_sha256'>
  > | null;
}

export interface StoreReduction {
  readonly ok: boolean;
  readonly records: readonly StoreRecord[];
  readonly last: StoreRecord | null;
  readonly errors: readonly string[];
  readonly ambiguous: boolean;
  readonly failed: boolean;
  readonly completed_head: StoreHead | null;
}

export interface VerifiedAuthorizationLedger {
  readonly ledger: Readonly<Record<string, unknown>>;
  readonly head: AuthorizationLedgerHead;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly by_id: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

export type ExecuteReleaseResult =
  | { readonly ok: true; readonly state: ReleaseLifecycleStateV2; readonly completion: StoreRecord }
  | {
      readonly ok: false;
      readonly phase: string;
      readonly code: string;
      readonly record?: StoreRecord;
    };

export type OfflineVerificationResult =
  | { readonly ok: true; readonly receipt: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly phase: 'validation' | 'provider'; readonly code: string };

export interface StateReduction {
  readonly ok: boolean;
  readonly head: ReleaseLifecycleStateV2 | null;
  readonly errors: readonly string[];
}

export type PublicationSignatureVerifier = (input: {
  readonly signed_payload_digest_sha256: string;
  readonly signature: string;
  readonly trust: TrustIdentity;
}) => boolean | Promise<boolean>;
