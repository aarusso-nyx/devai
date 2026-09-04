import { randomUUID } from 'node:crypto';
import { constants, fstatSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { createProtectedReleaseSinkFilesystem } from '@devai-nyx/authority';

const DIGEST = /^[0-9a-f]{64}$/u;

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  );
}

export interface DurableReleaseContentStoreOptions {
  readonly root: string;
  readonly sink_id: string;
  readonly repository_roots: readonly string[];
  readonly max_blob_bytes: number;
}

/** Private physical storage; every write still requires the action-specific host capability. */
export function createDurableReleaseContentStore(
  input: DurableReleaseContentStoreOptions,
  fail: () => never,
  owner: object,
) {
  if (
    typeof constants.O_NOFOLLOW !== 'number' ||
    !isAbsolute(input.root) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u.test(input.sink_id) ||
    !Number.isSafeInteger(input.max_blob_bytes) ||
    input.max_blob_bytes < 1 ||
    input.repository_roots.length === 0
  )
    fail();
  const root = resolve(input.root);
  const sinkId = input.sink_id;
  const limit = input.max_blob_bytes;
  if (root === parse(root).root) fail();
  const roots = input.repository_roots.map((path) => {
    if (!isAbsolute(path)) fail();
    return resolve(path);
  });
  if (roots.some((path) => within(path, root) || within(root, path))) fail();

  const inspectAncestors = (path: string) => {
    const absolute = resolve(path);
    let current = parse(absolute).root;
    const identities = [];
    for (const part of relative(current, absolute).split(sep)) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) fail();
      identities.push({ path: current, dev: stat.dev, ino: stat.ino });
    }
    return identities;
  };
  const initial = inspectAncestors(root);
  for (const path of roots) inspectAncestors(path);
  const rootStat = lstatSync(root);
  if (
    !rootStat.isDirectory() ||
    (rootStat.mode & 0o777) !== 0o700 ||
    typeof process.getuid !== 'function' ||
    rootStat.uid !== process.getuid()
  )
    fail();
  const { closeSync, fsyncSync, linkSync, mkdirSync, openSync, writeSync, readdirSync } =
    createProtectedReleaseSinkFilesystem(root, owner);
  const checkRoot = () => {
    for (const identity of initial) {
      const stat = lstatSync(identity.path);
      if (stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) fail();
    }
    const stat = lstatSync(root);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== rootStat.uid) fail();
  };
  const assertPath = (path: string) => {
    checkRoot();
    if (!within(root, path) || path === root) fail();
  };
  const read = (path: string): Buffer => {
    assertPath(path);
    const identities = inspectAncestors(path);
    const before = lstatSync(path);
    if (!before.isFile() || before.size > limit) fail();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > limit)
        fail();
      const value = readFileSync(fd);
      if (value.length > limit) fail();
      for (const identity of identities) {
        const current = lstatSync(identity.path);
        if (
          current.isSymbolicLink() ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino
        )
          fail();
      }
      checkRoot();
      return value;
    } finally {
      closeSync(fd);
    }
  };
  const ensureDirectory = (path: string) => {
    assertPath(path);
    inspectAncestors(dirname(path));
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) fail();
    flushDirectory(dirname(path));
    checkRoot();
  };
  const flushDirectory = (path: string) => {
    inspectAncestors(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isDirectory()) fail();
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  // Atomic no-clobber installation. Failed and successful staging bytes remain
  // inspectable; no recovery path edits or removes existing evidence.
  const install = (path: string, value: Buffer) => {
    assertPath(path);
    if (value.length > limit) fail();
    inspectAncestors(dirname(path));
    try {
      if (!read(path).equals(value)) fail();
      const existing = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(existing);
      } finally {
        closeSync(existing);
      }
      flushDirectory(dirname(path));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const stage = join(root, 'staging', randomUUID());
    const fd = openSync(
      stage,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      let offset = 0;
      while (offset < value.length) {
        const written = writeSync(fd, value, offset, value.length - offset, offset);
        if (!Number.isSafeInteger(written) || written <= 0) fail();
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    flushDirectory(dirname(stage));
    if (!read(stage).equals(value)) fail();
    try {
      linkSync(stage, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !read(path).equals(value))
        throw error;
    }
    flushDirectory(dirname(path));
    if (!read(path).equals(value)) fail();
  };
  const objectPath = (sha256: string) => {
    if (!DIGEST.test(sha256)) fail();
    return join(root, 'objects', sha256);
  };
  const list = (path: string) => {
    assertPath(path);
    const before = inspectAncestors(path);
    const entries = readdirSync(path, { withFileTypes: true });
    const after = inspectAncestors(path);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail();
    checkRoot();
    return entries.map((entry) => {
      if (typeof entry === 'string') fail();
      return entry;
    });
  };
  return {
    root,
    sinkId,
    limit,
    checkRoot,
    inspectAncestors,
    read,
    ensureDirectory,
    install,
    objectPath,
    list,
  };
}
