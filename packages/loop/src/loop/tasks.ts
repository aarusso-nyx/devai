import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { parsers } from '@devai-nyx/schemas';
import { join } from 'node:path';
import { provisionTask, dropTask } from './db.js';
import { acquireLocks, releaseLocks } from './locks.js';
import { createWorktree, destroyWorktree } from './worktrees.js';
import {
  classifyTaskRecord,
  type TaskRecord,
  type TaskRecordClassification,
  type TaskStatus,
} from './task-contract.js';

export * from './task-contract.js';

const RGR_PAUSE_TAG_PREFIX = 'rgr_pause:';

export function getPausedRgrId(task: Pick<TaskRecord, 'tags'>): string | null {
  for (const t of task.tags ?? []) {
    if (t.startsWith(RGR_PAUSE_TAG_PREFIX)) return t.slice(RGR_PAUSE_TAG_PREFIX.length);
  }
  return null;
}

function setPausedRgrId(task: TaskRecord, rgrId: string): TaskRecord {
  const tags = [...(task.tags ?? []).filter((t) => !t.startsWith(RGR_PAUSE_TAG_PREFIX))];
  tags.push(`${RGR_PAUSE_TAG_PREFIX}${rgrId}`);
  return { ...task, tags };
}

function clearPausedRgrId(task: TaskRecord): TaskRecord {
  const tags = (task.tags ?? []).filter((t) => !t.startsWith(RGR_PAUSE_TAG_PREFIX));
  if (tags.length === 0) {
    const { tags: _drop, ...rest } = task;
    void _drop;
    return rest;
  }
  return { ...task, tags };
}

export type SpawnTaskInput = Omit<
  TaskRecord,
  'schemaVersion' | 'status' | 'created_at' | 'iteration_count' | 'round_id' | 'executor'
> & {
  /** Untrusted callers may omit this field; spawnTask refuses them at runtime. */
  readonly round_id?: unknown;
  /** Untrusted callers may omit this field; spawnTask refuses them at runtime. */
  readonly executor?: unknown;
  /** Preserve an already queued task's immutable creation time when starting it. */
  readonly created_at?: string;
  /** Preserve retry state when a queued task re-enters resource acquisition. */
  readonly iteration_count?: number;
  readonly status?: TaskStatus;
};

type ValidatedSpawnTaskInput = SpawnTaskInput & {
  readonly round_id: string;
  readonly executor: TaskRecord['executor'];
};

export interface SpawnTaskOptions {
  readonly repoRoot: string;
  readonly task: SpawnTaskInput;
  /**
   * If true, create a git worktree for the task after locks acquire.
   * The worktree id is `WT-<task-id>` and the branch defaults to the
   * task id (e.g. `TASK-0001`). Failure to create the worktree releases
   * the locks and surfaces the error.
   */
  readonly withWorktree?: boolean;
  /**
   * If true, provision a per-task Postgres database after locks acquire
   * (and after worktree creation if both are requested). Requires
   * `databaseUrl`. Failure rolls back the worktree (if any) and locks.
   */
  readonly withDb?: boolean;
  readonly databaseUrl?: string;
  /** Base ref for the worktree (default: HEAD). */
  readonly baseRef?: string;
}

function tasksDir(repoRoot: string): string {
  return join(repoRoot, '.devai/state/tasks');
}

function taskPath(repoRoot: string, id: string): string {
  return join(tasksDir(repoRoot), `${id}.json`);
}

export function saveTask(repoRoot: string, task: TaskRecord): void {
  mkdirSync(tasksDir(repoRoot), { recursive: true });
  const validated = parsers.task.parse(task);
  writeFileSync(taskPath(repoRoot, task.id), JSON.stringify(validated, null, 2) + '\n');
}

export function readTaskRecord(repoRoot: string, id: string): TaskRecordClassification {
  const path = taskPath(repoRoot, id);
  if (!existsSync(path)) throw new Error(`task ${id} not found at ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return { kind: 'invalid', executable: false, code: 'TASK_RECORD_INVALID' };
  }
  const classification = classifyTaskRecord(value);
  if (classification.kind !== 'current') return classification;
  const parsed = parsers.task.safeParse<TaskRecord>(classification.record);
  return parsed.ok
    ? { kind: 'current', executable: true, record: parsed.value }
    : { kind: 'invalid', executable: false, code: 'TASK_RECORD_INVALID' };
}

export function loadTask(repoRoot: string, id: string): TaskRecord {
  const classification = readTaskRecord(repoRoot, id);
  if (classification.kind === 'current') return classification.record;
  throw new Error(classification.code);
}

/** List every stored record classification without making unsupported data executable. */
export function listTaskRecords(repoRoot: string): readonly TaskRecordClassification[] {
  const dir = tasksDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readTaskRecord(repoRoot, name.slice(0, -'.json'.length)));
}

export function listTasks(repoRoot: string): readonly TaskRecord[] {
  return listTaskRecords(repoRoot).flatMap((classification) =>
    classification.kind === 'current' ? [classification.record] : [],
  );
}

export interface SpawnResult {
  readonly task: TaskRecord;
  readonly lock_denied: readonly { target: string; held_by: string }[];
  /** Path of the worktree if one was created; otherwise null. */
  readonly worktree_path: string | null;
  /** Database name provisioned for this task, or null. */
  readonly database: string | null;
  /** Errors encountered after locks were acquired (rolled-back). */
  readonly rollback_reason: string | null;
}

/**
 * Spawn a task and (optionally) compose the full execution environment
 * around it: module locks → git worktree → per-task Postgres database
 * → status=ready (or lock_denied / failed-rollback).
 *
 * The composition is transactional in the rollback sense: if any
 * downstream step (worktree, DB) fails, the upstream steps already
 * taken are reversed (worktree destroyed, locks released). A failed
 * spawn never leaves the substrate half-initialized.
 *
 * With `withWorktree:false` and `withDb:false` (the defaults), the task is
 * validated, locked, and persisted without provisioning extra resources.
 */
export function spawnTask(opts: SpawnTaskOptions): SpawnResult {
  if (typeof opts.task.round_id !== 'string' || opts.task.round_id.length === 0) {
    throw new Error('TASK_ROUND_ID_REQUIRED');
  }
  if (
    opts.task.executor === null ||
    typeof opts.task.executor !== 'object' ||
    Array.isArray(opts.task.executor)
  ) {
    throw new Error('TASK_EXECUTOR_REQUIRED');
  }
  const requested = opts.task as ValidatedSpawnTaskInput;
  const createdAt = requested.created_at ?? new Date().toISOString();
  const preflight: TaskRecord = {
    schemaVersion: '2.0.0',
    ...requested,
    status: requested.status ?? 'queued',
    iteration_count: requested.iteration_count ?? 0,
    created_at: createdAt,
  };
  parsers.task.parse(preflight);

  const locksDir = join(opts.repoRoot, '.devai/state/locks');
  const lockResult = acquireLocks({
    locksDir,
    taskId: requested.id,
    targets: requested.target_modules.map((module) => `F2:${module}`),
  });

  // Lock-denied: never attempt worktree/DB; persist the record and return.
  if (lockResult.denied.length > 0) {
    // Acquisition is all-or-nothing: release any keys claimed before the conflict.
    releaseLocks({ locksDir, taskId: requested.id });
    const task: TaskRecord = {
      schemaVersion: '2.0.0',
      ...requested,
      status: 'lock_denied',
      iteration_count: requested.iteration_count ?? 0,
      created_at: createdAt,
    };
    saveTask(opts.repoRoot, task);
    return {
      task,
      lock_denied: lockResult.denied,
      worktree_path: null,
      database: null,
      rollback_reason: null,
    };
  }

  // Locks acquired. Attempt worktree (if requested), then DB (if requested).
  let worktreePath: string | null = null;
  let database: string | null = null;
  const worktreeId = `WT-${requested.id}`;

  if (opts.withWorktree === true) {
    try {
      const wt = createWorktree({
        repoRoot: opts.repoRoot,
        id: worktreeId,
        branch: requested.id,
        baseRef: opts.baseRef ?? 'HEAD',
        taskId: requested.id,
      });
      worktreePath = wt.path;
    } catch (err) {
      // Rollback: release locks; no worktree to destroy.
      releaseLocks({ locksDir, taskId: requested.id });
      const task: TaskRecord = {
        schemaVersion: '2.0.0',
        ...requested,
        status: 'cancelled',
        iteration_count: requested.iteration_count ?? 0,
        created_at: createdAt,
      };
      saveTask(opts.repoRoot, task);
      return {
        task,
        lock_denied: [],
        worktree_path: null,
        database: null,
        rollback_reason: `worktree creation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (opts.withDb === true) {
    if (opts.databaseUrl === undefined) {
      // Rollback worktree + locks.
      if (opts.withWorktree === true) {
        try {
          destroyWorktree({ repoRoot: opts.repoRoot, id: worktreeId, deleteBranch: true });
        } catch {
          // best-effort
        }
      }
      releaseLocks({ locksDir, taskId: requested.id });
      const task: TaskRecord = {
        schemaVersion: '2.0.0',
        ...requested,
        status: 'cancelled',
        iteration_count: requested.iteration_count ?? 0,
        created_at: createdAt,
      };
      saveTask(opts.repoRoot, task);
      return {
        task,
        lock_denied: [],
        worktree_path: null,
        database: null,
        rollback_reason: 'DB provisioning requested but databaseUrl is undefined',
      };
    }
    const dbRes = provisionTask({ databaseUrl: opts.databaseUrl, taskId: requested.id });
    if (!dbRes.ok) {
      if (opts.withWorktree === true) {
        try {
          destroyWorktree({ repoRoot: opts.repoRoot, id: worktreeId, deleteBranch: true });
        } catch {
          // best-effort
        }
      }
      releaseLocks({ locksDir, taskId: requested.id });
      const task: TaskRecord = {
        schemaVersion: '2.0.0',
        ...requested,
        status: 'cancelled',
        iteration_count: requested.iteration_count ?? 0,
        created_at: createdAt,
      };
      saveTask(opts.repoRoot, task);
      return {
        task,
        lock_denied: [],
        worktree_path: null,
        database: null,
        rollback_reason: `DB provisioning failed: ${dbRes.error ?? 'unknown error'}`,
      };
    }
    database = dbRes.database ?? null;
  }

  // All steps succeeded — record final state.
  const composed = opts.withWorktree === true || opts.withDb === true;
  const task: TaskRecord = {
    schemaVersion: '2.0.0',
    ...requested,
    // If we composed a full environment, the task is in_progress (ready
    // to run). Otherwise it's just 'ready' awaiting environment.
    status: composed ? 'in_progress' : 'ready',
    iteration_count: requested.iteration_count ?? 0,
    created_at: createdAt,
    ...(composed && { spawned_at: new Date().toISOString() }),
    ...(worktreePath !== null && { worktree_id: worktreeId, branch: requested.id }),
  };
  saveTask(opts.repoRoot, task);
  return {
    task,
    lock_denied: [],
    worktree_path: worktreePath,
    database,
    rollback_reason: null,
  };
}

/**
 * Drop the per-task DB if a databaseUrl is supplied. Best-effort.
 * Used by completeTask/escalateTask in their composition paths.
 */
function maybeDropTaskDb(databaseUrl: string | undefined, taskId: string): void {
  if (databaseUrl === undefined) return;
  try {
    dropTask({ databaseUrl, taskId });
  } catch {
    // best-effort; the operator may have already cleaned up.
  }
}

export interface TransitionOptions {
  readonly repoRoot: string;
  readonly taskId: string;
  /** If set, drop the per-task DB during the transition. */
  readonly databaseUrl?: string;
  /** If true, destroy the task's worktree during the transition. */
  readonly destroyWorktree?: boolean;
}

export function completeTask(opts: TransitionOptions): TaskRecord {
  const task = loadTask(opts.repoRoot, opts.taskId);
  const updated: TaskRecord = {
    ...task,
    status: 'completed',
    completed_at: new Date().toISOString(),
  };
  saveTask(opts.repoRoot, updated);
  if (opts.destroyWorktree === true && typeof task.worktree_id === 'string') {
    try {
      destroyWorktree({ repoRoot: opts.repoRoot, id: task.worktree_id });
    } catch {
      // best-effort
    }
  }
  maybeDropTaskDb(opts.databaseUrl, opts.taskId);
  releaseLocks({ locksDir: join(opts.repoRoot, '.devai/state/locks'), taskId: opts.taskId });
  return updated;
}

export function escalateTask(opts: TransitionOptions): TaskRecord {
  const task = loadTask(opts.repoRoot, opts.taskId);
  const updated: TaskRecord = {
    ...task,
    status: 'escalated',
    ...(typeof task.branch === 'string' &&
      task.branch.length > 0 && {
        branch: `escalated/${task.branch}`,
      }),
  };
  saveTask(opts.repoRoot, updated);
  if (opts.destroyWorktree === true && typeof task.worktree_id === 'string') {
    try {
      destroyWorktree({ repoRoot: opts.repoRoot, id: task.worktree_id });
    } catch {
      // best-effort
    }
  }
  maybeDropTaskDb(opts.databaseUrl, opts.taskId);
  releaseLocks({ locksDir: join(opts.repoRoot, '.devai/state/locks'), taskId: opts.taskId });
  return updated;
}

export interface PauseRgrOptions extends TransitionOptions {
  readonly rgrId: string;
}

export function pauseTaskForRgr(opts: PauseRgrOptions): TaskRecord {
  const task = loadTask(opts.repoRoot, opts.taskId);
  let updated: TaskRecord = {
    ...task,
    status: 'rgr_pending',
    ...(typeof task.branch === 'string' &&
      task.branch.length > 0 && {
        branch: `rgr/${task.branch}`,
      }),
  };
  updated = setPausedRgrId(updated, opts.rgrId);
  saveTask(opts.repoRoot, updated);
  releaseLocks({ locksDir: join(opts.repoRoot, '.devai/state/locks'), taskId: opts.taskId });
  return updated;
}

export interface ResumeRgrOptions {
  readonly repoRoot: string;
  readonly rgrId: string;
}

export function resumeTaskFromRgr(opts: ResumeRgrOptions): TaskRecord {
  const tasks = listTasks(opts.repoRoot);
  const target = tasks.find((t) => getPausedRgrId(t) === opts.rgrId);
  if (target === undefined) throw new Error(`no task paused on RGR ${opts.rgrId}`);
  const cleared = clearPausedRgrId(target);
  const updated: TaskRecord = { ...cleared, status: 'queued' };
  saveTask(opts.repoRoot, updated);
  return updated;
}
