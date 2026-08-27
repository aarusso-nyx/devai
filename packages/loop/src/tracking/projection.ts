/**
 * Projection outbox, delivery state, and status reporting.
 *
 * Two storage classes meet here and never merge. Canonical events and their
 * sealed segments are immutable evidence. Delivery state — what has been
 * acknowledged, by which comment, after how many attempts — is mutable and
 * lives in its own file, so a remote acknowledgement, retry, or edit can never
 * alter an event byte.
 *
 * Readiness and tracking health stay independent throughout: every failure
 * classified here is a failure to observe a remote, and a failure to observe
 * never manufactures or withdraws a governed verdict.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import { join } from 'node:path';
import { trackingFail, type GovernanceEvent, type GovernanceRole } from './events.js';
import { PUBLIC_SAFE_PROFILE } from './profile.js';
import { containsForbiddenContent } from './redact.js';
import {
  listGovernanceSegments,
  readGovernanceEvents,
  sealedEventIds,
  trackingStateDir,
} from './store.js';

export const UNCOVERED_NOTE =
  'Only DEVAI-mediated actions are tracked. Editor and shell activity outside the runtime is not covered.';

export type ProjectionReason =
  'checkpoint' | 'round_close' | 'tracking_disabled' | 'reconciliation';

export interface ProjectionBatchEntry {
  readonly event_id: string;
  readonly role: GovernanceRole;
  readonly kind: string;
  readonly status: string | null;
  readonly public_safe_summary: string;
  readonly commit: string | null;
  readonly tree: string | null;
  readonly evidence_digests_sha256: readonly string[];
  readonly payload_digest_sha256: string;
  readonly mediated: boolean;
}

export interface ProjectionBatch {
  readonly schemaVersion: '1.0.0';
  readonly batch_id: string;
  readonly marker: string;
  readonly repository_id: string;
  readonly round_id: string;
  readonly adapter: Readonly<{
    id: 'github-issues';
    adapter_version: string;
    package_version: string;
  }>;
  readonly disclosure_profile: 'public-safe-v1';
  readonly reason: ProjectionReason;
  readonly sessions: readonly Readonly<{
    authority_session_id: string;
    first: number;
    last: number;
  }>[];
  readonly event_ids: readonly string[];
  readonly entries: readonly ProjectionBatchEntry[];
  readonly segment_digests_sha256: readonly string[];
  readonly projected_at: string | null;
  readonly batch_digest_sha256: string;
}

export type ProjectionFailureClass =
  | 'authentication'
  | 'permission'
  | 'rate-limit'
  | 'validation'
  | 'missing-resource'
  | 'service'
  | 'ambiguous-response';

export interface ProjectionReceipt {
  readonly batch_id: string;
  readonly state: 'queued' | 'in-flight' | 'delivered' | 'failed' | 'reconciled';
  readonly comment_id: number | null;
  readonly projected_at: string | null;
  readonly attempts: number;
  readonly batch_digest_sha256: string;
}

/** Mutable delivery state. Deliberately separate from canonical event storage. */
export interface DeliveryState {
  readonly issue: number | null;
  readonly projected_event_ids: readonly string[];
  readonly receipts: readonly ProjectionReceipt[];
  readonly divergence: boolean;
  readonly divergence_detail: string | null;
  readonly last_error: Readonly<{
    classification: ProjectionFailureClass;
    observed_at: string;
    attempts: number;
    public_safe_detail: string | null;
  }> | null;
}

const EMPTY_DELIVERY: DeliveryState = {
  issue: null,
  projected_event_ids: [],
  receipts: [],
  divergence: false,
  divergence_detail: null,
  last_error: null,
};

function deliveryPath(repoRoot: string, round: string): string {
  return join(trackingStateDir(repoRoot, round), 'delivery.json');
}

export function readDeliveryState(options: {
  readonly repoRoot: string;
  readonly round: string;
}): DeliveryState {
  const path = deliveryPath(options.repoRoot, options.round);
  if (!existsSync(path)) return EMPTY_DELIVERY;
  return { ...EMPTY_DELIVERY, ...(JSON.parse(readFileSync(path, 'utf8')) as DeliveryState) };
}

export function writeDeliveryState(options: {
  readonly repoRoot: string;
  readonly round: string;
  readonly state: DeliveryState;
}): void {
  mkdirSync(trackingStateDir(options.repoRoot, options.round), { recursive: true });
  writeFileSync(
    deliveryPath(options.repoRoot, options.round),
    `${JSON.stringify(options.state, null, 2)}\n`,
  );
}

export interface RoundTrackingActivation {
  readonly schemaVersion: '1.0.0';
  readonly round_id: string;
  readonly repository_id: string;
  readonly state: 'active' | 'frozen' | 'disabled';
  readonly adapter: Readonly<{
    id: 'github-issues';
    adapter_version: string;
    package_version: string;
    config_digest_sha256: string;
    workflow_digest_sha256: string;
  }>;
  readonly target?: Readonly<{ repository: string; issue_number: number | null }>;
  readonly authorization: Readonly<{
    authority_session_id: string;
    role: 'owner';
    publish_flag: true;
    authorized_at: string;
  }>;
  readonly disclosure_profile: 'public-safe-v1';
  readonly pending_policy: 'freeze' | 'drain';
  readonly disabled?: Readonly<{
    disabled_at: string;
    authority_session_id: string;
    pending_events: number;
  }> | null;
}

function activationPath(repoRoot: string, round: string): string {
  return join(trackingStateDir(repoRoot, round), 'activation.json');
}

export function readRoundTrackingActivation(options: {
  readonly repoRoot: string;
  readonly round: string;
}): RoundTrackingActivation | undefined {
  const path = activationPath(options.repoRoot, options.round);
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!validators.roundTrackingActivation(parsed)) {
    trackingFail('ROUND_TRACKING_ACTIVATION_INVALID');
  }
  return parsed as RoundTrackingActivation;
}

export function writeRoundTrackingActivation(options: {
  readonly repoRoot: string;
  readonly round: string;
  readonly activation: RoundTrackingActivation;
}): void {
  if (!validators.roundTrackingActivation(options.activation)) {
    trackingFail('ROUND_TRACKING_ACTIVATION_INVALID');
  }
  mkdirSync(trackingStateDir(options.repoRoot, options.round), { recursive: true });
  writeFileSync(
    activationPath(options.repoRoot, options.round),
    `${JSON.stringify(options.activation, null, 2)}\n`,
  );
}

function entryFor(event: GovernanceEvent): ProjectionBatchEntry {
  return {
    event_id: event.event_id,
    role: event.role,
    kind: event.kind,
    status: event.status ?? null,
    public_safe_summary: event.public_safe_summary,
    commit: event.commit_binding?.candidate_commit ?? event.commit_binding?.base_commit ?? null,
    tree: event.commit_binding?.candidate_tree ?? event.commit_binding?.base_tree ?? null,
    evidence_digests_sha256: [],
    payload_digest_sha256: event.payload_digest_sha256,
    mediated: event.coverage.mediated,
  };
}

export interface BuildProjectionBatchOptions {
  readonly repoRoot: string;
  readonly round: string;
  readonly reason: ProjectionReason;
  readonly adapterVersion?: string;
  readonly packageVersion?: string;
}

/**
 * Build the next batch from sealed-but-unprojected events. Returns undefined
 * when there is nothing sealed to send — an unsealed event is never projected,
 * because a projection must be rebuildable from durable evidence alone.
 */
export function buildProjectionBatch(
  options: BuildProjectionBatchOptions,
): ProjectionBatch | undefined {
  const { repoRoot, round } = options;
  const events = readGovernanceEvents({ repoRoot, round });
  if (events.length === 0) return undefined;

  const sealed = sealedEventIds({ repoRoot, round });
  const delivered = new Set(readDeliveryState({ repoRoot, round }).projected_event_ids);
  const candidates = events
    .filter((event) => sealed.has(event.event_id) && !delivered.has(event.event_id))
    .slice(0, PUBLIC_SAFE_PROFILE.max_events_per_batch);
  if (candidates.length === 0) return undefined;

  const sessions = [...new Set(candidates.map((event) => event.authority_session_id))].flatMap(
    (sessionId) => {
      const own = candidates.filter((event) => event.authority_session_id === sessionId);
      const first = own.at(0);
      const last = own.at(-1);
      if (first === undefined || last === undefined) return [];
      return [
        {
          authority_session_id: sessionId,
          first: first.session_sequence,
          last: last.session_sequence,
        },
      ];
    },
  );

  const coveredIds = new Set(candidates.map((event) => event.event_id));
  const segmentDigests = listGovernanceSegments({ repoRoot, round })
    .filter((segment) => segment.event_ids.some((id) => coveredIds.has(id)))
    .map((segment) => segment.segment_digest_sha256);

  const entries = candidates.map(entryFor);
  for (const entry of entries) {
    if (containsForbiddenContent(entry.public_safe_summary)) {
      trackingFail('GOVERNANCE_DISCLOSURE_PROFILE_VIOLATION');
    }
  }

  const head = candidates.at(0);
  if (head === undefined) return undefined;
  const base = {
    schemaVersion: '1.0.0' as const,
    repository_id: head.repository_id,
    round_id: round,
    adapter: {
      id: 'github-issues' as const,
      adapter_version: options.adapterVersion ?? '1.0.0',
      package_version: options.packageVersion ?? '1.3.0',
    },
    disclosure_profile: PUBLIC_SAFE_PROFILE.profile,
    reason: options.reason,
    sessions,
    event_ids: candidates.map((event) => event.event_id),
    entries,
    segment_digests_sha256: segmentDigests,
    projected_at: null,
  };
  const digest = canonicalSha256(base);
  const batch: ProjectionBatch = {
    ...base,
    batch_id: `GBAT-${digest.slice(0, 16)}`,
    marker: `devai-governance-batch:${digest.slice(0, 16)}`,
    batch_digest_sha256: digest,
  };
  if (!validators.governanceProjectionBatch(batch)) {
    trackingFail('GOVERNANCE_PROJECTION_BATCH_CONTRACT_VIOLATION');
  }
  // Losslessness is asserted by id, never by rendered text.
  if (new Set(batch.event_ids).size !== batch.event_ids.length) {
    trackingFail('GOVERNANCE_PROJECTION_BATCH_DUPLICATE_EVENT');
  }
  if (batch.entries.length !== batch.event_ids.length) {
    trackingFail('GOVERNANCE_PROJECTION_BATCH_LOSSY');
  }
  return batch;
}

export interface GovernanceProjectionStatus {
  readonly schemaVersion: '1.0.0';
  readonly mode: 'disabled' | 'github-issues';
  readonly activation: 'absent' | 'bound-inactive' | 'active' | 'frozen' | 'disabled';
  readonly round_id: string | null;
  readonly canonical_events: number;
  readonly projected_events: number;
  readonly pending_events: number;
  readonly projection: 'idle' | 'pending' | 'synced' | 'failed' | 'unreachable';
  readonly issue: number | null;
  readonly divergence: boolean;
  readonly divergence_detail: string | null;
  readonly last_error: DeliveryState['last_error'];
  readonly receipts: readonly ProjectionReceipt[];
  readonly coverage_disclosure: Readonly<{ mediated_only: true; uncovered_note: string }>;
}

export interface GovernanceTrackingStatusOptions {
  readonly repoRoot: string;
  readonly round: string;
  /** True when the repository capability is bound but this round is not activated. */
  readonly bound?: boolean;
}

/**
 * Report canonical recording and remote delivery as two independent axes. A
 * pending, failed, or unreachable projection is stated as such and is never
 * folded into a governed verdict.
 */
export function governanceTrackingStatus(
  options: GovernanceTrackingStatusOptions,
): GovernanceProjectionStatus {
  const { repoRoot, round } = options;
  const events = readGovernanceEvents({ repoRoot, round });
  const delivery = readDeliveryState({ repoRoot, round });
  const activation = readRoundTrackingActivation({ repoRoot, round });

  const canonical = events.length;
  const projected = delivery.projected_event_ids.length;
  const pending = Math.max(0, canonical - projected);

  const projection: GovernanceProjectionStatus['projection'] =
    canonical === 0
      ? 'idle'
      : pending === 0
        ? 'synced'
        : delivery.last_error === null
          ? 'pending'
          : delivery.last_error.classification === 'rate-limit' ||
              delivery.last_error.classification === 'service'
            ? 'unreachable'
            : 'failed';

  const status: GovernanceProjectionStatus = {
    schemaVersion: '1.0.0',
    mode: activation === undefined && options.bound !== true ? 'disabled' : 'github-issues',
    activation:
      activation !== undefined
        ? activation.state
        : options.bound === true
          ? 'bound-inactive'
          : 'absent',
    round_id: round,
    canonical_events: canonical,
    projected_events: projected,
    pending_events: pending,
    projection,
    issue: delivery.issue ?? activation?.target?.issue_number ?? null,
    divergence: delivery.divergence,
    divergence_detail: delivery.divergence_detail,
    last_error: delivery.last_error,
    receipts: delivery.receipts,
    coverage_disclosure: { mediated_only: true, uncovered_note: UNCOVERED_NOTE },
  };
  if (!validators.governanceProjectionStatus(status)) {
    trackingFail('GOVERNANCE_PROJECTION_STATUS_CONTRACT_VIOLATION');
  }
  return status;
}
