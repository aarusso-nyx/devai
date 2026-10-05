import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
} from '@devai-nyx/authority';
import { parsers } from '@devai-nyx/schemas';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fsyncDirectorySync, mkdirDurableSync, writeAllSync } from './durable-files.js';
import { TaskServiceError, fail } from './task-queue-services.js';
import type { TaskRecord } from './task-contract.js';

/** The ordered boundaries of one experimental attempt (ADR-MDL-0005 D-6). */
export const DISPATCH_JOURNAL_EVENTS = [
  'intent',
  'spawned',
  'exited',
  'evidence-written',
  'settled',
] as const;

export type DispatchJournalEventName = (typeof DISPATCH_JOURNAL_EVENTS)[number];

/** How a human disposed of uncertain or blocked work (ADR-MDL-0007). */
export type DispatchDisposition = 'retry' | 'escalate';

/** One validated journal line (law/schemas/dispatch-journal-event.schema.json). */
export interface DispatchJournalEvent {
  readonly schemaVersion: '1.0.0';
  readonly round_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly event: DispatchJournalEventName;
  readonly at: string;
  readonly experimental: true;
  readonly previous_sha256: string | null;
  readonly runtime?: 'claude-cli' | 'codex-cli';
  readonly model?: string;
  readonly effort?: string;
  readonly tier?: 'default' | 'bumped';
  readonly prompt_sha256?: string;
  readonly pid?: number;
  readonly exit_code?: number | null;
  readonly signal?: string | null;
  readonly timed_out?: boolean;
  readonly evidence_id?: string;
  readonly outcome?: 'pass' | 'fail' | 'error' | 'cancelled';
  readonly disposition?: DispatchDisposition;
  readonly disposition_id?: string;
}

/** The facts a caller supplies; the journal adds identity, time, label and the hash link. */
export type DispatchJournalEntry = Omit<
  DispatchJournalEvent,
  'schemaVersion' | 'round_id' | 'experimental' | 'previous_sha256' | 'at'
> & { readonly at?: string };

/** An attempt that recorded intent but never settled: a provider may have run. */
export interface UncertainDispatch {
  readonly task_id: string;
  readonly attempt: number;
  readonly last_event: DispatchJournalEventName;
}

/** Work that blocks a round until a human records its disposition. */
export interface UncertainDispatchFinding {
  readonly task_id: string;
  /** The open attempt, or null for an agent task left in progress with no journal record. */
  readonly attempt: number | null;
  readonly last_event: DispatchJournalEventName | null;
}

/**
 * `TASK_DISPATCH_UNCERTAIN`, naming every task and attempt that needs a human
 * disposition before the round can dispatch again.
 */
export class DispatchUncertainError extends TaskServiceError {
  constructor(readonly uncertain: readonly UncertainDispatchFinding[]) {
    super('TASK_DISPATCH_UNCERTAIN');
  }
}

export function dispatchJournalPath(repoRoot: string, roundId: string): string {
  return join(repoRoot, '.devai/state/round-runs', roundId, 'dispatch-journal.jsonl');
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A human disposition closes an open attempt whatever boundary it reached. */
function isDisposition(event: Pick<DispatchJournalEvent, 'event' | 'outcome'>): boolean {
  return event.event === 'settled' && event.outcome === 'cancelled';
}

/**
 * The next boundary follows the previous one, except that a process that never
 * started (no pid) goes straight from `intent` to `exited`, and a human disposition
 * (`settled` with outcome `cancelled`) closes an open attempt at any boundary.
 */
function nextBoundary(
  reached: number,
  event: Pick<DispatchJournalEvent, 'event' | 'outcome'>,
): boolean {
  const position = DISPATCH_JOURNAL_EVENTS.indexOf(event.event);
  if (isDisposition(event)) return reached >= 0 && reached < position;
  return position === reached + 1 || (reached === 0 && position === 2);
}

function key(event: Pick<DispatchJournalEvent, 'task_id' | 'attempt'>): string {
  return `${event.task_id}#${String(event.attempt)}`;
}

/**
 * Read and verify the whole journal. Every line must be complete, schema-valid,
 * hash-linked to the previous line, and ordered within its attempt. A torn final
 * line from a crash mid-append, or any other damage, refuses with
 * `TASK_DISPATCH_JOURNAL_INVALID` and is never repaired automatically; only the
 * Owner's `round dispatch dispose --quarantine-journal` moves it aside.
 */
export function readDispatchJournal(
  repoRoot: string,
  roundId: string,
): readonly DispatchJournalEvent[] {
  const path = dispatchJournalPath(repoRoot, roundId);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  if (raw.length === 0) return [];
  if (!raw.endsWith('\n')) fail('TASK_DISPATCH_JOURNAL_INVALID');
  const lines = raw.slice(0, -1).split('\n');
  const events: DispatchJournalEvent[] = [];
  const progress = new Map<string, number>();
  let previous: string | null = null;
  for (const line of lines) {
    const parsed = parsers.dispatchJournalEvent.safeParseJson<DispatchJournalEvent>(line);
    if (!parsed.ok) fail('TASK_DISPATCH_JOURNAL_INVALID');
    const event = parsed.value;
    if (event.round_id !== roundId || event.previous_sha256 !== previous) {
      fail('TASK_DISPATCH_JOURNAL_INVALID');
    }
    const reached = progress.get(key(event)) ?? -1;
    if (!nextBoundary(reached, event)) fail('TASK_DISPATCH_JOURNAL_INVALID');
    progress.set(key(event), DISPATCH_JOURNAL_EVENTS.indexOf(event.event));
    events.push(event);
    previous = sha256(line);
  }
  return events;
}

/**
 * Append one fsynced, hash-linked event. The event must be the next boundary of
 * its attempt; anything else refuses before a byte is written. Every byte is
 * written, the file is fsynced, and when this append created the journal (or its
 * directories) the containing directories are fsynced too, so an acknowledged
 * `intent` survives a power loss and the attempt is seen as uncertain on restart.
 */
export function appendDispatchJournalEvent(
  repoRoot: string,
  roundId: string,
  entry: DispatchJournalEntry,
): DispatchJournalEvent {
  const path = dispatchJournalPath(repoRoot, roundId);
  const existing = readDispatchJournal(repoRoot, roundId);
  const created = !existsSync(path);
  const raw = created ? '' : readFileSync(path, 'utf8');
  const lines = raw.length === 0 ? [] : raw.slice(0, -1).split('\n');
  const last = lines.at(-1);
  const { at, ...facts } = entry;
  const event: DispatchJournalEvent = {
    schemaVersion: '1.0.0',
    round_id: roundId,
    ...facts,
    at: at ?? new Date().toISOString(),
    experimental: true,
    previous_sha256: last === undefined ? null : sha256(last),
  };
  if (!parsers.dispatchJournalEvent.safeParse(event).ok) fail('TASK_DISPATCH_JOURNAL_INVALID');
  const reached = Math.max(
    -1,
    ...existing
      .filter((item) => key(item) === key(event))
      .map((item) => DISPATCH_JOURNAL_EVENTS.indexOf(item.event)),
  );
  if (!nextBoundary(reached, event)) fail('TASK_DISPATCH_JOURNAL_ORDER');
  mkdirDurableSync(dirname(path));
  const fd = openSync(path, 'a');
  try {
    writeAllSync(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) fsyncDirectorySync(dirname(path));
  return event;
}

/** Attempts with intent but no `settled` event, in journal order. */
export function uncertainDispatches(
  events: readonly DispatchJournalEvent[],
): readonly UncertainDispatch[] {
  const open = new Map<string, UncertainDispatch>();
  for (const event of events) {
    if (event.event === 'settled') open.delete(key(event));
    else
      open.set(key(event), {
        task_id: event.task_id,
        attempt: event.attempt,
        last_event: event.event,
      });
  }
  return [...open.values()];
}

/** The open (unsettled) attempts of one task in a round's journal. */
export function openDispatchAttempts(
  repoRoot: string,
  roundId: string,
  taskId: string,
): readonly UncertainDispatch[] {
  return uncertainDispatches(readDispatchJournal(repoRoot, roundId)).filter(
    (item) => item.task_id === taskId,
  );
}

/**
 * Every task that blocks the round until a human records a disposition: each attempt
 * with intent but no `settled` event, whatever the task's status, and each agent task
 * of the round left `in_progress` with no open attempt (a crash before the first
 * intent, or a journal moved aside by quarantine). A task status alone never clears
 * uncertainty (ADR-MDL-0005 D-6 as amended by ADR-MDL-0007).
 */
export function uncertainDispatchFindings(
  repoRoot: string,
  roundId: string,
  tasks: readonly Pick<TaskRecord, 'id' | 'round_id' | 'status' | 'executor'>[],
): readonly UncertainDispatchFinding[] {
  const open = uncertainDispatches(readDispatchJournal(repoRoot, roundId));
  const findings: UncertainDispatchFinding[] = open.map((item) => ({ ...item }));
  for (const task of tasks) {
    if (
      task.round_id === roundId &&
      task.executor.kind === 'agent' &&
      task.status === 'in_progress' &&
      !open.some((item) => item.task_id === task.id)
    ) {
      findings.push({ task_id: task.id, attempt: null, last_event: null });
    }
  }
  return findings;
}

/**
 * Refuse to dispatch a round while any work is uncertain. A human disposes of it
 * with `round dispatch dispose` (retry or escalate) or `task escalate`, each of which
 * records the disposition; nothing here retries, replays, or cleans up an uncertain
 * attempt (ADR-MDL-0005 D-6, ADR-MDL-0007).
 */
export function assertNoUncertainDispatch(
  repoRoot: string,
  roundId: string,
  tasks: readonly Pick<TaskRecord, 'id' | 'round_id' | 'status' | 'executor'>[],
): void {
  const findings = uncertainDispatchFindings(repoRoot, roundId, tasks);
  if (findings.length > 0) throw new DispatchUncertainError(findings);
}

/** Where a damaged journal is moved: beside it, named by the SHA-256 of its bytes. */
export function quarantinedJournalPath(repoRoot: string, roundId: string, digest: string): string {
  return join(
    repoRoot,
    '.devai/state/round-runs',
    roundId,
    `dispatch-journal.quarantined-${digest}.jsonl`,
  );
}

export interface QuarantinedJournal {
  readonly sha256: string;
  readonly bytes: number;
  readonly path: string;
}

/**
 * Plan the quarantine of a damaged journal: its exact bytes, their SHA-256, and the
 * path it will move to. A missing journal or one that still verifies refuses:
 * quarantine never discards a readable record of uncertain work.
 */
export function planDispatchJournalQuarantine(
  repoRoot: string,
  roundId: string,
): QuarantinedJournal & { readonly raw: string } {
  const path = dispatchJournalPath(repoRoot, roundId);
  if (!existsSync(path)) fail('TASK_DISPATCH_JOURNAL_MISSING');
  let damaged = false;
  try {
    readDispatchJournal(repoRoot, roundId);
  } catch (error) {
    if (!(error instanceof TaskServiceError) || error.code !== 'TASK_DISPATCH_JOURNAL_INVALID') {
      throw error;
    }
    damaged = true;
  }
  if (!damaged) fail('TASK_DISPATCH_JOURNAL_VALID');
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  return {
    sha256: digest,
    bytes: bytes.length,
    path: quarantinedJournalPath(repoRoot, roundId, digest),
    raw: bytes.toString('utf8'),
  };
}

/**
 * Move the planned journal aside byte for byte, so the next dispatch starts a fresh
 * hash chain. The journal must still hold exactly the planned bytes.
 */
export function applyDispatchJournalQuarantine(
  repoRoot: string,
  roundId: string,
  plan: QuarantinedJournal,
): void {
  const path = dispatchJournalPath(repoRoot, roundId);
  if (!existsSync(path) || sha256(readFileSync(path)) !== plan.sha256) {
    fail('TASK_DISPATCH_JOURNAL_CHANGED');
  }
  renameSync(path, plan.path);
  fsyncDirectorySync(dirname(path));
}
