export interface CompositeDependency {
  readonly task_id: string;
  readonly depends_on: readonly string[];
}

export interface CompositeExecutorRequest {
  readonly kind: 'composite';
  readonly child_task_ids: readonly string[];
  readonly dependencies: readonly CompositeDependency[];
  readonly failure_policy?: 'stop-dependent-branch' | 'stop-composite';
}

export interface CompositeParent {
  readonly id: string;
  readonly round_id: string;
  readonly executor?: CompositeExecutorRequest;
}

export interface CompositeChild {
  readonly id: string;
  readonly round_id: string;
}

export interface CompositeValidationOptions {
  readonly parent: CompositeParent;
  readonly children: readonly CompositeChild[];
  /** Invoked only after the complete graph has validated and been ordered. */
  readonly dispatch?: (child: CompositeChild) => void;
}

export interface CompositeValidationSuccess {
  readonly ok: true;
  readonly ordered_task_ids: readonly string[];
  readonly generations: readonly (readonly string[])[];
}

export interface CompositeValidationFailure {
  readonly ok: false;
  readonly code:
    | 'TASK_COMPOSITE_EXECUTOR_REQUIRED'
    | 'TASK_COMPOSITE_CHILD_REQUIRED'
    | 'TASK_COMPOSITE_DUPLICATE_CHILD'
    | 'TASK_COMPOSITE_CHILD_UNDECLARED'
    | 'TASK_COMPOSITE_CROSS_ROUND'
    | 'TASK_COMPOSITE_DEPENDENCIES_REQUIRED'
    | 'TASK_COMPOSITE_DUPLICATE_DEPENDENCY'
    | 'TASK_DEPENDENCY_MISSING'
    | 'TASK_COMPOSITE_CYCLE'
    | 'TASK_COMPOSITE_DISPATCH_FAILED';
  readonly dispatched_task_ids?: readonly string[];
}

export type CompositeValidationResult = CompositeValidationSuccess | CompositeValidationFailure;

function utf8Compare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function duplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function dependencyRows(parent: CompositeParent): readonly CompositeDependency[] | null {
  return parent.executor !== undefined && Array.isArray(parent.executor.dependencies)
    ? parent.executor.dependencies
    : null;
}

/**
 * Validates the entire same-round composite graph, computes deterministic
 * topological generations, and only then permits an optional dispatch.
 */
export function validateCompositeExecutor(
  options: CompositeValidationOptions,
): CompositeValidationResult {
  if (options.parent.executor === undefined || options.parent.executor.kind !== 'composite') {
    return { ok: false, code: 'TASK_COMPOSITE_EXECUTOR_REQUIRED' };
  }

  const declaredIds = options.parent.executor.child_task_ids;
  if (declaredIds.length === 0) {
    return { ok: false, code: 'TASK_COMPOSITE_CHILD_REQUIRED' };
  }
  if (duplicate(declaredIds) !== null) {
    return { ok: false, code: 'TASK_COMPOSITE_DUPLICATE_CHILD' };
  }

  const childrenById = new Map<string, CompositeChild>();
  for (const child of options.children) {
    if (childrenById.has(child.id)) {
      return { ok: false, code: 'TASK_COMPOSITE_DUPLICATE_CHILD' };
    }
    childrenById.set(child.id, child);
  }

  const declaredSet = new Set(declaredIds);
  if (options.children.some((child) => !declaredSet.has(child.id))) {
    return { ok: false, code: 'TASK_COMPOSITE_CHILD_UNDECLARED' };
  }
  if (declaredIds.some((id) => !childrenById.has(id))) {
    return { ok: false, code: 'TASK_DEPENDENCY_MISSING' };
  }
  if (declaredIds.some((id) => id === options.parent.id)) {
    return { ok: false, code: 'TASK_COMPOSITE_CYCLE' };
  }
  if (options.children.some((child) => child.round_id !== options.parent.round_id)) {
    return { ok: false, code: 'TASK_COMPOSITE_CROSS_ROUND' };
  }

  const rows = dependencyRows(options.parent);
  if (rows === null) {
    return { ok: false, code: 'TASK_COMPOSITE_DEPENDENCIES_REQUIRED' };
  }

  const dependencies = new Map<string, readonly string[]>();
  for (const row of rows) {
    if (!declaredSet.has(row.task_id)) {
      return { ok: false, code: 'TASK_DEPENDENCY_MISSING' };
    }
    if (dependencies.has(row.task_id) || duplicate(row.depends_on) !== null) {
      return { ok: false, code: 'TASK_COMPOSITE_DUPLICATE_DEPENDENCY' };
    }
    if (row.depends_on.some((dependency) => !declaredSet.has(dependency))) {
      return { ok: false, code: 'TASK_DEPENDENCY_MISSING' };
    }
    if (row.depends_on.includes(row.task_id)) {
      return { ok: false, code: 'TASK_COMPOSITE_CYCLE' };
    }
    dependencies.set(row.task_id, [...row.depends_on]);
  }

  for (const id of declaredIds) {
    if (!dependencies.has(id)) dependencies.set(id, []);
  }

  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();
  for (const id of declaredIds) {
    dependents.set(id, []);
    remainingDependencies.set(id, dependencies.get(id)?.length ?? 0);
  }
  for (const [taskId, taskDependencies] of dependencies) {
    for (const dependency of taskDependencies) {
      dependents.get(dependency)?.push(taskId);
    }
  }

  let generation = declaredIds
    .filter((id) => remainingDependencies.get(id) === 0)
    .sort(utf8Compare);
  const generations: string[][] = [];
  const orderedTaskIds: string[] = [];
  while (generation.length > 0) {
    generations.push(generation);
    orderedTaskIds.push(...generation);
    const next: string[] = [];
    for (const completed of generation) {
      for (const dependent of dependents.get(completed) ?? []) {
        const remaining = (remainingDependencies.get(dependent) ?? 0) - 1;
        remainingDependencies.set(dependent, remaining);
        if (remaining === 0) next.push(dependent);
      }
    }
    generation = next.sort(utf8Compare);
  }

  if (orderedTaskIds.length !== declaredIds.length) {
    return { ok: false, code: 'TASK_COMPOSITE_CYCLE' };
  }

  if (options.dispatch !== undefined) {
    const dispatchedTaskIds: string[] = [];
    try {
      for (const id of orderedTaskIds) {
        const child = childrenById.get(id);
        if (child === undefined) {
          return { ok: false, code: 'TASK_DEPENDENCY_MISSING' };
        }
        options.dispatch(child);
        dispatchedTaskIds.push(id);
      }
    } catch {
      return {
        ok: false,
        code: 'TASK_COMPOSITE_DISPATCH_FAILED',
        dispatched_task_ids: dispatchedTaskIds,
      };
    }
  }

  return {
    ok: true,
    ordered_task_ids: orderedTaskIds,
    generations,
  };
}
