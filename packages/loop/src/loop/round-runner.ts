import { join } from 'node:path';
import { decideRoundTaskAdmission, planRoundTaskAdmission } from './round-task-admission.js';
import { LOCK_RENEWAL_INTERVAL_MS, listLocks, renewLocks, taskLockTargets } from './locks.js';
import { listTaskRecords, loadTask, saveTask, type TaskRecord } from './tasks.js';
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

/**
 * Run one dispatch while renewing the task's locks, so a dispatch longer than the
 * lock TTL is never taken over. A lock found missing or held by another task is a
 * lost lock: the dispatch result cannot claim exclusive resources it no longer had.
 */
async function dispatchWithLockRenewal(
  options: RunRoundTasksOptions,
  task: TaskRecord,
): Promise<RoundTaskDispatchResult> {
  const locksDir = join(options.repoRoot, '.devai/state/locks');
  const targets = taskLockTargets(task);
  let lost = false;
  const renew = (): void => {
    if (lost || targets.length === 0) return;
    try {
      // A dispatch that completed or escalated the task released its locks legitimately.
      if (loadTask(options.repoRoot, task.id).status !== 'in_progress') return;
      lost = renewLocks({ locksDir, taskId: task.id, targets }).lost.length > 0;
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
  renew();
  return lost ? { ok: false, code: 'TASK_RESOURCE_LOCK_LOST' } : result;
}

/** Validate the complete same-round population before any B3A dispatch. */
export async function runRoundTasks(options: RunRoundTasksOptions): Promise<RunRoundTasksResult> {
  const roundId = requireActiveTaskRound(options);
  const population = admissionPopulation(options.repoRoot);
  const plan = planRoundTaskAdmission({
    roundId,
    tasks: population,
    ...(options.taskIds !== undefined && { selectedTaskIds: options.taskIds }),
  });
  const ordered = plan.orderedTaskIds.map((id) => requiredTask(population, id));
  const blocked = new Set<string>();
  const results: RoundTaskRunResult[] = [];
  for (const task of ordered) {
    // Re-read both authorization and immutable requests at each admission boundary.
    requireActiveTaskRound(options);
    const liveTasks = admissionPopulation(options.repoRoot);
    const admission = decideRoundTaskAdmission(plan, {
      taskId: task.id,
      tasks: liveTasks,
      failedTaskIds: [...blocked],
    });
    if (!admission.admitted) {
      blocked.add(task.id);
      results.push({ task_id: task.id, ok: false, code: admission.blockers[0] });
      continue;
    }
    const current = requiredTask(liveTasks, task.id);
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
          taskId: task.id,
        });
    if (started.lock_denied.length > 0) {
      blocked.add(task.id);
      results.push({ task_id: task.id, ok: false, code: 'TASK_RESOURCE_LOCK_DENIED' });
      continue;
    }
    const running: TaskRecord = {
      ...started.task,
      status: 'in_progress',
      iteration_count: started.task.iteration_count + 1,
      spawned_at: new Date().toISOString(),
    };
    saveTask(options.repoRoot, running);
    if (running.max_iterations !== undefined && running.iteration_count > running.max_iterations) {
      escalateRoundTask({ repoRoot: options.repoRoot, round: roundId, taskId: task.id });
      blocked.add(task.id);
      results.push({ task_id: task.id, ok: false, code: 'TASK_MAX_ITERATIONS_EXCEEDED' });
      continue;
    }
    const result = await dispatchWithLockRenewal(options, running);
    if (!result.ok && loadTask(options.repoRoot, task.id).status === 'in_progress') {
      escalateRoundTask({ repoRoot: options.repoRoot, round: roundId, taskId: task.id });
    }
    results.push({
      task_id: task.id,
      ok: result.ok,
      ...(result.evidence_id !== undefined && { evidence_id: result.evidence_id }),
      ...(result.code !== undefined && { code: result.code }),
    });
    if (!result.ok) blocked.add(task.id);
  }
  return {
    ok: results.every((result) => result.ok),
    round_id: roundId,
    ordered_task_ids: ordered.map((task) => task.id),
    results,
  };
}
