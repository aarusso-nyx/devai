/**
 * Canonical governance event vocabulary.
 *
 * Events are the local, authoritative record of every DEVAI-mediated finding
 * and action in a governed round. They are produced before any remote is
 * contacted, they are append-only, and they are corrected only by appending a
 * supersession (Constitution Article 41). Nothing in this module reaches the
 * network.
 */
import { canonicalSha256 } from '@devai-nyx/utils';

/** The closed v1.3.0 event vocabulary. An unlisted kind is refused, not passed through. */
export const GOVERNANCE_EVENT_KINDS = [
  'session_opened',
  'finding_emitted',
  'finding_classified',
  'authorization_recorded',
  'action_intended',
  'action_completed',
  'verification_result',
  'divergence_detected',
  'failure_observed',
  'evidence_superseded',
  'round_verdict',
  'tracking_disabled',
] as const;

export type GovernanceEventKind = (typeof GOVERNANCE_EVENT_KINDS)[number];

/**
 * Where a chain identity came from. A `direct-cli` chain is derived
 * deterministically for an invocation that declared a role but no authority
 * session; it is never minted per invocation, and it is never presented as a
 * session it was not.
 */
export type GovernanceSessionSource = 'session-state' | 'direct-cli';
export type GovernanceRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
export type GovernanceEventStatus = 'pass' | 'review' | 'fail' | 'inconclusive' | 'not_applicable';

export interface GovernanceCommitBinding {
  readonly base_commit: string;
  readonly base_tree: string;
  readonly candidate_commit: string | null;
  readonly candidate_tree: string | null;
}

/**
 * Article 6 host-boundary disclosure. Only registered runtime actions and
 * declared host adapters are `mediated`; anything else must say so explicitly
 * rather than let a reader infer coverage DEVAI does not possess.
 */
export interface GovernanceCoverage {
  readonly mediated: boolean;
  readonly adapter_id?: string | null;
  readonly uncovered_reason?: string | null;
}

export interface GovernanceEvent {
  readonly schemaVersion: '1.0.0';
  readonly event_id: string;
  readonly repository_id: string;
  readonly round_id: string;
  readonly task_id: string | null;
  readonly authority_session_id: string;
  readonly session_source: GovernanceSessionSource;
  readonly role: GovernanceRole;
  readonly session_sequence: number;
  readonly previous_event_digest_sha256: string | null;
  readonly kind: GovernanceEventKind;
  readonly recorded_at: string;
  readonly status?: GovernanceEventStatus;
  readonly commit_binding: GovernanceCommitBinding | null;
  readonly coverage: Readonly<{
    mediated: boolean;
    adapter_id: string | null;
    uncovered_reason: string | null;
  }>;
  readonly public_safe_summary: string;
  readonly evidence_refs: readonly string[];
  readonly payload_digest_sha256: string;
  readonly supersedes_event_id: string | null;
}

/** What a caller supplies. The recorder derives identity, ordering, and redaction. */
export interface GovernanceEventDraft {
  readonly round_id: string;
  readonly task_id?: string | null;
  readonly authority_session_id: string;
  readonly session_source: GovernanceSessionSource;
  readonly role: GovernanceRole;
  readonly kind: GovernanceEventKind;
  readonly status?: GovernanceEventStatus;
  readonly commit_binding?: GovernanceCommitBinding | null;
  readonly coverage: GovernanceCoverage;
  /** Raw prose. Passed through the disclosure profile before it is stored. */
  readonly summary: string;
  readonly evidence_refs?: readonly string[];
  /** Local-only detail. Never stored or projected; only its digest is kept. */
  readonly payload: unknown;
  readonly supersedes_event_id?: string | null;
}

export class GovernanceTrackingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GovernanceTrackingError';
  }
}

export function trackingFail(code: string): never {
  throw new GovernanceTrackingError(code);
}

export function isGovernanceEventKind(value: string): value is GovernanceEventKind {
  return (GOVERNANCE_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * Content-derived identity: the canonical digest of every field except the id
 * itself. Two byte-identical events therefore carry the same id on any host,
 * which is what makes a projection deduplicable by id rather than by text.
 */
export function governanceEventId(event: Omit<GovernanceEvent, 'event_id'>): string {
  return `GEV-${canonicalSha256(event).slice(0, 16)}`;
}

/** Chain digest of a complete event, including its id. */
export function governanceEventDigest(event: GovernanceEvent): string {
  return canonicalSha256(event);
}
