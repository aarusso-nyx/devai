import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DISPOSABLE_ROOTS = [
  '.devai/cache',
  '.devai/state/tmp',
  '.devai/state/v8-coverage',
  'coverage',
] as const;

export interface StateMutationEffects {
  rmSync(path: string, options: { force: true }): void;
}

export interface PruneStateOptions {
  readonly repoRoot: string;
  readonly olderThanDays?: number;
  readonly apply?: boolean;
  readonly effects?: StateMutationEffects;
  readonly now?: Date;
}

export interface PruneStateResult {
  readonly applied: boolean;
  readonly older_than_days: number;
  readonly candidates: readonly string[];
  readonly deleted: readonly string[];
  readonly preserved_roots: readonly string[];
}

function relativePosix(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

export function pruneState(opts: PruneStateOptions): PruneStateResult {
  const olderThanDays = opts.olderThanDays ?? 30;
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
    throw new Error('olderThanDays must be a positive integer');
  }
  const mutationEffects = opts.effects;
  if (opts.apply === true && mutationEffects === undefined) {
    throw new Error('pruneState apply requires an authority-backed mutation effects adapter');
  }
  const cutoff = (opts.now ?? new Date()).getTime() - olderThanDays * 86_400_000;
  const candidates: string[] = [];
  for (const relativeRoot of DISPOSABLE_ROOTS) {
    const root = join(opts.repoRoot, relativeRoot);
    if (!existsSync(root)) continue;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && statSync(path).mtimeMs < cutoff) {
          candidates.push(relativePosix(opts.repoRoot, path));
        }
      }
    };
    walk(root);
  }
  candidates.sort();
  const deleted: string[] = [];
  if (opts.apply === true) {
    for (const path of candidates) {
      mutationEffects?.rmSync(join(opts.repoRoot, path), { force: true });
      deleted.push(path);
    }
  }
  return {
    applied: opts.apply === true,
    older_than_days: olderThanDays,
    candidates,
    deleted,
    preserved_roots: ['.devai/state/counters.json', '.devai/state/leases', '.devai/state/pointers'],
  };
}
