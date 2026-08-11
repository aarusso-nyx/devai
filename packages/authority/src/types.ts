/**
 * Authority decision seam.
 *
 * Round 19 W0 intentionally defines vocabulary and fail-closed hand-off
 * contracts only. It does not classify repository paths or authorize a
 * mutation. Enforcement must consume a resolved policy materialized under
 * `.devai/config/`, not DEVAI's source documentation.
 */

export const HUMAN_ROLES = ['owner', 'architect', 'inspector', 'engineer', 'auditor'] as const;
export type HumanRole = (typeof HUMAN_ROLES)[number];

export const MACHINE_ACTORS = ['harness', 'bootstrap', 'binding', 'release'] as const;
export type MachineActor = (typeof MACHINE_ACTORS)[number];

export type ActionEffect = 'read' | 'harness-write' | 'local-write' | 'remote-write';
export type EnforcementMode = 'shadow' | 'binding';

export type HumanPrincipal =
  | Readonly<{
      kind: 'human';
      role: HumanRole;
      declaration: Readonly<{ source: 'cli-flag'; declared_at: string }>;
    }>
  | Readonly<{
      kind: 'human';
      role: HumanRole;
      declaration: Readonly<{
        source: 'session-state';
        session_id: string;
        declared_at: string;
      }>;
    }>;

export type CallerDeclarablePrincipal = HumanPrincipal;

export type TrustedInvocationOrigin =
  | {
      readonly kind: 'direct-cli';
      readonly invocation_id: string;
    }
  | {
      readonly kind: 'interactive-session';
      readonly session_id: string;
    }
  | {
      readonly kind: 'ci-run';
      readonly provider: string;
      readonly repository_id: string;
      readonly workflow_id: string;
      readonly run_id: string;
      readonly event: string;
    }
  | {
      readonly kind: 'post-merge-hook';
      readonly repository_id: string;
      readonly hook_id: string;
      readonly merged_commit: string;
    }
  | {
      readonly kind: 'host-adapter';
      readonly adapter_id: string;
      readonly invocation_id: string;
    };

/**
 * Machine principals are runtime identities, never caller-selectable roles.
 * A trusted context adapter derives them from the action, transition, and
 * invocation origin. Raw plan data never contains a MachinePrincipal.
 */
export interface MachinePrincipal {
  readonly kind: 'machine';
  readonly actor: MachineActor;
  readonly derivation: {
    readonly action_id: string;
    readonly transition: 'harness-write' | 'bootstrap' | 'bind' | 'release';
    readonly origin: TrustedInvocationOrigin;
    readonly trusted_adapter_id: string;
    readonly invocation_id: string;
    readonly context_digest_sha256: string;
  };
}

export type Principal = HumanPrincipal | MachinePrincipal;

export interface HumanAuthorityContext {
  readonly kind: 'human-session';
  readonly principal: HumanPrincipal;
  readonly action_id: string;
  readonly origin: TrustedInvocationOrigin;
}

export interface MachineAuthorityContext {
  readonly kind: 'trusted-transition';
  readonly principal: MachinePrincipal;
  readonly initiated_by?: HumanPrincipal;
  readonly action_id: string;
  readonly consent: {
    readonly write: boolean;
    readonly allow_publish: boolean;
    readonly experimental: boolean;
  };
}

/** Produced only by a trusted AuthorityContextAdapter. */
export type AuthorityContext = HumanAuthorityContext | MachineAuthorityContext;

interface ResourceTargetBase {
  /** Stable, non-secret identifier used in decision/evidence records. */
  readonly id: string;
}

export interface FsResourceTarget extends ResourceTargetBase {
  readonly kind: 'fs';
  readonly repository_id: string;
  readonly canonical_relative_path: string;
  readonly operation: 'create' | 'update' | 'delete' | 'rename';
  readonly rename_from_canonical_relative_path?: string;
}

export interface GitRefResourceTarget extends ResourceTargetBase {
  readonly kind: 'git-ref';
  readonly repository_id: string;
  readonly ref: string;
  readonly operation: 'create' | 'update' | 'delete' | 'merge' | 'push';
  readonly remote_id?: string;
}

export interface DbResourceTarget extends ResourceTargetBase {
  readonly kind: 'db';
  /** Logical IDs only. URLs, passwords, and tokens are forbidden. */
  readonly connection_id: string;
  readonly database_id: string;
  readonly object_id: string;
  readonly operation: 'insert' | 'update' | 'delete' | 'ddl' | 'execute';
}

export interface RemoteResourceTarget extends ResourceTargetBase {
  readonly kind: 'remote';
  readonly system_id: string;
  /** Semantic endpoint identifier, never a credential-bearing URL. */
  readonly endpoint_id: string;
  readonly operation_id: string;
  readonly publication: boolean;
}

export type ResourceTarget =
  FsResourceTarget | GitRefResourceTarget | DbResourceTarget | RemoteResourceTarget;

export type ResourceTargetSelector =
  | {
      readonly kind: 'fs';
      readonly repository_id: string;
      readonly canonical_relative_path_glob: string;
      readonly operations: readonly FsResourceTarget['operation'][];
    }
  | {
      readonly kind: 'git-ref';
      readonly repository_id: string;
      readonly ref_glob: string;
      readonly operations: readonly GitRefResourceTarget['operation'][];
    }
  | {
      readonly kind: 'db';
      readonly connection_id: string;
      readonly database_id_glob: string;
      readonly object_id_glob: string;
      readonly operations: readonly DbResourceTarget['operation'][];
    }
  | {
      readonly kind: 'remote';
      readonly system_id: string;
      readonly endpoint_ids: readonly string[];
      readonly operation_ids: readonly string[];
      readonly publication: boolean;
    };

export type AuthorityPolicyProvenance = Readonly<{
  policy_id: string;
  policy_version: string;
  repository_id: string;
  framework_package: Readonly<{ name: '@aarusso-nyx/devai'; version: string }>;
  constitution: Readonly<{ version: string; digest_sha256: string }>;
  source_policy: Readonly<{
    policy_id: 'devai-core-authority';
    policy_version: string;
    digest_sha256: string;
  }>;
  additive_extensions: readonly Readonly<{
    extension_id: string;
    extension_version: string;
    digest_sha256: string;
  }>[];
  resolved_digest_sha256: string;
  materialized_from: Readonly<{
    kind: 'project-config';
    path: '.devai/config/authority-policy.json';
  }>;
}>;

/**
 * Untrusted caller input. It intentionally contains no effect, enforcement
 * mode, policy, machine principal, authority context, or execution progress.
 */
export interface MutationRequest {
  readonly request_id: string;
  readonly repository_id: string;
  readonly declared_principal?: CallerDeclarablePrincipal;
  readonly action_id: string;
  readonly dry_run: boolean;
  readonly requested_at: string;
  readonly invocation_id: string;
  readonly consent: {
    readonly write: boolean;
    readonly allow_publish: boolean;
    readonly experimental: boolean;
  };
}

declare const trustedMutationEnvelope: unique symbol;

/**
 * Trusted runtime product. Only an AuthorityRuntimeAdapter may materialize
 * this from caller input plus the action registry, resolved policy, and
 * invocation context. The opaque brand prevents ordinary structural
 * construction in TypeScript; runtime verification remains mandatory.
 */
export interface MutationEnvelope {
  readonly [trustedMutationEnvelope]: true;
  readonly envelope_id: string;
  readonly request: MutationRequest;
  readonly action_effect: ActionEffect;
  readonly enforcement_mode: EnforcementMode;
  readonly policy: AuthorityPolicyProvenance;
  readonly issued_by: {
    readonly adapter_id: string;
    readonly adapter_version: string;
    readonly envelope_digest_sha256: string;
  };
}

interface MutationPlanBase {
  readonly plan_id: string;
  readonly envelope: MutationEnvelope;
}

export interface ExactMutationPlan extends MutationPlanBase {
  readonly strategy: 'exact-plan';
  readonly targets: readonly ResourceTarget[];
  readonly atomicity: 'whole-plan';
}

export interface BoundedBatchesMutationPlan extends MutationPlanBase {
  readonly strategy: 'bounded-batches';
  readonly selectors: readonly ResourceTargetSelector[];
  readonly bounds: {
    readonly max_batches: number;
    readonly max_targets_per_batch: number;
    readonly max_total_targets: number;
  };
  readonly batch_atomicity: 'each-batch';
  readonly recovery: 'preserve-and-report';
}

export type MutationPlan = ExactMutationPlan | BoundedBatchesMutationPlan;

export interface MutationBatch {
  readonly batch_id: string;
  readonly plan_id: string;
  readonly ordinal: number;
  readonly targets: readonly ResourceTarget[];
  readonly atomicity: 'whole-batch';
}

/** Loaded from trusted runtime state, never accepted from caller/plan data. */
export interface TrustedExecutionState {
  readonly applied_batch_ids: readonly string[];
  readonly applied_target_count: number;
  readonly partial_effect_evidence_refs: readonly string[];
  readonly recovery_checkpoint_ref?: string;
}

export interface AuthorityDecisionSubject {
  readonly plan: MutationPlan;
  /** Present only while authorizing one exact dynamic batch. */
  readonly batch?: MutationBatch;
}

export type DecisionReasonCode =
  | 'READ_PASSTHROUGH'
  | 'MALFORMED_PLAN'
  | 'MISSING_RUNTIME_ADAPTER'
  | 'UNVERIFIED_MUTATION_ENVELOPE'
  | 'UNVERIFIED_AUTHORITY_CONTEXT'
  | 'MISSING_POLICY_ADAPTER'
  | 'POLICY_PROVENANCE_INVALID'
  | 'POLICY_BINDING_MISMATCH'
  | 'POLICY_ADAPTER_ERROR'
  | 'POLICY_ALLOW'
  | 'POLICY_DENY';

export interface Decision {
  readonly decision_id: string;
  readonly decision_digest_sha256: string;
  readonly subject_digest_sha256: string;
  readonly authority_context_digest_sha256: string | null;
  readonly policy_binding_digest_sha256: string;
  readonly plan_id: string;
  readonly batch_id?: string;
  readonly enforcement_mode: EnforcementMode;
  readonly evaluation: 'allow' | 'deny' | 'not-applicable';
  readonly disposition: 'proceed' | 'refuse';
  readonly reason_code: DecisionReasonCode;
  readonly reasons: readonly string[];
  readonly policy: AuthorityPolicyProvenance;
  readonly obligations: readonly string[];
  readonly readiness: {
    readonly eligible: boolean;
    readonly reason: string;
  };
  readonly recovery?: TrustedExecutionState;
}

declare const verifiedDecisionBinding: unique symbol;

/** Opaque capability issued only after the full decision binding recomputes. */
export interface VerifiedDecisionBinding {
  readonly [verifiedDecisionBinding]: true;
  readonly decision_id: string;
  readonly decision_digest_sha256: string;
  readonly subject_digest_sha256: string;
}

export type DecisionBindingVerification =
  | { readonly verified: false; readonly reasons: readonly string[] }
  | { readonly verified: true; readonly capability: VerifiedDecisionBinding };

export interface PolicyEvaluation {
  readonly outcome: 'allow' | 'deny';
  readonly reasons: readonly string[];
  readonly obligations?: readonly string[];
}
