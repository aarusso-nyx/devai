import type {
  AuthorityContext,
  AuthorityDecisionSubject,
  AuthorityPolicyProvenance,
  Decision,
  MutationEnvelope,
  MutationRequest,
  PolicyEvaluation,
  ResourceTarget,
  TrustedExecutionState,
  VerifiedDecisionBinding,
} from './types.js';

export interface AuthorityRuntimeVerification {
  readonly verified: boolean;
  /** Independent recomputation over the complete trusted envelope. */
  readonly envelope_digest_sha256: string;
  readonly context?: AuthorityContext;
  /** Required for a bounded-batch decision; loaded from runtime state. */
  readonly execution_state?: TrustedExecutionState;
  readonly reasons: readonly string[];
}

/**
 * Security boundary between raw caller data and trusted mutation metadata.
 * The application owns this adapter. It combines the trusted action registry,
 * resolved policy loader, invocation-origin verifier, and runtime-state store.
 * Plans cannot submit an effect, mode, policy, machine identity, or progress.
 */
export interface AuthorityRuntimeAdapter {
  readonly adapter_id: string;
  readonly adapter_version: string;
  materialize(request: MutationRequest): MutationEnvelope;
  verify(subject: AuthorityDecisionSubject): AuthorityRuntimeVerification;
}

/**
 * Resolves path/transition authority from a materialized, version-bound policy.
 * W0 supplies this interface only; R19 enforcement supplies the adapter.
 */
export interface AuthorityPolicyAdapter {
  readonly provenance: AuthorityPolicyProvenance;
  evaluate(subject: AuthorityDecisionSubject, context: AuthorityContext): PolicyEvaluation;
}

declare const preparedMutationCapability: unique symbol;

/**
 * Opaque adapter-issued capability. R19 will add nonce/HMAC verification;
 * until then, the concrete adapter must validate every binding field and its
 * own issuance record before apply. Structural `{plan_id,target_ids}` values
 * are not PreparedMutation capabilities.
 */
export interface PreparedMutation {
  readonly [preparedMutationCapability]: true;
  readonly preparation_id: string;
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly plan_id: string;
  readonly batch_id?: string;
  readonly subject_digest_sha256: string;
  readonly decision_digest_sha256: string;
  readonly target_ids: readonly string[];
}

declare const verifiedPreparedMutationCapability: unique symbol;

/**
 * Adapter-local proof that a prepared mutation was actually issued and is
 * still valid for apply. Only the concrete boundary adapter may construct it.
 */
export interface VerifiedPreparedMutationCapability {
  readonly [verifiedPreparedMutationCapability]: true;
  readonly prepared: PreparedMutation;
  readonly adapter_id: string;
  readonly adapter_version: string;
}

export type PreparedMutationVerification =
  | { readonly verified: false; readonly reasons: readonly string[] }
  | {
      readonly verified: true;
      readonly capability: VerifiedPreparedMutationCapability;
    };

export interface MutationReceipt {
  readonly preparation_id: string;
  readonly applied_target_ids: readonly string[];
  readonly evidence_refs: readonly string[];
}

/**
 * Final side-effect boundaries implement this interface. Adapter-local
 * configuration resolves repository IDs to absolute roots; plans never carry
 * those roots. A router decision alone is insufficient.
 */
export interface MutationBoundaryAdapter {
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly target_kind: ResourceTarget['kind'];
  prepare(
    subject: AuthorityDecisionSubject,
    decision: Decision,
    binding: VerifiedDecisionBinding,
  ): Promise<PreparedMutation>;
  verifyPrepared(prepared: PreparedMutation): PreparedMutationVerification;
  apply(capability: VerifiedPreparedMutationCapability): Promise<MutationReceipt>;
  rollback?(prepared: PreparedMutation): Promise<void>;
}

/** Trusted hosts may constrain shell/editor writes that CLI-only mode cannot. */
export interface HostEnforcementAdapter {
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly mode: 'host-integrated';
  attestContext(subject: AuthorityDecisionSubject): Promise<{
    readonly verified: boolean;
    readonly context_digest_sha256: string;
    readonly reasons: readonly string[];
  }>;
}

export interface AuthorityDecisionRecorder {
  record(decision: Decision): Promise<{ readonly evidence_ref: string }>;
}
