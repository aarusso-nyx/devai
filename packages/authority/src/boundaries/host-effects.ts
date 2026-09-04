import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
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
  linkSync as nodeLinkSync,
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
  readonly kind: 'filesystem' | 'process' | 'protected-release';
  readonly symbol: string;
  readonly arguments: readonly unknown[];
}

export interface AtomicAuthorityHostEffect {
  readonly request: AuthorityHostEffectRequest;
  readonly apply: () => unknown;
}

const scopes = new AsyncLocalStorage<AuthorityHostEffectScope>();
const protectedSinkScopes = new AsyncLocalStorage<
  Readonly<{
    scope: AuthorityHostEffectScope;
    owner: object | undefined;
    active: () => boolean;
  }>
>();

const sinkOwners = new WeakMap<
  object,
  { kind: 'artifact' | 'certification'; sink_id: string; root?: string }
>();
export function createProtectedReleaseSinkOwner(
  kind: 'artifact' | 'certification',
  sinkId: string,
): object {
  if (
    !['artifact', 'certification'].includes(kind) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u.test(sinkId)
  )
    throw new Error('AUTHORITY_PROTECTED_SINK_OWNER_INVALID');
  const owner = Object.freeze({});
  sinkOwners.set(owner, { kind, sink_id: sinkId });
  return owner;
}

function runSinkUnit<T>(
  scope: AuthorityHostEffectScope,
  owner: object | undefined,
  kind: 'artifact' | 'certification',
  callback: () => T,
  sinkId?: string,
): T {
  const identity = owner === undefined ? undefined : sinkOwners.get(owner);
  if (
    owner !== undefined &&
    (identity?.kind !== kind || (sinkId !== undefined && identity.sink_id !== sinkId))
  )
    throw new Error('AUTHORITY_PROTECTED_SINK_OWNER_INVALID');
  let active = true;
  try {
    return protectedSinkScopes.run({ scope, owner, active: () => active }, callback);
  } finally {
    active = false;
  }
}

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
    binding: ProtectedReleaseHostBinding;
    scope: AuthorityHostEffectScope;
    kind: 'provider' | 'sink';
    operation_id: string;
  }>
>();
let protectedOperationSequence = 0;

export interface ProtectedArtifactSinkBinding {
  readonly action_id: 'release prepare';
  readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
  readonly plan_receipt_digest_sha256: string;
  readonly pack_spec_digest_sha256: string;
  readonly sink_id: string;
}

const artifactOperations = new WeakMap<
  object,
  Readonly<{
    binding: ProtectedArtifactSinkBinding;
    scope: AuthorityHostEffectScope;
    kind: 'artifact-sink';
    operation_id: string;
  }>
>();

export function protectedArtifactSinkHostEffect(request: AuthorityHostEffectRequest) {
  if (request.kind !== 'protected-release' || request.symbol !== 'protectedArtifactSinkOperation')
    return undefined;
  const token = request.arguments[0];
  if (token === null || typeof token !== 'object') return undefined;
  const operation = artifactOperations.get(token);
  return operation?.scope === scopes.getStore() ? operation : undefined;
}

/** Separate prepare-only capability. No execution or certification authority is exposed. */
export function createProtectedArtifactSinkAdapter(binding: ProtectedArtifactSinkBinding) {
  if (
    Object.keys(binding).sort().join(',') !==
      'action_id,pack_spec_digest_sha256,plan_receipt_digest_sha256,repository,sink_id' ||
    Object.keys(binding.repository).sort().join(',') !== 'commit,id,tree'
  )
    throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
  const selected = Object.freeze({
    ...binding,
    repository: Object.freeze({ ...binding.repository }),
  });
  if (
    selected.action_id !== 'release prepare' ||
    typeof selected.repository.id !== 'string' ||
    selected.repository.id.length === 0 ||
    ![selected.repository.commit, selected.repository.tree].every((value) =>
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value),
    ) ||
    selected.repository.commit.length !== selected.repository.tree.length ||
    ![selected.plan_receipt_digest_sha256, selected.pack_spec_digest_sha256].every((value) =>
      /^[0-9a-f]{64}$/u.test(value),
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u.test(selected.sink_id)
  )
    throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
  const invoke = <T>(callback: () => T): T => {
    const scope = requireScope('mutation');
    if (scope.action_id !== selected.action_id)
      throw new Error('AUTHORITY_PROTECTED_RELEASE_ACTION_MISMATCH');
    const token = Object.freeze({});
    protectedOperationSequence += 1;
    const operation = Object.freeze({
      binding: selected,
      scope,
      kind: 'artifact-sink' as const,
      operation_id: `${scope.invocation_id}-${String(protectedOperationSequence)}`,
    });
    artifactOperations.set(token, operation);
    try {
      return scope.apply_effect(
        { kind: 'protected-release', symbol: 'protectedArtifactSinkOperation', arguments: [token] },
        () => {
          if (artifactOperations.get(token) !== operation || scopes.getStore() !== scope)
            throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
          artifactOperations.delete(token);
          return callback();
        },
      ) as T;
    } finally {
      artifactOperations.delete(token);
    }
  };
  return Object.freeze({
    invokeSink: <T>(callback: () => T, owner?: object): T => {
      const scope = requireScope('mutation');
      return invoke(() => runSinkUnit(scope, owner, 'artifact', callback, selected.sink_id));
    },
  });
}

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
    selected.repository.id.length === 0 ||
    ![selected.repository.commit, selected.repository.tree].every((value) =>
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value),
    ) ||
    selected.repository.commit.length !== selected.repository.tree.length ||
    ![
      selected.task_policy_digest_sha256,
      selected.plan_receipt_digest_sha256,
      selected.helper_identity_sha256,
    ].every((value) => /^[0-9a-f]{64}$/u.test(value))
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
    protectedOperationSequence += 1;
    const operation = Object.freeze({
      binding: selected,
      scope,
      kind,
      operation_id: `${scope.invocation_id}-${String(protectedOperationSequence)}`,
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

/** Root-confined primitives for the installed trusted CAS, never handed to candidate processes. */
export function createProtectedReleaseSinkFilesystem(rootPath: string, owner: object) {
  const ownership = sinkOwners.get(owner);
  if (ownership === undefined) throw new Error('AUTHORITY_PROTECTED_SINK_OWNER_INVALID');
  const root = realpathSync(rootPath);
  if (ownership.root !== undefined && ownership.root !== root)
    throw new Error('AUTHORITY_PROTECTED_SINK_OWNER_INVALID');
  ownership.root = root;
  const initial = lstatSync(root);
  if (
    !isAbsolute(rootPath) ||
    root !== resolve(rootPath) ||
    !initial.isDirectory() ||
    (initial.mode & 0o777) !== 0o700
  )
    throw new Error('AUTHORITY_PROTECTED_SINK_ROOT_INVALID');
  const descriptors = new Map<number, Readonly<{ dev: number; ino: number; writable: boolean }>>();
  const pathFor = (path: string): string => {
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new Error('AUTHORITY_PROTECTED_SINK_PATH_INVALID');
    const child = relative(root, path);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new Error('AUTHORITY_PROTECTED_SINK_PATH_INVALID');
    const observedRoot = lstatSync(root);
    if (
      observedRoot.isSymbolicLink() ||
      observedRoot.dev !== initial.dev ||
      observedRoot.ino !== initial.ino ||
      (observedRoot.mode & 0o777) !== 0o700
    )
      throw new Error('AUTHORITY_PROTECTED_SINK_ROOT_INVALID');
    let current = root;
    for (const part of child.split(sep).filter(Boolean)) {
      current = resolve(current, part);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new Error('AUTHORITY_PROTECTED_SINK_PATH_INVALID');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    return path;
  };
  const fdFor = (fd: number, write = false) => {
    const expected = descriptors.get(fd);
    if (expected === undefined || (write && !expected.writable))
      throw new Error('AUTHORITY_PROTECTED_SINK_DESCRIPTOR_INVALID');
    const observed = fstatSync(fd);
    if (observed.dev !== expected.dev || observed.ino !== expected.ino)
      throw new Error('AUTHORITY_PROTECTED_SINK_DESCRIPTOR_INVALID');
    return fd;
  };
  const effect = <T>(operation: () => T): T => {
    const sink = protectedSinkScopes.getStore();
    if (
      sink === undefined ||
      sink.scope !== scopes.getStore() ||
      !sink.active() ||
      sink.owner !== owner
    )
      throw new Error('AUTHORITY_PROTECTED_SINK_OPERATION_FORBIDDEN');
    return operation();
  };
  return Object.freeze({
    root,
    lstatSync: (path: string) => lstatSync(pathFor(path)),
    readdirSync: (path: string, options?: { withFileTypes: true }) =>
      options === undefined ? readdirSync(pathFor(path)) : readdirSync(pathFor(path), options),
    fstatSync: (fd: number) => fstatSync(fdFor(fd)),
    readFileSync: (path: string | number): Buffer => {
      if (typeof path === 'number') return readFileSync(fdFor(path));
      const fd = nodeOpenSync(
        pathFor(path),
        nodeFileConstants.O_RDONLY | nodeFileConstants.O_NOFOLLOW,
      );
      try {
        return readFileSync(fd);
      } finally {
        nodeCloseSync(fd);
      }
    },
    openSync: (path: string, flags: number, mode = 0o600): number => {
      const writeFlags =
        nodeFileConstants.O_WRONLY |
        nodeFileConstants.O_CREAT |
        nodeFileConstants.O_EXCL |
        nodeFileConstants.O_NOFOLLOW;
      const readFlags = nodeFileConstants.O_RDONLY | nodeFileConstants.O_NOFOLLOW;
      if ((flags !== writeFlags && flags !== readFlags) || (flags === writeFlags && mode !== 0o600))
        throw new Error('AUTHORITY_PROTECTED_SINK_OPEN_INVALID');
      const open = () => {
        const fd = nodeOpenSync(pathFor(path), flags, mode);
        const observed = fstatSync(fd);
        descriptors.set(fd, {
          dev: observed.dev,
          ino: observed.ino,
          writable: flags === writeFlags,
        });
        return fd;
      };
      return flags === writeFlags ? effect(open) : open();
    },
    writeSync: (
      fd: number,
      bytes: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ): number => effect(() => nodeWriteSync(fdFor(fd, true), bytes, offset, length, position)),
    fsyncSync: (fd: number): void => effect(() => nodeFsyncSync(fdFor(fd))),
    closeSync: (fd: number): void => {
      fdFor(fd);
      const close = () => {
        nodeCloseSync(fd);
        descriptors.delete(fd);
      };
      if (descriptors.get(fd)?.writable === true) effect(close);
      else close();
    },
    mkdirSync: (
      path: string,
      options: { recursive?: boolean; mode?: number } = {},
    ): string | undefined =>
      effect(() => {
        if (options.mode !== undefined && options.mode !== 0o700)
          throw new Error('AUTHORITY_PROTECTED_SINK_MODE_INVALID');
        return nodeMkdirSync(pathFor(path), { ...options, mode: 0o700 });
      }),
    linkSync: (source: string, destination: string): void =>
      effect(() => {
        const from = pathFor(source);
        const metadata = lstatSync(from);
        if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600)
          throw new Error('AUTHORITY_PROTECTED_SINK_PATH_INVALID');
        nodeLinkSync(from, pathFor(destination));
      }),
  });
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
