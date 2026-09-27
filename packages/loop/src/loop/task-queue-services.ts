import { existsSync, readFileSync } from '@devai-nyx/authority';
import { EXIT_PRECONDITION, EXIT_USAGE } from '@devai-nyx/utils';
import { join, resolve } from 'node:path';
import {
  appendBacklog,
  pickNextTask,
  readBacklog,
  updateBacklogStatus,
  type BacklogEntry,
} from './backlog.js';
import { listTasks, saveTask, validateTaskRecord, type TaskRecord } from './tasks.js';
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

export function fail(code: string, exitCode = 2): never {
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
  if (!authorizationIsActive(repoRoot, roundId)) fail('TASK_ROUND_INACTIVE', EXIT_PRECONDITION);
  return roundId;
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

export interface MaterializeRoundQueueTaskOptions {
  readonly repoRoot: string;
  readonly round?: string;
  readonly task: TaskRecord;
}

export interface MaterializedRoundQueueTask {
  readonly entry: BacklogEntry;
  readonly task: TaskRecord;
}

/**
 * Validate and persist an Architect-declared task through the queue action.
 * An earlier title-only queue entry may be enriched by the same task identity;
 * its immutable title, priority, description, and creation time must agree.
 */
export function materializeRoundQueueTask(
  options: MaterializeRoundQueueTaskOptions,
): MaterializedRoundQueueTask {
  const roundId = requireActiveTaskRound(options);
  let task: TaskRecord;
  try {
    task = validateTaskRecord(options.task);
  } catch {
    fail('TASK_RECORD_INVALID', EXIT_USAGE);
  }
  if (task.round_id !== roundId) fail('TASK_ROUND_MISMATCH');
  if (task.status !== 'queued') fail('TASK_QUEUE_STATUS_INVALID', EXIT_USAGE);

  const priority = task.priority ?? 50;
  const existingEntry = readBacklog(options.repoRoot).find((entry) => entry.id === task.id);
  if (
    existingEntry !== undefined &&
    (existingEntry.round_id !== task.round_id ||
      existingEntry.title !== task.title ||
      existingEntry.priority !== priority ||
      existingEntry.description !== task.description ||
      existingEntry.created_at !== task.created_at)
  ) {
    fail('TASK_QUEUE_MATERIALIZATION_CONFLICT');
  }

  const existingTask = listTasks(options.repoRoot).find((candidate) => candidate.id === task.id);
  if (existingTask !== undefined && JSON.stringify(existingTask) !== JSON.stringify(task)) {
    fail('TASK_RECORD_CONFLICT');
  }
  if (
    existingTask !== undefined &&
    existingEntry !== undefined &&
    existingEntry.status === 'queued' &&
    existingEntry.discipline === task.discipline &&
    JSON.stringify(existingEntry.target_modules) === JSON.stringify(task.target_modules) &&
    JSON.stringify(existingEntry.target_substrates) === JSON.stringify(task.target_substrates) &&
    existingEntry.db_isolation === task.db_isolation &&
    existingEntry.lifecycle === task.lifecycle &&
    JSON.stringify(existingEntry.acceptance_commands) === JSON.stringify(task.acceptance_commands)
  ) {
    return { entry: existingEntry, task: existingTask };
  }

  const entry = appendBacklog(options.repoRoot, {
    id: task.id,
    round_id: task.round_id,
    title: task.title,
    priority,
    status: 'queued',
    created_at: task.created_at,
    discipline: task.discipline,
    target_modules: task.target_modules,
    target_substrates: task.target_substrates,
    db_isolation: task.db_isolation,
    ...(task.description !== undefined && { description: task.description }),
    ...(task.lifecycle !== undefined && { lifecycle: task.lifecycle }),
    ...(task.acceptance_commands !== undefined && {
      acceptance_commands: task.acceptance_commands,
    }),
  });
  saveTask(options.repoRoot, task);
  return { entry, task };
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
  // Older entries without a status are queued, as in the global picker.
  return (
    listRoundQueue(options).find(
      (entry) => entry.status === 'queued' || entry.status === undefined,
    ) ?? null
  );
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
