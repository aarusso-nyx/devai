/**
 * Durable local storage for governance events and their sealed segments.
 *
 * Write order is fixed and local-first: validate and redact, canonicalize and
 * hash, append durably to round-owned state, seal checkpoint segments into
 * machine-written proof storage. Only after all of that may a projector look at
 * the outbox. Nothing here contacts a network, and no remote acknowledgement is
 * ever allowed to reach back and change recorded bytes.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import { join, resolve } from 'node:path';
import {
  GovernanceTrackingError,
  governanceEventDigest,
  governanceEventId,
  isGovernanceEventKind,
  trackingFail,
  type GovernanceEvent,
  type GovernanceEventDraft,
} from './events.js';
import { PUBLIC_SAFE_PROFILE } from './profile.js';
import { containsForbiddenContent, renderPublicSafe } from './redact.js';

export { GovernanceTrackingError };

const STATE_ROOT = '.devai/state/tracking';
const PROOF_ROOT = 'record/proofs/governance';

export function trackingStateDir(repoRoot: string, round: string): string {
  return join(resolve(repoRoot), STATE_ROOT, round);
}

export function trackingEventsPath(repoRoot: string, round: string): string {
  return join(trackingStateDir(repoRoot, round), 'events.jsonl');
}

export function trackingProofDir(repoRoot: string, round: string): string {
  return join(resolve(repoRoot), PROOF_ROOT, round);
}

interface ParsedLog {
  readonly events: readonly GovernanceEvent[];
  /** True when trailing bytes were not a complete record and must be discarded. */
  readonly torn: boolean;
}

/**
 * Parse the append log, tolerating exactly one failure mode: a torn trailing
 * write from a crash. A malformed record anywhere else is corruption of a
 * sealed history and is refused rather than silently skipped.
 */
function parseLog(source: string): ParsedLog {
  const lines = source.split('\n');
  const trailing = lines.pop() ?? '';
  const events: GovernanceEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      trackingFail(`GOVERNANCE_EVENT_LOG_CORRUPT:${String(index + 1)}`);
    }
    if (!validators.governanceEvent(parsed)) {
      trackingFail(`GOVERNANCE_EVENT_LOG_INVALID:${String(index + 1)}`);
    }
    events.push(parsed as GovernanceEvent);
  }
  return { events, torn: trailing.length > 0 };
}

function readLog(repoRoot: string, round: string): ParsedLog {
  const path = trackingEventsPath(repoRoot, round);
  if (!existsSync(path)) return { events: [], torn: false };
  return parseLog(readFileSync(path, 'utf8'));
}

export function readGovernanceEvents(options: {
  readonly repoRoot: string;
  readonly round: string;
}): readonly GovernanceEvent[] {
  return readLog(options.repoRoot, options.round).events;
}

function lastForSession(
  events: readonly GovernanceEvent[],
  sessionId: string,
): GovernanceEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.authority_session_id === sessionId) return event;
  }
  return undefined;
}

export interface RecordGovernanceEventOptions {
  readonly repoRoot: string;
  readonly repositoryId: string;
  readonly draft: GovernanceEventDraft;
  /** Injected only by tests and by replay; production uses the wall clock. */
  readonly recordedAt?: string;
}

export function recordGovernanceEvent(options: RecordGovernanceEventOptions): GovernanceEvent {
  const { repoRoot, repositoryId, draft } = options;
  if (!isGovernanceEventKind(draft.kind)) {
    trackingFail(`GOVERNANCE_EVENT_KIND_UNREGISTERED:${String(draft.kind)}`);
  }
  if (draft.kind === 'evidence_superseded' && (draft.supersedes_event_id ?? null) === null) {
    trackingFail('GOVERNANCE_SUPERSESSION_TARGET_REQUIRED');
  }
  if (draft.kind !== 'evidence_superseded' && (draft.supersedes_event_id ?? null) !== null) {
    trackingFail('GOVERNANCE_SUPERSESSION_KIND_INVALID');
  }

  const { events, torn } = readLog(repoRoot, draft.round_id);

  if (draft.supersedes_event_id !== undefined && draft.supersedes_event_id !== null) {
    const target = draft.supersedes_event_id;
    if (!events.some((event) => event.event_id === target)) {
      trackingFail(`GOVERNANCE_SUPERSESSION_TARGET_UNKNOWN:${target}`);
    }
  }

  const previous = lastForSession(events, draft.authority_session_id);
  const summary = renderPublicSafe(draft.summary, {
    maxChars: PUBLIC_SAFE_PROFILE.max_summary_chars,
  });
  // A renderer bug must surface as a refusal, never as a disclosure.
  if (containsForbiddenContent(summary)) trackingFail('GOVERNANCE_DISCLOSURE_PROFILE_VIOLATION');

  const base: Omit<GovernanceEvent, 'event_id'> = {
    schemaVersion: '1.0.0',
    repository_id: repositoryId,
    round_id: draft.round_id,
    task_id: draft.task_id ?? null,
    authority_session_id: draft.authority_session_id,
    session_source: draft.session_source,
    role: draft.role,
    session_sequence: (previous?.session_sequence ?? 0) + 1,
    previous_event_digest_sha256: previous === undefined ? null : governanceEventDigest(previous),
    kind: draft.kind,
    recorded_at: options.recordedAt ?? new Date().toISOString(),
    ...(draft.status === undefined ? {} : { status: draft.status }),
    commit_binding: draft.commit_binding ?? null,
    coverage: {
      mediated: draft.coverage.mediated,
      adapter_id: draft.coverage.adapter_id ?? null,
      uncovered_reason: draft.coverage.uncovered_reason ?? null,
    },
    public_safe_summary: summary,
    evidence_refs: [...(draft.evidence_refs ?? [])],
    payload_digest_sha256: canonicalSha256(draft.payload),
    supersedes_event_id: draft.supersedes_event_id ?? null,
  };
  const event: GovernanceEvent = { ...base, event_id: governanceEventId(base) };
  if (!validators.governanceEvent(event)) {
    trackingFail('GOVERNANCE_EVENT_CONTRACT_VIOLATION');
  }

  const directory = trackingStateDir(repoRoot, draft.round_id);
  mkdirSync(directory, { recursive: true });
  const path = trackingEventsPath(repoRoot, draft.round_id);
  const line = `${JSON.stringify(event)}\n`;
  if (torn) {
    // Discard the partial trailing bytes of a crashed write. They were never a
    // complete record, so dropping them removes nothing that was ever recorded.
    writeFileSync(path, `${events.map((item) => JSON.stringify(item)).join('\n')}\n${line}`);
  } else {
    appendFileSync(path, line);
  }
  return event;
}

export interface GovernanceSegment {
  readonly schemaVersion: '1.0.0';
  readonly segment_id: string;
  readonly repository_id: string;
  readonly round_id: string;
  readonly authority_session_id: string;
  readonly sequence_range: Readonly<{ first: number; last: number }>;
  readonly event_ids: readonly string[];
  readonly chain: Readonly<{
    previous_segment_digest_sha256: string | null;
    first_event_digest_sha256: string;
    last_event_digest_sha256: string;
  }>;
  readonly sealed_at: string;
  readonly seal_reason: 'checkpoint' | 'round_close' | 'tracking_disabled' | 'recovery';
  readonly segment_digest_sha256: string;
}

export function listGovernanceSegments(options: {
  readonly repoRoot: string;
  readonly round: string;
}): readonly GovernanceSegment[] {
  const directory = trackingProofDir(options.repoRoot, options.round);
  if (!existsSync(directory)) return [];
  const segments: GovernanceSegment[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!/^GSEG-[0-9a-f]{16}\.json$/u.test(name)) continue;
    const parsed: unknown = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    if (!validators.governanceEventSegment(parsed)) {
      trackingFail(`GOVERNANCE_SEGMENT_INVALID:${name}`);
    }
    segments.push(parsed as GovernanceSegment);
  }
  return segments.sort((left, right) => left.sealed_at.localeCompare(right.sealed_at));
}

/** Every event id already covered by a sealed segment. */
export function sealedEventIds(options: {
  readonly repoRoot: string;
  readonly round: string;
}): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const segment of listGovernanceSegments(options)) {
    for (const id of segment.event_ids) ids.add(id);
  }
  return ids;
}

export interface SealGovernanceSegmentOptions {
  readonly repoRoot: string;
  readonly round: string;
  readonly reason: GovernanceSegment['seal_reason'];
  readonly sealedAt?: string;
}

/**
 * Seal every not-yet-sealed event of the round, one segment per authority
 * session, so independent worktrees keep separate chains instead of being
 * forced into a fabricated global order. Sealing is idempotent: with nothing
 * new to cover it writes nothing and returns an empty list.
 */
export function sealGovernanceSegments(
  options: SealGovernanceSegmentOptions,
): readonly GovernanceSegment[] {
  const { repoRoot, round } = options;
  const events = readGovernanceEvents({ repoRoot, round });
  if (events.length === 0) return [];
  const sealed = sealedEventIds({ repoRoot, round });
  const pending = events.filter((event) => !sealed.has(event.event_id));
  if (pending.length === 0) return [];

  const sealedAt = options.sealedAt ?? new Date().toISOString();
  const existing = listGovernanceSegments({ repoRoot, round });
  const directory = trackingProofDir(repoRoot, round);
  const sessions = [...new Set(pending.map((event) => event.authority_session_id))];
  const written: GovernanceSegment[] = [];

  for (const sessionId of sessions) {
    const covered = pending.filter((event) => event.authority_session_id === sessionId);
    const firstEvent = covered.at(0);
    const lastEvent = covered.at(-1);
    if (firstEvent === undefined || lastEvent === undefined) continue;
    const previous = existing.filter((item) => item.authority_session_id === sessionId).at(-1);
    const base = {
      schemaVersion: '1.0.0' as const,
      repository_id: firstEvent.repository_id,
      round_id: round,
      authority_session_id: sessionId,
      sequence_range: {
        first: firstEvent.session_sequence,
        last: lastEvent.session_sequence,
      },
      event_ids: covered.map((event) => event.event_id),
      chain: {
        previous_segment_digest_sha256: previous?.segment_digest_sha256 ?? null,
        first_event_digest_sha256: governanceEventDigest(firstEvent),
        last_event_digest_sha256: governanceEventDigest(lastEvent),
      },
      sealed_at: sealedAt,
      seal_reason: options.reason,
    };
    const segment: GovernanceSegment = {
      ...base,
      segment_id: `GSEG-${canonicalSha256(base).slice(0, 16)}`,
      segment_digest_sha256: canonicalSha256(base),
    };
    if (!validators.governanceEventSegment(segment)) {
      trackingFail('GOVERNANCE_SEGMENT_CONTRACT_VIOLATION');
    }
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${segment.segment_id}.json`);
    // Proof records are append-only: an existing segment is never rewritten.
    if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(segment, null, 2)}\n`);
    written.push(segment);
  }
  return written;
}

/**
 * Seal and return the segment for the first pending session. Callers that seal
 * a whole round should use {@link sealGovernanceSegments}, which reports every
 * session it covered.
 */
export function sealGovernanceSegment(
  options: SealGovernanceSegmentOptions,
): GovernanceSegment | undefined {
  return sealGovernanceSegments(options)[0];
}
