import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from '@devai-nyx/authority';
import { CheckCache } from './cache.js';
import {
  buildTaskPlan,
  parseTaskDescriptor,
  readTaskDescriptor,
  isPreflightNode,
  withSyntheticNode,
} from './policy.js';
import {
  ADOPTER_PREFLIGHT_NODE_ID,
  ADOPTER_PREFLIGHT_PROBES_PATH,
  adopterPreflightNode,
  loadAdopterPreflightProbes,
} from './preflight.js';
import type { CheckRunnerOptions, PlannedTask, TaskDescriptorNode } from './types.js';

export function descriptorFor(options: CheckRunnerOptions) {
  const descriptor =
    options.descriptorDocument === undefined
      ? readTaskDescriptor(
          resolve(options.descriptorPath ?? join(options.repoRoot, 'test-tasks.json')),
        )
      : parseTaskDescriptor(options.descriptorDocument);
  if (options.target !== 'preflight') return descriptor;
  // The --preflight target also plans the adopter-owned probe list as a synthetic
  // root node; it is never part of the task policy the verifier rebuilds.
  const probes = loadAdopterPreflightProbes(options.repoRoot);
  const augmented =
    probes === undefined ? descriptor : withSyntheticNode(descriptor, adopterPreflightNode(probes));
  if (!augmented.tasks.some((task) => isPreflightNode(task))) {
    throw new Error(
      `CHECK_PREFLIGHT_PROBES_MISSING: declare a preflight-v1 node in test-tasks.json or probes in ${ADOPTER_PREFLIGHT_PROBES_PATH}`,
    );
  }
  return augmented;
}

/** Planned nodes outside the task policy: the synthetic adopter preflight root. */
export function unattestedNodeIds(options: CheckRunnerOptions): readonly string[] {
  return options.target === 'preflight' &&
    existsSync(join(options.repoRoot, ADOPTER_PREFLIGHT_PROBES_PATH))
    ? [ADOPTER_PREFLIGHT_NODE_ID]
    : [];
}

function commandVersion(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8', timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `CHECK_RUNNER_TOOLCHAIN_MISSING: ${command}: ${result.error?.message ?? String(result.stderr).trim()}`,
    );
  }
  return String(result.stdout).trim();
}

function packageVersion(repoRoot: string, packageName: string): string {
  try {
    const value = JSON.parse(
      readFileSync(join(repoRoot, 'node_modules', packageName, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof value.version !== 'string' || value.version === '')
      throw new Error('version missing');
    return `${packageName}@${value.version}`;
  } catch (error) {
    throw new Error(
      `CHECK_RUNNER_TOOLCHAIN_MISSING: ${packageName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function resolveRunnerToolchain(
  repoRoot: string,
  requiredKeys: readonly string[],
): Readonly<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const key of [...new Set(requiredKeys)].sort()) {
    if (key === 'node') resolved[key] = process.version;
    else if (key === 'pnpm') resolved[key] = commandVersion('pnpm', ['--version'], repoRoot);
    else if (key === 'git') resolved[key] = commandVersion('git', ['--version'], repoRoot);
    else if (key === 'eslint') resolved[key] = packageVersion(repoRoot, 'eslint');
    else if (key === 'vitest') resolved[key] = packageVersion(repoRoot, 'vitest');
    else if (key === 'typescript') resolved[key] = packageVersion(repoRoot, 'typescript');
    else if (key === 'postgres') {
      resolved[key] = commandVersion('psql', ['--version'], repoRoot);
    } else {
      throw new Error(`CHECK_RUNNER_TOOLCHAIN_MISSING: unsupported key ${key}`);
    }
  }
  return resolved;
}

export function planWithCache(
  options: CheckRunnerOptions,
  cache: CheckCache,
  toolchain: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string>>,
) {
  const descriptor = descriptorFor(options);
  const reusableDigests = new Map<string, string>();
  const unattested = unattestedNodeIds(options);
  return buildTaskPlan({
    repoRoot: options.repoRoot,
    descriptor,
    target: options.target,
    ...(options.baseCommit !== undefined && { baseCommit: options.baseCommit }),
    ...(options.releaseCandidate !== undefined && { releaseCandidate: options.releaseCandidate }),
    ...(options.releaseRequiredNodes !== undefined && {
      releaseRequiredNodes: options.releaseRequiredNodes,
    }),
    ...(options.releaseAffectedSelection !== undefined && {
      releaseAffectedSelection: options.releaseAffectedSelection,
    }),
    ...(options.releaseTaskBindings !== undefined && {
      releaseTaskBindings: options.releaseTaskBindings,
    }),
    toolchain,
    environment,
    ...(unattested.length > 0 && { unattestedNodes: unattested }),
    ...(options.resolveExecutable === undefined
      ? {}
      : { resolveExecutable: options.resolveExecutable }),
    ...(options.protectedExecutionIdentity === undefined
      ? {}
      : { protectedExecutionIdentity: options.protectedExecutionIdentity }),
    cacheState(task) {
      // The "ready for a pull request" probes always observe the present environment.
      if (unattested.includes(task.nodeId)) {
        return { cacheState: 'execute' as const, reason: 'preflight-always-executes' };
      }
      const dependencies: Record<string, string> = {};
      for (const dependency of task.dependencies) {
        const digest = reusableDigests.get(dependency);
        if (digest === undefined) {
          return { cacheState: 'execute' as const, reason: 'dependency-not-reusable' };
        }
        dependencies[dependency] = digest;
      }
      const inspection = cache.inspect(task as PlannedTask, dependencies);
      if (inspection.cachedResultDigest !== undefined) {
        reusableDigests.set(task.nodeId, inspection.cachedResultDigest);
      }
      return {
        cacheState: inspection.cacheState,
        reason: inspection.reason,
        ...(inspection.cachedResultDigest !== undefined && {
          cachedResultDigest: inspection.cachedResultDigest,
        }),
      };
    },
  });
}

export function requiredTaskNodes(
  options: CheckRunnerOptions,
  releaseScope: 'selected' | 'complete' = 'complete',
): readonly TaskDescriptorNode[] {
  const descriptor = descriptorFor(options);
  // Preflight nodes are selected for every target (ADR-CHK-0001).
  const preflightRoots = descriptor.tasks
    .filter((task) => isPreflightNode(task))
    .map((task) => task.nodeId);
  if (options.target === 'affected') {
    const profile = descriptor.profiles.find((entry) => entry.profileId === 'affected');
    const eligible = new Set([...(profile?.eligibleNodes ?? []), ...preflightRoots]);
    return descriptor.tasks.filter((task) => eligible.has(task.nodeId));
  }
  const roots = [
    ...preflightRoots,
    ...(options.target === 'preflight'
      ? []
      : options.target === 'release'
        ? releaseScope === 'complete'
          ? (options.releaseAllNodes ?? options.releaseRequiredNodes ?? [])
          : (options.releaseRequiredNodes ?? [])
        : options.target === 'local'
          ? [descriptor.fallbackNodeId]
          : (descriptor.profiles.find((entry) => entry.profileId === 'rc')?.requiredNodes ?? [])),
  ];
  const byId = new Map(descriptor.tasks.map((task) => [task.nodeId, task]));
  const selected = new Set<string>();
  const pending = roots.filter((nodeId): nodeId is string => nodeId !== null);
  for (let index = 0; index < pending.length; index += 1) {
    const nodeId = pending[index];
    if (nodeId === undefined || selected.has(nodeId)) continue;
    selected.add(nodeId);
    pending.push(...(byId.get(nodeId)?.dependencies ?? []));
  }
  return descriptor.tasks.filter((task) => selected.has(task.nodeId));
}

function requiredToolchainKeys(options: CheckRunnerOptions): readonly string[] {
  return requiredTaskNodes(options).flatMap((task) => task.toolchainKeys);
}

export function resolvedRunnerToolchain(
  options: CheckRunnerOptions,
): Readonly<Record<string, string>> {
  // A PATH or node_modules resolution is needed to execute a task, but is host
  // state, not portable policy.  Only an explicitly supplied protected
  // executable identity may be included in the task key.
  return resolveRunnerToolchain(options.repoRoot, requiredToolchainKeys(options));
}

export function requiredEnvironmentKeys(options: CheckRunnerOptions): readonly string[] {
  return requiredTaskNodes(options, 'selected').flatMap((task) => task.allowlistedEnv);
}

export function taskEnvironment(
  task: TaskDescriptorNode,
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const key of task.allowlistedEnv) {
    const value = environment[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}
