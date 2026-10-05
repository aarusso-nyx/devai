import { join } from 'node:path';
import { decideRoundTaskAdmission, planRoundTaskAdmission } from './round-task-admission.js';
import {
  LOCK_RENEWAL_INTERVAL_MS,
  inspectLocks,
  listLocks,
  lockIdentity,
  openReleaseJournal,
  renewLocks,
  taskLockTargets,
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
  recordLockDenial,
  releaseRoundController,
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
  const held = listLocks({ locksDir: join(repoRoot, '.devai/state/locks') }).filter(
    (lock) =>
      lock.task_id === task.id && Date.now() - new Date(lock.acquired_at).getTime() < lock.ttl_ms,
  );
  return taskLockTargets(task).every((target) =>
    held.some((lock) => `${lock.substrate}:${lock.module}` === target),
  );
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
 * True when every key is accounted for: it still holds exactly the record the task last
 * held there, or, after a transition that releases locks, that exact record was
 * released by the task's own release (and so was held up to it).
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
      identity !== undefined && (current.get(target) === identity || releasedByTask.has(identity))
    );
  });
}

/**
 * Run one dispatch while renewing the task's locks, so a dispatch longer than the
 * lock TTL is never taken over. A lock found missing, held by another task, or
 * replaced by any record other than the one this task last held is a lost lock: the
 * dispatch result cannot claim exclusive resources it no longer had. The final check
 * runs whatever status the dispatch left. A transition that released the locks
 * (`round-execution.json` resources.release_on) is accepted only if the task's own
 * release removed exactly the records it held; a completion recorded after a takeover
 * released nothing, and fails.
 */
async function dispatchWithLockRenewal(
  options: RunRoundTasksOptions,
  task: TaskRecord,
): Promise<RoundTaskDispatchResult> {
  const locksDir = join(options.repoRoot, '.devai/state/locks');
  const targets = taskLockTargets(task);
  const initial = inspectLocks({ locksDir, taskId: task.id, targets });
  const held = new Map(initial.held.map((entry) => [entry.target, entry.identity]));
  let lost = initial.lost.length > 0;
  const journal = openReleaseJournal();
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
    journal.close();
  }
  if (!lost && targets.length > 0) {
    try {
      const released = LOCK_RELEASE_STATUSES.includes(loadTask(options.repoRoot, task.id).status);
      lost = !locksAccountedFor(
        locksDir,
        task,
        targets,
        held,
        released ? journal.released : new Set(),
      );
    } catch {
      lost = true;
    }
  }
  return lost ? { ok: false, code: 'TASK_RESOURCE_LOCK_LOST' } : result;
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

/**
 * A denied task is re-queued; after repeated denials it is escalated for human
 * review (Article 25; round-execution.json resources). The re-queue returns the
 * task to `ready` at once; its priority bump is applied by `bumpRequeuedPriority`
 * after the run, because priority is part of the bound request and changing it
 * mid-run would invalidate every later admission against the same plan.
 */
function handleLockDenial(
  options: RunRoundTasksOptions,
  roundId: string,
  taskId: string,
  requeued: string[],
): RoundTaskRunResult {
  const denials = recordLockDenial(options.repoRoot, roundId, taskId);
  if (denials >= LOCK_DENIAL_ESCALATION_THRESHOLD) {
    escalateRoundTask({ repoRoot: options.repoRoot, round: roundId, taskId });
    clearLockDenials(options.repoRoot, roundId, taskId);
    return { task_id: taskId, ok: false, code: 'TASK_RESOURCE_LOCK_DENIED_REPEATED' };
  }
  saveTask(options.repoRoot, { ...loadTask(options.repoRoot, taskId), status: 'ready' });
  requeued.push(taskId);
  return { task_id: taskId, ok: false, code: 'TASK_RESOURCE_LOCK_DENIED' };
}

/**
 * Re-queue (or escalate) the round's tasks left in `lock_denied`. A denial is counted
 * and re-queued in two writes; a crash or a failed counter write between them would
 * strand the task, because an all-ready run selects only `ready` tasks and a stranded
 * dependency refuses planning. Runs under the round controller, before the plan binds
 * requests, so the re-queue carries its priority bump at once. The interrupted denial
 * is not counted again: it was counted unless the counter write itself failed. An
 * explicit selection naming a `lock_denied` task still refuses with `TASK_NOT_READY`.
 */
function requeueStrandedLockDenials(repoRoot: string, roundId: string): void {
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
      priority: Math.min(100, (task.priority ?? 0) + 1),
    });
  }
}

/** Raise each re-queued task's priority by one once no admission still binds this plan. */
function bumpRequeuedPriority(repoRoot: string, requeued: readonly string[]): void {
  for (const taskId of requeued) {
    const task = loadTask(repoRoot, taskId);
    if (task.status !== 'ready') continue;
    saveTask(repoRoot, { ...task, priority: Math.min(100, (task.priority ?? 0) + 1) });
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
  if (options.taskIds === undefined) requeueStrandedLockDenials(options.repoRoot, roundId);
  const population = admissionPopulation(options.repoRoot);
  const plan = planRoundTaskAdmission({
    roundId,
    tasks: population,
    ...(options.taskIds !== undefined && { selectedTaskIds: options.taskIds }),
  });
  const ordered = plan.orderedTaskIds.map((id) => requiredTask(population, id));
  const blocked = new Set<string>();
  const requeued: string[] = [];
  const results = new Map<string, RoundTaskRunResult>();
  const pending = ordered.map((task) => task.id);
  const active = new Map<string, Promise<void>>();

  const finish = (result: RoundTaskRunResult): void => {
    results.set(result.task_id, result);
    if (!result.ok) blocked.add(result.task_id);
  };

  const execute = async (running: TaskRecord): Promise<void> => {
    const result = await dispatchWithLockRenewal(options, running);
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
        finish(handleLockDenial(options, roundId, taskId, requeued));
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
  bumpRequeuedPriority(options.repoRoot, requeued);
  return {
    ok: ordered.every((task) => results.get(task.id)?.ok === true),
    round_id: roundId,
    ordered_task_ids: ordered.map((task) => task.id),
    results: ordered.flatMap((task) => {
      const result = results.get(task.id);
      return result === undefined ? [] : [result];
    }),
  };
}
