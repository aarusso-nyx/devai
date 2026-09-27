import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  constants as nodeFileConstants,
  closeSync as nodeCloseSync,
  fstatSync,
  fsyncSync as nodeFsyncSync,
  lstatSync,
  linkSync as nodeLinkSync,
  mkdirSync as nodeMkdirSync,
  openSync as nodeOpenSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeSync as nodeWriteSync,
} from 'node:fs';
import { scopes, type AuthorityHostEffectScope } from './host-scope.js';

const protectedSinkScopes = new AsyncLocalStorage<
  Readonly<{
    scope: AuthorityHostEffectScope;
    owner: object | undefined;
    active: () => boolean;
  }>
>();

const sinkOwners = new WeakMap<
  object,
  { kind: 'artifact' | 'certification' | 'export'; sink_id: string; root?: string }
>();
export function createProtectedReleaseSinkOwner(
  kind: 'artifact' | 'certification' | 'export',
  sinkId: string,
): object {
  if (
    !['artifact', 'certification', 'export'].includes(kind) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u.test(sinkId)
  )
    throw new Error('AUTHORITY_PROTECTED_SINK_OWNER_INVALID');
  const owner = Object.freeze({});
  sinkOwners.set(owner, { kind, sink_id: sinkId });
  return owner;
}

export function runSinkUnit<T>(
  scope: AuthorityHostEffectScope,
  owner: object | undefined,
  kind: 'artifact' | 'certification' | 'export',
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
    // Read-only assertion for synchronous transaction state changes. It neither
    // creates a capability nor extends the existing sink operation's lifetime.
    assertWriteAuthority: (): void => effect(() => undefined),
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
