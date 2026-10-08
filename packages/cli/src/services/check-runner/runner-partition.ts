import type { CheckRunnerOptions, PlannedTask, TaskPartition, TaskPartitionRole } from './types.js';

/** The selections a partitioned run may use (ADR-CHK-0007 rule 11). */
const PARTITION_TARGETS = new Set(['affected', 'local']);

function refuse(detail: string): never {
  throw new Error(`CHECK_RUNNER_PARTITION: ${detail}`);
}

/**
 * Refuse a partition before any node starts: outside `run` with `--affected` or `--local`,
 * under a protected identity, with an empty list, or naming a node the descriptor does not
 * declare.
 */
export function assertPartitionAdmissible(
  options: CheckRunnerOptions,
  partition: TaskPartition,
  declaredNodeIds: () => ReadonlySet<string>,
): void {
  if (partition.mode !== 'include' && partition.mode !== 'exclude') {
    refuse('mode must be include or exclude');
  }
  if (options.operation !== 'run') refuse('a partition applies only to --run');
  if (!PARTITION_TARGETS.has(options.target)) {
    refuse(`a partition applies only to --affected or --local, not ${options.target}`);
  }
  if (options.protectedExecutionIdentity !== undefined) {
    refuse('a protected run is never partitioned');
  }
  if (
    !Array.isArray(partition.nodeIds) ||
    partition.nodeIds.length === 0 ||
    partition.nodeIds.some((nodeId) => typeof nodeId !== 'string' || nodeId === '')
  ) {
    refuse('the partition lists no node');
  }
  const declared = declaredNodeIds();
  const unknown = partition.nodeIds.filter((nodeId) => !declared.has(nodeId));
  if (unknown.length > 0) refuse(`unknown node ${unknown.join(', ')}`);
}

export interface PartitionRoles {
  readonly roles: ReadonlyMap<string, TaskPartitionRole>;
  readonly separable: boolean;
}

/**
 * Ownership of a planned node set (ADR-CHK-0007 rule 11). With `I` the listed planned
 * nodes, `D` their planned descendants and `A` their planned ancestors, the plan is
 * separable when every planned ancestor of `D` lies in `I ∪ D ∪ A`. Then the including run
 * owns `I ∪ D` and the excluding run owns the rest; otherwise the including run owns every
 * planned node and the excluding run owns none. A run also executes the planned ancestors
 * of what it owns (prerequisites); every other node is partitioned out.
 */
export function partitionRoles(
  tasks: readonly Pick<PlannedTask, 'nodeId' | 'dependencies'>[],
  partition: TaskPartition,
): PartitionRoles {
  const planned = new Set(tasks.map((task) => task.nodeId));
  const parents = new Map(
    tasks.map((task) => [task.nodeId, task.dependencies.filter((id) => planned.has(id))]),
  );
  const children = new Map<string, string[]>(tasks.map((task) => [task.nodeId, []]));
  for (const [child, deps] of parents) for (const parent of deps) children.get(parent)?.push(child);
  const closure = (seeds: Iterable<string>, edges: ReadonlyMap<string, readonly string[]>) => {
    const seen = new Set<string>();
    const stack = [...seeds];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      for (const neighbour of edges.get(next) ?? []) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          stack.push(neighbour);
        }
      }
    }
    return seen;
  };
  const listed = new Set(partition.nodeIds.filter((nodeId) => planned.has(nodeId)));
  const descendants = closure(listed, children);
  const ancestors = closure(listed, parents);
  const included = new Set([...listed, ...descendants]);
  const separable = [...closure(descendants, parents)].every(
    (nodeId) => included.has(nodeId) || ancestors.has(nodeId),
  );
  const owned = new Set(
    tasks
      .map((task) => task.nodeId)
      .filter((nodeId) =>
        partition.mode === 'include'
          ? !separable || included.has(nodeId)
          : separable && !included.has(nodeId),
      ),
  );
  const prerequisites = closure(owned, parents);
  const roles = new Map<string, TaskPartitionRole>();
  for (const task of tasks) {
    roles.set(
      task.nodeId,
      owned.has(task.nodeId)
        ? 'owned'
        : prerequisites.has(task.nodeId)
          ? 'prerequisite'
          : 'partitioned-out',
    );
  }
  return { roles, separable };
}
