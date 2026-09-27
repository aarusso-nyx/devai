import { dirname, resolve } from 'node:path';
import {
  chmodSync as nodeChmodSync,
  existsSync,
  lstatSync,
  mkdirSync as nodeMkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync as nodeRmSync,
  symlinkSync as nodeSymlinkSync,
  writeFileSync as nodeWriteFileSync,
} from 'node:fs';

export interface AuthorityHostEffectRequest {
  readonly kind: 'filesystem' | 'process' | 'protected-release';
  readonly symbol: string;
  readonly arguments: readonly unknown[];
}

export interface AtomicAuthorityHostEffect {
  readonly request: AuthorityHostEffectRequest;
  readonly apply: () => unknown;
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
    | Readonly<{ kind: 'directory'; path: string; mode: number; entries?: readonly Snapshot[] }>
    | Readonly<{ kind: 'file'; path: string; mode: number; bytes: Buffer }>
    | Readonly<{ kind: 'symlink'; path: string; target: string }>;
  const paths: string[] = [];
  const recursivePaths = new Set<string>();
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
      if (typeof candidate !== 'string') continue;
      if (!paths.includes(candidate)) paths.push(candidate);
      // Only subtree-changing operations need child bytes; metadata-only
      // operations must not copy unrelated directory contents.
      if (['rmSync', 'renameSync', 'cpSync'].includes(effect.request.symbol))
        recursivePaths.add(candidate);
    }
  }
  function capture(path: string, recursive: boolean): Snapshot {
    // A dangling symlink is an existing entry and must survive rollback.
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return { kind: 'absent', path };
    if (stat.isSymbolicLink()) return { kind: 'symlink', path, target: readlinkSync(path) };
    if (stat.isDirectory())
      return {
        kind: 'directory',
        path,
        mode: stat.mode,
        ...(recursive
          ? {
              entries: readdirSync(path)
                .sort()
                .map((name) => capture(resolve(path, name), true)),
            }
          : {}),
      };
    if (!stat.isFile()) throw new Error('AUTHORITY_ATOMIC_SNAPSHOT_SPECIAL_FILE');
    return { kind: 'file', path, mode: stat.mode, bytes: readFileSync(path) };
  }
  const snapshots = paths.map((path) => capture(path, recursivePaths.has(path)));
  function restore(snapshot: Snapshot): void {
    if (snapshot.kind === 'directory') {
      if (snapshot.entries !== undefined) {
        nodeRmSync(snapshot.path, { recursive: true, force: true });
        nodeMkdirSync(snapshot.path, { recursive: true });
        for (const entry of snapshot.entries) restore(entry);
      } else if (!existsSync(snapshot.path)) nodeMkdirSync(snapshot.path, { recursive: true });
      nodeChmodSync(snapshot.path, snapshot.mode);
      return;
    }
    nodeRmSync(snapshot.path, { recursive: true, force: true });
    if (snapshot.kind === 'absent') return;
    nodeMkdirSync(dirname(snapshot.path), { recursive: true });
    if (snapshot.kind === 'symlink') nodeSymlinkSync(snapshot.target, snapshot.path);
    else {
      nodeWriteFileSync(snapshot.path, snapshot.bytes);
      nodeChmodSync(snapshot.path, snapshot.mode);
    }
  }
  const results: unknown[] = [];
  try {
    for (const effect of effects) results.push(effect.apply());
    return results;
  } catch (error) {
    try {
      for (const snapshot of snapshots.toReversed()) restore(snapshot);
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
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat !== undefined) {
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
    while (lstatSync(parent, { throwIfNoEntry: false }) === undefined && !captured.has(parent)) {
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
