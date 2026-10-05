/**
 * Human disposition of uncertain or blocked experimental work (ADR-MDL-0007, amending
 * ADR-MDL-0005 D-6). Every disposition writes a create-only, fsynced record under
 * `.devai/state/round-runs/<round>/dispositions/` before it changes anything else; each
 * open journal attempt of the task is then closed by a `settled` event with outcome
 * `cancelled` that names the record, and an `.applied` marker beside the record states
 * that every step completed. A record without its marker is an interrupted disposition:
 * it blocks the round until the same disposition is issued again and resumes it.
 * Nothing here runs a provider or retries on its own.
 */
import { existsSync, readdirSync, readFileSync } from '@devai-nyx/authority';
import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import { join } from 'node:path';
import {
  DispatchUncertainError,
  appendDispatchJournalEvent,
  applyDispatchJournalQuarantine,
  damagedJournalOpenAttempts,
  dispatchJournalQuarantined,
  openDispatchAttempts,
  planDispatchJournalQuarantine,
  readDispatchJournal,
  uncertainDispatches,
  type DispatchDisposition,
  type DispatchJournalEvent,
  type QuarantinedJournal,
  type UncertainDispatch,
  type UncertainDispatchFinding,
} from './dispatch-journal.js';
import { writeCreateOnlyDurableSync } from './durable-files.js';
import { acquireRoundController, releaseRoundController } from './round-controller.js';
import { fail, requireActiveTaskRound } from './task-queue-services.js';
import {
  escalateTask,
  listTasks,
  loadTask,
  saveTask,
  type TaskRecord,
  type TransitionOptions,
} from './tasks.js';
import { listWorktrees, releaseTaskWorktrees } from './worktrees.js';

/** An attempt a quarantined journal left open, resolved by a later task disposition. */
export interface QuarantinedAttemptRef {
  readonly quarantine_id: string;
  readonly attempt: number;
}

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
  /** Attempts left open by quarantined journals that this disposition resolves. */
  readonly resolved_quarantined_attempts: readonly QuarantinedAttemptRef[];
  /** Highest attempt number each named task has used, so a later attempt never reuses one. */
  readonly attempt_floors: Readonly<Record<string, number>>;
  readonly released_worktrees: readonly string[];
  readonly quarantined_journal: QuarantinedJournal | null;
  /** For a quarantine: every attempt the damaged journal leaves open; each blocks the round. */
  readonly open_attempts: readonly UncertainDispatch[];
  /** For a quarantine: every task left in flight; each needs its own disposition. */
  readonly in_flight_task_ids: readonly string[];
  readonly note: string | null;
}

/** The task transition options an escalation forwards to the task store. */
export type EscalationTransition = Pick<TransitionOptions, 'databaseUrl' | 'destroyWorktree'>;

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

function appliedMarkerPath(repoRoot: string, record: DispatchDispositionRecord): string {
  return join(dispositionsDir(repoRoot, record.round_id), `${record.id}.applied`);
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

/** State durably that every step of a task disposition completed. */
function markDispositionApplied(repoRoot: string, record: DispatchDispositionRecord): void {
  const path = appliedMarkerPath(repoRoot, record);
  if (existsSync(path)) return;
  writeCreateOnlyDurableSync(path, `${JSON.stringify({ applied_at: new Date().toISOString() })}\n`);
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

/** Task dispositions whose application was interrupted (no `.applied` marker), in record order. */
export function pendingTaskDispositions(
  repoRoot: string,
  roundId: string,
  taskId?: string,
  records: readonly DispatchDispositionRecord[] = listDispatchDispositions(repoRoot, roundId),
): readonly DispatchDispositionRecord[] {
  return records.filter(
    (record) =>
      record.kind === 'task' &&
      (taskId === undefined || record.task_id === taskId) &&
      !existsSync(appliedMarkerPath(repoRoot, record)),
  );
}

/**
 * Attempts that quarantined journals left open and that no task disposition has resolved
 * yet. Only a quarantine that took effect counts: until the journal moves aside, the
 * damaged journal itself blocks every dispatch.
 */
export function unresolvedQuarantinedAttempts(
  repoRoot: string,
  roundId: string,
  records: readonly DispatchDispositionRecord[] = listDispatchDispositions(repoRoot, roundId),
): readonly (UncertainDispatch & { readonly quarantine_id: string })[] {
  const resolved = new Set(
    records
      .filter((record) => record.kind === 'task')
      .flatMap((record) =>
        (record.resolved_quarantined_attempts ?? []).map(
          (item) => `${item.quarantine_id}#${String(record.task_id)}#${String(item.attempt)}`,
        ),
      ),
  );
  return records
    .filter(
      (record) =>
        record.kind === 'journal-quarantine' &&
        record.quarantined_journal !== null &&
        dispatchJournalQuarantined(repoRoot, roundId, record.quarantined_journal.sha256),
    )
    .flatMap((record) =>
      (record.open_attempts ?? [])
        .filter((item) => !resolved.has(`${record.id}#${item.task_id}#${String(item.attempt)}`))
        .map((item) => ({ ...item, quarantine_id: record.id })),
    );
}

/**
 * Every task that blocks the round until a human records a disposition: each attempt
 * with intent but no `settled` event, whatever the task's status; each attempt a
 * quarantined journal left open that no disposition resolved; each task disposition
 * whose application was interrupted; and each agent task of the round left `in_progress`
 * with none of these (a crash before the first intent). A task status alone never clears
 * uncertainty (ADR-MDL-0005 D-6 as amended by ADR-MDL-0007).
 */
export function uncertainDispatchFindings(
  repoRoot: string,
  roundId: string,
  tasks: readonly Pick<TaskRecord, 'id' | 'round_id' | 'status' | 'executor'>[],
): readonly UncertainDispatchFinding[] {
  const findings: UncertainDispatchFinding[] = uncertainDispatches(
    readDispatchJournal(repoRoot, roundId),
  ).map((item) => ({ ...item }));
  const records = listDispatchDispositions(repoRoot, roundId);
  findings.push(...unresolvedQuarantinedAttempts(repoRoot, roundId, records));
  for (const record of pendingTaskDispositions(repoRoot, roundId, undefined, records)) {
    findings.push({
      task_id: String(record.task_id),
      attempt: null,
      last_event: null,
      disposition_id: record.id,
    });
  }
  const flagged = new Set(findings.map((finding) => finding.task_id));
  for (const task of tasks) {
    if (
      task.round_id === roundId &&
      task.executor.kind === 'agent' &&
      task.status === 'in_progress' &&
      !flagged.has(task.id)
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

/**
 * The uncertain work of one task: its open journal attempts, the attempts quarantined
 * journals left open for it, and its interrupted dispositions. Ratification and
 * completion refuse while any remains.
 */
export function taskDispatchBlockers(
  repoRoot: string,
  roundId: string,
  taskId: string,
): readonly UncertainDispatchFinding[] {
  const records = listDispatchDispositions(repoRoot, roundId);
  return [
    ...openDispatchAttempts(repoRoot, roundId, taskId).map((item) => ({ ...item })),
    ...unresolvedQuarantinedAttempts(repoRoot, roundId, records).filter(
      (item) => item.task_id === taskId,
    ),
    ...pendingTaskDispositions(repoRoot, roundId, taskId, records).map((record) => ({
      task_id: taskId,
      attempt: null,
      last_event: null,
      disposition_id: record.id,
    })),
  ];
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

function boundWorktrees(repoRoot: string, taskId: string): readonly string[] {
  return listWorktrees({ repoRoot })
    .filter((worktree) => worktree.task_id === taskId && worktree.human_adopted !== true)
    .map((worktree) => worktree.id)
    .sort();
}

function withoutWorktree(task: TaskRecord): TaskRecord {
  const { worktree_id: _worktree, ...rest } = task;
  void _worktree;
  return rest;
}

/**
 * Apply every step of a recorded task disposition, idempotently, then mark it applied:
 * close each recorded attempt still open in the journal, release the task's attempt
 * worktrees, and move the task to the recorded status unless it is already there. A
 * resumed disposition repeats only the steps an interruption left undone.
 */
function applyTaskDisposition(
  repoRoot: string,
  record: DispatchDispositionRecord,
  transition: EscalationTransition = {},
): TaskRecord {
  const taskId = String(record.task_id);
  const disposition = record.disposition ?? 'escalate';
  const open = new Set(
    openDispatchAttempts(repoRoot, record.round_id, taskId).map((item) => item.attempt),
  );
  for (const attempt of record.closed_attempts) {
    if (!open.has(attempt)) continue;
    appendDispatchJournalEvent(repoRoot, record.round_id, {
      task_id: taskId,
      attempt,
      event: 'settled',
      outcome: 'cancelled',
      disposition,
      disposition_id: record.id,
    });
  }
  releaseTaskWorktrees({ repoRoot, taskId });
  const current = loadTask(repoRoot, taskId);
  if (current.status !== record.resulting_status) {
    if (TERMINAL.has(current.status)) fail('DISPOSITION_TASK_TERMINAL');
    if (disposition === 'retry') {
      // Locks follow round-execution.json release_on: a retried task keeps them, and the
      // next dispatch reuses them while they are unexpired.
      const { branch: _branch, ...rest } = withoutWorktree(current);
      void _branch;
      saveTask(repoRoot, { ...rest, status: 'ready' });
    } else {
      saveTask(repoRoot, withoutWorktree(current));
      escalateTask({ repoRoot, taskId, ...transition });
    }
  } else if (current.worktree_id !== undefined) {
    saveTask(repoRoot, withoutWorktree(current));
  }
  markDispositionApplied(repoRoot, record);
  return loadTask(repoRoot, taskId);
}

/** The last interrupted disposition of a task, which a matching request must resume. */
function resumable(
  repoRoot: string,
  roundId: string,
  taskId: string,
  disposition: DispatchDisposition,
): DispatchDispositionRecord | undefined {
  const pending = pendingTaskDispositions(repoRoot, roundId, taskId).at(-1);
  if (pending !== undefined && pending.disposition !== disposition) {
    fail('DISPOSITION_INCOMPLETE');
  }
  return pending;
}

/**
 * Escalate an agent task as a recorded disposition. The caller holds the round
 * controller: a live dispatch can therefore never have a provider running for the task.
 * When the task has open journal attempts, attempts a quarantined journal left open, or
 * is still `in_progress` (uncertain even with no journal record), the escalation writes a
 * disposition record that closes or resolves them; an interrupted escalation of the task
 * is resumed. The attempt worktrees are released either way. `task escalate` is the
 * human disposition ADR-MDL-0005 D-6 names; its uncertainty clears only through this record.
 */
export function escalateAgentTask(options: {
  readonly repoRoot: string;
  readonly roundId: string;
  readonly task: TaskRecord;
  readonly transition?: EscalationTransition;
  readonly now?: Date;
}): TaskRecord {
  const { repoRoot, roundId, task } = options;
  const pending = resumable(repoRoot, roundId, task.id, 'escalate');
  if (pending !== undefined) return applyTaskDisposition(repoRoot, pending, options.transition);
  const open = openDispatchAttempts(repoRoot, roundId, task.id).map((item) => item.attempt);
  const quarantined = unresolvedQuarantinedAttempts(repoRoot, roundId).filter(
    (item) => item.task_id === task.id,
  );
  if (open.length === 0 && quarantined.length === 0 && task.status !== 'in_progress') {
    releaseTaskWorktrees({ repoRoot, taskId: task.id });
    saveTask(repoRoot, withoutWorktree(loadTask(repoRoot, task.id)));
    return escalateTask({ repoRoot, taskId: task.id, ...options.transition });
  }
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
    closed_attempts: open,
    resolved_quarantined_attempts: quarantined.map((item) => ({
      quarantine_id: item.quarantine_id,
      attempt: item.attempt,
    })),
    attempt_floors: { [task.id]: dispatchAttemptFloor(repoRoot, roundId, task.id) },
    released_worktrees: boundWorktrees(repoRoot, task.id),
    quarantined_journal: null,
    open_attempts: [],
    in_flight_task_ids: [],
    note: null,
  });
  return applyTaskDisposition(repoRoot, record, options.transition);
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
 * attempt (any status), an attempt a quarantined journal left open, an agent task left
 * `in_progress` by a crashed dispatch, or an `experimental_blocked` task. It holds the
 * round controller, so it refuses with `TASK_ROUND_CONTROLLER_BUSY` while a dispatch owns
 * the round. It writes the disposition record, closes or resolves every open attempt,
 * releases the task's attempt worktrees, and then moves the task to `ready` (retry,
 * keeping its locks under release_on) or `escalated` (escalate, which releases them). A
 * retry continues the task's attempt ladder and refuses once the ladder is spent; a
 * terminal task with open attempts may only be escalated, which closes them without a
 * status change. Issuing an interrupted disposition again resumes it.
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
    const pending = resumable(repoRoot, roundId, task.id, options.disposition);
    if (pending !== undefined) {
      applyTaskDisposition(repoRoot, pending);
      return pending;
    }
    const open = openDispatchAttempts(repoRoot, roundId, task.id);
    const quarantined = unresolvedQuarantinedAttempts(repoRoot, roundId).filter(
      (item) => item.task_id === task.id,
    );
    const applicable =
      open.length > 0 ||
      quarantined.length > 0 ||
      task.status === 'experimental_blocked' ||
      task.status === 'in_progress';
    if (!applicable) fail('DISPOSITION_NOT_APPLICABLE');
    const terminal = TERMINAL.has(task.status);
    if (terminal && options.disposition === 'retry') fail('DISPOSITION_TASK_TERMINAL');
    const floor = dispatchAttemptFloor(repoRoot, roundId, task.id);
    if (options.disposition === 'retry' && floor >= attemptLimit(task)) {
      // Article 19: the ladder ends in experimental_blocked; a further try is a new task.
      fail('DISPOSITION_ATTEMPTS_EXHAUSTED');
    }
    const record = writeDispositionRecord(repoRoot, {
      round_id: roundId,
      kind: 'task',
      action: 'round dispatch dispose',
      role: 'owner',
      disposed_at: (options.now ?? new Date()).toISOString(),
      task_id: task.id,
      disposition: options.disposition,
      prior_status: task.status,
      resulting_status: terminal
        ? task.status
        : options.disposition === 'retry'
          ? 'ready'
          : 'escalated',
      closed_attempts: open.map((item) => item.attempt),
      resolved_quarantined_attempts: quarantined.map((item) => ({
        quarantine_id: item.quarantine_id,
        attempt: item.attempt,
      })),
      attempt_floors: { [task.id]: floor },
      released_worktrees: boundWorktrees(repoRoot, task.id),
      quarantined_journal: null,
      open_attempts: [],
      in_flight_task_ids: [],
      note: options.note ?? null,
    });
    applyTaskDisposition(repoRoot, record);
    return record;
  });
}

/** Highest attempt per task in every readable line of a damaged journal. */
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
 * The Owner's quarantine of a damaged journal: write a disposition record naming the
 * journal, every attempt it leaves open, their attempt floors and every task left in
 * flight, then move the journal aside byte for byte, named by its SHA-256. The next
 * dispatch starts a fresh chain; each attempt the journal left open keeps blocking the
 * round until its task gets its own disposition, whatever the task's status, and is
 * never retried blindly. Issuing the quarantine again after an interruption completes
 * the move.
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
    const pending = listDispatchDispositions(repoRoot, roundId).find(
      (record) =>
        record.kind === 'journal-quarantine' &&
        record.quarantined_journal !== null &&
        !dispatchJournalQuarantined(repoRoot, roundId, record.quarantined_journal.sha256),
    );
    if (pending?.quarantined_journal != null) {
      applyDispatchJournalQuarantine(repoRoot, roundId, pending.quarantined_journal);
      return pending;
    }
    const { raw, ...planned } = planDispatchJournalQuarantine(repoRoot, roundId);
    const open = damagedJournalOpenAttempts(raw, roundId);
    const inFlight = new Set(open.map((item) => item.task_id));
    for (const task of listTasks(repoRoot)) {
      if (
        task.round_id === roundId &&
        task.executor.kind === 'agent' &&
        task.status === 'in_progress'
      ) {
        inFlight.add(task.id);
      }
    }
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
      resolved_quarantined_attempts: [],
      attempt_floors: prefixAttemptFloors(raw, roundId),
      released_worktrees: [],
      quarantined_journal: planned,
      open_attempts: open,
      in_flight_task_ids: [...inFlight].sort(),
      note: options.note ?? null,
    });
    applyDispatchJournalQuarantine(repoRoot, roundId, planned);
    return record;
  });
}
