import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readExactGitTreeSync, type AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { sha256Hex } from './canonical.js';
import { parseTaskDescriptor, readTaskDescriptor } from './policy.js';
import { resolveTaskExecutable } from './executable.js';

export interface DeclaredCheckTaskProcess {
  readonly nodeId: string;
  readonly cwd: string;
  readonly taskPolicyDigest?: string;
}

export interface ReleaseTaskProcessBinding {
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly descriptor_digest: string;
  readonly task_policy_digest: string;
  readonly node_id: string;
  readonly executable: { readonly path: string; readonly sha256: string };
  readonly argv: readonly string[];
  readonly cwd: string;
}

const releaseTaskTokens = new WeakMap<object, ReleaseTaskProcessBinding>();
const releaseTaskToken = Symbol('devai.release-task-process-binding');
const releaseToolTokens = new WeakMap<object, ReleaseToolProcessBinding>();
const releaseToolToken = Symbol('devai.release-tool-process-binding');

export interface ReleaseToolProcessBinding {
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly tool: 'npm';
  readonly executable: { readonly path: string; readonly sha256: string };
  readonly cwd: string;
  readonly output: string;
}

export function bindReleaseTaskProcessOptions<T extends object>(
  options: T,
  binding: ReleaseTaskProcessBinding,
): T {
  const token = Object.freeze({});
  releaseTaskTokens.set(
    token,
    Object.freeze({
      ...binding,
      candidate: Object.freeze({ ...binding.candidate }),
      executable: Object.freeze({ ...binding.executable }),
      argv: Object.freeze([...binding.argv]),
    }),
  );
  Object.defineProperty(options, releaseTaskToken, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: token,
  });
  return options;
}

export function bindReleaseToolProcessOptions<T extends object>(
  options: T,
  binding: ReleaseToolProcessBinding,
): T {
  const token = Object.freeze({});
  releaseToolTokens.set(
    token,
    Object.freeze({
      ...binding,
      candidate: Object.freeze({ ...binding.candidate }),
      executable: Object.freeze({ ...binding.executable }),
    }),
  );
  Object.defineProperty(options, releaseToolToken, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: token,
  });
  return options;
}

export function trustedReleaseToolProcessBinding(
  options: Readonly<Record<PropertyKey, unknown>>,
): ReleaseToolProcessBinding | undefined {
  const token = options[releaseToolToken];
  return token !== null && typeof token === 'object' ? releaseToolTokens.get(token) : undefined;
}

function trustedReleaseBinding(options: Readonly<Record<PropertyKey, unknown>>) {
  const token = options[releaseTaskToken];
  return token !== null && typeof token === 'object' ? releaseTaskTokens.get(token) : undefined;
}

export interface DeclaredCheckTaskRefusal {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly descriptor_path: string;
  readonly closest_declared_node?: string;
  readonly reason: string;
}

function distance(left: readonly string[], right: readonly string[]): number {
  const width = right.length + 1;
  let prior = Array.from({ length: width }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const next = [row];
    for (let column = 1; column < width; column += 1) {
      next[column] = Math.min(
        (prior[column] ?? 0) + 1,
        (next[column - 1] ?? 0) + 1,
        (prior[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    prior = next;
  }
  return prior[right.length] ?? Math.max(left.length, right.length);
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function matchesDeclaredExecutable(root: string, declared: string, requested: string): boolean {
  if (declared === requested) return true;
  try {
    return resolveTaskExecutable(root, declared).path === requested;
  } catch {
    return false;
  }
}

function exactDeclaredTask(
  repoRoot: string,
  request: AuthorityHostEffectRequest,
): DeclaredCheckTaskProcess | undefined {
  if (request.kind !== 'process' || request.symbol !== 'spawnSync') return undefined;
  const executable = request.arguments[0];
  const argv = request.arguments[1];
  const rawOptions = request.arguments[2];
  if (
    typeof executable !== 'string' ||
    !Array.isArray(argv) ||
    argv.some((argument) => typeof argument !== 'string') ||
    rawOptions === null ||
    typeof rawOptions !== 'object' ||
    Array.isArray(rawOptions)
  ) {
    return undefined;
  }
  const options = rawOptions as Readonly<Record<string, unknown>>;
  if (options.shell !== undefined && options.shell !== false) return undefined;
  if (typeof options.cwd !== 'string') return undefined;
  const root = realpathSync(resolve(repoRoot));
  if (!existsSync(resolve(options.cwd))) return undefined;
  const cwd = realpathSync(resolve(options.cwd));
  if (!within(root, cwd)) return undefined;
  const task = readTaskDescriptor(resolve(root, 'test-tasks.json')).tasks.find(
    (candidate) =>
      matchesDeclaredExecutable(root, candidate.argv[0] ?? '', executable) &&
      JSON.stringify(candidate.argv.slice(1)) === JSON.stringify(argv) &&
      existsSync(resolve(root, candidate.cwd)) &&
      realpathSync(resolve(root, candidate.cwd)) === cwd,
  );
  return task === undefined ? undefined : { nodeId: task.nodeId, cwd };
}

/** Exact descriptor-only matcher for lifecycle-owned check-runner execution. */
export function matchDeclaredReleaseTaskProcess(
  repoRoot: string,
  request: AuthorityHostEffectRequest,
): DeclaredCheckTaskProcess | undefined {
  if (request.kind !== 'process' || request.symbol !== 'spawnSync') return undefined;
  const executable = request.arguments[0];
  const argv = request.arguments[1];
  const rawOptions = request.arguments[2];
  if (
    typeof executable !== 'string' ||
    !Array.isArray(argv) ||
    argv.some((argument) => typeof argument !== 'string') ||
    rawOptions === null ||
    typeof rawOptions !== 'object' ||
    Array.isArray(rawOptions)
  ) {
    return undefined;
  }
  const options = rawOptions as Readonly<Record<PropertyKey, unknown>>;
  if (options.shell !== false || typeof options.cwd !== 'string') return undefined;
  const binding = trustedReleaseBinding(options);
  if (binding === undefined) return undefined;
  let descriptor;
  try {
    const entries = readExactGitTreeSync(
      repoRoot,
      binding.candidate.commit,
      binding.candidate.tree,
      'test-tasks.json',
    );
    if (
      entries.length !== 1 ||
      entries[0]?.path !== 'test-tasks.json' ||
      entries[0].mode === '120000'
    ) {
      return undefined;
    }
    descriptor = parseTaskDescriptor(JSON.parse(entries[0].bytes.toString('utf8')) as unknown);
  } catch {
    return undefined;
  }
  if (sha256Hex(descriptor) !== binding.descriptor_digest) return undefined;
  const task = descriptor.tasks.find((candidate) => candidate.nodeId === binding.node_id);
  if (task === undefined || JSON.stringify(task.argv) !== JSON.stringify(binding.argv)) {
    return undefined;
  }
  const root = realpathSync(resolve(repoRoot));
  const cwd = realpathSync(resolve(root, task.cwd));
  if (options.cwd !== cwd || binding.cwd !== task.cwd) return undefined;
  const identity = resolveTaskExecutable(root, task.argv[0] ?? '');
  if (
    executable !== identity.path ||
    binding.executable.path !== identity.path ||
    binding.executable.sha256 !== identity.sha256 ||
    JSON.stringify(argv) !== JSON.stringify(task.argv.slice(1))
  ) {
    return undefined;
  }
  return { nodeId: task.nodeId, cwd, taskPolicyDigest: binding.task_policy_digest };
}

export function matchDeclaredCheckTaskProcess(
  repoRoot: string,
  invocationArgv: readonly string[],
  request: AuthorityHostEffectRequest,
): DeclaredCheckTaskProcess | undefined {
  if (request.kind !== 'process' || request.symbol !== 'spawnSync') return undefined;
  const targets = ['--affected', '--local', '--rc', '--release-intent'].filter((flag) =>
    invocationArgv.includes(flag),
  );
  const suiteIndex = invocationArgv.indexOf('--suite');
  const suite = suiteIndex < 0 ? undefined : invocationArgv[suiteIndex + 1];
  const onlyIndex = invocationArgv.indexOf('--only');
  const only = onlyIndex < 0 ? undefined : invocationArgv[onlyIndex + 1];
  const suiteRun =
    only === undefined &&
    targets.length === 0 &&
    (suite === undefined || ['quick', 'standard', 'full', 'release'].includes(suite));
  const ledgerOnlyRun = ['ledger-local', 'ledger-rc'].includes(only ?? '');
  const explicitTaskRun = invocationArgv.includes('--run') && targets.length === 1;
  if (!explicitTaskRun && !suiteRun && !ledgerOnlyRun) return undefined;
  return exactDeclaredTask(repoRoot, request);
}

export function describeDeclaredCheckTaskRefusal(
  repoRoot: string,
  request: AuthorityHostEffectRequest,
): DeclaredCheckTaskRefusal {
  const descriptorPath = resolve(realpathSync(resolve(repoRoot)), 'test-tasks.json');
  const executable = typeof request.arguments[0] === 'string' ? request.arguments[0] : '<invalid>';
  const argv = Array.isArray(request.arguments[1]) ? request.arguments[1].map(String) : [];
  const rawOptions = request.arguments[2];
  const options =
    rawOptions !== null && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
      ? (rawOptions as Readonly<Record<string, unknown>>)
      : {};
  let reason = 'process is not an exact declared task';
  if (options.shell !== undefined && options.shell !== false) reason = 'shell must be false';
  else if (typeof options.cwd !== 'string') reason = 'cwd must be declared';
  else if (!existsSync(resolve(options.cwd))) reason = 'cwd does not exist';
  else if (!within(realpathSync(resolve(repoRoot)), realpathSync(resolve(options.cwd))))
    reason = 'cwd escapes the repository';
  let closest: string | undefined;
  try {
    const requested = [executable, ...argv];
    closest = [...readTaskDescriptor(descriptorPath).tasks].sort(
      (left, right) => distance(requested, left.argv) - distance(requested, right.argv),
    )[0]?.nodeId;
  } catch {
    // The descriptor loader reports malformed or absent descriptors elsewhere.
  }
  return {
    executable,
    argv,
    descriptor_path: descriptorPath,
    ...(closest === undefined ? {} : { closest_declared_node: closest }),
    reason,
  };
}
