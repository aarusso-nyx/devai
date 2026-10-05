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
 * The exclusive repository upgrade lock (#264). init upgrade --write holds it across journal
 * recovery, planning, every write, the doctor post-checks and the receipt commit, so two
 * upgrades never recover or roll back each other's live bind journal; a bind that recovers the
 * journal refuses while another process holds it.
 */
export const UPGRADE_LOCK = '.devai/config/upgrade.lock';

/** A lock whose holder cannot be shown alive is stale after this long. */
const STALE_AFTER_MS = 30 * 60 * 1000;
/** A same-host lock is stale after this long even when its pid is alive (pid reuse). */
const SAME_HOST_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

interface UpgradeLockRecord {
  readonly schemaVersion: '1.0.0';
  readonly action_id: 'init upgrade';
  readonly token: string;
  readonly pid: number;
  readonly host: string;
  readonly acquired_at: string;
}

/** Raised when another process holds the upgrade lock. */
export class UpgradeLockHeld extends Error {
  readonly code = 'INIT_UPGRADE_LOCKED';
  readonly detail: string;
  readonly holder: Readonly<Record<string, unknown>>;

  constructor(holder: Readonly<Record<string, unknown>>) {
    const detail = `another init upgrade holds ${UPGRADE_LOCK} (pid ${String(holder['pid'] ?? 'unknown')} on ${String(holder['host'] ?? 'unknown')} since ${String(holder['acquired_at'] ?? 'unknown')})`;
    super(`INIT_UPGRADE_LOCKED:${detail}`);
    this.name = 'UpgradeLockHeld';
    this.detail = detail;
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

/** Whether the lock at `path` is held by a live holder other than `ownToken`. */
function heldByAnother(path: string, ownToken?: string): Readonly<Record<string, unknown>> | null {
  if (!existsSync(path)) return null;
  const holder = readHolder(path);
  if (holder !== undefined && ownToken !== undefined && holder['token'] === ownToken) return null;
  const acquired =
    holder !== undefined && typeof holder['acquired_at'] === 'string'
      ? Date.parse(holder['acquired_at'])
      : lstatSync(path).mtimeMs;
  const age = Date.now() - (Number.isNaN(acquired) ? 0 : acquired);
  // A torn or foreign-host lock cannot be probed; it is live until it ages out.
  if (holder === undefined || holder['host'] !== hostname() || typeof holder['pid'] !== 'number') {
    return age < STALE_AFTER_MS ? (holder ?? {}) : null;
  }
  return processAlive(holder['pid']) && age < SAME_HOST_STALE_AFTER_MS ? holder : null;
}

/** Refuse when another live process holds the upgrade lock of `targetRoot`. */
export function assertUpgradeLockFree(targetRoot: string, ownToken?: string): void {
  const holder = heldByAnother(join(targetRoot, UPGRADE_LOCK), ownToken);
  if (holder !== null) throw new UpgradeLockHeld(holder);
}

/**
 * Take the upgrade lock by exclusive create, replacing a stale lock once. Returns the owner
 * token and a release that removes the lock only while this token still owns it.
 */
export function acquireUpgradeLock(targetRoot: string): {
  readonly token: string;
  readonly release: () => void;
} {
  const path = join(targetRoot, UPGRADE_LOCK);
  const token = randomUUID();
  const record: UpgradeLockRecord = {
    schemaVersion: '1.0.0',
    action_id: 'init upgrade',
    token,
    pid: process.pid,
    host: hostname(),
    acquired_at: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
      return {
        token,
        release: () => {
          if (readHolder(path)?.['token'] === token) rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const holder = heldByAnother(path);
      if (holder !== null) throw new UpgradeLockHeld(holder);
      rmSync(path, { force: true });
    }
  }
  throw new UpgradeLockHeld(readHolder(path) ?? {});
}
