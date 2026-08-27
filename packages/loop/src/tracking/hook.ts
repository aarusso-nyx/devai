/**
 * The single seam every runtime boundary uses to record a governance event.
 *
 * Three properties make it safe to call from hot paths:
 *
 *  - **Inert when not activated.** With no activation record for the round it
 *    does nothing and touches no disk beyond one existence check, so a
 *    repository that never opted in behaves exactly as it did before.
 *  - **Never fatal.** Tracking is an observation of governed work, not a
 *    participant in it. A tracking fault is swallowed here rather than allowed
 *    to change the outcome of the action being observed.
 *  - **Chain identity is inherited, never invented.** The identity comes from
 *    the activation the Owner recorded, so events from every boundary in a
 *    round join that round's chain instead of starting new ones.
 */
import type {
  GovernanceCommitBinding,
  GovernanceCoverage,
  GovernanceEvent,
  GovernanceEventKind,
  GovernanceEventStatus,
  GovernanceRole,
  GovernanceSessionSource,
} from './events.js';
import { readRoundTrackingActivation } from './projection.js';
import { recordGovernanceEvent, sealGovernanceSegments } from './store.js';

export interface TrackGovernanceEventOptions {
  readonly repoRoot: string;
  readonly round: string;
  readonly role: GovernanceRole;
  readonly kind: GovernanceEventKind;
  readonly summary: string;
  /** Local-only detail. Only its digest is stored; the content never leaves the host. */
  readonly payload: unknown;
  readonly status?: GovernanceEventStatus;
  readonly taskId?: string | null;
  readonly commitBinding?: GovernanceCommitBinding | null;
  readonly evidenceRefs?: readonly string[];
  readonly coverage?: GovernanceCoverage;
  /** Seal after recording. Set at natural checkpoints, not on every event. */
  readonly checkpoint?: boolean;
}

/**
 * A `DIRECT-CLI-` activation identity was derived rather than issued, and must
 * keep saying so on every event that inherits it.
 */
function sourceOf(identity: string): GovernanceSessionSource {
  return identity.startsWith('AUTH-SESSION-') ? 'session-state' : 'direct-cli';
}

export function trackGovernanceEvent(
  options: TrackGovernanceEventOptions,
): GovernanceEvent | undefined {
  let activation;
  try {
    activation = readRoundTrackingActivation({
      repoRoot: options.repoRoot,
      round: options.round,
    });
  } catch {
    // A malformed activation is surfaced by Doctor and by `round tracking
    // status`. It must not take down the action being observed.
    return undefined;
  }
  if (activation === undefined) return undefined;
  // `frozen` keeps recording and stops projecting; `disabled` ends the round's
  // tracking entirely.
  if (activation.state === 'disabled') return undefined;

  const identity = activation.authorization.authority_session_id;
  try {
    const event = recordGovernanceEvent({
      repoRoot: options.repoRoot,
      repositoryId: activation.repository_id,
      draft: {
        round_id: options.round,
        task_id: options.taskId ?? null,
        authority_session_id: identity,
        session_source: sourceOf(identity),
        role: options.role,
        kind: options.kind,
        ...(options.status === undefined ? {} : { status: options.status }),
        commit_binding: options.commitBinding ?? null,
        coverage: options.coverage ?? { mediated: true, adapter_id: null },
        summary: options.summary,
        evidence_refs: options.evidenceRefs ?? [],
        payload: options.payload,
      },
    });
    if (options.checkpoint === true) {
      sealGovernanceSegments({
        repoRoot: options.repoRoot,
        round: options.round,
        reason: 'checkpoint',
      });
    }
    return event;
  } catch {
    return undefined;
  }
}

/**
 * Report a boundary DEVAI does not mediate.
 *
 * Article 6 obliges DEVAI to report the edge of its own control rather than
 * imply coverage it does not possess, so unmediated activity is recorded as
 * explicitly uncovered instead of being omitted (which would read as "nothing
 * happened") or recorded as mediated (which would be a false claim).
 */
export function trackUncoveredActivity(options: {
  readonly repoRoot: string;
  readonly round: string;
  readonly role: GovernanceRole;
  readonly summary: string;
  readonly reason: string;
  readonly payload: unknown;
  readonly taskId?: string | null;
}): GovernanceEvent | undefined {
  return trackGovernanceEvent({
    repoRoot: options.repoRoot,
    round: options.round,
    role: options.role,
    kind: 'divergence_detected',
    summary: options.summary,
    payload: options.payload,
    taskId: options.taskId ?? null,
    coverage: { mediated: false, uncovered_reason: options.reason },
  });
}
