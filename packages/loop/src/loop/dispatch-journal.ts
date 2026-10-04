import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from '@devai-nyx/authority';
import { parsers } from '@devai-nyx/schemas';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fail } from './task-queue-services.js';
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

const TERMINAL: ReadonlySet<TaskRecord['status']> = new Set([
  'completed',
  'escalated',
  'cancelled',
]);

export function dispatchJournalPath(repoRoot: string, roundId: string): string {
  return join(repoRoot, '.devai/state/round-runs', roundId, 'dispatch-journal.jsonl');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function key(event: Pick<DispatchJournalEvent, 'task_id' | 'attempt'>): string {
  return `${event.task_id}#${String(event.attempt)}`;
}

/**
 * Read and verify the whole journal. Every line must be complete, schema-valid,
 * hash-linked to the previous line, and ordered within its attempt. A torn final
 * line from a crash mid-append, or any other damage, refuses with
 * `TASK_DISPATCH_JOURNAL_INVALID` and is never repaired automatically.
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
    const position = DISPATCH_JOURNAL_EVENTS.indexOf(event.event);
    const reached = progress.get(key(event)) ?? -1;
    if (position !== reached + 1) fail('TASK_DISPATCH_JOURNAL_INVALID');
    progress.set(key(event), position);
    events.push(event);
    previous = sha256(line);
  }
  return events;
}

/**
 * Append one fsynced, hash-linked event. The event must be the next boundary of
 * its attempt; anything else refuses before a byte is written.
 */
export function appendDispatchJournalEvent(
  repoRoot: string,
  roundId: string,
  entry: DispatchJournalEntry,
): DispatchJournalEvent {
  const path = dispatchJournalPath(repoRoot, roundId);
  const existing = readDispatchJournal(repoRoot, roundId);
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
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
  const reached = existing.filter((item) => key(item) === key(event)).length - 1;
  if (DISPATCH_JOURNAL_EVENTS.indexOf(event.event) !== reached + 1) {
    fail('TASK_DISPATCH_JOURNAL_ORDER');
  }
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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

/**
 * Refuse to dispatch a round while any attempt is uncertain and its task has not
 * been disposed of by a human. A human disposes of uncertain work with `task
 * escalate` (or another terminal transition); nothing here retries, replays, or
 * cleans up an uncertain attempt (ADR-MDL-0005 D-6).
 */
export function assertNoUncertainDispatch(
  repoRoot: string,
  roundId: string,
  tasks: readonly Pick<TaskRecord, 'id' | 'status'>[],
): void {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  const pending = uncertainDispatches(readDispatchJournal(repoRoot, roundId)).filter(
    (item) => !TERMINAL.has(status.get(item.task_id) ?? 'in_progress'),
  );
  if (pending.length > 0) fail('TASK_DISPATCH_UNCERTAIN');
}
