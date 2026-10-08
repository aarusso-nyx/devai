import { availableParallelism } from 'node:os';
import { readExactGitTreeSync, type ReadOnlyGitTreeEntry } from '@devai-nyx/authority';
import { getValidator } from '@devai-nyx/schemas';
import type { PlannedTask, TaskDescriptorNode, TaskExclusivity, TaskTarget } from './types.js';

/** The ceiling on concurrent task processes, whatever the host or override asks for. */
export const MAX_CHECK_WORKERS = 16;
/** The default never exceeds this, so a large workstation is not saturated by default. */
const DEFAULT_WORKER_CEILING = 4;
export const CHECK_WORKERS_ENV = 'DEVAI_CHECK_TASK_WORKERS';
/**
 * The runner-only exclusivity declarations (ADR-CHK-0007 rule 5), kept out of
 * `test-tasks.json`, whose task keys the bundled release verifier checks exactly.
 */
export const TASK_EXCLUSIVITY_PATH = 'test-task-exclusivity.json';
/** Nodes that both allowlist this variable share one database. */
const DATABASE_ENV = 'DEVAI_DB_URL';
const EXCLUSIVITY_KEY = /^[a-z0-9][a-z0-9._-]*$/u;
const EXCLUSIVITY_SCHEMA = 'test-task-exclusivity.schema.json';
const SEQUENTIAL_ONLY =
  'CHECK_RUNNER_WORKERS: release and protected runs execute one task at a time';

/** Concurrent task processes when nothing overrides it (ADR-CHK-0007): min(4, CPUs). */
export function defaultCheckWorkers(cpus: number = availableParallelism()): number {
  return Math.max(1, Math.min(DEFAULT_WORKER_CEILING, cpus));
}

function workersRefusal(): Error {
  return new Error(
    `CHECK_RUNNER_WORKERS: task workers must be an integer from 1 to ${String(MAX_CHECK_WORKERS)}`,
  );
}

/** The only selections that admit more than one worker (ADR-CHK-0007 rule 3). */
const PARALLEL_TARGETS: ReadonlySet<TaskTarget> = new Set(['affected', 'preflight', 'local']);

/**
 * Release runs (`rc`, `release`), protected runs, and any selection outside `affected`,
 * `preflight`, and `local` always execute one node at a time.
 */
export function sequentialOnlyTarget(target: TaskTarget, protectedRun = false): boolean {
  return protectedRun || !PARALLEL_TARGETS.has(target);
}

/**
 * The worker count for one run: `--task-workers`, then `DEVAI_CHECK_TASK_WORKERS`, then the
 * default. 1 is the sequential runner exactly. A sequential-only target ignores the
 * environment and refuses an explicit count above 1.
 */
export function resolveCheckWorkers(
  flag: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cpus?: number,
  sequentialOnly = false,
): number {
  const parse = (raw: string): number => {
    const value = /^[0-9]+$/u.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CHECK_WORKERS) {
      throw workersRefusal();
    }
    return value;
  };
  if (sequentialOnly) {
    if (flag !== undefined && parse(flag) !== 1) throw new Error(SEQUENTIAL_ONLY);
    return 1;
  }
  // Only an unset variable falls through to the default; a set but empty one is refused.
  const raw = flag ?? environment[CHECK_WORKERS_ENV];
  return raw === undefined ? defaultCheckWorkers(cpus) : parse(raw);
}

/** Validates a worker count handed to the runner directly. */
export function assertCheckWorkers(workers: number, sequentialOnly: boolean): void {
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > MAX_CHECK_WORKERS) {
    throw workersRefusal();
  }
  if (sequentialOnly && workers !== 1) throw new Error(SEQUENTIAL_ONLY);
}

function validKeys(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((key) => typeof key === 'string' && EXCLUSIVITY_KEY.test(key)) &&
    new Set(value).size === value.length
  );
}

/**
 * Parse the exclusivity document against the planned descriptor's node ids:
 * `{ schemaVersion: "1.0.0", nodes: { <nodeId>: { exclusive?, shared? } } }`. A node id
 * the descriptor does not declare, or a malformed entry, is refused, so a misspelling can
 * never silently drop a declaration.
 */
export function parseTaskExclusivity(
  value: unknown,
  nodeIds: ReadonlySet<string>,
): ReadonlyMap<string, TaskExclusivity> {
  const fail = (detail: string): never => {
    throw new Error(`CHECK_RUNNER_EXCLUSIVITY: ${detail}`);
  };
  const validate = getValidator(EXCLUSIVITY_SCHEMA);
  if (!validate(value)) {
    const first = validate.errors?.[0];
    fail(
      `${TASK_EXCLUSIVITY_PATH} fails ${EXCLUSIVITY_SCHEMA}${
        first === undefined ? '' : `: ${first.instancePath || '/'} ${String(first.message)}`
      }`,
    );
  }
  // The schema decides the shape; the checks below keep the runner closed on its own too.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('the document must be an object');
  }
  const document = value as Readonly<Record<string, unknown>>;
  if (
    document.schemaVersion !== '1.0.0' ||
    Object.keys(document).some((key) => key !== 'schemaVersion' && key !== 'nodes')
  ) {
    return fail('expected schemaVersion 1.0.0 and nodes only');
  }
  const nodes = document.nodes;
  if (nodes === null || typeof nodes !== 'object' || Array.isArray(nodes)) {
    return fail('nodes must be an object');
  }
  const declared = new Map<string, TaskExclusivity>();
  for (const [nodeId, entry] of Object.entries(nodes as Record<string, unknown>)) {
    if (!nodeIds.has(nodeId)) fail(`${nodeId} is not a node of the task descriptor`);
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.entries(entry).some(
        ([field, keys]) => (field !== 'exclusive' && field !== 'shared') || !validKeys(keys),
      )
    ) {
      fail(`malformed declaration for ${nodeId}`);
    }
    declared.set(nodeId, entry as TaskExclusivity);
  }
  return declared;
}

/** Read the exclusivity file tracked at the planned commit; without one, every node is undeclared. */
export function readTaskExclusivity(
  repoRoot: string,
  candidate: Readonly<{ commit: string; tree: string }>,
  nodeIds: ReadonlySet<string>,
): ReadonlyMap<string, TaskExclusivity> {
  // Only the tracked bytes at the planned commit are authority: an untracked, ignored, or
  // locally edited working-tree file is never read, and an untracked one counts as absent.
  const notRegular = (): never => {
    throw new Error(`CHECK_RUNNER_EXCLUSIVITY: ${TASK_EXCLUSIVITY_PATH} must be a regular file`);
  };
  let projected: readonly ReadOnlyGitTreeEntry[];
  try {
    projected = readExactGitTreeSync(
      repoRoot,
      candidate.commit,
      candidate.tree,
      TASK_EXCLUSIVITY_PATH,
    );
  } catch (error) {
    // The path is not tracked at the planned commit: the file is absent.
    if (error instanceof Error && error.message === 'GIT_TREE_PROJECTION_EMPTY') return new Map();
    // A submodule (gitlink) entry at the path is not a regular file.
    if (error instanceof Error && error.message === 'GIT_TREE_ENTRY_UNSUPPORTED') notRegular();
    throw error;
  }
  // Anything tracked at the path must be exactly one regular file: a directory projects
  // the entries beneath it, and a symbolic link projects mode 120000.
  const entry = projected[0];
  if (
    entry === undefined ||
    projected.length !== 1 ||
    entry.path !== TASK_EXCLUSIVITY_PATH ||
    entry.mode === '120000'
  ) {
    return notRegular();
  }
  let document: unknown;
  try {
    document = JSON.parse(entry.bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`CHECK_RUNNER_EXCLUSIVITY: ${TASK_EXCLUSIVITY_PATH} is not valid JSON`);
  }
  return parseTaskExclusivity(document, nodeIds);
}

export interface ScheduledNode {
  readonly nodeId: string;
  readonly dependencies: readonly string[];
  /** Absent when the node declares nothing: it then conflicts with every node. */
  readonly exclusivity?: TaskExclusivity;
  /** Declared output paths and generated-namespace prefixes. */
  readonly outputs: readonly string[];
  /** Whether the node allowlists the shared database URL. */
  readonly database: boolean;
}

/** The schedule view of one planned node. */
export function scheduledNode(
  task: Pick<PlannedTask, 'nodeId' | 'dependencies' | 'outputContract'>,
  declared: Pick<TaskDescriptorNode, 'allowlistedEnv'> | undefined,
  exclusivity: TaskExclusivity | undefined,
): ScheduledNode {
  const contract = task.outputContract as {
    readonly paths?: unknown;
    readonly generated_namespaces?: unknown;
  };
  const paths = Array.isArray(contract.paths)
    ? contract.paths.filter((path): path is string => typeof path === 'string')
    : [];
  const prefixes = Array.isArray(contract.generated_namespaces)
    ? contract.generated_namespaces.flatMap((entry: unknown) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { prefix?: unknown }).prefix === 'string'
          ? [(entry as { prefix: string }).prefix]
          : [],
      )
    : [];
  return {
    nodeId: task.nodeId,
    dependencies: task.dependencies,
    ...(exclusivity !== undefined && { exclusivity }),
    outputs: [...paths, ...prefixes],
    database: (declared?.allowlistedEnv ?? []).includes(DATABASE_ENV),
  };
}

/** Equal paths, or one a directory prefix of the other. */
function nested(left: string, right: string): boolean {
  const a = left.replace(/\/+$/u, '');
  const b = right.replace(/\/+$/u, '');
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/** Either node holds exclusively a key the other holds at all. */
function keysConflict(left: TaskExclusivity, right: TaskExclusivity): boolean {
  const holds = (side: TaskExclusivity): Set<string> =>
    new Set([...(side.exclusive ?? []), ...(side.shared ?? [])]);
  const leftHolds = holds(left);
  const rightHolds = holds(right);
  return (
    (left.exclusive ?? []).some((key) => rightHolds.has(key)) ||
    (right.exclusive ?? []).some((key) => leftHolds.has(key))
  );
}

/**
 * Whether two nodes must not overlap (ADR-CHK-0007): either declares nothing; either
 * holds exclusively a key the other holds; an output path or generated-namespace prefix
 * of one equals or contains one of the other's; or both allowlist DEVAI_DB_URL.
 */
export function tasksConflict(left: ScheduledNode, right: ScheduledNode): boolean {
  if (left.exclusivity === undefined || right.exclusivity === undefined) return true;
  return (
    keysConflict(left.exclusivity, right.exclusivity) ||
    (left.database && right.database) ||
    left.outputs.some((path) => right.outputs.some((other) => nested(path, other)))
  );
}

/**
 * The plan-order predecessors each node waits for: its dependencies, and every earlier
 * node it conflicts with. Plans are topological, so every planned dependency is earlier;
 * a dependency that is not planned is never awaited and is seen unresolved, exactly as
 * the sequential runner sees it.
 */
export function schedulePredecessors(nodes: readonly ScheduledNode[]): readonly number[][] {
  const index = new Map(nodes.map((node, position) => [node.nodeId, position]));
  return nodes.map((node, position) => {
    const waits = new Set<number>();
    for (const dependency of node.dependencies) {
      const at = index.get(dependency);
      if (at !== undefined && at < position) waits.add(at);
    }
    for (let earlier = 0; earlier < position; earlier += 1) {
      const other = nodes[earlier];
      if (other !== undefined && tasksConflict(other, node)) waits.add(earlier);
    }
    return [...waits].sort((a, b) => a - b);
  });
}

/**
 * Run every node once, at most `workers` at a time. A node starts once all its
 * predecessors have settled; among ready nodes the earliest in plan order starts first.
 * Task failures are results, not errors, and never stop the schedule. A host error stops
 * new starts, lets running siblings settle, and then rethrows the error of the earliest
 * node that raised one. `workers` is re-read before every start: when it drops to 1, no
 * node starts until every running node has settled, and the rest run one at a time.
 */
export async function runScheduled(
  nodes: readonly ScheduledNode[],
  workers: number | (() => number),
  run: (position: number) => Promise<void>,
): Promise<void> {
  const limit = typeof workers === 'number' ? () => workers : workers;
  const predecessors = schedulePredecessors(nodes);
  const started = new Array<boolean>(nodes.length).fill(false);
  const settled = new Array<boolean>(nodes.length).fill(false);
  const errors = new Map<number, unknown>();
  let running = 0;
  await new Promise<void>((resolveAll) => {
    const pump = (): void => {
      if (errors.size === 0) {
        for (let position = 0; position < nodes.length && running < limit(); position += 1) {
          if (started[position] === true) continue;
          if (!(predecessors[position] ?? []).every((at) => settled[at] === true)) continue;
          started[position] = true;
          running += 1;
          void run(position)
            .catch((error: unknown) => {
              errors.set(position, error);
            })
            .finally(() => {
              settled[position] = true;
              running -= 1;
              pump();
            });
        }
      }
      if (running === 0) resolveAll();
    };
    pump();
  });
  if (errors.size > 0) throw errors.get(Math.min(...errors.keys()));
  if (started.some((value) => !value)) {
    throw new Error('CHECK_RUNNER_INTERNAL: scheduled node never started');
  }
}
