import { parsers } from '@devai-nyx/schemas';
import { join } from 'node:path';
import { validateCompositeExecutor } from './composite-executor.js';
import { listLocks } from './locks.js';
import { listTasks, loadTask, saveTask, type TaskRecord } from './tasks.js';
import {
  escalateRoundTask,
  requireActiveTaskRound,
  startRoundTask,
  TaskServiceError,
} from './task-services.js';

const TERMINAL = new Set<TaskRecord['status']>(['completed', 'escalated', 'cancelled']);
const COUPLED_POSITION: Readonly<Record<string, number>> = {
  inspector: 0,
  architect: 1,
  engineer: 2,
};

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

function fail(code: string): never {
  throw new TaskServiceError(code);
}

function utf8Compare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function taskDependencies(task: TaskRecord, roundTasks: readonly TaskRecord[]): readonly string[] {
  const dependencies = new Set<string>();
  if (typeof task.upstream_task_id === 'string' && task.upstream_task_id.length > 0) {
    dependencies.add(task.upstream_task_id);
  }
  if (task.executor.kind === 'composite') {
    for (const row of task.executor.dependencies) {
      for (const dependency of row.depends_on) dependencies.add(dependency);
    }
    for (const child of task.executor.child_task_ids) dependencies.add(child);
  }
  if (typeof task.coupled_task_group === 'string' && task.coupled_task_group.length > 0) {
    const position = task.coupled_pipeline_position;
    const current =
      position === null || position === undefined ? undefined : COUPLED_POSITION[position];
    if (current !== undefined) {
      for (const candidate of roundTasks) {
        if (candidate.coupled_task_group !== task.coupled_task_group) continue;
        const candidatePosition = candidate.coupled_pipeline_position;
        const prior =
          candidatePosition === null || candidatePosition === undefined
            ? undefined
            : COUPLED_POSITION[candidatePosition];
        if (prior !== undefined && prior < current) dependencies.add(candidate.id);
      }
    }
  }
  return [...dependencies].sort(utf8Compare);
}

function validateComposite(task: TaskRecord, byId: ReadonlyMap<string, TaskRecord>): void {
  if (task.executor.kind !== 'composite') return;
  const executor = task.executor;
  const children = executor.child_task_ids.map((id) => {
    const child = byId.get(id);
    if (child === undefined) fail('TASK_DEPENDENCY_MISSING');
    const row = executor.dependencies.find((candidate) => candidate.task_id === id);
    return { id: child.id, round_id: child.round_id, dependencies: row?.depends_on ?? [] };
  });
  const result = validateCompositeExecutor({
    parent: { id: task.id, round_id: task.round_id, executor },
    children,
  });
  if (!result.ok) fail(result.code);
}

function requiredTaskLocksHeld(repoRoot: string, task: TaskRecord): boolean {
  const held = listLocks({ locksDir: join(repoRoot, '.devai/state/locks') }).filter(
    (lock) =>
      lock.task_id === task.id && Date.now() - new Date(lock.acquired_at).getTime() < lock.ttl_ms,
  );
  return task.target_modules.every((module) =>
    held.some((lock) => lock.substrate === 'F2' && lock.module === module),
  );
}

function orderedPopulation(options: {
  readonly all: readonly TaskRecord[];
  readonly selectedIds?: readonly string[];
}): readonly TaskRecord[] {
  const byId = new Map(options.all.map((task) => [task.id, task]));
  const selected = new Set<string>();
  const visit = (id: string): void => {
    const task = byId.get(id);
    if (task === undefined) fail('TASK_DEPENDENCY_MISSING');
    if (selected.has(id) || TERMINAL.has(task.status)) return;
    if (task.status !== 'ready') fail('TASK_NOT_READY');
    selected.add(id);
    for (const dependency of taskDependencies(task, options.all)) {
      const dependencyTask = byId.get(dependency);
      if (dependencyTask === undefined) fail('TASK_DEPENDENCY_MISSING');
      if (dependencyTask.round_id !== task.round_id) fail('TASK_COMPOSITE_CROSS_ROUND');
      if (!TERMINAL.has(dependencyTask.status)) visit(dependency);
    }
    validateComposite(task, byId);
  };

  const roots =
    options.selectedIds ??
    options.all.filter((task) => task.status === 'ready').map((task) => task.id);
  for (const id of roots) visit(id);

  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const id of selected) {
    incoming.set(id, new Set());
    outgoing.set(id, new Set());
  }
  for (const id of selected) {
    const task = byId.get(id);
    if (task === undefined) fail('TASK_DEPENDENCY_MISSING');
    for (const dependency of taskDependencies(task, options.all)) {
      if (!selected.has(dependency)) continue;
      incoming.get(id)?.add(dependency);
      outgoing.get(dependency)?.add(id);
    }
  }

  const compare = (leftId: string, rightId: string): number => {
    const left = byId.get(leftId);
    const right = byId.get(rightId);
    if (left === undefined || right === undefined) return utf8Compare(leftId, rightId);
    const leftPosition =
      left.coupled_pipeline_position === null || left.coupled_pipeline_position === undefined
        ? Number.MAX_SAFE_INTEGER
        : (COUPLED_POSITION[left.coupled_pipeline_position] ?? Number.MAX_SAFE_INTEGER);
    const rightPosition =
      right.coupled_pipeline_position === null || right.coupled_pipeline_position === undefined
        ? Number.MAX_SAFE_INTEGER
        : (COUPLED_POSITION[right.coupled_pipeline_position] ?? Number.MAX_SAFE_INTEGER);
    if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    const priority = (right.priority ?? 0) - (left.priority ?? 0);
    return priority === 0 ? utf8Compare(leftId, rightId) : priority;
  };

  const ready = [...selected].filter((id) => incoming.get(id)?.size === 0).sort(compare);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    ordered.push(id);
    for (const dependent of outgoing.get(id) ?? []) {
      const edges = incoming.get(dependent);
      edges?.delete(id);
      if (edges?.size === 0) {
        ready.push(dependent);
        ready.sort(compare);
      }
    }
  }
  if (ordered.length !== selected.size) fail('TASK_COMPOSITE_CYCLE');
  return ordered.map((id) => byId.get(id) as TaskRecord);
}

/** Validate the complete same-round population before any B3A dispatch. */
export async function runRoundTasks(options: RunRoundTasksOptions): Promise<RunRoundTasksResult> {
  const roundId = requireActiveTaskRound(options);
  const population = listTasks(options.repoRoot);
  for (const task of population) parsers.task.parse(task);
  if (
    options.taskIds?.some((id) => {
      const task = population.find((candidate) => candidate.id === id);
      return task !== undefined && task.round_id !== roundId;
    }) === true
  ) {
    fail('TASK_ROUND_MISMATCH');
  }
  const all = population.filter((task) => task.round_id === roundId);
  const populationById = new Map(population.map((task) => [task.id, task]));
  for (const task of all) {
    for (const dependencyId of taskDependencies(task, all)) {
      const dependency = populationById.get(dependencyId);
      if (dependency !== undefined && dependency.round_id !== roundId) {
        fail('TASK_COMPOSITE_CROSS_ROUND');
      }
    }
  }
  const ordered = orderedPopulation({
    all,
    ...(options.taskIds !== undefined && { selectedIds: options.taskIds }),
  });
  const blocked = new Set(
    all
      .filter((task) => task.status === 'escalated' || task.status === 'cancelled')
      .map((task) => task.id),
  );
  const results: RoundTaskRunResult[] = [];
  for (const task of ordered) {
    const dependencies = taskDependencies(task, all);
    if (dependencies.some((dependency) => blocked.has(dependency))) {
      blocked.add(task.id);
      results.push({ task_id: task.id, ok: false, code: 'TASK_DEPENDENCY_FAILED' });
      continue;
    }
    const started = requiredTaskLocksHeld(options.repoRoot, task)
      ? {
          task,
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
    let result: RoundTaskDispatchResult;
    try {
      result = await options.dispatch(running);
    } catch {
      result = { ok: false, code: 'TASK_EXECUTOR_DISPATCH_FAILED' };
    }
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
