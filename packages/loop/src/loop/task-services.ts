import { existsSync, readFileSync } from '@devai-nyx/authority';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { clusterStatus } from './db.js';
import { recordAgentEscalation } from './dispatch-disposition.js';
import { dispatchJournalPath, openDispatchAttempts } from './dispatch-journal.js';
import { writeCreateOnlyDurableSync } from './durable-files.js';
import { completeHumanTask, type HumanExecutorRole } from './human-executor.js';
import { listLocks } from './locks.js';
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
import { requireActiveTaskRound, fail } from './task-queue-services.js';
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

/**
 * The registered completion path of an agent task (ADR-MDL-0007): `round ratify
 * --decision accept` moved it to pre_merge, a human integrated the attempt's changes
 * (merge stays a separate human act, ADR-GOV-0025), and `task finish` now records the
 * completion with the accepted ratification and the merge evidence. It refuses without
 * an accepted ratification, without merge evidence, or while the journal still holds an
 * open attempt for the task. The attempt worktree is released and the task passes
 * through merging; the caller then completes it.
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
  if (
    existsSync(dispatchJournalPath(repoRoot, task.round_id)) &&
    openDispatchAttempts(repoRoot, task.round_id, task.id).length > 0
  ) {
    fail('TASK_DISPATCH_UNCERTAIN');
  }
  const now = new Date().toISOString();
  const released = releaseTaskWorktrees({ repoRoot, taskId: task.id });
  const completion: AgentCompletionRecord = {
    schemaVersion: '1.0.0',
    round_id: task.round_id,
    task_id: task.id,
    completed_at: now,
    ratification: {
      path: `.devai/state/round-runs/${task.round_id}/ratifications/${task.id}.json`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    merge_evidence_refs: refs,
    released_worktrees: released,
  };
  const completionPath = agentCompletionPath(repoRoot, task.round_id, task.id);
  // A crash after the record and before the transition leaves the record to be reused.
  if (!existsSync(completionPath)) {
    writeCreateOnlyDurableSync(completionPath, `${JSON.stringify(completion, null, 2)}\n`);
  }
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
        ended_at: now,
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
  } else if (task.executor.kind === 'agent' && task.status === 'pre_merge') {
    recordAgentCompletion(options.repoRoot, task, options.evidence ?? []);
  } else if (task.status !== 'merging') {
    fail('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');
  }
  const completed = completeTask(transitionOptions({ ...options, operation: 'finish' }));
  trackTaskTransition(
    options.repoRoot,
    completed,
    'action_completed',
    `Task ${completed.id} completed.`,
    { status: 'pass', checkpoint: true },
  );
  return completed;
}

export function escalateRoundTask(
  options: TransitionOptions & { readonly round?: string },
): TaskRecord {
  const { task } = roundBoundTask({ ...options, operation: 'escalate' });
  if (
    ![
      'lock_denied',
      'in_progress',
      'checkpoint',
      'awaiting_human_review',
      'pre_merge',
      'merging',
      'experimental_blocked',
      'rgr_pending',
    ].includes(task.status)
  ) {
    fail('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');
  }
  // An agent task's escalation is a recorded disposition of any open journal attempt, and
  // it releases the attempt worktrees (ADR-MDL-0007); other executors are unchanged.
  recordAgentEscalation({ repoRoot: options.repoRoot, roundId: task.round_id, task });
  const escalated = escalateTask(transitionOptions({ ...options, operation: 'escalate' }));
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
