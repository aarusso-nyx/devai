import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sha256Hex } from './canonical.js';
import type { PlannedTask, TaskDescriptor, TaskPlan, TaskPolicy, TaskTarget } from './types.js';
import { resolveMutationOutputContract } from './mutation-output.js';
import { PREFLIGHT_RUNNER } from './preflight.js';

import { resolveTaskExecutable, taskExecutableFromToolchain } from './executable.js';
import {
  currentRepositoryState,
  exactCandidateRepositoryState,
  assertCommit,
  gitText,
  changedPaths,
  projectChangedPaths,
  committedSnapshot,
  worktreeSnapshot,
  isHarnessMutatedPath,
  RELEASE_INPUT_PROJECTION,
} from './policy-git.js';
import { CHANGE_TAXONOMY_BINDING_PATHS } from '../change-taxonomy.js';
import {
  type PathClassifier,
  anySelectorMatches,
  selectorMatches,
  isPreflightNode,
  withoutMutationTestTasks,
  descriptorClassifier,
  taxonomyClassifier,
  taskDescriptorDigest,
  topologicalTasks,
} from './policy-descriptor.js';
export {
  type PathClassifier,
  selectorMatches,
  isPreflightNode,
  withSyntheticNode,
  withoutMutationTestTasks,
  taskDescriptorDigest,
  parseTaskDescriptor,
  readTaskDescriptor,
} from './policy-descriptor.js';
export {
  readPreflightGitText,
  trackedPaths,
  currentRepositoryState,
  exactCommitTree,
  exactCommitFile,
  exactCandidateRepositoryState,
  projectChangedPaths,
} from './policy-git.js';

/** Repository-relative path of the adopter toolchain manifest (ADR-CHK-0002). */
export const TOOLCHAIN_MANIFEST_PATH = '.devai/config/toolchain.json';

/**
 * SHA-256 of the canonical bytes of the toolchain manifest under repoRoot, or
 * undefined when the repository carries no manifest. Canonicalizing first makes
 * the digest independent of whitespace and key order, so only a semantic
 * manifest edit changes it.
 */
export function toolchainManifestDigest(repoRoot: string): string | undefined {
  const path = join(repoRoot, TOOLCHAIN_MANIFEST_PATH);
  if (!existsSync(path)) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `CHECK_RUNNER_TOOLCHAIN_MANIFEST_INVALID: ${TOOLCHAIN_MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return sha256Hex(manifest);
}

/**
 * The toolchain digest the runner binds into release preflight receipts: the
 * resolved toolchain record (versions and protected executable identities)
 * together with the canonical manifest digest when a manifest is present.
 */
export function runnerToolchainDigest(
  repoRoot: string,
  toolchain: Readonly<Record<string, string>>,
): string {
  const manifestDigest = toolchainManifestDigest(repoRoot);
  return manifestDigest === undefined
    ? sha256Hex(toolchain)
    : sha256Hex({ toolchain, toolchainManifestSha256: manifestDigest });
}

interface PolicyBuildOptions {
  readonly repoRoot: string;
  readonly descriptor: TaskDescriptor;
  readonly target: TaskTarget;
  readonly baseCommit?: string;
  readonly releaseCandidate?: Readonly<{ commit: string; tree: string }>;
  readonly releaseRequiredNodes?: readonly string[];
  /** Internal exact-node consumers; closes dependencies without selecting downstream nodes. */
  readonly selectedTaskNodes?: readonly string[];
  readonly releaseAffectedSelection?: boolean;
  readonly releaseTaskBindings?: Readonly<Record<string, unknown>>;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly resolveExecutable?: (name: string) => Readonly<{ path: string; sha256: string }>;
  readonly protectedExecutionIdentity?: Readonly<Record<string, unknown>>;
  /** Planned nodes that stay outside the task policy (the adopter preflight root). */
  readonly unattestedNodes?: readonly string[];
  readonly cacheState: (
    task: Readonly<
      Pick<
        PlannedTask,
        | 'nodeId'
        | 'taskKey'
        | 'dependencies'
        | 'argv'
        | 'cwd'
        | 'inputDigest'
        | 'inputPaths'
        | 'matchedChangedPaths'
        | 'outputContract'
      >
    >,
  ) => Readonly<{
    cacheState: 'reusable' | 'execute' | 'stale';
    reason: string;
    cachedResultDigest?: string;
  }>;
}

/**
 * The fixed descriptor profile the affected target plans when every changed
 * path classifies as plan (ADR-CHK-0003).
 */
export const PLANNING_LANE_PROFILE = 'planning';

/** The only change class the planning lane admits. */
const PLANNING_LANE_CLASS = 'plan';

/** Name-status letters the planning lane admits: added and modified paths only. */
const PLANNING_LANE_STATUSES = new Set(['A', 'M']);

type ChangedEntry = Readonly<{ status: string; path: string }>;

/**
 * Changed entries with their Git status, through the same closed Git grammar
 * as changedPaths. A rename or copy is reported under its own status, and
 * untracked worktree paths count as additions.
 */
function changedEntries(
  repoRoot: string,
  base: string,
  candidate: string,
  clean: boolean,
): readonly ChangedEntry[] {
  const fields = gitText(repoRoot, [
    'diff',
    '--name-status',
    '-z',
    '-M',
    '--find-renames',
    base,
    clean ? candidate : '--',
  ]).split('\0');
  const entries: ChangedEntry[] = [];
  let index = 0;
  while (index < fields.length && fields[index] !== '') {
    const status = fields[index++] ?? '';
    const paths = /^[RC]/u.test(status) ? 2 : 1;
    for (let offset = 0; offset < paths; offset += 1) {
      const path = fields[index++];
      if (path === undefined) throw new Error('CHECK_RUNNER_GIT: change truncated');
      entries.push({ status: status.charAt(0), path });
    }
  }
  if (!clean) {
    gitText(repoRoot, ['ls-files', '-z', '--others', '--exclude-standard'])
      .split('\0')
      .filter((path) => path !== '')
      .forEach((path) => entries.push({ status: 'A', path }));
  }
  return entries;
}

/**
 * Classifier over the change-taxonomy binding committed at the base, so a
 * candidate cannot move its own paths into the plan class. An unreadable or
 * malformed base binding classifies nothing.
 */
function baseCommitClassifier(repoRoot: string, base: string): PathClassifier {
  let bindings: readonly Readonly<{
    selector: Readonly<{ kind: 'exact' | 'prefix' | 'glob'; pattern: string }>;
    class: string;
  }>[] = [];
  for (const path of CHANGE_TAXONOMY_BINDING_PATHS) {
    let text: string;
    try {
      text = gitText(repoRoot, ['cat-file', 'blob', `${base}:${path}`]);
    } catch {
      continue;
    }
    try {
      const document = JSON.parse(text) as { bindings?: unknown };
      if (Array.isArray(document.bindings)) bindings = document.bindings as typeof bindings;
    } catch {
      bindings = [];
    }
    break;
  }
  return (path) => {
    const hits = bindings.filter(
      (entry) =>
        typeof entry.selector?.pattern === 'string' && selectorMatches(entry.selector, path),
    );
    return hits.length === 1 ? hits[0]?.class : undefined;
  };
}

/**
 * True when the affected target should plan the planning lane: the descriptor
 * declares the planning profile, the diff is not empty, every changed path is
 * an addition or modification, and every path classifies as plan under both
 * the candidate's and the base's taxonomy binding. A rename, a deletion, or
 * any path of another class falls back to the affected profile. The candidate
 * classifier is loaded only once the lane is otherwise eligible, whether or not
 * the descriptor holds a class selector (ADR-CHK-0006); a taxonomy that cannot
 * be loaded classifies nothing, so the affected profile is planned.
 */
function selectsPlanningLane(
  descriptor: TaskDescriptor,
  entries: readonly ChangedEntry[],
  loadCandidateClassifier: () => PathClassifier | undefined,
  baseClassifier: () => PathClassifier,
): boolean {
  const profile = descriptor.profiles.find((entry) => entry.profileId === PLANNING_LANE_PROFILE);
  if (profile?.mode !== 'fixed' || entries.length === 0) return false;
  if (entries.some((entry) => !PLANNING_LANE_STATUSES.has(entry.status))) return false;
  let candidateClassifier: PathClassifier | undefined;
  try {
    candidateClassifier = loadCandidateClassifier();
  } catch {
    return false;
  }
  if (candidateClassifier === undefined) return false;
  if (entries.some((entry) => candidateClassifier(entry.path) !== PLANNING_LANE_CLASS)) {
    return false;
  }
  const atBase = baseClassifier();
  return entries.every((entry) => atBase(entry.path) === PLANNING_LANE_CLASS);
}

function selectedNodeIds(
  descriptor: TaskDescriptor,
  target: TaskTarget | typeof PLANNING_LANE_PROFILE,
  changes: readonly string[],
  releaseRequiredNodes: readonly string[] = [],
  releaseAffectedSelection = false,
  classifyPath?: PathClassifier,
): Set<string> {
  const selected = new Set<string>();
  const impacted = new Set<string>();
  if (target === 'preflight') {
    // Only the probe nodes and their dependencies.
  } else if (target === 'release') {
    if (releaseRequiredNodes.length === 0) {
      throw new Error('CHECK_RELEASE_PROFILE_TASKS_REQUIRED');
    }
    releaseRequiredNodes.forEach((nodeId) => selected.add(nodeId));
  } else if (target === 'local') {
    if (!descriptor.tasks.some((task) => task.nodeId === 'test:local-full')) {
      throw new Error(
        'CHECK_RUNNER_DESCRIPTOR: local target requires a node named test:local-full (the local-closure root); declare it in test-tasks.json or use --rc / --affected',
      );
    }
    selected.add('test:local-full');
  } else {
    const profile = descriptor.profiles.find((entry) => entry.profileId === target);
    if (profile === undefined) throw new Error(`CHECK_RUNNER_PROFILE: unknown target ${target}`);
    profile.requiredNodes.forEach((nodeId) => selected.add(nodeId));
    if (profile.mode === 'affected') {
      const eligible = new Set(profile.eligibleNodes ?? []);
      for (const path of changes) {
        if (anySelectorMatches(descriptor.dynamicFallbackSelectors, path, classifyPath)) {
          if (descriptor.fallbackNodeId === null) throw new Error('CHECK_RUNNER_UNKNOWN_PATH');
          impacted.add(descriptor.fallbackNodeId);
          continue;
        }
        const matches = descriptor.tasks.filter(
          (task) =>
            eligible.has(task.nodeId) &&
            task.nodeId !== descriptor.fallbackNodeId &&
            anySelectorMatches(task.inputSelectors, path, classifyPath),
        );
        if (matches.length === 0) {
          if (descriptor.fallbackNodeId === null) {
            throw new Error(`CHECK_RUNNER_UNKNOWN_PATH: ${path}`);
          }
          impacted.add(descriptor.fallbackNodeId);
        } else {
          matches.forEach((task) => impacted.add(task.nodeId));
        }
      }
    }
  }

  if (target === 'release' && releaseAffectedSelection) {
    const affectedProfile = descriptor.profiles.find((entry) => entry.profileId === 'affected');
    if (affectedProfile?.mode !== 'affected') {
      throw new Error('CHECK_RELEASE_AFFECTED_PROFILE_REQUIRED');
    }
    const eligible = new Set(affectedProfile.eligibleNodes ?? []);
    for (const path of changes) {
      if (anySelectorMatches(descriptor.dynamicFallbackSelectors, path, classifyPath)) {
        if (descriptor.fallbackNodeId === null) throw new Error('CHECK_RUNNER_UNKNOWN_PATH');
        impacted.add(descriptor.fallbackNodeId);
        continue;
      }
      const matches = descriptor.tasks.filter(
        (task) =>
          eligible.has(task.nodeId) &&
          task.nodeId !== descriptor.fallbackNodeId &&
          anySelectorMatches(task.inputSelectors, path, classifyPath),
      );
      if (matches.length === 0) {
        if (descriptor.fallbackNodeId === null)
          throw new Error(`CHECK_RUNNER_UNKNOWN_PATH: ${path}`);
        impacted.add(descriptor.fallbackNodeId);
      } else {
        matches.forEach((task) => impacted.add(task.nodeId));
      }
    }
  }

  const dependents = new Map(descriptor.tasks.map((task) => [task.nodeId, [] as string[]]));
  descriptor.tasks.forEach((task) =>
    task.dependencies.forEach((dependency) => dependents.get(dependency)?.push(task.nodeId)),
  );
  const downstream = [...impacted];
  for (let index = 0; index < downstream.length; index += 1) {
    const nodeId = downstream[index];
    if (nodeId === undefined) continue;
    selected.add(nodeId);
    for (const dependent of dependents.get(nodeId) ?? []) {
      const profile = descriptor.profiles.find((entry) =>
        target === 'release' && releaseAffectedSelection
          ? entry.profileId === 'affected'
          : entry.profileId === target,
      );
      const eligible = profile?.mode === 'affected' ? new Set(profile.eligibleNodes ?? []) : null;
      const aggregateFallback = dependent === descriptor.fallbackNodeId;
      if (
        !aggregateFallback &&
        (eligible === null || eligible.has(dependent)) &&
        !impacted.has(dependent)
      ) {
        impacted.add(dependent);
        downstream.push(dependent);
      }
    }
  }
  // Preflight nodes are selected unconditionally for every target (ADR-CHK-0001).
  descriptor.tasks
    .filter((task) => isPreflightNode(task))
    .forEach((task) => selected.add(task.nodeId));
  const byId = new Map(descriptor.tasks.map((task) => [task.nodeId, task]));
  const dependencies = [...selected];
  for (let index = 0; index < dependencies.length; index += 1) {
    const task = byId.get(dependencies[index] ?? '');
    if (task === undefined) throw new Error('CHECK_RUNNER_DESCRIPTOR: selected task missing');
    for (const dependency of task.dependencies) {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        dependencies.push(dependency);
      }
    }
  }
  return selected;
}

export function buildTaskPlan(options: PolicyBuildOptions): TaskPlan {
  const { repoRoot, target, toolchain, environment } = options;
  const descriptor = withoutMutationTestTasks(options.descriptor);
  const repositoryState =
    options.releaseCandidate === undefined
      ? currentRepositoryState(repoRoot)
      : exactCandidateRepositoryState(repoRoot, options.releaseCandidate);
  const { commit, tree, clean } = repositoryState;
  if (target === 'release' && !clean) {
    throw new Error('CHECK_RELEASE_CANDIDATE_WORKTREE_MISMATCH');
  }
  let changes: readonly string[] = [];
  let entriesWithStatus: readonly ChangedEntry[] = [];
  if (target === 'affected' || target === 'release') {
    if (options.baseCommit === undefined) {
      throw new Error('CHECK_RUNNER_BASE_REQUIRED: affected and release targets require --base');
    }
    assertCommit(repoRoot, options.baseCommit, 'BASE');
    try {
      const ancestor = gitText(repoRoot, ['merge-base', options.baseCommit, commit]).trim();
      if (ancestor !== options.baseCommit) throw new Error('CHECK_RUNNER_BASE_NOT_ANCESTOR');
    } catch {
      throw new Error('CHECK_RUNNER_BASE_NOT_ANCESTOR');
    }
    changes = changedPaths(repoRoot, options.baseCommit, commit, clean);
    if (target === 'affected') {
      entriesWithStatus = changedEntries(repoRoot, options.baseCommit, commit, clean);
    }
  } else if (target === 'preflight' && options.baseCommit !== undefined) {
    assertCommit(repoRoot, options.baseCommit, 'BASE');
    if (!clean) changes = changedPaths(repoRoot, commit, commit, false);
  } else if (!clean) {
    changes = changedPaths(repoRoot, commit, commit, false);
  }
  changes = projectChangedPaths(changes);
  const entries = (clean ? committedSnapshot(repoRoot, commit) : worktreeSnapshot(repoRoot)).filter(
    (entry) => !isHarnessMutatedPath(entry.path),
  );
  const classifyPath = descriptorClassifier(repoRoot, descriptor);
  const baseCommit = options.baseCommit;
  const planningLane =
    target === 'affected' &&
    baseCommit !== undefined &&
    selectsPlanningLane(
      descriptor,
      entriesWithStatus,
      () => classifyPath ?? taxonomyClassifier(repoRoot),
      () => baseCommitClassifier(repoRoot, baseCommit),
    );
  const selected =
    options.selectedTaskNodes === undefined
      ? selectedNodeIds(
          descriptor,
          planningLane ? PLANNING_LANE_PROFILE : target,
          changes,
          options.releaseRequiredNodes?.filter(
            (node) =>
              !options.descriptor.tasks.some((task) => task.nodeId === node) ||
              descriptor.tasks.some((task) => task.nodeId === node),
          ),
          options.releaseAffectedSelection,
          classifyPath,
        )
      : new Set(options.selectedTaskNodes);
  if (options.selectedTaskNodes !== undefined) {
    const byId = new Map(descriptor.tasks.map((task) => [task.nodeId, task]));
    const pending = [...selected];
    for (let index = 0; index < pending.length; index += 1) {
      const task = byId.get(pending[index] ?? '');
      if (task === undefined) throw new Error('CHECK_RUNNER_DESCRIPTOR: selected task missing');
      for (const dependency of task.dependencies) {
        if (!selected.has(dependency)) {
          selected.add(dependency);
          pending.push(dependency);
        }
      }
    }
  }
  const descriptorDigest = taskDescriptorDigest(options.descriptor);
  const ordered = topologicalTasks(descriptor);
  const outputContracts = new Map(
    ordered.map((task) => [
      task.nodeId,
      resolveMutationOutputContract(repoRoot, task.outputContract),
    ]),
  );
  const taskKeys = new Map<string, string>();
  const plannedById = new Map<
    string,
    Omit<PlannedTask, 'cacheState' | 'reason' | 'cachedResultDigest'>
  >();
  for (const task of ordered) {
    if (!selected.has(task.nodeId)) continue;
    const selectedToolchain: Record<string, string> = {};
    for (const key of [...task.toolchainKeys].sort()) {
      const value = toolchain[key];
      if (value === undefined) throw new Error(`CHECK_RUNNER_TOOLCHAIN_MISSING: ${key}`);
      selectedToolchain[key] = value;
    }
    const selectedEnvironment: Record<string, string | null> = {};
    for (const key of [...task.allowlistedEnv].sort()) {
      selectedEnvironment[key] =
        environment[key] === undefined
          ? null
          : `sha256:${sha256Hex(Buffer.from(environment[key], 'utf8'))}`;
    }
    const inputs = entries.filter((entry) =>
      anySelectorMatches(task.inputSelectors, entry.path, classifyPath),
    );
    const dependencies = task.dependencies.map((nodeId) => ({
      nodeId,
      taskKey: taskKeys.get(nodeId),
    }));
    const preflight = isPreflightNode(task);
    const executableName = task.argv[0] ?? '';
    const protectedExecutable = preflight
      ? undefined
      : taskExecutableFromToolchain(toolchain, executableName);
    // A preflight node executes no declared program; its identity is its probe list.
    const executable = preflight
      ? { path: PREFLIGHT_RUNNER, sha256: sha256Hex(task.probes ?? []) }
      : (options.resolveExecutable?.(executableName) ??
        resolveTaskExecutable(repoRoot, executableName));
    if (
      protectedExecutable !== undefined &&
      (protectedExecutable.path !== executable.path ||
        protectedExecutable.sha256 !== executable.sha256)
    ) {
      throw new Error(`CHECK_RUNNER_EXECUTABLE_IDENTITY_MISMATCH: ${executableName}`);
    }
    const releaseBinding = options.releaseTaskBindings?.[task.nodeId];
    const taskKey = sha256Hex({
      schemaVersion: '1.0.0',
      descriptorDigest,
      descriptorVersion: descriptor.descriptorVersion,
      nodeId: task.nodeId,
      argv: task.argv,
      ...(preflight && { probes: task.probes, base: options.baseCommit ?? null }),
      ...(protectedExecutable === undefined ? {} : { executable: protectedExecutable }),
      cwd: task.cwd,
      runner: task.runner,
      toolchain: selectedToolchain,
      environment: selectedEnvironment,
      outputContract: outputContracts.get(task.nodeId),
      ...(releaseBinding === undefined ? {} : { releaseBinding }),
      ...(options.protectedExecutionIdentity === undefined
        ? {}
        : { protectedExecutionIdentity: options.protectedExecutionIdentity }),
      inputs,
      dependencies,
    });
    taskKeys.set(task.nodeId, taskKey);
    plannedById.set(task.nodeId, {
      nodeId: task.nodeId,
      taskKey,
      dependencies: [...task.dependencies],
      argv: [...task.argv],
      executable,
      cwd: task.cwd,
      inputDigest: sha256Hex({
        inputs,
        executable,
        toolchain: selectedToolchain,
        environment: selectedEnvironment,
      }),
      inputPaths: inputs.map((entry) => entry.path),
      matchedChangedPaths: changes.filter((path) =>
        anySelectorMatches(task.inputSelectors, path, classifyPath),
      ),
      outputContract: outputContracts.get(task.nodeId) ?? task.outputContract,
    });
  }
  const tasks = ordered
    .filter((task) => selected.has(task.nodeId))
    .map((task): PlannedTask => {
      const planned = plannedById.get(task.nodeId);
      if (planned === undefined) throw new Error('CHECK_RUNNER_INTERNAL: missing planned task');
      return { ...planned, ...options.cacheState(planned) };
    });
  const taskPolicy: TaskPolicy = {
    // v1.1 stays byte-compatible for non-release checks. The canonical verifier
    // accepts inputProjection only in the explicitly forward v1.2 release form.
    schemaVersion: target === 'release' ? '1.2.0' : '1.1.0',
    repositoryId: descriptor.repositoryId,
    requiredNodes: tasks
      .filter((task) => !(options.unattestedNodes ?? []).includes(task.nodeId))
      .map(({ nodeId, taskKey, dependencies, outputContract }) => ({
        nodeId,
        taskKey,
        dependencies,
        outputContract,
      })),
    ...(target === 'release' && {
      inputProjection: {
        ...RELEASE_INPUT_PROJECTION,
        digest: sha256Hex(entries),
      },
    }),
  };
  return {
    schemaVersion: '1.0.0',
    repository: { id: descriptor.repositoryId, commit, tree },
    target,
    clean,
    ...(options.baseCommit !== undefined && { baseCommit: options.baseCommit }),
    descriptorDigest,
    taskPolicy,
    taskPolicyDigest: sha256Hex(taskPolicy),
    changedPaths: changes,
    tasks,
  };
}
