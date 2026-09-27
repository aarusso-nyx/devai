export type PersistedReleaseState =
  | 'preflight_passed'
  | 'certified'
  | 'prepared'
  | 'exported'
  | 'evidence_published'
  | 'publication_dispatched';
export type DerivedReleaseState = 'planned' | 'offline_verified' | 'published';

export interface ReleaseIdentity {
  readonly id: string;
  readonly commit: string;
  readonly tree: string;
}

export interface ReleaseCandidateIdentity {
  readonly release_unit: string;
  readonly version: string;
  readonly commit: string;
  readonly tree: string;
}

export interface ReleaseArtifactIdentity {
  readonly kind: 'package-tarball' | 'evidence-bundle' | 'manifest' | 'attestation';
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export interface ReleaseStateReference {
  readonly state: PersistedReleaseState;
  readonly state_id: string;
  readonly record_digest_sha256: string;
}

export interface ReleaseLifecycleStateRecord extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly state_id: string;
  readonly state: PersistedReleaseState;
  readonly action_id:
    | 'release preflight'
    | 'release certify'
    | 'release prepare'
    | 'release export'
    | 'release evidence-publish'
    | 'release publish';
  readonly effect: 'harness-write' | 'local-write' | 'remote-write';
  readonly prior_state: ReleaseStateReference | null;
  readonly repository: ReleaseIdentity;
  readonly candidate: ReleaseCandidateIdentity;
  readonly artifacts: readonly ReleaseArtifactIdentity[];
  readonly authorization_event_id: string | null;
  readonly publication_expectation: PublicationExpectation | null;
  readonly record_digest_sha256: string;
}

export interface PublicationExpectation {
  readonly authorization_event_id: string;
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
  readonly trust: {
    readonly trust_root_id: string;
    readonly trust_store_digest_sha256: string;
    readonly key_id: string;
    readonly signature_algorithm: 'ed25519' | 'ecdsa-p256-sha256' | 'rsa-pss-sha256';
  };
}

export interface ReleasePlanReceipt extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0' | '2.0.0';
  readonly receipt_kind: 'release-plan-receipt';
  readonly receipt_id: string;
  readonly state_observed: 'planned' | null;
  readonly verdict: 'pass' | 'block';
  readonly repository: ReleaseIdentity;
  readonly candidate: ReleaseCandidateIdentity;
  readonly receipt_digest_sha256: string;
}

export interface ReleaseOfflineVerificationReceipt extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly receipt_kind: 'release-offline-verification-receipt';
  readonly receipt_id: string;
  readonly verdict: 'pass' | 'fail';
  readonly state_observed: 'offline_verified' | null;
  readonly repository: ReleaseIdentity;
  readonly candidate: ReleaseCandidateIdentity;
  readonly verified_state: ReleaseStateReference;
  readonly artifacts: readonly ReleaseArtifactIdentity[];
  readonly receipt_digest_sha256: string;
}

export interface ReleasePublicationReceipt extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly receipt_kind: 'release-publication-receipt';
  readonly receipt_id: string;
  readonly attests_state: 'published' | null;
  readonly outcome: 'published' | 'failed';
  readonly repository: ReleaseIdentity;
  readonly candidate: ReleaseCandidateIdentity;
  readonly dispatched_state: ReleaseStateReference & { readonly state: 'publication_dispatched' };
  readonly artifacts: readonly ReleaseArtifactIdentity[];
  readonly publication: PublicationExpectation['destination'];
  readonly workflow: PublicationExpectation['workflow'] & {
    readonly run_id: string;
    readonly run_attempt: number;
    readonly candidate_product_execution: false;
  };
  readonly trust: PublicationExpectation['trust'] & {
    readonly signature: string;
    readonly signed_payload_digest_sha256: string;
  };
  readonly receipt_digest_sha256: string;
}

export interface ReleaseDerivedReceipt {
  readonly state: DerivedReleaseState;
  readonly receipt_kind:
    'release-plan-receipt' | 'release-offline-verification-receipt' | 'release-publication-receipt';
  readonly receipt_id: string;
  readonly receipt_digest_sha256: string;
  readonly verified: true;
}

export interface ReleaseLifecycleObservation extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0' | '1.1.0';
  readonly observation_kind: 'release-lifecycle-observation';
  readonly observation_id: string;
  readonly repository: ReleaseIdentity;
  readonly candidate: ReleaseCandidateIdentity;
  readonly head: ReleaseStateReference | null;
  readonly derived_states: readonly ReleaseDerivedReceipt[];
  readonly published: Readonly<Record<string, unknown>>;
  readonly observation_digest_sha256: string;
}

export type ReleaseLifecycleError =
  | 'release-state-schema-invalid'
  | 'release-state-record-digest-mismatch'
  | 'release-state-id-duplicate'
  | 'release-state-transition-invalid'
  | 'release-state-prior-mismatch'
  | 'release-state-repository-mismatch'
  | 'release-state-candidate-mismatch';

export type ReleaseLifecycleReduction =
  | {
      readonly ok: true;
      readonly records: readonly ReleaseLifecycleStateRecord[];
      readonly head: ReleaseLifecycleStateRecord | null;
    }
  | { readonly ok: false; readonly errors: readonly ReleaseLifecycleError[] };

export type PublicationSignatureVerifier = (input: {
  readonly signed_payload_digest_sha256: string;
  readonly signature: string;
  readonly trust: PublicationExpectation['trust'];
}) => boolean | Promise<boolean>;

export type ReleaseTransitionResult<T> =
  | {
      readonly ok: true;
      readonly state: ReleaseLifecycleStateRecord;
      readonly adapter_result: T;
    }
  | {
      readonly ok: false;
      readonly phase: 'validation' | 'authorization' | 'adapter' | 'append';
      readonly code: string;
      readonly cause?: unknown;
    };
