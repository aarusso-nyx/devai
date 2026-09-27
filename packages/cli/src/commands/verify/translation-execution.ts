import { platform } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { runLinuxIsolated } from '#runtime-core';
import { existsSync, mkdirSync, readdirSync, rmSync, spawnSync } from '@devai-nyx/authority';
import {
  fileDigest,
  requireGit,
  safeRepoPath,
  type StateChange,
  type TestRef,
  type ProcessResult,
  type Execution,
  canonicalRef,
  EXECUTION_TIMEOUT_MS,
} from './translation-support.js';

export const LINUX_IMAGE =
  'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd';

export function snapshotValidationState(repoRoot: string): ReadonlyMap<string, string> {
  const snapshot = new Map<string, string>();
  const stateRoot = resolve(repoRoot, '.devai/state');
  const walk = (absoluteDirectory: string, relativeDirectory: string): void => {
    if (!existsSync(absoluteDirectory)) return;
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath =
        relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolutePath = resolve(absoluteDirectory, entry.name);
      if (entry.isDirectory()) walk(absolutePath, relativePath);
      else snapshot.set(`.devai/state/${relativePath}`, fileDigest(absolutePath));
    }
  };
  walk(stateRoot, '');

  const tracked = requireGit(
    repoRoot,
    ['ls-files', '-z'],
    'VALIDATION_TRACKED_STATE_SNAPSHOT_FAILED',
  )
    .split('\0')
    .filter((path) => path.length > 0);
  for (const path of tracked) {
    if (!safeRepoPath(path) || snapshot.has(path)) continue;
    const absolutePath = resolve(repoRoot, path);
    snapshot.set(path, existsSync(absolutePath) ? fileDigest(absolutePath) : 'absent');
  }
  return snapshot;
}

export function stateChanges(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): readonly StateChange[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: StateChange[] = [];
  for (const path of paths) {
    const oldDigest = before.get(path);
    const newDigest = after.get(path);
    if (oldDigest === newDigest) continue;
    if (oldDigest === undefined || oldDigest === 'absent')
      changes.push({ path, operation: 'create' });
    else if (newDigest === undefined || newDigest === 'absent')
      changes.push({ path, operation: 'retire' });
    else changes.push({ path, operation: 'append' });
  }
  return changes;
}

export function uniqueStateChanges(changes: readonly StateChange[]): readonly StateChange[] {
  const byKey = new Map<string, StateChange>();
  for (const change of changes) byKey.set(`${change.operation}:${change.path}`, change);
  return [...byKey.values()].sort((left, right) => {
    const a = `${left.path}:${left.operation}`;
    const b = `${right.path}:${right.operation}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function testArgv(repoRoot: string, ref: TestRef): readonly string[] {
  if (!safeRepoPath(ref.path) || ref.names.length === 0) {
    throw new Error('TEST_REF_INVALID');
  }
  const pattern = ref.names.at(-1);
  if (pattern === undefined || pattern.length === 0) throw new Error('TEST_REF_INVALID');
  const extension = extname(ref.path);
  if (['.js', '.mjs', '.cjs'].includes(extension)) {
    return ['node', '--test', '--test-name-pattern', pattern, ref.path];
  }
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) {
    const vitest = join(repoRoot, 'node_modules/vitest/vitest.mjs');
    if (!existsSync(vitest)) throw new Error('REGISTERED_TEST_RUNNER_MISSING');
    return ['node', 'node_modules/vitest/vitest.mjs', 'run', ref.path, '-t', pattern];
  }
  throw new Error('REGISTERED_TEST_RUNNER_UNSUPPORTED');
}

function classify(result: ProcessResult): Execution['failure_mode'] {
  if (result.status === 0) return 'none';
  const output = `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ''}`;
  if (result.error !== undefined && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
    return 'timeout';
  }
  if (result.signal !== null) return 'signal';
  if (/ENOENT|Cannot find module|Could not find|no such file/i.test(output)) return 'missing-file';
  if (/SyntaxError|ERR_MODULE_NOT_FOUND|failed to load/i.test(output)) return 'load-error';
  if (/AssertionError|ERR_ASSERTION|Assertion failed/i.test(output)) return 'assertion';
  return 'infrastructure';
}

export function executionFrom(ref: TestRef, result: ProcessResult): Execution {
  const failureMode = classify(result);
  return {
    test_ref: canonicalRef(ref),
    outcome: result.status === 0 ? 'pass' : failureMode === 'assertion' ? 'fail' : 'crash',
    failure_mode: failureMode,
  };
}

function runMacOs(worktree: string, argv: readonly string[]): ProcessResult {
  const escapedWorktree = worktree.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const result = spawnSync(
    'sandbox-exec',
    [
      '-p',
      `(version 1)(deny network*)(deny file-write* (subpath "${escapedWorktree}"))(allow default)`,
      ...argv,
    ],
    {
      cwd: worktree,
      encoding: 'utf8',
      timeout: EXECUTION_TIMEOUT_MS,
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: process.env['HOME'] ?? '/tmp',
        TMPDIR: process.env['TMPDIR'] ?? '/tmp',
        DEVAI_VALIDATION_ISOLATED: '1',
      },
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

export async function runIsolated(
  repoRoot: string,
  worktree: string,
  argv: readonly string[],
): Promise<ProcessResult> {
  if (platform() === 'linux') {
    const result = await runLinuxIsolated({
      repo_root: worktree,
      dependencies_root: repoRoot,
      image: LINUX_IMAGE,
      argv,
      timeout_ms: EXECUTION_TIMEOUT_MS,
      prepare_dependency_mount_point: (path) => mkdirSync(path, { recursive: true }),
      remove_dependency_mount_point: (path) => rmSync(path, { recursive: true, force: true }),
      spawn: (command, args, options) =>
        spawnSync(command, [...args], options) as ReturnType<typeof spawnSync>,
    });
    return {
      status: result.exit_code,
      signal: null,
      stdout: result.stdout,
      stderr: result.stderr,
      isolation_applied: result.isolation_applied,
    };
  }
  if (platform() !== 'darwin') {
    return {
      status: 1,
      signal: null,
      stdout: '',
      stderr: `unsupported validation platform: ${platform()}`,
    };
  }
  return runMacOs(worktree, argv);
}
