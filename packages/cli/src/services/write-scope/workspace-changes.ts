/**
 * The tracked changes a process makes in a Git working tree it shares with earlier edits: the
 * routine execution root of `round run`, which may be the repository root itself. A baseline is
 * taken before the process starts and the tree is compared after it ends, so changes already
 * present at the baseline are not the process's own, and a further change to such a path is.
 * Commits the process made are seen through the moved HEAD. A path's state is what Git tracks:
 * its bytes and executable bit, or a symbolic link's target. Ignored files are not observed;
 * runtime state, worktrees and scratch space are never charged to the process.
 */
import { execFileSync, lstatSync, readFileSync, readlinkSync } from '@devai-nyx/authority';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { WriteChange } from './index.js';

/** Runtime paths a process may always write: never committed, owned by the executing verb. */
const RUNTIME_PREFIXES = ['.devai/state/', '.devai/worktrees/', '.devai/local/', 'scratch/'];

/** The digest of a path's tracked state (bytes and executable bit, or link target); null when absent. */
type Digest = string | null;

export interface WorkspaceBaseline {
  readonly head: string;
  /** Paths changed against HEAD at the baseline, with their digest then. */
  readonly dirty: ReadonlyMap<string, Digest>;
  /** The baseline text of every dirty path, for assertion comparison. */
  readonly texts: ReadonlyMap<string, string>;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runtimePath(path: string): boolean {
  return RUNTIME_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Tracked and untracked paths that differ from HEAD; a nested repository counts as one entry. */
function dirtyPaths(root: string): string[] {
  const entries = git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ])
    .split('\0')
    .filter(Boolean);
  return entries.map((entry) => entry.slice(3)).filter((path) => !runtimePath(path));
}

/** A regular file's bytes, for assertion comparison; undefined for a link or an absent path. */
function fileBytes(root: string, path: string): Buffer | undefined {
  try {
    return lstatSync(join(root, path)).isFile() ? readFileSync(join(root, path)) : undefined;
  } catch {
    return undefined;
  }
}

function digest(kind: 'file' | 'executable' | 'link', bytes: Buffer | string): string {
  return `${kind}:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** The tracked state of a working-tree path, as Git would record it (core.fileMode). */
function workingDigest(root: string, path: string): Digest {
  try {
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) return digest('link', readlinkSync(join(root, path)));
    if (!stat.isFile()) return null;
    return digest(
      (stat.mode & 0o100) !== 0 ? 'executable' : 'file',
      readFileSync(join(root, path)),
    );
  } catch {
    return null;
  }
}

function committed(root: string, head: string, path: string): Buffer | undefined {
  try {
    return execFileSync('git', ['show', `${head}:${path}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

/** The tracked state of a path at a commit: its mode from the tree, its blob as bytes or target. */
function committedDigest(root: string, head: string, path: string): Digest {
  let entry: string;
  try {
    entry = git(root, ['ls-tree', '-z', head, '--', path]).split('\0')[0] ?? '';
  } catch {
    return null;
  }
  const mode = /^(\d+) blob /u.exec(entry)?.[1];
  const bytes = mode === undefined ? undefined : committed(root, head, path);
  if (bytes === undefined) return null;
  return digest(mode === '120000' ? 'link' : mode === '100755' ? 'executable' : 'file', bytes);
}

/** The baseline of a working tree before a process runs in it. */
export function captureWorkspace(root: string): WorkspaceBaseline {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const dirty = new Map<string, Digest>();
  const texts = new Map<string, string>();
  for (const path of dirtyPaths(root)) {
    dirty.set(path, workingDigest(root, path));
    const bytes = fileBytes(root, path);
    if (bytes !== undefined) texts.set(path, bytes.toString('utf8'));
  }
  return { head, dirty, texts };
}

/**
 * The paths a process changed since the baseline, each as added, modified or deleted against
 * its baseline state, and the baseline text of a path. A change the process committed counts
 * even when the working tree was restored afterwards; such a committed path whose working-tree
 * state no longer matches the commit is also named as divergent, because the tree then hides
 * what the candidate commit holds.
 */
export function workspaceChanges(
  root: string,
  baseline: WorkspaceBaseline,
): {
  readonly changes: readonly WriteChange[];
  readonly divergent: readonly string[];
  readonly readBase: (path: string) => string | undefined;
} {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const candidates = new Set([...baseline.dirty.keys(), ...dirtyPaths(root)]);
  const committedPaths = new Set<string>();
  if (head !== baseline.head) {
    for (const path of git(root, ['diff', '--name-only', '-z', '--no-renames', baseline.head, head])
      .split('\0')
      .filter((entry) => entry !== '' && !runtimePath(entry))) {
      candidates.add(path);
      committedPaths.add(path);
    }
  }
  const before = (path: string): Digest =>
    baseline.dirty.has(path)
      ? (baseline.dirty.get(path) ?? null)
      : committedDigest(root, baseline.head, path);
  const changes: WriteChange[] = [];
  const divergent: string[] = [];
  const kindOf = (was: Digest, is: Digest): WriteChange['kind'] =>
    is === null ? 'deleted' : was === null ? 'added' : 'modified';
  for (const path of [...candidates].sort()) {
    const was = before(path);
    const is = workingDigest(root, path);
    if (committedPaths.has(path)) {
      const committedBefore = committedDigest(root, baseline.head, path);
      const committedAfter = committedDigest(root, head, path);
      if (committedAfter !== is) divergent.push(path);
      if (was === is && committedBefore !== committedAfter) {
        changes.push({ path, kind: kindOf(committedBefore, committedAfter) });
        continue;
      }
    }
    if (was !== is) changes.push({ path, kind: kindOf(was, is) });
  }
  const readBase = (path: string): string | undefined =>
    baseline.dirty.has(path)
      ? baseline.texts.get(path)
      : committed(root, baseline.head, path)?.toString('utf8');
  return { changes, divergent, readBase };
}
