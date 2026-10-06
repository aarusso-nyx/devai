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
  rmdirSync as nodeRmdirSync,
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
import type { ProtectedReleaseRepositoryIdentity } from './release-repository-identity.js';
import type { AuthorityHostEffectRequest } from './host-atomic-effects.js';
import { scopes, type AuthorityHostEffectScope } from './host-scope.js';
import { runSinkUnit } from './host-sink-filesystem.js';
import { publishNoReplaceSteps, type PublishedFileIdentity } from './host-publish.js';
import {
  currentRepositoryBinding,
  nextProtectedOperationSequence,
  requireScope,
} from './host-operation.js';
export {
  createProtectedArtifactSinkAdapter,
  createProtectedExportSignerAdapter,
  createProtectedExportSinkAdapter,
  protectedArtifactSinkHostEffect,
  protectedExportHostEffect,
} from './host-sink-adapters.js';
export type { ProtectedArtifactSinkBinding } from './host-sink-adapters.js';

export {
  createProtectedReleaseSinkFilesystem,
  createProtectedReleaseSinkOwner,
} from './host-sink-filesystem.js';

export {
  assertProtectedReleaseExportCapacityEffect,
  assertProtectedReleasePrepareCapacityEffect,
  readProtectedReleaseExportCapacity,
  readProtectedReleasePrepareCapacity,
  withProtectedReleaseExportCapacity,
  withProtectedReleasePrepareCapacity,
} from './host-capacity.js';

export { runWithAuthorityHostEffects } from './host-scope.js';
export type {
  AuthorityHostEffectScope,
  ProtectedReleaseExportCapacity,
  ProtectedReleaseExportCapacityBinding,
  ProtectedReleasePrepareCapacity,
  ProtectedReleasePrepareCapacityBinding,
} from './host-scope.js';

export {
  assertProtectedReleaseRepositoryRoot,
  createProtectedReleaseRepositoryContext,
  readProtectedReleaseRepositoryIdentity,
  withProtectedReleaseRepositoryContext,
} from './host-repository-context.js';
export type {
  ProtectedReleaseRepositoryContext,
  ProtectedReleaseRepositoryControls,
} from './host-repository-context.js';

export {
  applyAuthorityHostEffectsAtomically,
  runAuthorityHostEffectsWithRollback,
} from './host-atomic-effects.js';
export type {
  AtomicAuthorityHostEffect,
  AuthorityHostEffectRequest,
} from './host-atomic-effects.js';

export {
  captureProtectedReleaseRepositoryIdentity,
  parseProtectedReleaseOrigin,
  type ProtectedReleaseRepositoryIdentity,
} from './release-repository-identity.js';
export type { ProtectedReleaseExportBinding } from './release-export-binding.js';

export interface ProtectedReleaseHostBinding {
  readonly action_id: 'release certify' | 'release preflight';
  readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
  readonly task_policy_digest_sha256: string;
  readonly plan_receipt_digest_sha256: string;
  readonly helper_identity_sha256: string;
}

const protectedOperations = new WeakMap<
  object,
  Readonly<{
    binding: ProtectedReleaseHostBinding & ProtectedReleaseRepositoryIdentity;
    scope: AuthorityHostEffectScope;
    kind: 'provider' | 'sink';
    operation_id: string;
  }>
>();

/** Broker-only inspection of a live, single-use, process-local protected operation. */
export function protectedReleaseHostEffect(request: AuthorityHostEffectRequest) {
  if (request.kind !== 'protected-release' || request.symbol !== 'protectedReleaseHostOperation')
    return undefined;
  const token = request.arguments[0];
  if (token === null || typeof token !== 'object') return undefined;
  const operation = protectedOperations.get(token);
  if (operation === undefined || operation.scope !== scopes.getStore()) return undefined;
  return operation;
}

/** Only the trusted installed host composition creates this adapter. It is never passed to a task. */
export function createProtectedReleaseHostAdapter(binding: ProtectedReleaseHostBinding) {
  if (
    Object.keys(binding).sort().join(',') !==
      'action_id,helper_identity_sha256,plan_receipt_digest_sha256,repository,task_policy_digest_sha256' ||
    Object.keys(binding.repository).sort().join(',') !== 'commit,id,tree'
  )
    throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
  const selected = Object.freeze({
    ...binding,
    repository: Object.freeze({ ...binding.repository }),
  });
  if (
    !['release certify', 'release preflight'].includes(selected.action_id) ||
    typeof selected.repository.id !== 'string' ||
    selected.repository.id.length === 0 ||
    ![selected.repository.commit, selected.repository.tree].every(
      (value) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value),
    ) ||
    selected.repository.commit.length !== selected.repository.tree.length ||
    ![
      selected.task_policy_digest_sha256,
      selected.plan_receipt_digest_sha256,
      selected.helper_identity_sha256,
    ].every((value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value))
  ) {
    throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
  }
  const invoke = <T>(kind: 'provider' | 'sink', callback: () => T): T => {
    const scope = requireScope('mutation');
    if (
      scope.action_id !== selected.action_id ||
      (kind === 'sink' && selected.action_id !== 'release certify')
    )
      throw new Error('AUTHORITY_PROTECTED_RELEASE_ACTION_MISMATCH');
    const token = Object.freeze({});
    const sequence = nextProtectedOperationSequence();
    const operation = Object.freeze({
      binding: currentRepositoryBinding(selected),
      scope,
      kind,
      operation_id: `${scope.invocation_id}-${String(sequence)}`,
    });
    protectedOperations.set(token, operation);
    try {
      return scope.apply_effect(
        { kind: 'protected-release', symbol: 'protectedReleaseHostOperation', arguments: [token] },
        () => {
          if (protectedOperations.get(token) !== operation || scopes.getStore() !== scope)
            throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
          protectedOperations.delete(token);
          return callback();
        },
      ) as T;
    } finally {
      protectedOperations.delete(token);
    }
  };
  return Object.freeze({
    spawnSync: ((...args: Parameters<typeof nodeSpawnSync>) =>
      invoke('provider', () =>
        Reflect.apply(nodeSpawnSync, undefined, args),
      )) as typeof nodeSpawnSync,
    invokeSink: <T>(callback: () => T, owner?: object): T => {
      const scope = requireScope('mutation');
      return invoke('sink', () => runSinkUnit(scope, owner, 'certification', callback));
    },
  });
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

/**
 * Opens an existing regular file read-only without following a final link and without
 * blocking: O_NONBLOCK keeps an open of a FIFO (or another special file swapped in after an
 * lstat) from waiting for a writer, and an entry whose fstat is not a regular file is closed
 * and refused with code `ENOTREGULAR` before any read (#313). O_NONBLOCK does not change reads
 * of a regular file.
 */
export function openRegularFileReadOnlySync(path: string): number {
  const descriptor = nodeOpenSync(
    path,
    nodeFileConstants.O_RDONLY |
      (nodeFileConstants.O_NOFOLLOW ?? 0) |
      (nodeFileConstants.O_NONBLOCK ?? 0),
  );
  let regular = false;
  try {
    regular = fstatSync(descriptor).isFile();
  } finally {
    if (!regular) nodeCloseSync(descriptor);
  }
  if (!regular) {
    throw Object.assign(new Error(`AUTHORITY_READ_NOT_REGULAR_FILE: ${path}`), {
      code: 'ENOTREGULAR',
    });
  }
  return descriptor;
}

/** Closes a descriptor created by openReadOnlyNoFollowSync or openRegularFileReadOnlySync. */
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
/** Non-recursive directory removal: it refuses (ENOTEMPTY) a directory that holds any entry. */
export const rmdirSync = guarded('rmdirSync', nodeRmdirSync, 'mutation');
export const symlinkSync = guarded('symlinkSync', nodeSymlinkSync, 'mutation');
export const unlinkSync = guarded('unlinkSync', nodeUnlinkSync, 'mutation');
export const writeFileSync = guarded('writeFileSync', nodeWriteFileSync, 'mutation');
export const writeSync = guarded('writeSync', nodeWriteSync, 'mutation');
/**
 * Governed atomic no-replace publication (ADR-AUT-0005): one authorized `create` of
 * `path` that writes and fsyncs a staged file, links it into place (refusing with EEXIST
 * when `path` exists), removes the staged name and fsyncs the directory. It returns the
 * published file's identity, taken from the staged descriptor before the link.
 */
export const publishFileNoReplaceSync = guarded(
  'publishFileNoReplaceSync',
  (path: string, data: string | Uint8Array): PublishedFileIdentity =>
    publishNoReplaceSteps(path, data),
  'mutation',
);
export { PUBLISH_INDETERMINATE, type PublishedFileIdentity } from './host-publish.js';

/**
 * Exact flush exception (ADR-AUT-0005): fsync one directory opened read-only and without
 * following a final symbolic link, so a `.devai` entry just created in it is durable. It
 * changes no bytes and names no new entry; the direct-mutator guard restricts its caller
 * to the state-root initializer, which runs only inside an authorized init step.
 */
export function flushDirectoryEntrySync(path: string): void {
  const fd = nodeOpenSync(
    path,
    nodeFileConstants.O_RDONLY |
      (nodeFileConstants.O_DIRECTORY ?? 0) |
      (nodeFileConstants.O_NOFOLLOW ?? 0),
  );
  try {
    nodeFsyncSync(fd);
  } finally {
    nodeCloseSync(fd);
  }
}
export const execFileSync = guarded('execFileSync', nodeExecFileSync, 'process');
export const spawnSync = guarded('spawnSync', nodeSpawnSync, 'process');

export { spawn } from './host-process.js';
export type {
  GuardedChildProcess,
  GuardedProcessResult,
  GuardedSpawnOptions,
} from './host-process.js';

/** Exact read-only bootstrap exception used only to resolve the CLI version. */
export const readProcessSync = nodeSpawnSync;

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
    ![...path].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    }) &&
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

/** Closed, read-only Git grammar for task-policy reconstruction, never task execution. */
export function readCheckPolicyGitSync(
  repoRoot: string,
  args: readonly string[],
  input?: string | Buffer,
): Buffer {
  const matches = (...expected: string[]) =>
    args.length === expected.length && args.every((value, index) => value === expected[index]);
  const revision = (value: string | undefined) =>
    typeof value === 'string' &&
    /^(?:HEAD|[a-f0-9]{40}|[a-f0-9]{64})\^\{(?:commit|tree)\}$/u.test(value);
  const batch = matches('cat-file', '--batch');
  const batchCheck = matches('cat-file', '--batch-check');
  const batchRead = batch || batchCheck;
  const separator = args[2]?.indexOf(':') ?? -1;
  const objectPath =
    separator < 0 ? undefined : [args[2]?.slice(0, separator), args[2]?.slice(separator + 1)];
  const valid =
    (args.length === 3 &&
      args[0] === 'merge-base' &&
      validGitObject(args[1] ?? '') &&
      validGitObject(args[2] ?? '')) ||
    (args.length === 3 && args[0] === 'rev-parse' && args[1] === '--verify' && revision(args[2])) ||
    matches('status', '--porcelain=v1', '--untracked-files=all') ||
    (args.length === 5 &&
      args.slice(0, 4).join(',') === 'ls-tree,-r,-z,--full-tree' &&
      validGitObject(args[4] ?? '')) ||
    matches('ls-files', '-s', '-z') ||
    matches('ls-files', '-z', '--cached', '--others', '--exclude-standard') ||
    matches('ls-files', '-z', '--others', '--exclude-standard') ||
    (args.length === 7 &&
      args.slice(0, 5).join(',') === 'diff,--name-status,-z,-M,--find-renames' &&
      validGitObject(args[5] ?? '') &&
      (args[6] === '--' || validGitObject(args[6] ?? ''))) ||
    (args.length === 3 &&
      args[0] === 'cat-file' &&
      args[1] === 'blob' &&
      objectPath?.length === 2 &&
      validGitObject(objectPath[0] ?? '') &&
      validGitPath(objectPath[1] ?? '')) ||
    batchRead;
  if (!valid) throw new Error('GIT_POLICY_READ_ARGUMENTS_INVALID');
  if (batchRead) {
    const bytes = typeof input === 'string' ? Buffer.from(input) : input;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 64 * 1024 * 1024)
      throw new Error('GIT_POLICY_READ_INPUT_INVALID');
    const lines = bytes.toString('utf8').split('\n');
    if (lines.pop() !== '' || !lines.every(validGitObject))
      throw new Error('GIT_POLICY_READ_INPUT_INVALID');
  } else if (input !== undefined) throw new Error('GIT_POLICY_READ_INPUT_INVALID');
  // Candidate filters, external diff drivers, fsmonitor hooks and inherited Git
  // configuration must never turn policy inspection into program execution.
  const command =
    args[0] === 'diff' ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)] : [...args];
  const result = Reflect.apply(nodeSpawnSync, undefined, [
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...command],
    {
      cwd: repoRoot,
      encoding: null,
      input,
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
      },
    },
  ]) as ReturnType<typeof nodeSpawnSync>;
  if (result.error !== undefined || result.status !== 0 || !Buffer.isBuffer(result.stdout))
    throw new Error('GIT_POLICY_READ_FAILED');
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
