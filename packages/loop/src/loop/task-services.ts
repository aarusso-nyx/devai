import { existsSync, readFileSync, renameSync } from '@devai-nyx/authority';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { clusterStatus } from './db.js';
import { escalateAgentTask, taskDispatchBlockers } from './dispatch-disposition.js';
import { fsyncDirectorySync, writeCreateOnlyDurableSync } from './durable-files.js';
import { acquireRoundController, releaseRoundController } from './round-controller.js';
import { completeHumanTask, type HumanExecutorRole } from './human-executor.js';
import { assertLockOwnership, listLocks, taskLockTargets } from './locks.js';
import { ratificationPath, type RatificationRecord } from './ratification.js';

import {
  completeTask,
  escalateTask,
  getPausedRgrId,
  listTasks,
  loadTask,
  pauseTaskForRgr,
  resumeTaskFromRgr,
  saveTask,
  spawnTask,
  validateTaskRound,
  type SpawnResult,
  type TaskRecord,
  type TransitionOptions,
} from './tasks.js';
import { listWorktrees, releaseTaskWorktrees } from './worktrees.js';

import { trackGovernanceEvent } from '../tracking/hook.js';
import type { GovernanceEventStatus } from '../tracking/events.js';
import { requireActiveTaskRound, fail, TaskServiceError } from './task-queue-services.js';
export {
  addRoundQueueEntry,
  materializeRoundQueueTask,
  listRoundQueue,
  nextRoundQueueEntry,
  completeRoundQueueEntry,
  type AddRoundQueueEntryOptions,
  requireActiveTaskRound,
  type MaterializeRoundQueueTaskOptions,
  type MaterializedRoundQueueTask,
  TaskServiceError,
} from './task-queue-services.js';

/**
 * Record one task-lifecycle transition as a governance event.
 *
 * Inert unless the task's round has an Owner activation, and never able to
 * fail a transition: the transition is the governed act, this is only its
 * observation.
 */
function trackTaskTransition(
  repoRoot: string,
  task: TaskRecord,
  kind: 'action_intended' | 'action_completed' | 'failure_observed',
  summary: string,
  extra: Readonly<{ status?: GovernanceEventStatus; checkpoint?: boolean }> = {},
): void {
  trackGovernanceEvent({
    repoRoot,
    round: task.round_id,
    role: 'engineer',
    kind,
    taskId: task.id,
    summary,
    payload: { task_id: task.id, status: task.status, executor: task.executor.kind },
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(extra.checkpoint === true ? { checkpoint: true } : {}),
  });
}

function roundBoundTask(options: {
  readonly repoRoot: string;
  readonly round?: string;
  readonly taskId: string;
  readonly operation: string;
}): Readonly<{ roundId: string; task: TaskRecord }> {
  const roundId = requireActiveTaskRound(options);
  let task: TaskRecord;
  try {
    task = loadTask(options.repoRoot, options.taskId);
  } catch (error) {
    const code =
      error instanceof Error && error.message.startsWith('task ')
        ? 'TASK_NOT_FOUND'
        : error instanceof Error && error.message !== ''
          ? error.message
          : 'TASK_NOT_FOUND';
    fail(code);
  }
  const validation = validateTaskRound({
    operation: options.operation,
    requested_round_id: roundId,
    task_round_id: task.round_id,
    active_round_ids: [roundId],
  });
  if (!validation.ok)
    fail(validation.code, validation.code === 'TASK_ROUND_REQUIRED' ? EXIT_USAGE : 2);
  return { roundId, task };
}

export function startRoundTask(options: {
  readonly repoRoot: string;
  readonly round?: string;
  readonly taskId: string;
  readonly withWorktree?: boolean;
  readonly withDb?: boolean;
  readonly databaseUrl?: string;
  readonly baseRef?: string;
}): SpawnResult {
  const { task } = roundBoundTask({ ...options, operation: 'start' });
  if (task.status !== 'queued' && task.status !== 'ready' && task.status !== 'lock_denied') {
    fail('TASK_START_STATUS_INVALID');
  }
  if (task.status !== 'ready') {
    saveTask(options.repoRoot, { ...task, status: 'ready' });
  }
  const { schemaVersion: _schemaVersion, status: _status, ...request } = task;
  void _schemaVersion;
  void _status;
  trackTaskTransition(options.repoRoot, task, 'action_intended', `Task ${task.id} started.`);
  return spawnTask({
    repoRoot: options.repoRoot,
    task: request,
    ...(options.withWorktree === true && { withWorktree: true }),
    ...(options.withDb === true && { withDb: true }),
    ...(options.databaseUrl !== undefined && { databaseUrl: options.databaseUrl }),
    ...(options.baseRef !== undefined && { baseRef: options.baseRef }),
  });
}

function transitionOptions(
  options: TransitionOptions & { readonly round?: string; readonly operation: string },
): TransitionOptions {
  roundBoundTask(options);
  return {
    repoRoot: options.repoRoot,
    taskId: options.taskId,
    ...(options.databaseUrl !== undefined && { databaseUrl: options.databaseUrl }),
    ...(options.destroyWorktree === true && { destroyWorktree: true }),
  };
}

/** The record binding an agent task's completion to its ratification and merge evidence. */
export interface AgentCompletionRecord {
  readonly schemaVersion: '1.0.0';
  readonly round_id: string;
  readonly task_id: string;
  readonly completed_at: string;
  readonly ratification: { readonly path: string; readonly sha256: string };
  readonly merge_evidence_refs: readonly string[];
  readonly released_worktrees: readonly string[];
}

function agentCompletionPath(repoRoot: string, roundId: string, taskId: string): string {
  return join(repoRoot, '.devai/state/round-runs', roundId, 'completions', `${taskId}.json`);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The completion record already written for the task, if any. A file that is not a
 * complete record for this task (left by an interrupted write) is moved aside under its
 * SHA-256 and treated as absent; its bytes stay for inspection.
 */
function priorCompletion(path: string, task: TaskRecord): AgentCompletionRecord | undefined {
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  try {
    const value = JSON.parse(bytes.toString('utf8')) as Partial<AgentCompletionRecord>;
    if (
      value.schemaVersion === '1.0.0' &&
      value.round_id === task.round_id &&
      value.task_id === task.id &&
      typeof value.completed_at === 'string' &&
      typeof value.ratification?.sha256 === 'string' &&
      Array.isArray(value.merge_evidence_refs) &&
      Array.isArray(value.released_worktrees)
    ) {
      return value as AgentCompletionRecord;
    }
  } catch {
    // Fall through to move it aside.
  }
  renameSync(path, `${path}.torn-${sha256(bytes)}`);
  fsyncDirectorySync(dirname(path));
  return undefined;
}

/**
 * The registered completion path of an agent task (ADR-MDL-0007): `round ratify
 * --decision accept` moved it to pre_merge, a human integrated the attempt's changes
 * (merge stays a separate human act, ADR-GOV-0025), and `task finish` now records the
 * completion with the accepted ratification and the merge evidence. It refuses without
 * an accepted ratification, without merge evidence, or while the task has uncertain
 * dispatch work. The completion record, naming the worktrees it releases, is written
 * atomically and durably first; only then are the worktrees released and the task moved
 * through merging, so a retry after any interruption reuses the identical record and
 * refuses a differing one. The caller then completes the task.
 */
function recordAgentCompletion(
  repoRoot: string,
  task: TaskRecord,
  evidence: readonly string[],
): void {
  const ratification = ratificationPath(repoRoot, task.round_id, task.id);
  if (!existsSync(ratification)) fail('TASK_RATIFICATION_REQUIRED');
  const bytes = readFileSync(ratification);
  let decision: unknown;
  let ratifiedAt: unknown;
  try {
    const record = JSON.parse(bytes.toString('utf8')) as Partial<RatificationRecord>;
    if (record.task_id !== task.id || record.round_id !== task.round_id) {
      fail('TASK_RATIFICATION_REQUIRED');
    }
    decision = record.decision;
    ratifiedAt = record.ratified_at;
  } catch {
    fail('TASK_RATIFICATION_REQUIRED');
  }
  if (decision !== 'accept' || typeof ratifiedAt !== 'string') fail('TASK_RATIFICATION_REQUIRED');
  const refs = [...new Set(evidence)];
  if (
    refs.length === 0 ||
    refs.length !== evidence.length ||
    refs.some((ref) => !/^EV-/u.test(ref))
  ) {
    fail('TASK_MERGE_EVIDENCE_REQUIRED');
  }
  if (taskDispatchBlockers(repoRoot, task.round_id, task.id).length > 0) {
    fail('TASK_DISPATCH_UNCERTAIN');
  }
  const ratificationSha256 = sha256(bytes);
  const path = agentCompletionPath(repoRoot, task.round_id, task.id);
  let completion = priorCompletion(path, task);
  if (completion === undefined) {
    completion = {
      schemaVersion: '1.0.0',
      round_id: task.round_id,
      task_id: task.id,
      completed_at: new Date().toISOString(),
      ratification: {
        path: `.devai/state/round-runs/${task.round_id}/ratifications/${task.id}.json`,
        sha256: ratificationSha256,
      },
      merge_evidence_refs: refs,
      released_worktrees: listWorktrees({ repoRoot })
        .filter((worktree) => worktree.task_id === task.id && worktree.human_adopted !== true)
        .map((worktree) => worktree.id)
        .sort(),
    };
    writeCreateOnlyDurableSync(path, `${JSON.stringify(completion, null, 2)}\n`);
  } else if (
    completion.ratification.sha256 !== ratificationSha256 ||
    JSON.stringify(completion.merge_evidence_refs) !== JSON.stringify(refs)
  ) {
    fail('TASK_COMPLETION_CONFLICT');
  }
  releaseTaskWorktrees({ repoRoot, taskId: task.id });
  const { worktree_id: _worktree, ...rest } = task;
  void _worktree;
  saveTask(repoRoot, {
    ...rest,
    status: 'merging',
    iteration_trail: [
      ...(task.iteration_trail ?? []),
      {
        iteration: Math.max(1, task.iteration_count),
        started_at: ratifiedAt,
        ended_at: completion.completed_at,
        verdict: 'PASS',
        evidence_refs: refs,
      },
    ],
  });
}

export function finishRoundTask(
  options: TransitionOptions & {
    readonly round?: string;
    readonly evidence?: readonly string[];
    readonly completedByRole?: HumanExecutorRole;
  },
): TaskRecord {
  const { task } = roundBoundTask({ ...options, operation: 'finish' });
  // A task waits outside any dispatch before it finishes, so its locks may have lapsed and
  // been taken over meanwhile. Secure them before any transition: refuse after a takeover
  // with nothing written, and renew a lapsing or expired own record by an exact-record swap
  // so no takeover can land during the finish. `completeTask` proves ownership again.
  assertLockOwnership({
    locksDir: join(options.repoRoot, '.devai/state/locks'),
    taskId: task.id,
    targets: taskLockTargets(task),
  });
  if (task.executor.kind === 'human') {
    if (task.status !== 'awaiting_human_review') {
      fail('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');
    }
    const completion = completeHumanTask({
      task_id: task.id,
      round_id: task.round_id,
      executor: task.executor,
      evidence: options.evidence ?? [],
      task,
      ...(options.completedByRole !== undefined && {
        completed_by_role: options.completedByRole,
      }),
    });
    if (!completion.ok) fail(completion.code);
    const now = new Date().toISOString();
    const resumed: TaskRecord = { ...task, status: 'in_progress' };
    saveTask(options.repoRoot, resumed);
    saveTask(options.repoRoot, {
      ...resumed,
      status: 'pre_merge',
      iteration_trail: [
        ...(resumed.iteration_trail ?? []),
        {
          iteration: resumed.iteration_count,
          started_at: resumed.spawned_at ?? now,
          ended_at: now,
          verdict: 'PASS',
          evidence_refs: completion.evidence,
        },
      ],
    });
    saveTask(options.repoRoot, { ...loadTask(options.repoRoot, task.id), status: 'merging' });
    try {
      return reportCompletion(
        options.repoRoot,
        completeTask(transitionOptions({ ...options, operation: 'finish' })),
      );
    } catch (error) {
      // A human task cannot finish again from `merging`: a completion refused for a lost
      // lock escalates it, as the runner does with a pass recorded without its locks,
      // releasing only the records it still holds.
      if (error instanceof TaskServiceError && error.code === 'TASK_RESOURCE_LOCK_LOST') {
        escalateTask({ repoRoot: options.repoRoot, taskId: task.id });
      }
      throw error;
    }
  } else if (task.executor.kind === 'agent') {
    // Agent completion runs under the round controller, which `task escalate` also takes:
    // the load, the completion record, the worktree release and both transitions see the
    // current record, never a snapshot an escalation replaced (refuses with
    // TASK_ROUND_CONTROLLER_BUSY while another holder owns the round).
    const controller = acquireRoundController(options.repoRoot, task.round_id);
    try {
      const current = loadTask(options.repoRoot, task.id);
      if (current.status === 'pre_merge') {
        recordAgentCompletion(options.repoRoot, current, options.evidence ?? []);
      } else if (current.status !== 'merging') {
        fail('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');
      }
      return reportCompletion(
        options.repoRoot,
        completeTask(transitionOptions({ ...options, operation: 'finish' })),
      );
    } finally {
      releaseRoundController(options.repoRoot, controller);
    }
  } else if (task.status !== 'merging') {
    fail('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');
  }
  return reportCompletion(
    options.repoRoot,
    completeTask(transitionOptions({ ...options, operation: 'finish' })),
  );
}

function reportCompletion(repoRoot: string, completed: TaskRecord): TaskRecord {
  trackTaskTransition(repoRoot, completed, 'action_completed', `Task ${completed.id} completed.`, {
    status: 'pass',
    checkpoint: true,
  });
  return completed;
}

const ESCALATABLE: ReadonlySet<TaskRecord['status']> = new Set([
  'lock_denied',
  'in_progress',
  'checkpoint',
  'awaiting_human_review',
  'pre_merge',
  'merging',
  'experimental_blocked',
  'rgr_pending',
]);

export function escalateRoundTask(
  options: TransitionOptions & {
    readonly round?: string;
    /**
     * Take the round controller to escalate an agent task, refusing with
     * `TASK_ROUND_CONTROLLER_BUSY` while a dispatch owns the round, so an escalation never
     * settles the attempt or removes the worktree of a provider still running. The CLI
     * sets it; the round runner, which already holds the controller, does not.
     */
    readonly acquireRoundController?: boolean;
  },
): TaskRecord {
  const { task } = roundBoundTask({ ...options, operation: 'escalate' });
  if (!ESCALATABLE.has(task.status)) fail('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');
  const transition = transitionOptions({ ...options, operation: 'escalate' });
  let escalated: TaskRecord;
  if (task.executor.kind === 'agent') {
    // An agent task's escalation is a recorded disposition of its uncertain work, and it
    // releases the attempt worktrees (ADR-MDL-0007); other executors are unchanged.
    const escalate = (): TaskRecord => {
      // Re-read under the controller: the snapshot above may predate a dispatch's write.
      const current = loadTask(options.repoRoot, task.id);
      if (!ESCALATABLE.has(current.status)) fail('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');
      return escalateAgentTask({
        repoRoot: options.repoRoot,
        roundId: task.round_id,
        task: current,
        transition: {
          ...(transition.databaseUrl !== undefined && { databaseUrl: transition.databaseUrl }),
          ...(transition.destroyWorktree === true && { destroyWorktree: true }),
        },
      });
    };
    if (options.acquireRoundController === true) {
      const controller = acquireRoundController(options.repoRoot, task.round_id);
      try {
        escalated = escalate();
      } finally {
        releaseRoundController(options.repoRoot, controller);
      }
    } else {
      escalated = escalate();
    }
  } else {
    escalated = escalateTask(transition);
  }
  trackTaskTransition(
    options.repoRoot,
    escalated,
    'failure_observed',
    `Task ${escalated.id} escalated after convergence failure.`,
    { status: 'fail', checkpoint: true },
  );
  return escalated;
}

export function pauseRoundTask(options: {
  readonly repoRoot: string;
  readonly round?: string;
  readonly taskId: string;
  readonly gapId: string;
}): TaskRecord {
  const { task } = roundBoundTask({ ...options, operation: 'pause' });
  if (task.status !== 'in_progress' && task.status !== 'checkpoint') {
    fail('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');
  }
  const paused = pauseTaskForRgr({
    repoRoot: options.repoRoot,
    taskId: options.taskId,
    rgrId: options.gapId,
  });
  trackTaskTransition(
    options.repoRoot,
    paused,
    'failure_observed',
    `Task ${paused.id} paused pending reference gap ${options.gapId}.`,
    { status: 'review' },
  );
  return paused;
}

export function resumeRoundTask(options: {
  readonly repoRoot: string;
  readonly round?: string;
  readonly taskId: string;
  readonly gapId: string;
}): TaskRecord {
  const { task } = roundBoundTask({ ...options, operation: 'resume' });
  if (task.status !== 'rgr_pending') fail('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');
  if (getPausedRgrId(task) !== options.gapId) fail('TASK_GAP_MISMATCH');
  const updated = resumeTaskFromRgr({
    repoRoot: options.repoRoot,
    rgrId: options.gapId,
    taskId: options.taskId,
  });
  if (updated.id !== options.taskId) fail('TASK_ID_MISMATCH');
  trackTaskTransition(
    options.repoRoot,
    updated,
    'action_intended',
    `Task ${updated.id} resumed after reference gap ${options.gapId} was resolved.`,
  );
  return updated;
}

export function roundTaskStatus(options: {
  readonly repoRoot: string;
  readonly round?: string;
  readonly taskId?: string;
}): Readonly<{ round_id: string; count: number; tasks: readonly TaskRecord[] }> {
  const roundId = requireActiveTaskRound(options);
  const tasks = listTasks(options.repoRoot).filter(
    (task) =>
      task.round_id === roundId && (options.taskId === undefined || task.id === options.taskId),
  );
  if (options.taskId !== undefined && tasks.length === 0) fail('TASK_NOT_FOUND');
  return { round_id: roundId, count: tasks.length, tasks };
}

export function roundTaskResourceStatus(options: {
  readonly repoRoot: string;
  readonly round?: string;
  readonly taskId?: string;
  readonly resource: 'db' | 'locks' | 'worktrees';
  readonly containerName?: string;
  readonly databaseUrl?: string;
}): unknown {
  // Resolve the active round and complete task population before touching any resource registry.
  const status = roundTaskStatus(options);
  const taskIds = new Set(status.tasks.map((task) => task.id));
  if (options.resource === 'locks') {
    const locks = listLocks({ locksDir: join(options.repoRoot, '.devai/state/locks') }).filter(
      (lock) => taskIds.has(lock.task_id),
    );
    return { round_id: status.round_id, resource: 'locks', count: locks.length, locks };
  }
  if (options.resource === 'worktrees') {
    const worktrees = listWorktrees({ repoRoot: options.repoRoot }).filter(
      (worktree) => worktree.task_id !== undefined && taskIds.has(worktree.task_id),
    );
    return {
      round_id: status.round_id,
      resource: 'worktrees',
      count: worktrees.length,
      worktrees,
    };
  }
  const db = clusterStatus({
    ...(options.containerName !== undefined && { containerName: options.containerName }),
    ...(options.databaseUrl !== undefined && { databaseUrl: options.databaseUrl }),
  });
  const taskDbs = db.task_dbs.filter((name) =>
    [...taskIds].some((taskId) => name === `devai_task_${taskId}`),
  );
  return { ...db, round_id: status.round_id, resource: 'db', task_dbs: taskDbs };
}
