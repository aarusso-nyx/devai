/**
 * Human disposition of uncertain or blocked experimental work (ADR-MDL-0007, amending
 * ADR-MDL-0005 D-6). Every disposition writes a create-only, fsynced record under
 * `.devai/state/round-runs/<round>/dispositions/` before it changes anything else; each
 * open journal attempt of the task is then closed by a `settled` event with outcome
 * `cancelled` that names the record. Nothing here runs a provider or retries on its own.
 */
import { existsSync, readdirSync, readFileSync } from '@devai-nyx/authority';
import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import { join } from 'node:path';
import {
  appendDispatchJournalEvent,
  applyDispatchJournalQuarantine,
  dispatchJournalPath,
  openDispatchAttempts,
  planDispatchJournalQuarantine,
  readDispatchJournal,
  type DispatchDisposition,
  type DispatchJournalEvent,
  type QuarantinedJournal,
} from './dispatch-journal.js';
import { writeCreateOnlyDurableSync } from './durable-files.js';
import { acquireRoundController, releaseRoundController } from './round-controller.js';
import { fail, requireActiveTaskRound } from './task-queue-services.js';
import { escalateTask, listTasks, loadTask, saveTask, type TaskRecord } from './tasks.js';
import { listWorktrees, releaseTaskWorktrees } from './worktrees.js';

/** One disposition record (ADR-MDL-0007). */
export interface DispatchDispositionRecord {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly round_id: string;
  readonly kind: 'task' | 'journal-quarantine';
  /** `round dispatch dispose` (the Owner), or an escalation through `task escalate` or a runner. */
  readonly action: 'round dispatch dispose' | 'escalation';
  /** The Owner for a dispose; null when the escalating action's own authority names the caller. */
  readonly role: 'owner' | null;
  readonly disposed_at: string;
  readonly task_id: string | null;
  readonly disposition: DispatchDisposition | null;
  readonly prior_status: TaskRecord['status'] | null;
  readonly resulting_status: TaskRecord['status'] | null;
  /** Attempts this disposition closed in the journal. */
  readonly closed_attempts: readonly number[];
  /** Highest attempt number each named task has used, so a later attempt never reuses one. */
  readonly attempt_floors: Readonly<Record<string, number>>;
  readonly released_worktrees: readonly string[];
  readonly quarantined_journal: QuarantinedJournal | null;
  /** Agent tasks left in progress when the journal was quarantined; each needs its own disposition. */
  readonly in_flight_task_ids: readonly string[];
  readonly note: string | null;
}

const TERMINAL: ReadonlySet<TaskRecord['status']> = new Set([
  'completed',
  'escalated',
  'cancelled',
]);

function roundRunDir(repoRoot: string, roundId: string): string {
  return join(repoRoot, '.devai/state/round-runs', roundId);
}

function dispositionsDir(repoRoot: string, roundId: string): string {
  return join(roundRunDir(repoRoot, roundId), 'dispositions');
}

function writeDispositionRecord(
  repoRoot: string,
  draft: Omit<DispatchDispositionRecord, 'schemaVersion' | 'id'>,
): DispatchDispositionRecord {
  const id = `DSP-${canonicalSha256(draft).slice(0, 16)}`;
  const record: DispatchDispositionRecord = { schemaVersion: '1.0.0', id, ...draft };
  writeCreateOnlyDurableSync(
    join(dispositionsDir(repoRoot, draft.round_id), `${id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

/** The disposition records of one round, in name order. */
export function listDispatchDispositions(
  repoRoot: string,
  roundId: string,
): readonly DispatchDispositionRecord[] {
  const dir = dispositionsDir(repoRoot, roundId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as DispatchDispositionRecord);
}

const ATTEMPT_SUFFIX = /-A([1-9][0-9]*)(?:\.json)?$/u;

function attemptNumber(name: string, taskId: string): number | undefined {
  if (!name.startsWith(`${taskId}-A`) && !name.startsWith(`WT-${taskId}-A`)) return undefined;
  const match = ATTEMPT_SUFFIX.exec(name);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * The highest attempt number one task has used in a round, from every durable trace an
 * attempt leaves: journal intents, exit diagnostics, attempt worktrees, and the floors
 * that dispositions and journal quarantines recorded. Attempts are numbered for the
 * task's lifetime, so the Article 19 ladder continues after a retry instead of
 * restarting, and no attempt identity is ever reused.
 */
export function dispatchAttemptFloor(repoRoot: string, roundId: string, taskId: string): number {
  const numbers: number[] = [0];
  for (const event of readDispatchJournal(repoRoot, roundId)) {
    if (event.task_id === taskId) numbers.push(event.attempt);
  }
  const diagnostics = join(roundRunDir(repoRoot, roundId), 'diagnostics');
  if (existsSync(diagnostics)) {
    for (const name of readdirSync(diagnostics)) {
      const number = attemptNumber(name, taskId);
      if (number !== undefined) numbers.push(number);
    }
  }
  for (const worktree of listWorktrees({ repoRoot })) {
    const number = attemptNumber(worktree.id, taskId);
    if (number !== undefined) numbers.push(number);
  }
  for (const record of listDispatchDispositions(repoRoot, roundId)) {
    numbers.push(record.attempt_floors[taskId] ?? 0);
  }
  return Math.max(...numbers);
}

/** Close every open attempt of a task with a human disposition naming its record. */
function closeOpenAttempts(
  repoRoot: string,
  roundId: string,
  taskId: string,
  attempts: readonly number[],
  disposition: DispatchDisposition,
  dispositionId: string,
): void {
  for (const attempt of attempts) {
    appendDispatchJournalEvent(repoRoot, roundId, {
      task_id: taskId,
      attempt,
      event: 'settled',
      outcome: 'cancelled',
      disposition,
      disposition_id: dispositionId,
    });
  }
}

/**
 * Record the escalation of an agent task as a disposition when it still has open
 * journal attempts, closing them, and release its attempt worktrees. `task escalate`
 * is the human disposition ADR-MDL-0005 D-6 names; its uncertainty now clears only
 * through this record. A task with no journal history only has its worktrees released.
 */
export function recordAgentEscalation(options: {
  readonly repoRoot: string;
  readonly roundId: string;
  readonly task: TaskRecord;
  readonly now?: Date;
}): void {
  const { repoRoot, roundId, task } = options;
  if (task.executor.kind !== 'agent') return;
  const open = existsSync(dispatchJournalPath(repoRoot, roundId))
    ? openDispatchAttempts(repoRoot, roundId, task.id)
    : [];
  if (open.length > 0) {
    const closed = open.map((item) => item.attempt);
    const record = writeDispositionRecord(repoRoot, {
      round_id: roundId,
      kind: 'task',
      action: 'escalation',
      role: null,
      disposed_at: (options.now ?? new Date()).toISOString(),
      task_id: task.id,
      disposition: 'escalate',
      prior_status: task.status,
      resulting_status: 'escalated',
      closed_attempts: closed,
      attempt_floors: { [task.id]: dispatchAttemptFloor(repoRoot, roundId, task.id) },
      released_worktrees: boundWorktrees(repoRoot, task.id),
      quarantined_journal: null,
      in_flight_task_ids: [],
      note: null,
    });
    closeOpenAttempts(repoRoot, roundId, task.id, closed, 'escalate', record.id);
  }
  releaseTaskWorktrees({ repoRoot, taskId: task.id });
  const current = loadTask(repoRoot, task.id);
  if (current.worktree_id !== undefined) {
    const { worktree_id: _worktree, ...rest } = current;
    void _worktree;
    saveTask(repoRoot, rest);
  }
}

function boundWorktrees(repoRoot: string, taskId: string): readonly string[] {
  return listWorktrees({ repoRoot })
    .filter((worktree) => worktree.task_id === taskId && worktree.human_adopted !== true)
    .map((worktree) => worktree.id)
    .sort();
}

function withRoundController<T>(repoRoot: string, roundId: string, run: () => T): T {
  // A live dispatch owns the round controller, so a disposition can never race one.
  const controller = acquireRoundController(repoRoot, roundId);
  try {
    return run();
  } finally {
    releaseRoundController(repoRoot, controller);
  }
}

/** The bound on one task's lifetime attempts (Article 19; experimental-execution ceilings). */
function attemptLimit(task: TaskRecord): number {
  const executor = task.executor as unknown as { readonly max_iterations?: number };
  return Math.min(executor.max_iterations ?? 4, 4);
}

/**
 * The Owner's disposition of one uncertain or blocked agent task: an open journal
 * attempt (any status), an agent task left `in_progress` by a crashed dispatch, or an
 * `experimental_blocked` task. It holds the round controller, writes the disposition
 * record, closes every open attempt, releases the task's attempt worktrees, and then
 * moves the task to `ready` (retry, keeping its locks under release_on) or `escalated`
 * (escalate, which releases them). A retry continues the task's attempt ladder and
 * refuses once the ladder is spent; a terminal task with open attempts may only be
 * escalated, which closes them without a status change.
 */
export function disposeDispatchTask(options: {
  readonly repoRoot: string;
  readonly round?: string;
  readonly taskId: string;
  readonly disposition: DispatchDisposition;
  readonly note?: string;
  readonly now?: Date;
}): DispatchDispositionRecord {
  if (options.disposition !== 'retry' && options.disposition !== 'escalate') {
    fail('DISPOSITION_INVALID');
  }
  const roundId = requireActiveTaskRound(options);
  return withRoundController(options.repoRoot, roundId, () => {
    const { repoRoot } = options;
    let task: TaskRecord;
    try {
      task = loadTask(repoRoot, options.taskId);
    } catch {
      fail('TASK_NOT_FOUND');
    }
    if (task.round_id !== roundId) fail('TASK_ROUND_MISMATCH');
    if (task.executor.kind !== 'agent') fail('DISPOSITION_TASK_NOT_AGENT');
    const open = openDispatchAttempts(repoRoot, roundId, task.id);
    const applicable =
      open.length > 0 || task.status === 'experimental_blocked' || task.status === 'in_progress';
    if (!applicable) fail('DISPOSITION_NOT_APPLICABLE');
    const terminal = TERMINAL.has(task.status);
    if (terminal && options.disposition === 'retry') fail('DISPOSITION_TASK_TERMINAL');
    const floor = dispatchAttemptFloor(repoRoot, roundId, task.id);
    if (options.disposition === 'retry' && floor >= attemptLimit(task)) {
      // Article 19: the ladder ends in experimental_blocked; a further try is a new task.
      fail('DISPOSITION_ATTEMPTS_EXHAUSTED');
    }
    const resulting: TaskRecord['status'] = terminal
      ? task.status
      : options.disposition === 'retry'
        ? 'ready'
        : 'escalated';
    const bound = boundWorktrees(repoRoot, task.id);
    const closed = open.map((item) => item.attempt);
    const record = writeDispositionRecord(repoRoot, {
      round_id: roundId,
      kind: 'task',
      action: 'round dispatch dispose',
      role: 'owner',
      disposed_at: (options.now ?? new Date()).toISOString(),
      task_id: task.id,
      disposition: options.disposition,
      prior_status: task.status,
      resulting_status: resulting,
      closed_attempts: closed,
      attempt_floors: { [task.id]: floor },
      released_worktrees: bound,
      quarantined_journal: null,
      in_flight_task_ids: [],
      note: options.note ?? null,
    });
    closeOpenAttempts(repoRoot, roundId, task.id, closed, options.disposition, record.id);
    releaseTaskWorktrees({ repoRoot, taskId: task.id });
    if (terminal) return record;
    const current = loadTask(repoRoot, task.id);
    if (options.disposition === 'retry') {
      const { worktree_id: _worktree, branch: _branch, ...rest } = current;
      void _worktree;
      void _branch;
      // Locks follow round-execution.json release_on: a retried task keeps them, and the
      // next dispatch reuses them while they are unexpired.
      saveTask(repoRoot, { ...rest, status: 'ready' });
    } else {
      const { worktree_id: _worktree, ...rest } = current;
      void _worktree;
      saveTask(repoRoot, rest);
      escalateTask({ repoRoot, taskId: task.id });
    }
    return record;
  });
}

/** Highest attempt per task in the verifiable prefix of a damaged journal. */
function prefixAttemptFloors(raw: string, roundId: string): Record<string, number> {
  const floors: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    const parsed = parsers.dispatchJournalEvent.safeParseJson<DispatchJournalEvent>(line);
    if (!parsed.ok) continue;
    if (parsed.value.round_id !== roundId) continue;
    floors[parsed.value.task_id] = Math.max(
      floors[parsed.value.task_id] ?? 0,
      parsed.value.attempt,
    );
  }
  return floors;
}

/**
 * The Owner's quarantine of a damaged journal: move it aside byte for byte, named by
 * its SHA-256, and write a disposition record naming it, the attempt floors of its
 * readable lines, and every agent task left in progress. The next dispatch starts a
 * fresh chain; each in-flight task still needs its own explicit disposition and is
 * never retried blindly.
 */
export function quarantineRoundDispatchJournal(options: {
  readonly repoRoot: string;
  readonly round?: string;
  readonly note?: string;
  readonly now?: Date;
}): DispatchDispositionRecord {
  const roundId = requireActiveTaskRound(options);
  return withRoundController(options.repoRoot, roundId, () => {
    const { repoRoot } = options;
    const { raw, ...planned } = planDispatchJournalQuarantine(repoRoot, roundId);
    const inFlight = listTasks(repoRoot)
      .filter(
        (task) =>
          task.round_id === roundId &&
          task.executor.kind === 'agent' &&
          task.status === 'in_progress',
      )
      .map((task) => task.id)
      .sort();
    // The record is durable before the journal moves, so a crash between the two leaves
    // the damaged journal in place and the quarantine can simply run again.
    const record = writeDispositionRecord(repoRoot, {
      round_id: roundId,
      kind: 'journal-quarantine',
      action: 'round dispatch dispose',
      role: 'owner',
      disposed_at: (options.now ?? new Date()).toISOString(),
      task_id: null,
      disposition: null,
      prior_status: null,
      resulting_status: null,
      closed_attempts: [],
      attempt_floors: prefixAttemptFloors(raw, roundId),
      released_worktrees: [],
      quarantined_journal: planned,
      in_flight_task_ids: inFlight,
      note: options.note ?? null,
    });
    applyDispatchJournalQuarantine(repoRoot, roundId, planned);
    return record;
  });
}
