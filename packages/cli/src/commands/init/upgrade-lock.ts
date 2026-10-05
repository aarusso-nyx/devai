import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The exclusive repository binding lock (#264). init upgrade --write and
 * init bind --adopter-policy --write hold it across bind-journal recovery and every write, so
 * neither recovers or rolls back the other's live journal.
 *
 * It is taken by exclusive create with an owner token and removed only by that owner. A lock
 * is never taken over automatically: two contenders could otherwise both judge it stale and
 * one would delete the other's fresh lock. A lock whose owner is gone or has aged out refuses
 * with its own code and the exact manual removal step instead.
 */
export const UPGRADE_LOCK = '.devai/config/upgrade.lock';

/** A lock whose owner cannot be probed (another host, or a torn record) ages out after this. */
const STALE_AFTER_MS = 30 * 60 * 1000;
/** A same-host lock ages out after this even when its pid is alive, because pids are reused. */
const SAME_HOST_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

interface UpgradeLockRecord {
  readonly schemaVersion: '1.0.0';
  readonly action_id: string;
  readonly token: string;
  readonly pid: number;
  readonly host: string;
  readonly acquired_at: string;
}

function ownerText(holder: Readonly<Record<string, unknown>>): string {
  return `${String(holder['action_id'] ?? 'an unknown action')} (pid ${String(holder['pid'] ?? 'unknown')} on ${String(holder['host'] ?? 'unknown')} since ${String(holder['acquired_at'] ?? 'unknown')})`;
}

/** Raised when a live process holds the binding lock. */
export class UpgradeLockHeld extends Error {
  readonly code = 'INIT_UPGRADE_LOCKED';
  readonly detail: string;
  readonly holder: Readonly<Record<string, unknown>>;

  constructor(holder: Readonly<Record<string, unknown>>) {
    const detail = `${UPGRADE_LOCK} is held by ${ownerText(holder)}`;
    super(`INIT_UPGRADE_LOCKED:${detail}`);
    this.name = 'UpgradeLockHeld';
    this.detail = detail;
    this.holder = holder;
  }
}

/** Raised when the binding lock's owner is gone or has aged out: removal is a human step. */
export class UpgradeLockStale extends Error {
  readonly code = 'INIT_UPGRADE_LOCK_STALE';
  readonly detail: string;
  readonly removal: string;
  readonly holder: Readonly<Record<string, unknown>>;

  constructor(path: string, holder: Readonly<Record<string, unknown>>) {
    const removal = `rm "${path}"`;
    const detail = `${UPGRADE_LOCK} was left by ${ownerText(holder)}, which is no longer running or has aged out; once no init upgrade or init bind is running, remove it with: ${removal}`;
    super(`INIT_UPGRADE_LOCK_STALE:${detail}`);
    this.name = 'UpgradeLockStale';
    this.detail = detail;
    this.removal = removal;
    this.holder = holder;
  }
}

function readHolder(path: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** Classify the lock at `path` for a caller holding `ownToken` (or none). */
function lockState(
  path: string,
  ownToken?: string,
):
  | { readonly state: 'free' | 'own' }
  | { readonly state: 'live' | 'stale'; readonly holder: Readonly<Record<string, unknown>> } {
  if (!existsSync(path)) return { state: 'free' };
  const holder = readHolder(path);
  if (holder !== undefined && ownToken !== undefined && holder['token'] === ownToken) {
    return { state: 'own' };
  }
  const acquired =
    holder !== undefined && typeof holder['acquired_at'] === 'string'
      ? Date.parse(holder['acquired_at'])
      : lstatSync(path).mtimeMs;
  const age = Date.now() - (Number.isNaN(acquired) ? 0 : acquired);
  const recorded = holder ?? {};
  // A torn or foreign-host record cannot be probed; it is live until it ages out.
  if (holder === undefined || holder['host'] !== hostname() || typeof holder['pid'] !== 'number') {
    return { state: age < STALE_AFTER_MS ? 'live' : 'stale', holder: recorded };
  }
  return {
    state: processAlive(holder['pid']) && age < SAME_HOST_STALE_AFTER_MS ? 'live' : 'stale',
    holder: recorded,
  };
}

/** Refuse unless the binding lock of `targetRoot` is free or held by `ownToken`. */
export function assertUpgradeLockFree(targetRoot: string, ownToken?: string): void {
  const path = join(targetRoot, UPGRADE_LOCK);
  const current = lockState(path, ownToken);
  if (current.state === 'live') throw new UpgradeLockHeld(current.holder);
  if (current.state === 'stale') throw new UpgradeLockStale(path, current.holder);
}

/**
 * Take the binding lock by exclusive create. An existing lock is never replaced: a live owner
 * refuses with INIT_UPGRADE_LOCKED, a gone or aged-out owner with INIT_UPGRADE_LOCK_STALE.
 * The release removes the lock only while this owner's token is still recorded in it.
 */
export function acquireUpgradeLock(
  targetRoot: string,
  actionId = 'init upgrade',
): { readonly token: string; readonly release: () => void } {
  const path = join(targetRoot, UPGRADE_LOCK);
  const token = randomUUID();
  const record: UpgradeLockRecord = {
    schemaVersion: '1.0.0',
    action_id: actionId,
    token,
    pid: process.pid,
    host: hostname(),
    acquired_at: new Date().toISOString(),
  };
  const exists = (error: unknown): boolean =>
    error instanceof Error && 'code' in error && error.code === 'EEXIST';
  const create = () => writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  mkdirSync(dirname(path), { recursive: true });
  try {
    create();
  } catch (error) {
    if (!exists(error)) throw error;
    assertUpgradeLockFree(targetRoot);
    // The lock vanished between the create and the probe: its owner released it. Contend
    // again once, still by exclusive create, so no lock is ever removed but by its owner.
    try {
      create();
    } catch (retry) {
      if (!exists(retry)) throw retry;
      throw new UpgradeLockHeld(readHolder(path) ?? {});
    }
  }
  return {
    token,
    release: () => {
      if (readHolder(path)?.['token'] === token) rmSync(path, { force: true });
    },
  };
}
