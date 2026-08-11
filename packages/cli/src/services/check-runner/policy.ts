import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from '@devai-nyx/authority';
import { sha256Hex } from './canonical.js';
import type {
  InputSelector,
  PlannedTask,
  TaskDescriptor,
  TaskDescriptorNode,
  TaskPlan,
  TaskPolicy,
  TaskTarget,
} from './types.js';

const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

interface SnapshotEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly contentDigest: string;
}

interface PolicyBuildOptions {
  readonly repoRoot: string;
  readonly descriptor: TaskDescriptor;
  readonly target: TaskTarget;
  readonly baseCommit?: string;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly environment: Readonly<Record<string, string>>;
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

function git(
  repoRoot: string,
  args: readonly string[],
  options: Readonly<{
    encoding?: BufferEncoding | null;
    allowFailure?: boolean;
    input?: string | Buffer;
  }> = {},
): string | Buffer {
  const encoding = options.encoding === null ? null : (options.encoding ?? 'utf8');
  const result = spawnSync('git', [...args], {
    cwd: repoRoot,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    ...(options.input !== undefined && { input: options.input }),
  });
  if (result.error !== undefined || (result.status !== 0 && options.allowFailure !== true)) {
    const detail = result.error?.message ?? String(result.stderr || result.stdout).trim();
    throw new Error(`CHECK_RUNNER_GIT: git ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout ?? (encoding === null ? Buffer.alloc(0) : '');
}

function objectContentDigests(
  repoRoot: string,
  objectIds: readonly string[],
): ReadonlyMap<string, string> {
  const unique = [...new Set(objectIds)].sort();
  if (unique.length === 0) return new Map();
  const output = Buffer.from(
    git(repoRoot, ['cat-file', '--batch'], {
      encoding: null,
      input: `${unique.join('\n')}\n`,
    }),
  );
  const digests = new Map<string, string>();
  let offset = 0;
  for (const expectedObjectId of unique) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error('CHECK_RUNNER_GIT: truncated cat-file header');
    const header = output.subarray(offset, newline).toString('utf8');
    const match = /^([0-9a-f]+) ([a-z]+) (\d+)$/u.exec(header);
    if (match?.[1] === undefined || match[3] === undefined || match[1] !== expectedObjectId) {
      throw new Error('CHECK_RUNNER_GIT: unexpected cat-file header');
    }
    const size = Number(match[3]);
    const contentStart = newline + 1;
    const contentEnd = contentStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || output[contentEnd] !== 0x0a) {
      throw new Error('CHECK_RUNNER_GIT: truncated cat-file content');
    }
    digests.set(expectedObjectId, sha256Hex(output.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }
  if (offset !== output.length) throw new Error('CHECK_RUNNER_GIT: extra cat-file output');
  return digests;
}

function gitText(repoRoot: string, args: readonly string[]): string {
  return String(git(repoRoot, args));
}

function assertCommit(repoRoot: string, value: string, label: string): void {
  if (!GIT_OBJECT.test(value)) throw new Error(`CHECK_RUNNER_${label}: exact commit required`);
  const resolved = gitText(repoRoot, ['rev-parse', '--verify', `${value}^{commit}`]).trim();
  if (resolved !== value) throw new Error(`CHECK_RUNNER_${label}: commit does not resolve exactly`);
}

function normalizePath(value: string): string {
  if (
    value === '' ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(`CHECK_RUNNER_PATH: non-canonical repository path ${value}`);
  }
  return value;
}

function globExpression(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          expression += '(?:.*/)?';
          index += 1;
        } else {
          expression += '.*';
        }
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
  }
  return new RegExp(`${expression}$`, 'u');
}

export function selectorMatches(selector: InputSelector, path: string): boolean {
  if (selector.kind === 'exact') return path === selector.pattern;
  if (selector.kind === 'prefix') return path.startsWith(selector.pattern);
  return globExpression(selector.pattern).test(path);
}

function validateDescriptor(value: unknown): TaskDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CHECK_RUNNER_DESCRIPTOR: descriptor must be an object');
  }
  const descriptor = value as TaskDescriptor;
  if (
    descriptor.schemaVersion !== '1.0.0' ||
    typeof descriptor.descriptorVersion !== 'string' ||
    typeof descriptor.repositoryId !== 'string' ||
    !Array.isArray(descriptor.tasks) ||
    descriptor.tasks.length === 0 ||
    !Array.isArray(descriptor.profiles) ||
    !Array.isArray(descriptor.dynamicFallbackSelectors)
  ) {
    throw new Error('CHECK_RUNNER_DESCRIPTOR: unsupported or malformed descriptor');
  }
  const ids = new Set<string>();
  for (const task of descriptor.tasks) {
    if (
      typeof task.nodeId !== 'string' ||
      ids.has(task.nodeId) ||
      !Array.isArray(task.dependencies) ||
      !Array.isArray(task.argv) ||
      task.argv.length === 0 ||
      !Array.isArray(task.inputSelectors) ||
      task.inputSelectors.length === 0 ||
      !Array.isArray(task.toolchainKeys) ||
      !Array.isArray(task.allowlistedEnv) ||
      task.outputContract === null ||
      typeof task.outputContract !== 'object' ||
      Array.isArray(task.outputContract)
    ) {
      throw new Error(`CHECK_RUNNER_DESCRIPTOR: malformed task ${task.nodeId ?? '<unknown>'}`);
    }
    const outputPaths = task.outputContract.paths;
    if (
      outputPaths !== undefined &&
      (!Array.isArray(outputPaths) ||
        outputPaths.length === 0 ||
        outputPaths.some((path) => typeof path !== 'string' || normalizePath(path) !== path) ||
        new Set(outputPaths).size !== outputPaths.length)
    ) {
      throw new Error(`CHECK_RUNNER_DESCRIPTOR: malformed output paths for ${task.nodeId}`);
    }
    ids.add(task.nodeId);
  }
  if (descriptor.fallbackNodeId !== null && !ids.has(descriptor.fallbackNodeId)) {
    throw new Error('CHECK_RUNNER_DESCRIPTOR: unknown fallback node');
  }
  for (const task of descriptor.tasks) {
    if ((task.dependencies as readonly string[]).some((dependency) => !ids.has(dependency))) {
      throw new Error(`CHECK_RUNNER_DESCRIPTOR: ${task.nodeId} has an unknown dependency`);
    }
  }
  for (const profile of descriptor.profiles) {
    if (
      typeof profile.profileId !== 'string' ||
      (profile.mode !== 'affected' && profile.mode !== 'fixed') ||
      !Array.isArray(profile.requiredNodes) ||
      (profile.mode === 'affected' && !Array.isArray(profile.eligibleNodes)) ||
      (profile.mode === 'fixed' && profile.eligibleNodes !== undefined)
    ) {
      throw new Error(
        `CHECK_RUNNER_DESCRIPTOR: malformed profile ${profile.profileId ?? '<unknown>'}`,
      );
    }
    const requiredNodes = profile.requiredNodes as readonly string[];
    const eligible = new Set<string>((profile.eligibleNodes ?? []) as readonly string[]);
    for (const nodeId of [...requiredNodes, ...eligible]) {
      if (!ids.has(nodeId)) {
        throw new Error(`CHECK_RUNNER_DESCRIPTOR: profile ${profile.profileId} names unknown node`);
      }
    }
    if (
      profile.mode === 'affected' &&
      (requiredNodes.some((nodeId) => !eligible.has(nodeId)) ||
        (descriptor.fallbackNodeId !== null && !eligible.has(descriptor.fallbackNodeId)) ||
        descriptor.tasks.some(
          (task) =>
            eligible.has(task.nodeId) &&
            (task.dependencies as readonly string[]).some(
              (dependency) => !eligible.has(dependency),
            ),
        ))
    ) {
      throw new Error(
        `CHECK_RUNNER_DESCRIPTOR: affected profile ${profile.profileId} is not closed`,
      );
    }
  }
  topologicalTasks(descriptor);
  return descriptor;
}

export function readTaskDescriptor(path: string): TaskDescriptor {
  try {
    return validateDescriptor(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CHECK_RUNNER_DESCRIPTOR:')) throw error;
    throw new Error(
      `CHECK_RUNNER_DESCRIPTOR: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function topologicalTasks(descriptor: TaskDescriptor): readonly TaskDescriptorNode[] {
  const byId = new Map(descriptor.tasks.map((task) => [task.nodeId, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: TaskDescriptorNode[] = [];
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw new Error(`CHECK_RUNNER_DESCRIPTOR: cycle at ${nodeId}`);
    if (visited.has(nodeId)) return;
    const task = byId.get(nodeId);
    if (task === undefined) throw new Error(`CHECK_RUNNER_DESCRIPTOR: unknown node ${nodeId}`);
    visiting.add(nodeId);
    task.dependencies.forEach(visit);
    visiting.delete(nodeId);
    visited.add(nodeId);
    ordered.push(task);
  };
  descriptor.tasks.forEach((task) => visit(task.nodeId));
  return ordered;
}

function cleanStatus(repoRoot: string): boolean {
  return gitText(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']) === '';
}

function committedSnapshot(repoRoot: string, commit: string): readonly SnapshotEntry[] {
  const output = git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', commit], { encoding: null });
  const rawEntries: Array<
    Readonly<{ path: string; mode: string; type: string; objectId: string }>
  > = [];
  for (const record of Buffer.from(output).toString('utf8').split('\0')) {
    if (record === '') continue;
    const match = /^(\d+) ([a-z]+) ([0-9a-f]+)\t(.+)$/u.exec(record);
    if (match === null) throw new Error('CHECK_RUNNER_GIT: malformed ls-tree record');
    const [, mode, type, objectId, rawPath] = match;
    if (
      mode === undefined ||
      type === undefined ||
      objectId === undefined ||
      rawPath === undefined
    ) {
      throw new Error('CHECK_RUNNER_GIT: incomplete ls-tree record');
    }
    const path = normalizePath(rawPath);
    rawEntries.push({ path, mode, type, objectId });
  }
  const contentDigests = objectContentDigests(
    repoRoot,
    rawEntries.map((entry) => entry.objectId),
  );
  const entries: SnapshotEntry[] = rawEntries.map(({ path, mode, type, objectId }) => {
    const contentDigest = contentDigests.get(objectId);
    if (contentDigest === undefined) throw new Error('CHECK_RUNNER_GIT: object digest missing');
    return { path, mode, type, contentDigest };
  });
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function worktreeSnapshot(repoRoot: string): readonly SnapshotEntry[] {
  const staged = Buffer.from(git(repoRoot, ['ls-files', '-s', '-z'], { encoding: null }))
    .toString('utf8')
    .split('\0');
  const modes = new Map<string, string>();
  for (const record of staged) {
    if (record === '') continue;
    const match = /^(\d+) [0-9a-f]+ \d+\t(.+)$/u.exec(record);
    if (match?.[1] !== undefined && match[2] !== undefined) modes.set(match[2], match[1]);
  }
  const listed = Buffer.from(
    git(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: null,
    }),
  )
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '');
  const entries: SnapshotEntry[] = [];
  for (const rawPath of listed) {
    const path = normalizePath(rawPath);
    const absolute = join(repoRoot, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    const content = stat.isSymbolicLink()
      ? Buffer.from(readlinkSync(absolute), 'utf8')
      : readFileSync(absolute);
    const mode = stat.isSymbolicLink()
      ? '120000'
      : (modes.get(path) ?? (stat.mode & 0o111 ? '100755' : '100644'));
    entries.push({ path, mode, type: 'blob', contentDigest: sha256Hex(content) });
  }
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function parseChangedPaths(output: Buffer): readonly string[] {
  const fields = output.toString('utf8').split('\0');
  const paths = new Set<string>();
  let index = 0;
  while (index < fields.length && fields[index] !== '') {
    const status = fields[index++];
    if (status === undefined) break;
    if (/^[RC]\d+$/u.test(status)) {
      const before = fields[index++];
      const after = fields[index++];
      if (before === undefined || after === undefined)
        throw new Error('CHECK_RUNNER_GIT: rename truncated');
      paths.add(normalizePath(before));
      paths.add(normalizePath(after));
    } else {
      const path = fields[index++];
      if (path === undefined) throw new Error('CHECK_RUNNER_GIT: change truncated');
      paths.add(normalizePath(path));
    }
  }
  return [...paths].sort();
}

function changedPaths(
  repoRoot: string,
  base: string,
  candidate: string,
  clean: boolean,
): readonly string[] {
  const args = clean
    ? ['diff', '--name-status', '-z', '-M', '--find-renames', base, candidate]
    : ['diff', '--name-status', '-z', '-M', '--find-renames', base, '--'];
  const paths = new Set(parseChangedPaths(Buffer.from(git(repoRoot, args, { encoding: null }))));
  if (!clean) {
    const untracked = Buffer.from(
      git(repoRoot, ['ls-files', '-z', '--others', '--exclude-standard'], { encoding: null }),
    )
      .toString('utf8')
      .split('\0')
      .filter((path) => path !== '');
    untracked.forEach((path) => paths.add(normalizePath(path)));
  }
  return [...paths].sort();
}

function selectedNodeIds(
  descriptor: TaskDescriptor,
  target: TaskTarget,
  changes: readonly string[],
): Set<string> {
  const selected = new Set<string>();
  const impacted = new Set<string>();
  if (target === 'local') {
    if (!descriptor.tasks.some((task) => task.nodeId === 'test:local-full')) {
      throw new Error('CHECK_RUNNER_DESCRIPTOR: local target requires test:local-full');
    }
    selected.add('test:local-full');
  } else {
    const profile = descriptor.profiles.find((entry) => entry.profileId === target);
    if (profile === undefined) throw new Error(`CHECK_RUNNER_PROFILE: unknown target ${target}`);
    profile.requiredNodes.forEach((nodeId) => selected.add(nodeId));
    if (profile.mode === 'affected') {
      const eligible = new Set(profile.eligibleNodes ?? []);
      for (const path of changes) {
        if (
          descriptor.dynamicFallbackSelectors.some((selector) => selectorMatches(selector, path))
        ) {
          if (descriptor.fallbackNodeId === null) throw new Error('CHECK_RUNNER_UNKNOWN_PATH');
          impacted.add(descriptor.fallbackNodeId);
          continue;
        }
        const matches = descriptor.tasks.filter(
          (task) =>
            eligible.has(task.nodeId) &&
            task.nodeId !== descriptor.fallbackNodeId &&
            task.inputSelectors.some((selector) => selectorMatches(selector, path)),
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
      const profile = descriptor.profiles.find((entry) => entry.profileId === target);
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
  const { repoRoot, descriptor, target, toolchain, environment } = options;
  const commit = gitText(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  assertCommit(repoRoot, commit, 'HEAD');
  const tree = gitText(repoRoot, ['rev-parse', '--verify', `${commit}^{tree}`]).trim();
  const clean = cleanStatus(repoRoot);
  let changes: readonly string[] = [];
  if (target === 'affected') {
    if (options.baseCommit === undefined) {
      throw new Error('CHECK_RUNNER_BASE_REQUIRED: --affected requires --base');
    }
    assertCommit(repoRoot, options.baseCommit, 'BASE');
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', options.baseCommit, commit], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (ancestor.status !== 0) throw new Error('CHECK_RUNNER_BASE_NOT_ANCESTOR');
    changes = changedPaths(repoRoot, options.baseCommit, commit, clean);
  } else if (!clean) {
    changes = changedPaths(repoRoot, commit, commit, false);
  }
  const selected = selectedNodeIds(descriptor, target, changes);
  const entries = clean ? committedSnapshot(repoRoot, commit) : worktreeSnapshot(repoRoot);
  const descriptorDigest = sha256Hex(descriptor);
  const taskKeys = new Map<string, string>();
  const plannedById = new Map<
    string,
    Omit<PlannedTask, 'cacheState' | 'reason' | 'cachedResultDigest'>
  >();
  const ordered = topologicalTasks(descriptor);
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
      selectedEnvironment[key] = environment[key] ?? null;
    }
    const inputs = entries.filter((entry) =>
      task.inputSelectors.some((selector) => selectorMatches(selector, entry.path)),
    );
    const dependencies = task.dependencies.map((nodeId) => ({
      nodeId,
      taskKey: taskKeys.get(nodeId),
    }));
    const taskKey = sha256Hex({
      schemaVersion: '1.0.0',
      descriptorDigest,
      descriptorVersion: descriptor.descriptorVersion,
      nodeId: task.nodeId,
      argv: task.argv,
      cwd: task.cwd,
      runner: task.runner,
      toolchain: selectedToolchain,
      environment: selectedEnvironment,
      outputContract: task.outputContract,
      inputs,
      dependencies,
    });
    taskKeys.set(task.nodeId, taskKey);
    plannedById.set(task.nodeId, {
      nodeId: task.nodeId,
      taskKey,
      dependencies: [...task.dependencies],
      argv: [...task.argv],
      cwd: task.cwd,
      inputDigest: sha256Hex({
        inputs,
        toolchain: selectedToolchain,
        environment: selectedEnvironment,
      }),
      inputPaths: inputs.map((entry) => entry.path),
      matchedChangedPaths: changes.filter((path) =>
        task.inputSelectors.some((selector) => selectorMatches(selector, path)),
      ),
      outputContract: task.outputContract,
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
    schemaVersion: '1.0.0',
    repositoryId: descriptor.repositoryId,
    requiredNodes: tasks.map(({ nodeId, taskKey, dependencies }) => ({
      nodeId,
      taskKey,
      dependencies,
    })),
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

export function currentRepositoryState(repoRoot: string): Readonly<{
  commit: string;
  tree: string;
  clean: boolean;
}> {
  const commit = gitText(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const tree = gitText(repoRoot, ['rev-parse', '--verify', `${commit}^{tree}`]).trim();
  return { commit, tree, clean: cleanStatus(repoRoot) };
}
