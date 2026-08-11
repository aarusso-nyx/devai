import { existsSync, readFileSync } from '@devai-nyx/authority';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { join, resolve } from 'node:path';
import { clusterStatus } from './db.js';
import { completeHumanTask, type HumanExecutorRole } from './human-executor.js';
import { listLocks } from './locks.js';
import {
  appendBacklog,
  pickNextTask,
  readBacklog,
  updateBacklogStatus,
  type BacklogEntry,
} from './backlog.js';
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
import { listWorktrees } from './worktrees.js';
import { normalizeRoundId } from '../round-lifecycle/index.js';

export class TaskServiceError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: number = 2,
  ) {
    super(code);
    this.name = 'TaskServiceError';
  }
}

function fail(code: string, exitCode = 2): never {
  throw new TaskServiceError(code, exitCode);
}

function requestedRound(round: string | undefined): string {
  if (round === undefined || round.trim().length === 0) {
    fail('TASK_ROUND_REQUIRED', EXIT_USAGE);
  }
  return normalizeRoundId(round);
}

function authorizationIsActive(repoRoot: string, roundId: string): boolean {
  const roundDir = join(repoRoot, 'work/rounds', roundId);
  if (!existsSync(roundDir) || existsSync(join(roundDir, 'close-state.jsonl'))) return false;
  const authorization = join(roundDir, 'AUTHORIZATION.md');
  if (!existsSync(authorization)) return false;
  const source = readFileSync(authorization, 'utf8');
  return /status:\s*active\b/u.test(source) && /\bGRANTED\b/u.test(source);
}

/** Resolve one explicitly requested active round before any task resource is acquired. */
export function requireActiveTaskRound(options: {
  readonly repoRoot: string;
  readonly round?: string;
}): string {
  const roundId = requestedRound(options.round);
  const repoRoot = resolve(options.repoRoot);
  if (!authorizationIsActive(repoRoot, roundId)) fail('TASK_ROUND_INACTIVE');
  return roundId;
}

function roundBoundTask(options: {
  readonly repoRoot: string;
  readonly round?: string;
  readonly taskId: string;
  readonly operation: string;
}): Readonly<{ roundId: string; task: TaskRecord }> {
  const roundId = requireActiveTaskRound(options);
  const task = loadTask(options.repoRoot, options.taskId);
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

export interface AddRoundQueueEntryOptions {
  readonly repoRoot: string;
  readonly round?: string;
  readonly title: string;
  readonly priority?: number;
  readonly description?: string;
  readonly discipline?: BacklogEntry['discipline'];
  readonly targetModules?: readonly string[];
  readonly targetSubstrates?: BacklogEntry['target_substrates'];
}

export function addRoundQueueEntry(options: AddRoundQueueEntryOptions): BacklogEntry {
  const roundId = requireActiveTaskRound(options);
  if (options.title.trim().length === 0) fail('TASK_QUEUE_TITLE_REQUIRED', EXIT_USAGE);
  return appendBacklog(options.repoRoot, {
    round_id: roundId,
    title: options.title,
    priority: options.priority ?? 50,
    ...(options.description !== undefined && { description: options.description }),
    ...(options.discipline !== undefined && { discipline: options.discipline }),
    ...(options.targetModules !== undefined && { target_modules: options.targetModules }),
    ...(options.targetSubstrates !== undefined && {
      target_substrates: options.targetSubstrates,
    }),
  });
}

export function listRoundQueue(options: {
  readonly repoRoot: string;
  readonly round?: string;
}): readonly BacklogEntry[] {
  const roundId = requireActiveTaskRound(options);
  return readBacklog(options.repoRoot).filter((entry) => entry.round_id === roundId);
}

export function nextRoundQueueEntry(options: {
  readonly repoRoot: string;
  readonly round?: string;
}): BacklogEntry | null {
  const roundId = requireActiveTaskRound(options);
  const next = pickNextTask(options.repoRoot);
  if (next?.round_id === roundId) return next;
  return listRoundQueue(options).find((entry) => entry.status === 'queued') ?? null;
}

export function completeRoundQueueEntry(options: {
  readonly repoRoot: string;
  readonly round?: string;
  readonly taskId: string;
}): BacklogEntry {
  const roundId = requireActiveTaskRound(options);
  const current = readBacklog(options.repoRoot).find((entry) => entry.id === options.taskId);
  if (current === undefined) fail('TASK_QUEUE_ENTRY_NOT_FOUND');
  if (current.round_id !== roundId) fail('TASK_ROUND_MISMATCH');
  const updated = updateBacklogStatus(options.repoRoot, options.taskId, 'completed');
  if (updated === null) fail('TASK_QUEUE_ENTRY_NOT_FOUND');
  return updated;
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
  } else if (task.status !== 'merging') {
    fail('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');
  }
  return completeTask(transitionOptions({ ...options, operation: 'finish' }));
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
  return escalateTask(transitionOptions({ ...options, operation: 'escalate' }));
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
  return pauseTaskForRgr({
    repoRoot: options.repoRoot,
    taskId: options.taskId,
    rgrId: options.gapId,
  });
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
  const updated = resumeTaskFromRgr({ repoRoot: options.repoRoot, rgrId: options.gapId });
  if (updated.id !== options.taskId) fail('TASK_ID_MISMATCH');
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
