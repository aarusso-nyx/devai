import { join } from 'node:path';
import { decideRoundTaskAdmission, planRoundTaskAdmission } from './round-task-admission.js';
import {
  LOCK_RENEWAL_INTERVAL_MS,
  WAITING_LOCK_TTL_MS,
  closeLockFence,
  holdsLiveLocks,
  inspectLocks,
  listLockFences,
  lockFenceReleases,
  lockIdentity,
  openLockFence,
  releaseLocks,
  removeOrphanLockReceipts,
  renewLocks,
  taskLockTargets,
  type LockFence,
} from './locks.js';
import {
  LOCK_DENIAL_ESCALATION_THRESHOLD,
  LOCK_RELEASE_STATUSES,
  ROUND_DEFAULT_WORKERS,
  ROUND_MAX_WORKERS,
  acquireRoundController,
  assertLockDenialsValid,
  clearLockDenials,
  lockDenialCount,
  pendingPriorityBumps,
  recordLockDenial,
  releaseRoundController,
  settlePendingPriorityBump,
} from './round-controller.js';
import { escalateTask, listTaskRecords, loadTask, saveTask, type TaskRecord } from './tasks.js';
import {
  escalateRoundTask,
  requireActiveTaskRound,
  startRoundTask,
  TaskServiceError,
} from './task-services.js';

export interface RoundTaskDispatchResult {
  readonly ok: boolean;
  readonly evidence_id?: string;
  readonly code?: string;
}

export interface RunRoundTasksOptions {
  readonly repoRoot: string;
  readonly round?: string;
  readonly taskIds?: readonly string[];
  /** B3A-backed boundary that validates, executes, and evidences the immutable request. */
  readonly dispatch: (
    task: TaskRecord,
  ) => RoundTaskDispatchResult | Promise<RoundTaskDispatchResult>;
  /**
   * Opt-in concurrent worker cap, bounded by `round-execution.json` capacity.max_workers.
   * Omitted, the runner is serial (capacity.default_workers).
   */
  readonly maxWorkers?: number;
  /** How often held locks are renewed while a dispatch runs. Defaults to a quarter TTL. */
  readonly lockRenewalIntervalMs?: number;
}

export interface RoundTaskRunResult {
  readonly task_id: string;
  readonly ok: boolean;
  readonly evidence_id?: string;
  readonly code?: string;
}

export interface RunRoundTasksResult {
  readonly ok: boolean;
  readonly round_id: string;
  readonly ordered_task_ids: readonly string[];
  readonly results: readonly RoundTaskRunResult[];
  /**
   * Attempts a stopped runner left unjudged and this run reconciled before planning;
   * present only when one lost its lock (`TASK_RESOURCE_LOCK_LOST`).
   */
  readonly reconciled?: readonly RoundTaskRunResult[];
}

/** Unsupported or corrupt storage is preserved, never silently omitted from admission. */
function admissionPopulation(repoRoot: string): readonly TaskRecord[] {
  return listTaskRecords(repoRoot).map((classification) => {
    if (classification.kind !== 'current') throw new TaskServiceError(classification.code);
    return classification.record;
  });
}

function requiredTask(tasks: readonly TaskRecord[], id: string): TaskRecord {
  const task = tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new TaskServiceError('TASK_DEPENDENCY_MISSING');
  return task;
}

function requiredTaskLocksHeld(repoRoot: string, task: TaskRecord): boolean {
  return holdsLiveLocks({
    locksDir: join(repoRoot, '.devai/state/locks'),
    taskId: task.id,
    targets: taskLockTargets(task),
  });
}

/** A dispatch that leaves its task here still holds the task's locks. */
const LOCK_HOLDING_STATUSES = new Set<TaskRecord['status']>([
  'in_progress',
  'checkpoint',
  'pre_merge',
  'merging',
  'awaiting_human_review',
  'experimental_blocked',
]);

/**
 * Statuses in which a task waits outside any dispatch, still holding its locks, for a
 * human review, a merge, a disposition, or its next dispatch.
 */
const WAITING_STATUSES = new Set<TaskRecord['status']>(
  [...LOCK_HOLDING_STATUSES].filter((status) => status !== 'in_progress'),
);

/**
 * True when every key is accounted for: it still holds exactly the record the task last
 * held there, or, after a transition that releases locks, the task's own release left
 * its receipt there (and so held the key up to that release).
 */
function locksAccountedFor(
  locksDir: string,
  task: TaskRecord,
  targets: readonly string[],
  held: ReadonlyMap<string, string>,
  releasedByTask: ReadonlySet<string>,
): boolean {
  const current = new Map(
    inspectLocks({ locksDir, taskId: task.id, targets }).held.map((entry) => [
      entry.target,
      entry.identity,
    ]),
  );
  return targets.every((target) => {
    const identity = held.get(target);
    return (
      identity !== undefined && (current.get(target) === identity || releasedByTask.has(target))
    );
  });
}

/**
 * Run one dispatch while renewing the task's locks, so a dispatch longer than the
 * lock TTL is never taken over. A dispatch that leaves its task waiting outside any
 * dispatch (`WAITING_STATUSES`) hands it the waiting lease (`WAITING_LOCK_TTL_MS`):
 * nothing renews a waiting task, and a lease lapsing during a human review would let
 * another task take the module before the completion. A lock found missing, held by another task, or
 * replaced by any record other than the one this task last held is a lost lock: the
 * dispatch result cannot claim exclusive resources it no longer had. The final check
 * runs whatever status the dispatch left. A transition that released the locks
 * (`round-execution.json` resources.release_on) is accepted only if the task's own
 * release left a receipt for every key in the attempt's fence; a completion recorded
 * after a takeover released nothing, and fails.
 */
async function dispatchWithLockRenewal(
  options: RunRoundTasksOptions,
  task: TaskRecord,
  fence: LockFence | undefined,
): Promise<RoundTaskDispatchResult> {
  const locksDir = join(options.repoRoot, '.devai/state/locks');
  const targets = taskLockTargets(task);
  const initial = inspectLocks({ locksDir, taskId: task.id, targets });
  const held = new Map(initial.held.map((entry) => [entry.target, entry.identity]));
  let lost = initial.lost.length > 0;
  const renew = (): void => {
    if (lost || targets.length === 0) return;
    try {
      // Mid-dispatch, only a running task renews; the final check covers the rest.
      if (loadTask(options.repoRoot, task.id).status !== 'in_progress') return;
      const renewal = renewLocks({ locksDir, taskId: task.id, targets });
      for (const record of renewal.renewed) {
        held.set(`${record.substrate}:${record.module}`, lockIdentity(record));
      }
      lost = renewal.lost.length > 0;
    } catch {
      lost = true;
    }
  };
  const timer = setInterval(renew, options.lockRenewalIntervalMs ?? LOCK_RENEWAL_INTERVAL_MS);
  timer.unref();
  let result: RoundTaskDispatchResult;
  try {
    result = await options.dispatch(task);
  } catch (error) {
    const code =
      error instanceof Error && /^TASK_[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : 'TASK_EXECUTOR_DISPATCH_FAILED';
    result = { ok: false, code };
  } finally {
    clearInterval(timer);
  }
  if (!lost && targets.length > 0) {
    try {
      const status = loadTask(options.repoRoot, task.id).status;
      const released = LOCK_RELEASE_STATUSES.includes(status);
      lost = !locksAccountedFor(
        locksDir,
        task,
        targets,
        held,
        released && fence !== undefined ? lockFenceReleases({ locksDir, fence }) : new Set(),
      );
      if (!lost && WAITING_STATUSES.has(status)) {
        const lease = renewLocks({
          locksDir,
          taskId: task.id,
          targets,
          ttlMs: WAITING_LOCK_TTL_MS,
        });
        lost = lease.lost.length > 0;
      }
    } catch {
      lost = true;
    }
  }
  return lost ? { ok: false, code: 'TASK_RESOURCE_LOCK_LOST' } : result;
}

/**
 * Judge the attempts a stopped runner left fenced, before planning, under the round
 * controller. A transition that released the task's locks (a completion recorded
 * inside the dispatch, say) persisted before the runner could check it; it stands only
 * if every fenced key was released by the task itself or still holds its record (which
 * is then released). A key taken from it means the lock was lost: a completion is
 * withdrawn by escalation, a gap pause escalated, and a pass handed off for merge or
 * review escalated too. A task left `in_progress` stays for human disposition.
 */
function reconcileFencedAttempts(repoRoot: string, roundId: string): RoundTaskRunResult[] {
  const locksDir = join(repoRoot, '.devai/state/locks');
  // Receipts a stop left between retiring a fence and its receipts name a judged attempt.
  removeOrphanLockReceipts({ locksDir });
  const fences = listLockFences({ locksDir }).filter((fence) => fence.round_id === roundId);
  if (fences.length === 0) return [];
  const tasks = new Map(admissionPopulation(repoRoot).map((task) => [task.id, task]));
  const reconciled: RoundTaskRunResult[] = [];
  for (const fence of fences) {
    const task = tasks.get(fence.task_id);
    if (task !== undefined) {
      const released = lockFenceReleases({ locksDir, fence });
      const holding = new Set(
        inspectLocks({ locksDir, taskId: task.id, targets: fence.targets }).held.map(
          (entry) => entry.target,
        ),
      );
      const lost = fence.targets.some((target) => !released.has(target) && !holding.has(target));
      const lostCode = { task_id: task.id, ok: false, code: 'TASK_RESOURCE_LOCK_LOST' } as const;
      if (LOCK_RELEASE_STATUSES.includes(task.status)) {
        if (lost && task.status === 'completed') {
          escalateTask({ repoRoot, taskId: task.id });
        } else if (lost && task.status === 'rgr_pending') {
          escalateRoundTask({ repoRoot, round: roundId, taskId: task.id });
        }
        if (lost) reconciled.push(lostCode);
        // A transition that stopped before releasing leaves the task's own records behind.
        releaseLocks({ locksDir, taskId: task.id });
      } else if (lost && task.status !== 'in_progress' && LOCK_HOLDING_STATUSES.has(task.status)) {
        escalateRoundTask({ repoRoot, round: roundId, taskId: task.id });
        reconciled.push(lostCode);
      }
    }
    closeLockFence({ locksDir, fence });
  }
  return reconciled;
}

/** Validate the complete same-round population before any B3A dispatch. */
export async function runRoundTasks(options: RunRoundTasksOptions): Promise<RunRoundTasksResult> {
  const roundId = requireActiveTaskRound(options);
  const controller = acquireRoundController(options.repoRoot, roundId);
  try {
    return await runControlledRound(options, roundId);
  } finally {
    releaseRoundController(options.repoRoot, controller);
  }
}

function bumpedPriority(task: TaskRecord): number {
  return Math.min(100, (task.priority ?? 0) + 1);
}

/**
 * A denied task is re-queued; after repeated denials it is escalated for human
 * review (Article 25; round-execution.json resources). The denial count and the
 * priority bump the re-queue owes persist in one write before the task returns to
 * `ready`, so a crash after the re-queue never loses the bump. The bump itself waits
 * for `applyPendingPriorityBumps`, because priority is part of the bound request and
 * changing it mid-run would invalidate every later admission against the same plan.
 */
function handleLockDenial(
  options: RunRoundTasksOptions,
  roundId: string,
  taskId: string,
): RoundTaskRunResult {
  const task = loadTask(options.repoRoot, taskId);
  const denials = recordLockDenial(options.repoRoot, roundId, taskId, bumpedPriority(task));
  if (denials >= LOCK_DENIAL_ESCALATION_THRESHOLD) {
    escalateRoundTask({ repoRoot: options.repoRoot, round: roundId, taskId });
    clearLockDenials(options.repoRoot, roundId, taskId);
    return { task_id: taskId, ok: false, code: 'TASK_RESOURCE_LOCK_DENIED_REPEATED' };
  }
  saveTask(options.repoRoot, { ...task, status: 'ready' });
  return { task_id: taskId, ok: false, code: 'TASK_RESOURCE_LOCK_DENIED' };
}

/**
 * Re-queue (or escalate) the round's tasks left in `lock_denied`. A denial is counted
 * and re-queued in two writes; a crash or a failed counter write between them would
 * strand the task, because an all-ready run selects only `ready` tasks and a stranded
 * dependency refuses planning. Runs under the round controller, before the plan binds
 * requests. A denial whose count was written already owes its bump through
 * `applyPendingPriorityBumps`; one interrupted before that write is neither counted
 * nor owed, and is bumped here. An explicit selection naming a `lock_denied` task still
 * refuses with `TASK_NOT_READY`.
 */
function requeueStrandedLockDenials(repoRoot: string, roundId: string): void {
  const owed = pendingPriorityBumps(repoRoot, roundId);
  for (const task of admissionPopulation(repoRoot)) {
    if (task.round_id !== roundId || task.status !== 'lock_denied') continue;
    if (lockDenialCount(repoRoot, roundId, task.id) >= LOCK_DENIAL_ESCALATION_THRESHOLD) {
      escalateRoundTask({ repoRoot, round: roundId, taskId: task.id });
      clearLockDenials(repoRoot, roundId, task.id);
      continue;
    }
    saveTask(repoRoot, {
      ...task,
      status: 'ready',
      ...(!owed.has(task.id) && { priority: bumpedPriority(task) }),
    });
  }
}

/**
 * Apply every priority bump a re-queue owes, once no admission binds a plan: at the
 * start of a run, before planning, and at its end. Idempotent: a bump raises the
 * priority to the recorded value, never past it, so a crash between applying and
 * settling a bump never applies it twice. A task still `lock_denied` keeps its bump
 * until it is re-queued; a task no longer waiting to run settles it unapplied.
 */
function applyPendingPriorityBumps(repoRoot: string, roundId: string): void {
  const owed = pendingPriorityBumps(repoRoot, roundId);
  if (owed.size === 0) return;
  const tasks = new Map(admissionPopulation(repoRoot).map((task) => [task.id, task]));
  for (const [taskId, priority] of owed) {
    const task = tasks.get(taskId);
    if (task?.status === 'lock_denied') continue;
    if (task?.status === 'ready' && (task.priority ?? 0) < priority) {
      saveTask(repoRoot, { ...task, priority });
    }
    settlePendingPriorityBump(repoRoot, roundId, taskId);
  }
}

/** Blockers that may clear once an active task finishes; anything else is final. */
const WAITABLE_BLOCKERS = new Set([
  'TASK_WORKER_CAP',
  'TASK_RESOURCE_CONFLICT',
  'TASK_GENERATION_BARRIER',
  'TASK_DEPENDENCY_NOT_COMPLETED',
]);

/** Resolve the opt-in worker cap against the `round-execution.json` capacity ceiling. */
export function resolveRoundWorkers(requested: number | undefined): number {
  if (requested === undefined) return ROUND_DEFAULT_WORKERS;
  if (!Number.isInteger(requested) || requested < 1 || requested > ROUND_MAX_WORKERS) {
    throw new TaskServiceError('TASK_WORKER_CAP_INVALID');
  }
  return requested;
}

/**
 * Admit and dispatch the plan with at most `maxWorkers` tasks in flight. Admission
 * stays in plan order and only shares a topological generation between resource-
 * disjoint tasks; with one worker this is the serial runner, task for task.
 */
async function runControlledRound(
  options: RunRoundTasksOptions,
  roundId: string,
): Promise<RunRoundTasksResult> {
  const workers = resolveRoundWorkers(options.maxWorkers);
  assertLockDenialsValid(options.repoRoot, roundId);
  const reconciled = reconcileFencedAttempts(options.repoRoot, roundId);
  if (options.taskIds === undefined) requeueStrandedLockDenials(options.repoRoot, roundId);
  applyPendingPriorityBumps(options.repoRoot, roundId);
  const locksDir = join(options.repoRoot, '.devai/state/locks');
  const population = admissionPopulation(options.repoRoot);
  const plan = planRoundTaskAdmission({
    roundId,
    tasks: population,
    ...(options.taskIds !== undefined && { selectedTaskIds: options.taskIds }),
  });
  const ordered = plan.orderedTaskIds.map((id) => requiredTask(population, id));
  const blocked = new Set<string>();
  const results = new Map<string, RoundTaskRunResult>();
  const pending = ordered.map((task) => task.id);
  const active = new Map<string, Promise<void>>();

  const finish = (result: RoundTaskRunResult): void => {
    results.set(result.task_id, result);
    if (!result.ok) blocked.add(result.task_id);
  };

  const execute = async (running: TaskRecord): Promise<void> => {
    const targets = taskLockTargets(running);
    // Fence the attempt before dispatch and retire the fence only once it is judged
    // and any escalation persisted, so a runner that stops in between leaves evidence
    // for the next run's reconciliation.
    const fence =
      targets.length > 0
        ? openLockFence({ locksDir, taskId: running.id, roundId, targets })
        : undefined;
    const result = await dispatchWithLockRenewal(options, running, fence);
    if (!result.ok) {
      const status = loadTask(options.repoRoot, running.id).status;
      const lost = result.code === 'TASK_RESOURCE_LOCK_LOST';
      if (lost && status === 'completed') {
        // A completion recorded without exclusive resources is withdrawn for review;
        // the lifecycle forbids leaving `completed`, so this bypasses its guard.
        escalateTask({ repoRoot: options.repoRoot, taskId: running.id });
      } else if (
        status === 'in_progress' ||
        // A pass recorded without exclusive resources is never left to finish or merge.
        (lost && (LOCK_HOLDING_STATUSES.has(status) || status === 'rgr_pending'))
      ) {
        escalateRoundTask({ repoRoot: options.repoRoot, round: roundId, taskId: running.id });
      }
    }
    if (fence !== undefined) closeLockFence({ locksDir, fence });
    finish({
      task_id: running.id,
      ok: result.ok,
      ...(result.evidence_id !== undefined && { evidence_id: result.evidence_id }),
      ...(result.code !== undefined && { code: result.code }),
    });
  };

  const admit = (): void => {
    for (const taskId of [...pending]) {
      if (active.size >= workers) return;
      // Re-read both authorization and immutable requests at each admission boundary.
      requireActiveTaskRound(options);
      const liveTasks = admissionPopulation(options.repoRoot);
      const admission = decideRoundTaskAdmission(plan, {
        taskId,
        tasks: liveTasks,
        failedTaskIds: [...blocked],
        activeTaskIds: [...active.keys()],
        maxWorkers: workers,
      });
      if (!admission.admitted) {
        if (active.size > 0 && admission.blockers.every((code) => WAITABLE_BLOCKERS.has(code))) {
          continue;
        }
        pending.splice(pending.indexOf(taskId), 1);
        finish({ task_id: taskId, ok: false, code: admission.blockers[0] });
        continue;
      }
      pending.splice(pending.indexOf(taskId), 1);
      const current = requiredTask(liveTasks, taskId);
      const started = requiredTaskLocksHeld(options.repoRoot, current)
        ? {
            task: current,
            lock_denied: [],
            worktree_path: null,
            database: null,
            rollback_reason: null,
          }
        : startRoundTask({
            repoRoot: options.repoRoot,
            round: roundId,
            taskId,
          });
      if (started.lock_denied.length > 0) {
        finish(handleLockDenial(options, roundId, taskId));
        continue;
      }
      clearLockDenials(options.repoRoot, roundId, taskId);
      const running: TaskRecord = {
        ...started.task,
        status: 'in_progress',
        iteration_count: started.task.iteration_count + 1,
        spawned_at: new Date().toISOString(),
      };
      saveTask(options.repoRoot, running);
      if (
        running.max_iterations !== undefined &&
        running.iteration_count > running.max_iterations
      ) {
        escalateRoundTask({ repoRoot: options.repoRoot, round: roundId, taskId });
        finish({ task_id: taskId, ok: false, code: 'TASK_MAX_ITERATIONS_EXCEEDED' });
        continue;
      }
      active.set(
        taskId,
        execute(running).finally(() => active.delete(taskId)),
      );
    }
  };

  try {
    admit();
    while (active.size > 0) {
      await Promise.race(active.values());
      admit();
    }
  } catch (error) {
    // Never abandon in-flight dispatches: settle them before reporting the failure.
    await Promise.allSettled(active.values());
    throw error;
  }
  applyPendingPriorityBumps(options.repoRoot, roundId);
  return {
    ok: reconciled.length === 0 && ordered.every((task) => results.get(task.id)?.ok === true),
    round_id: roundId,
    ordered_task_ids: ordered.map((task) => task.id),
    results: ordered.flatMap((task) => {
      const result = results.get(task.id);
      return result === undefined ? [] : [result];
    }),
    ...(reconciled.length > 0 && { reconciled }),
  };
}
