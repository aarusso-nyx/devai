/**
 * The tracked changes a process makes in a Git working tree it shares with earlier edits: the
 * routine execution root of `round run`, which may be the repository root itself. A baseline is
 * taken before the process starts and the tree is compared after it ends, so changes already
 * present at the baseline are not the process's own, and a further change to such a path is.
 * Commits the process made are seen through the moved HEAD. Ignored files are not observed;
 * runtime state, worktrees and scratch space are never charged to the process.
 */
import { execFileSync, readFileSync, lstatSync } from '@devai-nyx/authority';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { WriteChange } from './index.js';

/** Runtime paths a process may always write: never committed, owned by the executing verb. */
const RUNTIME_PREFIXES = ['.devai/state/', '.devai/worktrees/', '.devai/local/', 'scratch/'];

/** The digest of a path's bytes, or null when it is absent. */
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

function fileBytes(root: string, path: string): Buffer | undefined {
  try {
    return lstatSync(join(root, path)).isFile() ? readFileSync(join(root, path)) : undefined;
  } catch {
    return undefined;
  }
}

function digestOf(bytes: Buffer | undefined): Digest {
  return bytes === undefined ? null : createHash('sha256').update(bytes).digest('hex');
}

function committed(root: string, head: string, path: string): Buffer | undefined {
  try {
    return execFileSync('git', ['show', `${head}:${path}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }) as unknown as Buffer;
  } catch {
    return undefined;
  }
}

/** The baseline of a working tree before a process runs in it. */
export function captureWorkspace(root: string): WorkspaceBaseline {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const dirty = new Map<string, Digest>();
  const texts = new Map<string, string>();
  for (const path of dirtyPaths(root)) {
    const bytes = fileBytes(root, path);
    dirty.set(path, digestOf(bytes));
    if (bytes !== undefined) texts.set(path, bytes.toString('utf8'));
  }
  return { head, dirty, texts };
}

/**
 * The paths a process changed since the baseline, each as added, modified or deleted against
 * its baseline state, and the baseline text of a path.
 */
export function workspaceChanges(
  root: string,
  baseline: WorkspaceBaseline,
): {
  readonly changes: readonly WriteChange[];
  readonly readBase: (path: string) => string | undefined;
} {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const candidates = new Set([...baseline.dirty.keys(), ...dirtyPaths(root)]);
  if (head !== baseline.head) {
    for (const path of git(root, ['diff', '--name-only', '-z', '--no-renames', baseline.head, head])
      .split('\0')
      .filter((entry) => entry !== '' && !runtimePath(entry))) {
      candidates.add(path);
    }
  }
  const before = (path: string): Digest =>
    baseline.dirty.has(path)
      ? (baseline.dirty.get(path) ?? null)
      : digestOf(committed(root, baseline.head, path));
  const changes: WriteChange[] = [];
  for (const path of [...candidates].sort()) {
    const was = before(path);
    const is = digestOf(fileBytes(root, path));
    if (was === is) continue;
    changes.push({ path, kind: is === null ? 'deleted' : was === null ? 'added' : 'modified' });
  }
  const readBase = (path: string): string | undefined =>
    baseline.dirty.has(path)
      ? baseline.texts.get(path)
      : committed(root, baseline.head, path)?.toString('utf8');
  return { changes, readBase };
}
