import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  PUBLISH_INDETERMINATE,
  closeReadOnlySync,
  openRegularFileReadOnlySync,
  publishFileNoReplaceSync,
  unlinkSync,
} from '@devai-nyx/authority';

/**
 * The exclusive repository recipe-install lock (#313). A recipe adapter installation holds
 * it across its write-time recheck, every publication and any rollback, so two DEVAI
 * installers never interleave in one repository.
 *
 * It is created only by the ADR-AUT-0005 no-replace publication, carries an owner token and
 * is removed only by that owner. It is never taken over: a lock whose owner is gone or has
 * aged out refuses with RECIPE_INSTALL_LOCK_STALE and the exact manual removal step.
 */
export const RECIPE_INSTALL_LOCK = '.devai/state/recipe-adapters.lock';

/** A lock whose owner cannot be probed (another host, or a torn record) ages out after this. */
const STALE_AFTER_MS = 30 * 60 * 1000;
/** A same-host lock ages out after this even when its pid is alive, because pids are reused. */
const SAME_HOST_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

type Holder = Readonly<Record<string, unknown>>;

/**
 * Identity of a file this process published, as the ADR-AUT-0005 publication returns it:
 * device, inode and the inode's birth time in nanoseconds (inode numbers are reused).
 */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}

/** The identity an indeterminate ADR-AUT-0005 publication linked into place, if `error` is one. */
export function indeterminateIdentity(error: unknown): FileIdentity | undefined {
  if ((error as { code?: unknown } | null)?.code !== PUBLISH_INDETERMINATE) return undefined;
  const identity = (error as { identity?: unknown }).identity as Partial<FileIdentity> | undefined;
  return typeof identity?.dev === 'bigint' &&
    typeof identity.ino === 'bigint' &&
    typeof identity.birthtimeNs === 'bigint'
    ? { dev: identity.dev, ino: identity.ino, birthtimeNs: identity.birthtimeNs }
    : undefined;
}

/** Whether the entry at `path` (lstat, never followed at its final component) is `identity`. */
export function hasIdentity(path: string, identity: FileIdentity): boolean {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return (
    stat?.isFile() === true &&
    stat.dev === identity.dev &&
    stat.ino === identity.ino &&
    stat.birthtimeNs === identity.birthtimeNs
  );
}

/** Unlinks `path` only while its lstat is a regular file with exactly `identity`. */
export function unlinkIfIdentity(path: string, identity: FileIdentity): boolean {
  if (!hasIdentity(path, identity)) return false;
  unlinkSync(path);
  return true;
}

function ownerText(holder: Holder): string {
  return `pid ${String(holder['pid'] ?? 'unknown')} on ${String(holder['host'] ?? 'unknown')} since ${String(holder['acquired_at'] ?? 'unknown')}`;
}

/** Raised when a live installer holds the lock. */
export class RecipeInstallLocked extends Error {
  readonly code = 'RECIPE_INSTALL_LOCKED';
  readonly holder: Holder;

  constructor(holder: Holder) {
    super(`RECIPE_INSTALL_LOCKED: ${RECIPE_INSTALL_LOCK} is held by ${ownerText(holder)}`);
    this.name = 'RecipeInstallLocked';
    this.holder = holder;
  }
}

/** Raised when the lock's owner is gone or has aged out: removal is a human step. */
export class RecipeInstallLockStale extends Error {
  readonly code = 'RECIPE_INSTALL_LOCK_STALE';
  readonly removal: string;
  readonly holder: Holder;

  constructor(path: string, holder: Holder) {
    const removal = `rm "${path}"`;
    super(
      `RECIPE_INSTALL_LOCK_STALE: ${RECIPE_INSTALL_LOCK} was left by ${ownerText(holder)}, which is no longer running or has aged out; once no recipe installation is running, remove it with: ${removal}`,
    );
    this.name = 'RecipeInstallLockStale';
    this.removal = removal;
    this.holder = holder;
  }
}

/** Reads the lock record without following a link; undefined when absent, torn or not a file. */
function readHolder(path: string): Holder | undefined {
  let descriptor: number;
  try {
    // Non-blocking and no-follow: a FIFO or other special entry is refused before any read.
    descriptor = openRegularFileReadOnlySync(path);
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Holder)
      : undefined;
  } catch {
    return undefined;
  } finally {
    closeReadOnlySync(descriptor);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function refuseHeld(path: string): never {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) throw new RecipeInstallLocked({});
  if (!stat.isFile()) {
    // A link, FIFO, directory or socket is never a lock record: never read, never removed here.
    throw Object.assign(
      new Error(
        `RECIPE_INSTALL_LOCK_INVALID: ${RECIPE_INSTALL_LOCK} is not a regular file; once no recipe installation is running, inspect and remove it with: rm -r "${path}"`,
      ),
      { code: 'RECIPE_INSTALL_LOCK_INVALID' },
    );
  }
  const holder = readHolder(path);
  const recorded = holder ?? {};
  const acquired =
    holder !== undefined && typeof holder['acquired_at'] === 'string'
      ? Date.parse(holder['acquired_at'])
      : stat.mtimeMs;
  const age = Date.now() - (Number.isNaN(acquired) ? 0 : acquired);
  // A torn or foreign-host record cannot be probed; it is live until it ages out.
  const live =
    holder === undefined || holder['host'] !== hostname() || typeof holder['pid'] !== 'number'
      ? age < STALE_AFTER_MS
      : processAlive(holder['pid']) && age < SAME_HOST_STALE_AFTER_MS;
  if (live) throw new RecipeInstallLocked(recorded);
  throw new RecipeInstallLockStale(path, recorded);
}

/**
 * Takes the lock under `repoRoot`. The state root `.devai/state` must already be a real
 * directory (init apply harness creates it before installing adapters); a missing state root
 * or a link on its path refuses rather than being created here. An existing lock is never
 * replaced: a live owner refuses with RECIPE_INSTALL_LOCKED, a gone or aged-out owner with
 * RECIPE_INSTALL_LOCK_STALE. The release removes the lock only while it still holds this
 * owner's token and is the file this call published.
 */
export function acquireRecipeInstallLock(repoRoot: string): { readonly release: () => void } {
  for (const segment of ['.devai', '.devai/state']) {
    const stat = lstatSync(join(repoRoot, segment), { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`RECIPE_INSTALL_STATE_ROOT_MISSING: ${segment}`);
    }
  }
  const path = join(repoRoot, RECIPE_INSTALL_LOCK);
  const token = randomUUID();
  const record = {
    schemaVersion: '1.0.0',
    action_id: 'recipe adapter install',
    token,
    pid: process.pid,
    host: hostname(),
    acquired_at: new Date().toISOString(),
  };
  let identity: FileIdentity;
  try {
    identity = publishFileNoReplaceSync(path, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    const linked = indeterminateIdentity(error);
    if (linked !== undefined) {
      // The lock is in place without a durability promise: remove this owner's lock and refuse.
      unlinkIfIdentity(path, linked);
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    refuseHeld(path);
  }
  return {
    release: () => {
      if (readHolder(path)?.['token'] === token) unlinkIfIdentity(path, identity);
    },
  };
}
