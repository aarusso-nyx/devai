export type EffectAuthorizationRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
export type EffectAuthorizationTerminalKind = 'consumed' | 'revoked' | 'expired' | 'rejected';
export type EffectAuthorizationKind = 'granted' | EffectAuthorizationTerminalKind;

export interface EffectAuthorizationResource {
  readonly kind: 'fs' | 'git-ref' | 'db' | 'remote';
  readonly system_id: string;
  readonly exact_identifier: string;
  readonly operations: readonly (
    'create' | 'update' | 'delete' | 'rename' | 'merge' | 'push' | 'publish' | 'execute'
  )[];
}

export interface EffectAuthorizationRepository {
  readonly id: string;
  readonly commit: string;
  readonly tree: string;
}

export interface EffectAuthorizationCandidate {
  readonly release_unit: string;
  readonly version: string;
  readonly commit: string;
  readonly tree: string;
}

export interface EffectAuthorizationConsent {
  readonly write: boolean;
  readonly allow_publish: boolean;
  readonly experimental: false;
}

export interface EffectAuthorizationEvent {
  readonly schemaVersion: '1.0.0';
  readonly canonicalization: Readonly<Record<string, unknown>>;
  readonly event_id: string;
  readonly ledger_id: string;
  readonly sequence: number;
  readonly previous_event_digest_sha256: string | null;
  readonly kind: EffectAuthorizationKind;
  readonly action_id: string;
  readonly effect: 'read' | 'harness-write' | 'local-write' | 'remote-write';
  readonly resource: EffectAuthorizationResource;
  readonly repository: EffectAuthorizationRepository;
  readonly candidate: EffectAuthorizationCandidate;
  readonly grantor: {
    readonly kind: 'human';
    readonly role: EffectAuthorizationRole;
    readonly declaration_source: 'cli-flag' | 'session-state';
  };
  readonly subject_role: EffectAuthorizationRole;
  readonly consent: EffectAuthorizationConsent;
  readonly one_time: true;
  readonly uses_permitted: 1;
  readonly bearer_transferable: false;
  readonly delegable: false;
  readonly not_before?: string;
  readonly expires_at?: string;
  readonly recorded_at: string;
  readonly payload_digest_sha256: string;
  readonly grant_event_id: string | null;
  readonly consumed_by_state_id?: string;
  readonly reason_code?: string;
}

export interface EffectAuthorizationLedgerEntry {
  readonly sequence: number;
  readonly event_id: string;
  readonly event_digest_sha256: string;
  readonly previous_event_digest_sha256: string | null;
  readonly kind: EffectAuthorizationKind;
  readonly references_event_id: string | null;
}

export interface EffectAuthorizationLedger {
  readonly schemaVersion: '1.0.0';
  readonly ledger_id: string;
  readonly repository: { readonly id: string };
  readonly event_schema: 'law/schemas/effect-authorization-event.schema.json';
  readonly append_only: true;
  readonly ordering: 'hash-linked-ascending-sequence';
  readonly semantic_verifier: Readonly<Record<string, unknown>>;
  readonly head: {
    readonly sequence: number;
    readonly event_id: string;
    readonly event_digest_sha256: string;
  };
  readonly entries: readonly EffectAuthorizationLedgerEntry[];
  readonly enforcement: Readonly<Record<string, unknown>>;
}

export type EffectAuthorizationLedgerError =
  | 'eal-event-content-unresolved'
  | 'eal-event-ledger-id-mismatch'
  | 'eal-entry-event-sequence-mismatch'
  | 'eal-entry-event-previous-digest-mismatch'
  | 'eal-entry-event-kind-mismatch'
  | 'eal-entry-event-grant-reference-mismatch'
  | 'eal-event-payload-digest-mismatch'
  | 'eal-event-digest-mismatch'
  | 'eal-event-id-mismatch'
  | 'eal-sequence-not-contiguous-from-one'
  | 'eal-duplicate-sequence'
  | 'eal-previous-digest-mismatch'
  | 'eal-terminal-entry-without-grant-reference'
  | 'eal-grant-reference-unresolved'
  | 'eal-grant-identity-mismatch'
  | 'eal-grant-consumed-more-than-once'
  | 'eal-grant-live-window-invalid'
  | 'eal-grant-has-multiple-terminal-events'
  | 'eal-terminal-after-terminal'
  | 'eal-consume-outside-live-window'
  | 'eal-head-not-final-entry'
  | 'eal-semantic-verification-not-performed';

export interface VerifiedEffectAuthorizationLedger {
  readonly kernel_id: 'devai.kernel.effect-authorization-ledger.v1';
  readonly ledger: EffectAuthorizationLedger;
  readonly events: ReadonlyMap<string, EffectAuthorizationEvent>;
  readonly event_digests: ReadonlyMap<string, string>;
  readonly terminal_by_grant: ReadonlyMap<string, EffectAuthorizationEvent>;
}

export type EffectAuthorizationLedgerVerification =
  | { readonly ok: true; readonly value: VerifiedEffectAuthorizationLedger }
  | {
      readonly ok: false;
      readonly kernel_id: 'devai.kernel.effect-authorization-ledger.v1';
      readonly errors: readonly EffectAuthorizationLedgerError[];
    };

export interface EffectAuthorizationGrantRequest {
  readonly authorization_event_id: string;
  readonly ledger_id: string;
  readonly action_id: string;
  readonly effect: EffectAuthorizationEvent['effect'];
  readonly resource: EffectAuthorizationResource;
  readonly repository: EffectAuthorizationRepository;
  readonly candidate: EffectAuthorizationCandidate;
  readonly subject_role: EffectAuthorizationRole;
  readonly consent: EffectAuthorizationConsent;
  /** The caller supplies the observation time so resolution is deterministic. */
  readonly observed_at: string;
}

export type EffectAuthorizationResolution =
  | {
      readonly ok: true;
      readonly grant: EffectAuthorizationEvent;
      readonly grant_event_digest_sha256: string;
      readonly verification: VerifiedEffectAuthorizationLedger;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'absent-effect-authorization'
        | 'consumed-effect-authorization'
        | 'revoked-effect-authorization'
        | 'expired-effect-authorization'
        | 'authorization-identity-mismatch'
        | 'authorization-ledger-invalid';
      readonly ledger_errors?: readonly EffectAuthorizationLedgerError[];
    };

export type EffectAuthorizationEventResolver = (entry: EffectAuthorizationLedgerEntry) => unknown;

export type AuthorizedEffectExecutionResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly consumed_event: EffectAuthorizationEvent;
      readonly ledger: EffectAuthorizationLedger;
    }
  | {
      readonly ok: false;
      readonly phase: 'authorization' | 'consumption' | 'adapter';
      readonly code: string;
      readonly consumed_event?: EffectAuthorizationEvent;
      readonly ledger?: EffectAuthorizationLedger;
      readonly cause?: unknown;
    };
