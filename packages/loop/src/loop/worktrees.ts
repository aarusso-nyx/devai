import { execFileSync } from '@devai-nyx/authority';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { join, resolve, sep } from 'node:path';

export interface WorktreeRecord {
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  readonly task_id?: string;
  readonly created_at: string;
  readonly human_adopted?: boolean;
}

export interface CreateWorktreeOptions {
  readonly repoRoot: string;
  /** Worktree id, e.g. WT-<task-id> or WT-human-<branch>. */
  readonly id: string;
  /** Branch to create or check out. */
  readonly branch: string;
  /** Base ref (default: HEAD). */
  readonly baseRef?: string;
  readonly taskId?: string;
  readonly humanAdopted?: boolean;
}

function worktreesDir(repoRoot: string): string {
  return join(repoRoot, '.devai/worktrees');
}

function registryPath(repoRoot: string): string {
  return join(repoRoot, '.devai/state/worktrees.json');
}

interface WorktreeRegistry {
  worktrees: WorktreeRecord[];
}

function loadRegistry(repoRoot: string): WorktreeRegistry {
  const path = registryPath(repoRoot);
  if (!existsSync(path)) return { worktrees: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as WorktreeRegistry;
}

function saveRegistry(repoRoot: string, registry: WorktreeRegistry): void {
  const path = registryPath(repoRoot);
  mkdirSync(join(repoRoot, '.devai/state'), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n');
}

/**
 * Per-host cap on concurrent non-adopted worktrees. Set by D-52
 * (Phase 16.C; supersedes D-11's earlier value of 6). Human-adopted
 * worktrees are cap-exempt — they reflect deliberate human review
 * paths, not autonomous-loop parallelism. The cap can be raised
 * project-locally by editing this constant; a future `.devai/config/
 * limits.json` override surface is documented in D-52 as the
 * migration path when adopters need higher concurrency.
 */
export const WORKTREE_CAP = 3;

/**
 * Count active worktrees, excluding human-adopted ones (cap-exempt).
 * Active means present in the registry; orphan detection is the
 * separate `reapWorktrees` flow.
 */
function activeNonAdoptedCount(registry: WorktreeRegistry): number {
  return registry.worktrees.filter((w) => w.human_adopted !== true).length;
}

export function createWorktree(opts: CreateWorktreeOptions): WorktreeRecord {
  if (!/^WT-[A-Za-z0-9._-]+$/u.test(opts.id)) {
    throw new Error(`invalid managed worktree id: ${opts.id}`);
  }
  const registry = loadRegistry(opts.repoRoot);

  // Cap enforcement (D-52). Human-adopted worktrees are cap-exempt.
  // Re-creating an existing worktree id (the registry-update flow
  // below dedupes by id) does not count against the cap.
  const reusingExisting = registry.worktrees.some((w) => w.id === opts.id);
  if (
    !reusingExisting &&
    opts.humanAdopted !== true &&
    activeNonAdoptedCount(registry) >= WORKTREE_CAP
  ) {
    throw new Error(
      `worktree cap exceeded: ${String(WORKTREE_CAP)} non-adopted worktrees already active. ` +
        'Complete or cancel an active task before creating another managed worktree; ' +
        'human-adopted worktrees are exempt.',
    );
  }

  const wtRoot = worktreesDir(opts.repoRoot);
  mkdirSync(wtRoot, { recursive: true });
  const wtPath = join(wtRoot, opts.id);

  execFileSync('git', ['worktree', 'add', '-b', opts.branch, wtPath, opts.baseRef ?? 'HEAD'], {
    cwd: opts.repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const record: WorktreeRecord = {
    id: opts.id,
    path: resolve(wtPath),
    branch: opts.branch,
    ...(opts.taskId !== undefined && { task_id: opts.taskId }),
    created_at: new Date().toISOString(),
    ...(opts.humanAdopted === true && { human_adopted: true }),
  };
  registry.worktrees = registry.worktrees.filter((w) => w.id !== opts.id);
  registry.worktrees.push(record);
  saveRegistry(opts.repoRoot, registry);
  return record;
}

export function destroyWorktree(opts: {
  repoRoot: string;
  id: string;
  forceHumanAdopted?: boolean;
  deleteBranch?: boolean;
}): void {
  if (!/^WT-[A-Za-z0-9._-]+$/u.test(opts.id)) {
    throw new Error(`invalid managed worktree id: ${opts.id}`);
  }
  const registry = loadRegistry(opts.repoRoot);
  const record = registry.worktrees.find((w) => w.id === opts.id);
  if (record?.human_adopted === true && opts.forceHumanAdopted !== true) {
    throw new Error(`refusing to destroy human-adopted worktree: ${opts.id}`);
  }
  if (record !== undefined) {
    const managedRoot = resolve(worktreesDir(opts.repoRoot));
    const expectedPath = resolve(managedRoot, opts.id);
    const recordedPath = resolve(record.path);
    if (
      recordedPath !== expectedPath ||
      !recordedPath.startsWith(`${managedRoot}${sep}`) ||
      lstatSync(recordedPath).isSymbolicLink()
    ) {
      throw new Error('WORKTREE_REGISTRY_PATH_INVALID');
    }
    const canonicalRecordedPath = realpathSync(recordedPath);
    const registeredPaths = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: opts.repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => resolve(line.slice('worktree '.length)));
    if (!registeredPaths.includes(canonicalRecordedPath)) {
      throw new Error('WORKTREE_GIT_REGISTRATION_MISSING');
    }
    try {
      execFileSync('git', ['worktree', 'remove', expectedPath, '--force'], {
        cwd: opts.repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Fall back to manual rm.
      try {
        rmSync(expectedPath, { recursive: true, force: true });
      } catch {
        // give up
      }
    }
    if (opts.deleteBranch === true) {
      execFileSync('git', ['branch', '-D', '--', record.branch], {
        cwd: opts.repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  }
  registry.worktrees = registry.worktrees.filter((w) => w.id !== opts.id);
  saveRegistry(opts.repoRoot, registry);
}

export function listWorktrees(opts: { repoRoot: string }): readonly WorktreeRecord[] {
  return [...loadRegistry(opts.repoRoot).worktrees].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

export interface AdoptWorktreeOptions {
  readonly repoRoot: string;
  readonly branch: string;
}

export function adoptWorktree(opts: AdoptWorktreeOptions): WorktreeRecord {
  return createWorktree({
    repoRoot: opts.repoRoot,
    id: `WT-human-${opts.branch.replace(/\//g, '-')}`,
    branch: opts.branch,
    baseRef: opts.branch,
    humanAdopted: true,
  });
}

/** Detect orphan worktrees and either log or remove them. */
export function reapWorktrees(opts: { repoRoot: string }): readonly string[] {
  const reaped: string[] = [];
  const registry = loadRegistry(opts.repoRoot);
  const remaining: WorktreeRecord[] = [];
  for (const w of registry.worktrees) {
    if (!existsSync(w.path)) {
      reaped.push(w.id);
      continue;
    }
    remaining.push(w);
  }
  // Unknown directories are deliberately preserved: they may be unrelated or
  // human-managed worktrees and the registry has no authority to delete them.
  registry.worktrees = remaining;
  saveRegistry(opts.repoRoot, registry);
  return reaped.sort();
}
