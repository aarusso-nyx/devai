import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import { validateCompositeExecutor } from './composite-executor.js';
import { taskLockTargets, utf8Compare } from './lock-targets.js';
import { TaskServiceError } from './task-queue-services.js';
import type { TaskRecord } from './task-contract.js';

export interface RoundTaskAdmissionNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly generation: number;
  readonly resourceKeys: readonly string[];
  readonly taskDigest: string;
  readonly executionContextDigest: string;
}

export interface RoundTaskAdmissionPlan {
  readonly roundId: string;
  readonly orderedTaskIds: readonly string[];
  readonly tasks: readonly RoundTaskAdmissionNode[];
}

export interface PlanRoundTaskAdmissionOptions {
  readonly roundId: string;
  readonly tasks: readonly TaskRecord[];
  readonly selectedTaskIds?: readonly string[];
}

export interface RoundTaskAdmissionDecision {
  readonly admitted: boolean;
  readonly blockers: readonly string[];
}

/*
 * Mirror of `law/policy/round-execution.json` capacity.review_reserve (ADR-MDL-0009); a
 * contract test pins it. While a same-generation review task awaits admission, non-review
 * tasks may hold at most the run's workers minus the reserve, so implementation work
 * cannot starve review. Review tasks may use every worker, and a run with no more workers
 * than the reserve (the serial runner) is unreserved.
 */
export const ROUND_REVIEW_RESERVE = Object.freeze({
  disciplines: Object.freeze(['inspector', 'auditor'] as const),
  reserved_workers: 1,
});

const TERMINAL = new Set<TaskRecord['status']>(['completed', 'escalated', 'cancelled']);
const FAILED = new Set<TaskRecord['status']>([
  'escalated',
  'cancelled',
  'experimental_blocked',
  'rgr_pending',
]);
const POSITION = { architect: 0, inspector: 1, engineer: 2 } as const;
const MUTABLE_FIELDS = new Set([
  'status',
  'iteration_count',
  'spawned_at',
  'completed_at',
  'branch',
  'worktree_id',
  'actual_diff',
  'iteration_trail',
]);
// This brand recognizes validated in-memory plans, never an authority grant or a wire format.
const plans = new WeakSet<RoundTaskAdmissionPlan>();

function fail(code: string): never {
  throw new TaskServiceError(code);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) fail('TASK_DEPENDENCY_MISSING');
  return value;
}

function coupledPosition(task: TaskRecord): number {
  const position = task.coupled_pipeline_position;
  return position == null ? Number.MAX_SAFE_INTEGER : POSITION[position];
}

function population(tasks: readonly TaskRecord[]): Map<string, TaskRecord> {
  const byId = new Map<string, TaskRecord>();
  for (const task of tasks) {
    if (!parsers.task.safeParse(task).ok) fail('TASK_RECORD_INVALID');
    if (byId.has(task.id)) fail('TASK_ID_DUPLICATE');
    byId.set(task.id, task);
  }
  return byId;
}

/** The requested task record without mutable lifecycle fields: what admission binds. */
export function requestedTaskFields(task: TaskRecord): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(task).filter(([key]) => !MUTABLE_FIELDS.has(key)));
}

function requestDigest(task: TaskRecord): string {
  return canonicalSha256(requestedTaskFields(task));
}

function executionContextDigest(task: TaskRecord): string {
  return canonicalSha256({ branch: task.branch ?? null, worktreeId: task.worktree_id ?? null });
}

function resources(task: TaskRecord): readonly string[] {
  return taskLockTargets(task);
}

/**
 * Whether a task may not run beside the given active tasks: they share a lock key, or (round-
 * execution.json resources.keyless_agent_tasks, ADR-MDL-0009) it is an agent task and either
 * it or an active agent task derives no lock key. A keyless agent task has no enforceable
 * write scope a lock could serialize, so it never overlaps another agent task.
 */
function resourceConflict(
  task: TaskRecord,
  keys: readonly string[],
  active: readonly TaskRecord[],
): boolean {
  if (active.some((other) => resources(other).some((key) => keys.includes(key)))) return true;
  if (task.executor.kind !== 'agent') return false;
  return active.some(
    (other) =>
      other.executor.kind === 'agent' && (keys.length === 0 || resources(other).length === 0),
  );
}

/** Whether a task's discipline is one the review reserve serves. */
export function isReviewDiscipline(task: Pick<TaskRecord, 'discipline'>): boolean {
  return (ROUND_REVIEW_RESERVE.disciplines as readonly string[]).includes(task.discipline);
}

/**
 * Pilot-style explicit admission adapted to canonical tasks. This pure plan performs
 * no queue, filesystem, provider, lock, lifecycle or evidence operation.
 */
export function planRoundTaskAdmission(
  options: PlanRoundTaskAdmissionOptions,
): RoundTaskAdmissionPlan {
  if (!/^R-[0-9]{4}$/u.test(options.roundId)) fail('TASK_ROUND_REQUIRED');
  const byId = population(options.tasks);
  const all = options.tasks.filter((task) => task.round_id === options.roundId);
  const edges = new Map(all.map((task) => [task.id, new Set<string>()]));
  for (const task of all) {
    const dependencies = required(edges.get(task.id));
    if (task.upstream_task_id) dependencies.add(task.upstream_task_id);
    const position = task.coupled_pipeline_position;
    if (task.coupled_task_group && position) {
      for (const prior of all) {
        const priorPosition = prior.coupled_pipeline_position;
        if (
          prior.coupled_task_group === task.coupled_task_group &&
          priorPosition &&
          POSITION[priorPosition] < POSITION[position]
        )
          dependencies.add(prior.id);
      }
    }
    if (task.executor.kind !== 'composite') continue;
    const executor = task.executor;
    const children = executor.child_task_ids.map((id) => {
      const child = byId.get(id);
      if (!child) fail('TASK_DEPENDENCY_MISSING');
      return { id, round_id: child.round_id };
    });
    const validated = validateCompositeExecutor({
      parent: { id: task.id, round_id: task.round_id, executor },
      children,
    });
    if (!validated.ok) fail(validated.code);
    for (const child of executor.child_task_ids) dependencies.add(child);
    for (const row of executor.dependencies) {
      const childEdges = edges.get(row.task_id);
      if (!childEdges) fail('TASK_COMPOSITE_CROSS_ROUND');
      for (const dependency of row.depends_on) childEdges.add(dependency);
    }
  }
  for (const dependencies of edges.values()) {
    for (const id of dependencies) {
      const dependency = byId.get(id);
      if (!dependency) fail('TASK_DEPENDENCY_MISSING');
      if (dependency.round_id !== options.roundId) fail('TASK_COMPOSITE_CROSS_ROUND');
    }
  }

  // Validate even unselected records. Selection cannot hide a contradictory round graph.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const validate = (id: string): void => {
    if (visiting.has(id)) fail('TASK_COMPOSITE_CYCLE');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of edges.get(id) ?? []) validate(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of all) validate(task.id);

  const selected = new Set<string>();
  const select = (id: string): void => {
    const task = byId.get(id);
    if (!task) fail('TASK_DEPENDENCY_MISSING');
    if (task.round_id !== options.roundId) fail('TASK_ROUND_MISMATCH');
    if (selected.has(id) || TERMINAL.has(task.status)) return;
    if (task.status !== 'ready') fail('TASK_NOT_READY');
    selected.add(id);
    for (const dependency of edges.get(id) ?? []) select(dependency);
  };
  const roots = options.selectedTaskIds ?? all.filter((t) => t.status === 'ready').map((t) => t.id);
  for (const id of roots) select(id);

  const compare = (a: string, b: string): number => {
    const left = required(byId.get(a));
    const right = required(byId.get(b));
    const leftPosition = coupledPosition(left);
    const rightPosition = coupledPosition(right);
    return (
      leftPosition - rightPosition ||
      (right.priority ?? 0) - (left.priority ?? 0) ||
      utf8Compare(a, b)
    );
  };
  const pending = new Set(selected);
  const ordered: string[] = [];
  const generations = new Map<string, number>();
  let generation = 0;
  while (pending.size) {
    const ready = [...pending]
      .filter((id) => [...(edges.get(id) ?? [])].every((dependency) => !pending.has(dependency)))
      .sort(compare);
    if (!ready.length) fail('TASK_COMPOSITE_CYCLE');
    // Finish a whole generation before admitting the next, independent of priority.
    for (const id of ready) {
      ordered.push(id);
      generations.set(id, generation);
      pending.delete(id);
    }
    generation++;
  }
  const plan: RoundTaskAdmissionPlan = Object.freeze({
    roundId: options.roundId,
    orderedTaskIds: Object.freeze(ordered),
    tasks: Object.freeze(
      all
        .map((task) =>
          Object.freeze({
            id: task.id,
            dependsOn: Object.freeze([...(edges.get(task.id) ?? [])].sort(utf8Compare)),
            generation: generations.get(task.id) ?? -1,
            resourceKeys: Object.freeze(resources(task)),
            taskDigest: requestDigest(task),
            executionContextDigest: executionContextDigest(task),
          }),
        )
        .sort((a, b) => utf8Compare(a.id, b.id)),
    ),
  });
  plans.add(plan);
  return plan;
}

/**
 * Whether a review-discipline task of the candidate's generation would pass every admission
 * check except capacity: planned, live `ready` with its bound request unchanged, not active,
 * not failed, every dependency completed, and no resource conflict with an active task.
 * Only such a task holds the reserve, so a blocked review task never idles a worker.
 */
function reviewAwaitsAdmission(
  plan: RoundTaskAdmissionPlan,
  candidate: RoundTaskAdmissionNode,
  byId: ReadonlyMap<string, TaskRecord>,
  active: readonly TaskRecord[],
  failed: ReadonlySet<string>,
): boolean {
  const activeIds = new Set(active.map((task) => task.id));
  return plan.tasks.some((node) => {
    if (node.id === candidate.id || node.generation !== candidate.generation) return false;
    if (!plan.orderedTaskIds.includes(node.id) || activeIds.has(node.id) || failed.has(node.id)) {
      return false;
    }
    const task = byId.get(node.id);
    if (task === undefined || task.status !== 'ready' || !isReviewDiscipline(task)) return false;
    if (
      requestDigest(task) !== node.taskDigest ||
      executionContextDigest(task) !== node.executionContextDigest
    ) {
      return false;
    }
    if (!node.dependsOn.every((id) => byId.get(id)?.status === 'completed')) return false;
    return !resourceConflict(task, node.resourceKeys, active);
  });
}

/** A plan and callback success never substitute for live, durably completed prerequisites. */
export function decideRoundTaskAdmission(
  plan: RoundTaskAdmissionPlan,
  options: {
    readonly taskId: string;
    readonly tasks: readonly TaskRecord[];
    readonly failedTaskIds: readonly string[];
    readonly activeTaskIds?: readonly string[];
    /** Concurrent worker cap; one unless a caller opted into bounded parallelism. */
    readonly maxWorkers?: number;
  },
): RoundTaskAdmissionDecision {
  if (!plans.has(plan)) fail('TASK_ADMISSION_PLAN_INVALID');
  const byId = population(options.tasks);
  const node = plan.tasks.find((task) => task.id === options.taskId);
  if (!node || !plan.orderedTaskIds.includes(node.id)) fail('TASK_NOT_READY');
  const live = byId.get(node.id);
  if (!live) fail('TASK_DEPENDENCY_MISSING');
  for (const bound of plan.tasks) {
    const task = byId.get(bound.id);
    if (!task) fail('TASK_DEPENDENCY_MISSING');
    if (task.round_id !== plan.roundId) fail('TASK_COMPOSITE_CROSS_ROUND');
  }
  const blockers: string[] = [];
  const failed = new Set(options.failedTaskIds);
  const dependencies = node.dependsOn.map((id) => required(byId.get(id)));
  if (dependencies.some((task) => failed.has(task.id) || FAILED.has(task.status)))
    blockers.push('TASK_DEPENDENCY_FAILED');
  if (dependencies.some((task) => task.status !== 'completed'))
    blockers.push('TASK_DEPENDENCY_NOT_COMPLETED');
  if (
    options.tasks.filter((task) => task.round_id === plan.roundId).length !== plan.tasks.length ||
    plan.tasks.some((bound) => requestDigest(required(byId.get(bound.id))) !== bound.taskDigest) ||
    executionContextDigest(live) !== node.executionContextDigest
  )
    blockers.push('TASK_RECORD_CHANGED');
  if (live.status !== 'ready') blockers.push('TASK_NOT_READY');
  const active = options.activeTaskIds ?? [];
  if (new Set(active).size !== active.length) fail('TASK_ID_DUPLICATE');
  const activeRecords = active.map((id) => {
    const task = byId.get(id);
    if (!task) fail('TASK_DEPENDENCY_MISSING');
    return task;
  });
  if (resourceConflict(live, node.resourceKeys, activeRecords))
    blockers.push('TASK_RESOURCE_CONFLICT');
  // Parallelism is same-topological-generation only (round-execution.json selection).
  if (
    active.some((id) => plan.tasks.find((bound) => bound.id === id)?.generation !== node.generation)
  )
    blockers.push('TASK_GENERATION_BARRIER');
  const workers = options.maxWorkers ?? 1;
  if (active.length >= workers) blockers.push('TASK_WORKER_CAP');
  else if (
    !isReviewDiscipline(live) &&
    workers > ROUND_REVIEW_RESERVE.reserved_workers &&
    activeRecords.filter((task) => !isReviewDiscipline(task)).length >=
      workers - ROUND_REVIEW_RESERVE.reserved_workers &&
    reviewAwaitsAdmission(plan, node, byId, activeRecords, failed)
  )
    // The review reserve narrows the worker cap for non-review tasks (ADR-MDL-0009).
    blockers.push('TASK_WORKER_CAP');
  return { admitted: blockers.length === 0, blockers };
}
