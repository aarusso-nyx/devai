import { execFileSync } from '@devai-nyx/authority';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from '@devai-nyx/authority';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  PublicationIndeterminate,
  fsyncDirectorySync,
  publishCreateOnlyDurableSync,
  replaceDurableSync,
} from './durable-files.js';

/** The process running an autonomous attempt in a worktree. */
export interface WorktreeOwner {
  readonly pid: number;
  readonly hostname: string;
}

export interface WorktreeRecord {
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  readonly task_id?: string;
  readonly created_at: string;
  readonly human_adopted?: boolean;
  /**
   * Kept after its attempt settled, for human review or disposition. A retained
   * worktree no longer holds autonomous capacity (ADR-MDL-0007).
   */
  readonly retained?: boolean;
  /** Set for an autonomous attempt; once this process is provably gone the worktree is retained. */
  readonly owner?: WorktreeOwner;
}

export interface CreateWorktreeOptions extends RegistryLockOptions {
  readonly repoRoot: string;
  /** Worktree id, e.g. WT-<task-id> or WT-human-<branch>. */
  readonly id: string;
  /** Branch to create or check out. */
  readonly branch: string;
  /** Base ref when creating a new branch (default: HEAD). */
  readonly baseRef?: string;
  readonly taskId?: string;
  readonly humanAdopted?: boolean;
  /** The live process that runs an autonomous attempt in this worktree. */
  readonly owner?: WorktreeOwner;
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

/**
 * Replace the registry atomically: the complete next registry goes to a staged, fsynced
 * file renamed over it, and the directory entry is fsynced, so a crash leaves either the
 * previous registry or the next one, never a partial file.
 */
function saveRegistry(repoRoot: string, registry: WorktreeRegistry): void {
  replaceDurableSync(registryPath(repoRoot), JSON.stringify(registry, null, 2) + '\n');
}

/** Serializes every read-modify-replace of the registry across processes (#286). */
export const WORKTREE_REGISTRY_LOCK = '.devai/state/worktrees.lock';
/** How long a registry writer waits for another one by default. */
export const WORKTREE_REGISTRY_LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 25;

interface RegistryLockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly token: string;
  readonly acquired_at: string;
}

/** Options every registry writer accepts. */
export interface RegistryLockOptions {
  /** Bound on the wait for another registry writer (default 30 s); 0 refuses at once. */
  readonly lockWaitMs?: number;
}

/**
 * `WORKTREE_REGISTRY_LOCK_STALE`: the registry lock was left by a writer on this host that
 * is gone. It is never taken over automatically, since two contenders could both judge it
 * stale and remove each other's lock; removing it is a human step, named here.
 */
export class WorktreeRegistryLockStale extends Error {
  readonly code = 'WORKTREE_REGISTRY_LOCK_STALE';
  readonly removal: string;

  constructor(path: string) {
    super('WORKTREE_REGISTRY_LOCK_STALE');
    this.removal = `rm "${path}"`;
  }
}

function readRegistryLock(path: string): RegistryLockOwner | 'unreadable' | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return 'unreadable';
  }
  try {
    const value = JSON.parse(raw) as Partial<RegistryLockOwner>;
    return typeof value.pid === 'number' &&
      typeof value.hostname === 'string' &&
      typeof value.token === 'string'
      ? (value as RegistryLockOwner)
      : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `run` holding the registry lock. The lock is published atomically and never
 * replaced (ADR-AUT-0005), so no reader ever sees an empty or partial lock and exactly one
 * writer holds it. Another writer waits up to `lockWaitMs`, then refuses with
 * `WORKTREE_REGISTRY_BUSY`; a lock left by a provably gone process on this host refuses with
 * `WORKTREE_REGISTRY_LOCK_STALE`. The lock is not re-entrant.
 */
export function withWorktreeRegistryLock<T>(
  repoRoot: string,
  run: () => T,
  options: RegistryLockOptions = {},
): T {
  const path = join(repoRoot, WORKTREE_REGISTRY_LOCK);
  const owner: RegistryLockOwner = {
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    acquired_at: new Date().toISOString(),
  };
  const body = `${JSON.stringify(owner)}\n`;
  const deadline = Date.now() + (options.lockWaitMs ?? WORKTREE_REGISTRY_LOCK_WAIT_MS);
  // Only the owner whose token the lock records removes it, durably. A crash before release
  // leaves a lock naming a dead process, which refuses as stale rather than being taken over.
  const release = (): void => {
    const current = readRegistryLock(path);
    if (current !== undefined && current !== 'unreadable' && current.token === owner.token) {
      unlinkSync(path);
      fsyncDirectorySync(dirname(path));
    }
  };
  const acquire = (): boolean => {
    try {
      return publishCreateOnlyDurableSync(path, body);
    } catch (error) {
      // An indeterminate publication left our complete lock in place: it is ours to remove.
      if (error instanceof PublicationIndeterminate) release();
      throw error;
    }
  };
  while (!acquire()) {
    const held = readRegistryLock(path);
    if (
      held !== undefined &&
      held !== 'unreadable' &&
      held.hostname === hostname() &&
      !processAlive(held.pid)
    ) {
      throw new WorktreeRegistryLockStale(path);
    }
    if (Date.now() >= deadline) throw new Error('WORKTREE_REGISTRY_BUSY');
    sleepSync(LOCK_POLL_MS);
  }
  try {
    return run();
  } finally {
    release();
  }
}

/**
 * Per-host cap on concurrently active autonomous worktrees. ADR-MDL-0007 derives it
 * from `law/policy/round-execution.json` capacity.max_workers (a contract test pins
 * this mirror), replacing D-52's earlier value of 3, so every worker the policy
 * admits can hold its attempt worktree. Human-adopted and retained worktrees are
 * cap-exempt (Constitution Article 27): they hold work awaiting a human review or
 * disposition, not autonomous-loop parallelism.
 */
export const WORKTREE_CAP = 4;

/** True when the pid names a live process; EPERM means alive but not ours. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** An attempt owner is provably gone only when it ran on this host and its pid is dead. */
function ownerGone(owner: WorktreeOwner | undefined): boolean {
  return owner !== undefined && owner.hostname === hostname() && !processAlive(owner.pid);
}

/**
 * Whether a registry entry holds autonomous capacity: not human-adopted, not retained
 * for review or disposition, and not left by an attempt process that is provably gone
 * (that worktree waits for a human disposition instead). Orphan detection is the
 * separate `reapWorktrees` flow.
 */
export function holdsWorktreeCapacity(record: WorktreeRecord): boolean {
  return record.human_adopted !== true && record.retained !== true && !ownerGone(record.owner);
}

function activeNonAdoptedCount(registry: WorktreeRegistry): number {
  return registry.worktrees.filter(holdsWorktreeCapacity).length;
}

/**
 * Create and register a managed worktree. The cap check, the checkout and the registry
 * replace run under the registry lock, so concurrent admitters in other processes never
 * exceed the cap and never drop each other's entries (#286).
 */
export function createWorktree(opts: CreateWorktreeOptions): WorktreeRecord {
  if (!/^WT-[A-Za-z0-9._-]+$/u.test(opts.id)) {
    throw new Error(`invalid managed worktree id: ${opts.id}`);
  }
  return withWorktreeRegistryLock(opts.repoRoot, () => createWorktreeLocked(opts), opts);
}

function createWorktreeLocked(opts: CreateWorktreeOptions): WorktreeRecord {
  const registry = loadRegistry(opts.repoRoot);

  // Cap enforcement (ADR-MDL-0007). Human-adopted and retained worktrees are cap-exempt.
  // Replacing an entry that already holds capacity does not add a slot. Replacing an
  // exempt entry with an active autonomous one does, so it must satisfy the cap.
  const existing = registry.worktrees.find((w) => w.id === opts.id);
  const reusingExisting = existing !== undefined && holdsWorktreeCapacity(existing);
  if (
    !reusingExisting &&
    opts.humanAdopted !== true &&
    activeNonAdoptedCount(registry) >= WORKTREE_CAP
  ) {
    throw new Error(
      `worktree cap exceeded: ${String(WORKTREE_CAP)} autonomous worktrees already active. ` +
        'Complete or cancel an active task before creating another managed worktree; ' +
        'human-adopted and retained worktrees are exempt.',
    );
  }

  const wtRoot = worktreesDir(opts.repoRoot);
  mkdirSync(wtRoot, { recursive: true });
  const wtPath = join(wtRoot, opts.id);

  let branchExists = false;
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${opts.branch}`], {
      cwd: opts.repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    branchExists = true;
  } catch {
    // Git still validates the new branch name and base before creating a worktree.
  }
  const args = branchExists
    ? ['worktree', 'add', '--', wtPath, opts.branch]
    : ['worktree', 'add', '-b', opts.branch, '--', wtPath, opts.baseRef ?? 'HEAD'];
  execFileSync('git', args, {
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
    ...(opts.owner !== undefined && { owner: { ...opts.owner } }),
  };
  registry.worktrees = registry.worktrees.filter((w) => w.id !== opts.id);
  registry.worktrees.push(record);
  saveRegistry(opts.repoRoot, registry);
  return record;
}

/**
 * Keep a settled attempt's worktree for human review or disposition: it stays bound to
 * its task but no longer holds autonomous capacity.
 */
export function retainWorktree(
  opts: { readonly repoRoot: string; readonly id: string } & RegistryLockOptions,
): void {
  withWorktreeRegistryLock(
    opts.repoRoot,
    () => {
      const registry = loadRegistry(opts.repoRoot);
      const record = registry.worktrees.find((w) => w.id === opts.id);
      if (record === undefined) throw new Error('WORKTREE_NOT_REGISTERED');
      registry.worktrees = registry.worktrees.map((w) =>
        w.id === opts.id ? { ...w, retained: true } : w,
      );
      saveRegistry(opts.repoRoot, registry);
    },
    opts,
  );
}

/**
 * Release every managed worktree bound to one task: remove each checkout that still
 * exists and drop its registry entry. Branches are kept, and human-adopted worktrees
 * are never touched. Returns the released worktree ids in name order.
 */
export function releaseTaskWorktrees(
  opts: {
    readonly repoRoot: string;
    readonly taskId: string;
  } & RegistryLockOptions,
): readonly string[] {
  return withWorktreeRegistryLock(
    opts.repoRoot,
    () => {
      const bound = loadRegistry(opts.repoRoot).worktrees.filter(
        (w) => w.task_id === opts.taskId && w.human_adopted !== true,
      );
      const released: string[] = [];
      for (const record of bound) {
        if (existsSync(record.path)) {
          destroyWorktreeLocked({ repoRoot: opts.repoRoot, id: record.id });
        } else {
          const registry = loadRegistry(opts.repoRoot);
          registry.worktrees = registry.worktrees.filter((w) => w.id !== record.id);
          saveRegistry(opts.repoRoot, registry);
        }
        released.push(record.id);
      }
      return released.sort();
    },
    opts,
  );
}

interface DestroyWorktreeOptions extends RegistryLockOptions {
  repoRoot: string;
  id: string;
  forceHumanAdopted?: boolean;
  deleteBranch?: boolean;
}

export function destroyWorktree(opts: DestroyWorktreeOptions): void {
  if (!/^WT-[A-Za-z0-9._-]+$/u.test(opts.id)) {
    throw new Error(`invalid managed worktree id: ${opts.id}`);
  }
  withWorktreeRegistryLock(opts.repoRoot, () => destroyWorktreeLocked(opts), opts);
}

function destroyWorktreeLocked(opts: DestroyWorktreeOptions): void {
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
export function reapWorktrees(opts: { repoRoot: string } & RegistryLockOptions): readonly string[] {
  return withWorktreeRegistryLock(
    opts.repoRoot,
    () => {
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
    },
    opts,
  );
}
