import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

type Package = Readonly<{
  files: Readonly<Record<string, Readonly<{ present?: unknown; sha256?: unknown }>>>;
  dependencies: Readonly<Record<string, unknown>>;
}>;
type Bundle = Readonly<{ package_root: string; packages: Readonly<Record<string, Package>> }>;
const fields = [
  'dev',
  'ino',
  'birthtimeNs',
  'ctimeNs',
  'mtimeNs',
  'size',
  'mode',
  'uid',
  'gid',
  'nlink',
] as const;
function stale(): never {
  throw new Error('AUTHORITY_RECONCILIATION_OPERATION_STALE');
}
function same(left: BigIntStats, right: BigIntStats): boolean {
  return fields.every((field) => left[field] === right[field]);
}
function stat(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Invocation-local content memo. Every use rechecks the entire installed closure;
 * policy decisions and clocks are never cached. A changed witness poisons the memo.
 * At most 8192 readonly descriptors are pinned until disposal. The cold directory
 * census and unchanged full directory metadata before/after each FD scan prove
 * named bindings unchanged, just as unchanged FD metadata proves content hashes:
 * replacing a leaf changes its parent census/ctime; editing the pinned inode
 * changes its own ctime. Reopening every file at every guard is unnecessary.
 */
export function reconciliationPackageWitness(bundle: Bundle): { verify(): void; dispose(): void } {
  const files = new Map<string, { stat: BigIntStats; fd: number; sha256: string }>();
  const directories = new Map<string, { stat: BigIntStats; names: string }>();
  const resolution = new Map<string, BigIntStats | null>();
  let active = true;
  const dispose = (): void => {
    active = false;
    for (const file of files.values()) {
      try {
        closeSync(file.fd);
      } catch {
        /* Retire all remaining pins after any descriptor failure. */
      }
    }
    files.clear();
    directories.clear();
    resolution.clear();
  };
  const checkDirectory = (path: string, expected: { stat: BigIntStats; names: string }) => {
    const before = stat(path);
    if (!before || !same(before, expected.stat) || !before.isDirectory() || before.isSymbolicLink())
      stale();
  };
  const pinFile = (path: string, digest: string): void => {
    const existing = files.get(path);
    if (existing) {
      if (
        existing.sha256 !== digest ||
        !same(existing.stat, fstatSync(existing.fd, { bigint: true }))
      )
        stale();
      return;
    }
    if (files.size >= 8192) stale();
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) stale();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let retained = false;
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!same(before, opened)) stale();
      if (createHash('sha256').update(readFileSync(fd)).digest('hex') !== digest) stale();
      if (
        !same(opened, fstatSync(fd, { bigint: true })) ||
        !same(opened, lstatSync(path, { bigint: true }))
      )
        stale();
      files.set(path, { stat: opened, fd, sha256: digest });
      retained = true;
    } finally {
      if (!retained) closeSync(fd);
    }
  };
  try {
    for (const [root, metadata] of Object.entries(bundle.packages)) {
      if (realpathSync(root) !== root) stale();
      const seen = new Set<string>();
      const visit = (directory: string): void => {
        const before = lstatSync(directory, { bigint: true });
        if (!before.isDirectory() || before.isSymbolicLink()) stale();
        const names = readdirSync(directory).sort();
        directories.set(directory, { stat: before, names: JSON.stringify(names) });
        for (const name of names) {
          const path = join(directory, name),
            entry = lstatSync(path, { bigint: true });
          if (entry.isSymbolicLink()) stale();
          if (entry.isDirectory()) visit(path);
          else {
            const key = relative(root, path),
              expected = metadata.files[key];
            if (!expected || expected.present !== true || typeof expected.sha256 !== 'string')
              stale();
            pinFile(path, expected.sha256);
            seen.add(key);
          }
        }
        if (!same(before, lstatSync(directory, { bigint: true }))) stale();
      };
      visit(root);
      if (seen.size !== Object.keys(metadata.files).length) stale();
      // Pin every module-resolution search container and scoped candidate. This
      // detects an absent optional dependency appearing or a nearer retarget.
      const resolver = createRequire(join(root, 'package.json'));
      for (const name of Object.keys(metadata.dependencies)) {
        for (const search of resolver.resolve.paths(name) ?? []) {
          for (const path of new Set([
            search,
            dirname(join(search, name)),
            join(search, name),
            join(search, name, 'package.json'),
          ])) {
            if (!resolution.has(path)) {
              const witness = stat(path);
              if (path.endsWith('/package.json') && witness?.isSymbolicLink()) stale();
              resolution.set(path, witness);
            }
          }
        }
      }
    }
    const verify = (): void => {
      try {
        if (!active) stale();
        for (const root of Object.keys(bundle.packages)) if (realpathSync(root) !== root) stale();
        for (const [path, expected] of resolution) {
          const current = stat(path);
          if (expected === null ? current !== null : current === null || !same(expected, current))
            stale();
        }
        for (const [path, expected] of directories) checkDirectory(path, expected);
        for (const file of files.values())
          if (!same(file.stat, fstatSync(file.fd, { bigint: true }))) stale();
        for (const [path, expected] of directories) checkDirectory(path, expected);
      } catch {
        dispose();
        stale();
      }
    };
    verify();
    return Object.freeze({
      verify,
      dispose,
    });
  } catch {
    dispose();
    stale();
  }
}
