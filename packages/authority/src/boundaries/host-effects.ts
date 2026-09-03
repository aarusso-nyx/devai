import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname } from 'node:path';
import {
  constants as nodeFileConstants,
  appendFileSync as nodeAppendFileSync,
  chmodSync as nodeChmodSync,
  closeSync as nodeCloseSync,
  copyFileSync as nodeCopyFileSync,
  cpSync as nodeCpSync,
  existsSync,
  fstatSync,
  fsyncSync as nodeFsyncSync,
  lstatSync,
  mkdirSync as nodeMkdirSync,
  mkdtempSync as nodeMkdtempSync,
  openSync as nodeOpenSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync as nodeRenameSync,
  rmSync as nodeRmSync,
  statSync,
  symlinkSync as nodeSymlinkSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
  writeSync as nodeWriteSync,
} from 'node:fs';
import {
  execFileSync as nodeExecFileSync,
  spawnSync as nodeSpawnSync,
  type SpawnSyncOptions,
} from 'node:child_process';
import { issuerState } from '../runtime/contracts.js';

/**
 * The sole raw host-effect seam for DEVAI's supported CLI runtime.
 *
 * Every mutating import is routed here, and production calls require the
 * one-shot action scope installed by the CLI authority boundary. Read-only
 * filesystem functions remain ordinary reads. There is deliberately no test
 * or environment bypass: tests exercise the same final boundary as production.
 */
export interface AuthorityHostEffectScope {
  readonly action_id: string;
  readonly invocation_id: string;
  readonly effect: 'read' | 'harness-write' | 'local-write' | 'remote-write';
  readonly receipt_store: object;
  readonly apply_effect: (request: AuthorityHostEffectRequest, apply: () => unknown) => unknown;
}

export interface AuthorityHostEffectRequest {
  readonly kind: 'filesystem' | 'process';
  readonly symbol: string;
  readonly arguments: readonly unknown[];
}

export interface AtomicAuthorityHostEffect {
  readonly request: AuthorityHostEffectRequest;
  readonly apply: () => unknown;
}

const scopes = new AsyncLocalStorage<AuthorityHostEffectScope>();

function requireScope(mode: 'mutation' | 'process'): AuthorityHostEffectScope {
  const scope = scopes.getStore();
  if (!scope) {
    throw new Error('AUTHORITY_FINAL_BOUNDARY_REQUIRED');
  }
  if (mode === 'mutation' && scope.effect === 'read') {
    throw new Error('AUTHORITY_READ_ACTION_MUTATION_FORBIDDEN');
  }
  return scope;
}

function guarded<T extends object>(
  symbol: string,
  implementation: T,
  mode: 'mutation' | 'process',
): T {
  const wrapper = (...args: unknown[]) => {
    const scope = requireScope(mode);
    const apply = () => Reflect.apply(implementation as CallableFunction, undefined, args);
    return scope.apply_effect(
      { kind: mode === 'mutation' ? 'filesystem' : 'process', symbol, arguments: args },
      apply,
    );
  };
  return wrapper as T;
}

export function runWithAuthorityHostEffects<T>(
  scope: AuthorityHostEffectScope,
  callback: () => T,
): T {
  if (
    scope.action_id.length === 0 ||
    scope.invocation_id.length === 0 ||
    typeof scope.apply_effect !== 'function' ||
    !issuerState(scope.receipt_store) ||
    issuerState(scope.receipt_store)?.closed === true ||
    issuerState(scope.receipt_store)?.invocation_id !== scope.invocation_id
  ) {
    throw new Error('AUTHORITY_HOST_SCOPE_INVALID');
  }
  return scopes.run(Object.freeze({ ...scope }), callback);
}

/**
 * Trusted final-adapter helper for a captured exact filesystem unit.
 * The caller has already completed policy/receipt preparation. Effects remain
 * process-local closures over the original raw host calls and are unavailable
 * to command handlers as reusable capabilities.
 */
export function applyAuthorityHostEffectsAtomically(
  effects: readonly AtomicAuthorityHostEffect[],
): readonly unknown[] {
  type Snapshot =
    | Readonly<{ kind: 'absent'; path: string }>
    | Readonly<{ kind: 'directory'; path: string; mode: number }>
    | Readonly<{ kind: 'file'; path: string; mode: number; bytes: Buffer }>
    | Readonly<{ kind: 'symlink'; path: string; target: string }>;
  const paths: string[] = [];
  for (const effect of effects) {
    if (effect.request.kind !== 'filesystem') {
      throw new Error('AUTHORITY_ATOMIC_UNIT_FILESYSTEM_ONLY');
    }
    const args = effect.request.arguments;
    const candidates =
      effect.request.symbol === 'renameSync'
        ? [args[0], args[1]]
        : ['copyFileSync', 'cpSync', 'symlinkSync'].includes(effect.request.symbol)
          ? [args[1]]
          : [args[0]];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && !paths.includes(candidate)) paths.push(candidate);
    }
  }
  const snapshots: Snapshot[] = paths.map((path) => {
    if (!existsSync(path)) return { kind: 'absent', path };
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { kind: 'symlink', path, target: readlinkSync(path) };
    if (stat.isDirectory()) return { kind: 'directory', path, mode: stat.mode };
    return { kind: 'file', path, mode: stat.mode, bytes: readFileSync(path) };
  });
  const results: unknown[] = [];
  try {
    for (const effect of effects) results.push(effect.apply());
    return results;
  } catch (error) {
    try {
      for (const snapshot of snapshots.toReversed()) {
        if (snapshot.kind === 'directory') {
          if (!existsSync(snapshot.path)) nodeMkdirSync(snapshot.path, { recursive: true });
          nodeChmodSync(snapshot.path, snapshot.mode);
          continue;
        }
        nodeRmSync(snapshot.path, { recursive: true, force: true });
        if (snapshot.kind === 'absent') continue;
        nodeMkdirSync(dirname(snapshot.path), { recursive: true });
        if (snapshot.kind === 'symlink') nodeSymlinkSync(snapshot.target, snapshot.path);
        else {
          nodeWriteFileSync(snapshot.path, snapshot.bytes);
          nodeChmodSync(snapshot.path, snapshot.mode);
        }
      }
    } catch {
      throw new Error('AUTHORITY_ATOMIC_ROLLBACK_FAILED');
    }
    throw error;
  }
}

/**
 * Run an already-authorized filesystem projection as one recoverable unit.
 * Mutations inside `callback` still cross the guarded host-effect seam; this
 * helper owns only the snapshots and raw rollback needed after a later guarded
 * effect fails. Callers must preflight and enumerate every file they may touch.
 */
export function runAuthorityHostEffectsWithRollback<T>(
  targetPaths: readonly string[],
  callback: () => T,
): T {
  type Snapshot =
    | Readonly<{ kind: 'absent'; path: string }>
    | Readonly<{ kind: 'file'; path: string; mode: number; bytes: Buffer }>
    | Readonly<{ kind: 'symlink'; path: string; target: string }>;
  const paths = [...new Set(targetPaths)];
  if (paths.some((path) => path.length === 0)) throw new Error('AUTHORITY_ROLLBACK_TARGET_INVALID');
  const snapshots: Snapshot[] = [];
  const captured = new Set<string>();
  for (const path of paths) {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isDirectory()) throw new Error(`AUTHORITY_ROLLBACK_FILE_TARGET_REQUIRED:${path}`);
      snapshots.push(
        stat.isSymbolicLink()
          ? { kind: 'symlink', path, target: readlinkSync(path) }
          : { kind: 'file', path, mode: stat.mode, bytes: readFileSync(path) },
      );
      captured.add(path);
      continue;
    }
    snapshots.push({ kind: 'absent', path });
    captured.add(path);
    let parent = dirname(path);
    while (!existsSync(parent) && !captured.has(parent)) {
      snapshots.push({ kind: 'absent', path: parent });
      captured.add(parent);
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  try {
    return callback();
  } catch (error) {
    try {
      for (const snapshot of snapshots.toReversed()) {
        nodeRmSync(snapshot.path, { recursive: true, force: true });
        if (snapshot.kind === 'absent') continue;
        nodeMkdirSync(dirname(snapshot.path), { recursive: true });
        if (snapshot.kind === 'symlink') nodeSymlinkSync(snapshot.target, snapshot.path);
        else {
          nodeWriteFileSync(snapshot.path, snapshot.bytes);
          nodeChmodSync(snapshot.path, snapshot.mode);
        }
      }
    } catch {
      throw new Error('AUTHORITY_ATOMIC_ROLLBACK_FAILED');
    }
    throw error;
  }
}

export {
  fstatSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  type SpawnSyncOptions,
};

/** Read-only open flags exposed without handing callers the mutable fs module. */
export const fileOpenConstants = Object.freeze({
  O_RDONLY: nodeFileConstants.O_RDONLY,
  O_DIRECTORY: nodeFileConstants.O_DIRECTORY,
  O_NOFOLLOW: nodeFileConstants.O_NOFOLLOW,
});

/** Narrow non-mutating descriptor seam for race-resistant store inspection. */
export function openReadOnlyNoFollowSync(path: string, directory = false): number {
  return nodeOpenSync(
    path,
    nodeFileConstants.O_RDONLY |
      (nodeFileConstants.O_NOFOLLOW ?? 0) |
      (directory ? (nodeFileConstants.O_DIRECTORY ?? 0) : 0),
  );
}

/** Closes a descriptor created by openReadOnlyNoFollowSync. */
export function closeReadOnlySync(descriptor: number): void {
  nodeCloseSync(descriptor);
}

export const appendFileSync = guarded('appendFileSync', nodeAppendFileSync, 'mutation');
export const chmodSync = guarded('chmodSync', nodeChmodSync, 'mutation');
export const closeSync = guarded('closeSync', nodeCloseSync, 'mutation');
export const copyFileSync = guarded('copyFileSync', nodeCopyFileSync, 'mutation');
export const cpSync = guarded('cpSync', nodeCpSync, 'mutation');
export const fsyncSync = guarded('fsyncSync', nodeFsyncSync, 'mutation');
export const mkdirSync = guarded('mkdirSync', nodeMkdirSync, 'mutation');
export const mkdtempSync = guarded('mkdtempSync', nodeMkdtempSync, 'mutation');
export const openSync = guarded('openSync', nodeOpenSync, 'mutation');
export const renameSync = guarded('renameSync', nodeRenameSync, 'mutation');
export const rmSync = guarded('rmSync', nodeRmSync, 'mutation');
export const symlinkSync = guarded('symlinkSync', nodeSymlinkSync, 'mutation');
export const unlinkSync = guarded('unlinkSync', nodeUnlinkSync, 'mutation');
export const writeFileSync = guarded('writeFileSync', nodeWriteFileSync, 'mutation');
export const writeSync = guarded('writeSync', nodeWriteSync, 'mutation');
export const execFileSync = guarded('execFileSync', nodeExecFileSync, 'process');
export const spawnSync = guarded('spawnSync', nodeSpawnSync, 'process');

/** Exact read-only bootstrap exception used only to resolve the CLI version. */
export const readProcessSync = nodeSpawnSync;

/**
 * Exact conditional-effect exception for governance render --out. The caller
 * is statically restricted by the direct-mutator guard and completes the
 * Architect/write-consent check before invoking this helper.
 */
export function writeGovernanceProjectionSync(target: string, body: string): void {
  nodeMkdirSync(dirname(target), { recursive: true });
  nodeWriteFileSync(target, body);
}

/** Exact read-only Git object lookup used by the first-parent gate guard. */
export function readGitObjectSync(repoRoot: string, revision: string, path: string): string {
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('GIT_OBJECT_REVISION_INVALID');
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('GIT_OBJECT_PATH_INVALID');
  }
  const result = Reflect.apply(nodeSpawnSync, undefined, [
    'git',
    ['show', `${revision}:${path}`],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ]) as ReturnType<typeof nodeSpawnSync>;
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('GIT_OBJECT_READ_FAILED');
  }
  return result.stdout;
}

export interface ReadOnlyGitTreeEntry {
  readonly path: string;
  readonly mode: '100644' | '100755' | '120000';
  readonly object_id: string;
  readonly bytes: Buffer;
}

function validGitObject(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function validGitPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/[\u0000-\u001f\u007f]/u.test(path) &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

function rawGitRead(repoRoot: string, args: readonly string[]): Buffer {
  const result = Reflect.apply(nodeSpawnSync, undefined, [
    'git',
    [...args],
    {
      cwd: repoRoot,
      encoding: null,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  ]) as ReturnType<typeof nodeSpawnSync>;
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error('GIT_TREE_READ_FAILED');
  }
  return result.stdout;
}

/**
 * Read a regular-file/symlink projection from one exact immutable Git tree.
 * The caller must still decide which Git modes are safe to materialize.
 */
export function readExactGitTreeSync(
  repoRoot: string,
  commit: string,
  expectedTree: string,
  prefix: string,
): readonly ReadOnlyGitTreeEntry[] {
  if (!validGitObject(commit) || !validGitObject(expectedTree)) {
    throw new Error('GIT_TREE_IDENTITY_INVALID');
  }
  if (prefix !== '.' && !validGitPath(prefix)) throw new Error('GIT_OBJECT_PATH_INVALID');
  const observedCommit = rawGitRead(repoRoot, ['rev-parse', '--verify', `${commit}^{commit}`])
    .toString('utf8')
    .trim();
  if (observedCommit !== commit) throw new Error('GIT_COMMIT_IDENTITY_MISMATCH');
  const observedTree = rawGitRead(repoRoot, ['rev-parse', '--verify', `${commit}^{tree}`])
    .toString('utf8')
    .trim();
  if (observedTree !== expectedTree) throw new Error('GIT_TREE_IDENTITY_MISMATCH');
  const listing = rawGitRead(repoRoot, [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    commit,
    '--',
    prefix,
  ]).toString('utf8');
  const entries: ReadOnlyGitTreeEntry[] = [];
  for (const line of listing.split('\0')) {
    if (line.length === 0) continue;
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      throw new Error('GIT_TREE_ENTRY_UNSUPPORTED');
    }
    if (!validGitPath(match[3])) throw new Error('GIT_OBJECT_PATH_INVALID');
    entries.push({
      path: match[3],
      mode: match[1] as ReadOnlyGitTreeEntry['mode'],
      object_id: match[2],
      bytes: rawGitRead(repoRoot, ['cat-file', 'blob', match[2]]),
    });
  }
  if (entries.length === 0) throw new Error('GIT_TREE_PROJECTION_EMPTY');
  return entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}
