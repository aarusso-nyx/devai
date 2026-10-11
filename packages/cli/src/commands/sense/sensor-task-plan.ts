import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { buildTaskPlan } from '../../services/check-runner/policy.js';
import { resolveRunnerToolchain } from '../../services/check-runner/runner-plan.js';
import { resolveTaskEnvironment } from '../../services/check-runner/runner-inputs.js';
import { CheckCache } from '../../services/check-runner/cache.js';
import { canonicalize, sha256Hex } from '../../services/check-runner/canonical.js';
import type {
  CandidateReceipt,
  PlannedTask,
  TaskDescriptor,
  TaskPlan,
} from '../../services/check-runner/types.js';

function containedFile(root: string, path: string): string {
  const lexical = resolve(root, path);
  const actual = realpathSync(lexical);
  const rel = relative(root, actual);
  if (
    isAbsolute(path) ||
    !lstatSync(lexical).isFile() ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error('SENSE_TASK_PATH_ESCAPES_ROOT');
  }
  return actual;
}

function closure(descriptor: TaskDescriptor, roots: readonly string[]) {
  const ids = new Set(roots);
  const pending = [...ids];
  for (let index = 0; index < pending.length; index += 1) {
    const task = descriptor.tasks.find((entry) => entry.nodeId === pending[index]);
    if (task === undefined) throw new Error('SENSE_TASK_UNKNOWN');
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        ids.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return descriptor.tasks.filter((task) => ids.has(task.nodeId));
}

export function planSensorTasks(
  root: string,
  descriptor: TaskDescriptor,
  roots: readonly string[],
  resolveToolchain = resolveRunnerToolchain,
) {
  const nodes = closure(descriptor, roots);
  const toolchain = resolveToolchain(
    root,
    nodes.flatMap((task) => task.toolchainKeys),
  );
  const environment = resolveTaskEnvironment(
    root,
    nodes.flatMap((task) => task.allowlistedEnv),
  );
  const plan = buildTaskPlan({
    repoRoot: root,
    descriptor,
    target: 'local',
    selectedTaskNodes: roots,
    toolchain,
    environment,
    cacheState: () => ({ cacheState: 'execute', reason: 'sensor-measurement-always-executes' }),
  });
  return { plan, environment };
}

/** Require content-addressed prior completion with current candidate, policy and environment. */
export function sensorTaskPrerequisites(
  root: string,
  descriptor: TaskDescriptor,
  plan: TaskPlan,
  task: PlannedTask,
  reconstruct: (ids: readonly string[]) => { plan: TaskPlan } = (ids) =>
    planSensorTasks(root, descriptor, ids),
): Readonly<Record<string, string>> {
  if (task.dependencies.length === 0) return Object.freeze({});
  if (!plan.clean) throw new Error('SENSE_TASK_PREREQUISITE_CANDIDATE_DIRTY');
  const receiptDir = join(root, '.devai/state/check-cache/v1/receipts');
  if (!existsSync(receiptDir)) throw new Error('SENSE_TASK_PREREQUISITE_REQUIRED');
  const cache = new CheckCache(root, join(root, '.devai/state/check-cache/v1'));
  const required = closure(descriptor, task.dependencies).map((node) => node.nodeId);
  for (const file of readdirSync(receiptDir).sort()) {
    if (!/^[0-9a-f]{64}\.json$/u.test(file)) continue;
    try {
      const receipt = JSON.parse(
        readFileSync(containedFile(root, `.devai/state/check-cache/v1/receipts/${file}`), 'utf8'),
      ) as CandidateReceipt;
      if (
        sha256Hex(receipt) !== file.slice(0, -5) ||
        receipt.schemaVersion !== '1.1.0' ||
        canonicalize(receipt.repository) !== canonicalize(plan.repository) ||
        !Array.isArray(receipt.tasks) ||
        !['affected', 'rc'].includes(receipt.profile)
      )
        continue;
      const ids = receipt.tasks.map((node) => node.nodeId);
      if (new Set(ids).size !== ids.length || !required.every((id) => ids.includes(id))) continue;
      const current = reconstruct(ids).plan;
      if (
        current.taskPolicyDigest !== receipt.taskPolicyDigest ||
        current.tasks.length !== ids.length
      )
        continue;
      const digests: Record<string, string> = {};
      let valid = true;
      for (const node of current.tasks) {
        const completed = receipt.tasks.find((entry) => entry.nodeId === node.nodeId);
        const dependencyDigests: Record<string, string> = {};
        for (const id of node.dependencies) {
          const digest = digests[id];
          if (digest === undefined) throw new Error('SENSE_TASK_PREREQUISITE_REQUIRED');
          dependencyDigests[id] = digest;
        }
        const inspection = cache.inspect(node, dependencyDigests);
        if (
          completed?.taskKey !== node.taskKey ||
          inspection.cacheState !== 'reusable' ||
          inspection.cachedResultDigest !== completed.resultDigest ||
          inspection.result?.inputDigest !== node.inputDigest
        ) {
          valid = false;
          break;
        }
        digests[node.nodeId] = completed.resultDigest;
      }
      if (valid)
        return Object.freeze(Object.fromEntries(required.map((id) => [id, digests[id] as string])));
    } catch {
      // Malformed or stale receipts never provide prerequisite standing.
    }
  }
  throw new Error('SENSE_TASK_PREREQUISITE_REQUIRED');
}
