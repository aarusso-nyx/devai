import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from '@devai-nyx/authority';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { utf8Compare } from './lock-targets.js';

export { taskLockTargets } from './lock-targets.js';
export type { LockTargetSource } from './lock-targets.js';

export interface LockRecord {
  readonly task_id: string;
  readonly substrate: string;
  readonly module: string;
  readonly acquired_at: string;
  readonly ttl_ms: number;
}

export interface AcquireLockOptions {
  readonly locksDir: string;
  readonly taskId: string;
  /** Target tuples as `substrate:module`, e.g. `F2:apps/api/src/users`. */
  readonly targets: readonly string[];
  readonly ttlMs?: number;
}

export interface AcquireResult {
  readonly acquired: readonly LockRecord[];
  readonly denied: readonly { target: string; held_by: string }[];
}

export const DEFAULT_LOCK_TTL_MS = 60 * 60 * 1000;
/** A holder renews well inside its TTL so a live dispatch never reads as expired. */
export const LOCK_RENEWAL_INTERVAL_MS = DEFAULT_LOCK_TTL_MS / 4;

function lockPath(locksDir: string, substrate: string, modulePart: string): string {
  // Module names may contain slashes (e.g. "apps/api/src/users"). Replace with
  // tildes for filesystem safety; restored when reading.
  return join(locksDir, `${substrate}~${modulePart.replace(/\//g, '~')}.json`);
}

/**
 * Atomically claim a lock file. Per Constitution Article 25, module locks
 * must be mutually exclusive. The previous implementation used
 *
 *   if (existsSync(path)) {…} else writeFileSync(path, …)
 *
 * which races: two agents both pass the existsSync check, both writeFile,
 * the later wins and the earlier silently believes it holds the lock.
 * We replace it with `openSync(path, 'wx')` — POSIX O_CREAT|O_EXCL — which
 * fails with EEXIST when the file already exists. fsync ensures the
 * record reaches disk before this call returns, so a concurrent reader
 * never sees a half-written lock.
 *
 * Returns true on successful atomic create.
 */
function tryAtomicCreate(path: string, record: LockRecord): boolean {
  try {
    const fd = openSync(path, 'wx');
    try {
      writeSync(fd, JSON.stringify(record, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Read a lock record, or `undefined` when gone, or `'unreadable'` when partial or corrupt. */
function observeLock(path: string): LockRecord | undefined | 'unreadable' {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockRecord;
  } catch {
    return existsSync(path) ? 'unreadable' : undefined;
  }
}

function expired(record: LockRecord, now = Date.now()): boolean {
  return now - new Date(record.acquired_at).getTime() >= record.ttl_ms;
}

function sameRecord(a: LockRecord, b: LockRecord): boolean {
  return a.task_id === b.task_id && a.acquired_at === b.acquired_at && a.ttl_ms === b.ttl_ms;
}

/**
 * Remove the exact expired lock record that was observed, never a newer one.
 *
 * Unlinking by path after a read races: two reapers both read the same expired
 * record, the first replaces it with a fresh lock, and the second then unlinks
 * that fresh lock. Instead the lock is renamed aside atomically (only one
 * renamer can move a given file) and the moved record is compared with the one
 * observed. A fresh lock moved by mistake is restored with an exclusive create;
 * if a third acquirer filled the path in that instant, the displaced holder
 * detects the loss at its next renewal (`renewLocks`).
 */
function removeObservedExpired(path: string, observed: LockRecord): boolean {
  const aside = `${path}.reap-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch {
    return false; // Already moved by another reaper.
  }
  let raw = '';
  let moved: LockRecord | undefined;
  try {
    raw = readFileSync(aside, 'utf8');
    moved = JSON.parse(raw) as LockRecord;
  } catch {
    moved = undefined;
  }
  const exact = moved !== undefined && sameRecord(moved, observed) && expired(moved);
  if (!exact && raw.length > 0) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, raw);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // A third acquirer filled the path; the displaced holder sees the loss on renewal.
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // best-effort
  }
  return exact;
}

/**
 * Remove one expired lock only if it still is exactly the `expected` record.
 * Returns false, leaving the path untouched, when the lock is unexpired, gone,
 * or was replaced after the caller read it.
 */
export function reapLock(opts: {
  readonly locksDir: string;
  readonly target: string;
  readonly expected: LockRecord;
}): boolean {
  if (!expired(opts.expected)) return false;
  const { substrate, modulePart } = parseTarget(opts.target);
  return removeObservedExpired(lockPath(opts.locksDir, substrate, modulePart), opts.expected);
}

function holderOf(path: string): string {
  const observed = observeLock(path);
  if (observed === 'unreadable') return '<unreadable>';
  return observed?.task_id ?? '<unknown>';
}

function parseTarget(target: string): { substrate: string; modulePart: string } {
  const [substrate = 'F2', ...rest] = target.split(':');
  return { substrate, modulePart: rest.join(':') };
}

/**
 * Acquire every target all-or-nothing, in UTF-8 key order (`round-execution.json`
 * resources.acquisition_order). A key this task already holds unexpired counts as
 * held. On the first conflict, keys created by this call are released and the
 * conflict is reported; keys held before the call are left untouched.
 */
export function acquireLocks(opts: AcquireLockOptions): AcquireResult {
  mkdirSync(opts.locksDir, { recursive: true });
  const acquired: LockRecord[] = [];
  const created: string[] = [];
  const now = new Date().toISOString();
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const targets = [...new Set(opts.targets)].sort(utf8Compare);

  const deny = (target: string, held_by: string): AcquireResult => {
    for (const path of created) {
      const observed = observeLock(path);
      if (observed !== undefined && observed !== 'unreadable' && observed.task_id === opts.taskId) {
        try {
          unlinkSync(path);
        } catch {
          // best-effort
        }
      }
    }
    return { acquired: [], denied: [{ target, held_by }] };
  };

  for (const target of targets) {
    const { substrate, modulePart } = parseTarget(target);
    const path = lockPath(opts.locksDir, substrate, modulePart);
    const record: LockRecord = {
      task_id: opts.taskId,
      substrate,
      module: modulePart,
      acquired_at: now,
      ttl_ms: ttlMs,
    };

    if (tryAtomicCreate(path, record)) {
      acquired.push(record);
      created.push(path);
      continue;
    }

    const observed = observeLock(path);
    if (observed === 'unreadable') {
      // Mid-write by another process, or corrupted: treat as held.
      return deny(target, '<unreadable>');
    }
    if (observed === undefined) {
      // Released between our create and read; one retry, then report the winner.
      if (tryAtomicCreate(path, record)) {
        acquired.push(record);
        created.push(path);
        continue;
      }
      return deny(target, holderOf(path));
    }
    if (!expired(observed)) {
      if (observed.task_id === opts.taskId) {
        acquired.push(observed);
        continue;
      }
      return deny(target, observed.task_id);
    }
    if (removeObservedExpired(path, observed) && tryAtomicCreate(path, record)) {
      acquired.push(record);
      created.push(path);
      continue;
    }
    return deny(target, holderOf(path));
  }

  return { acquired, denied: [] };
}

export interface RenewLocksResult {
  readonly renewed: readonly LockRecord[];
  /** Targets this task no longer holds: missing, or now held by another task. */
  readonly lost: readonly { target: string; held_by: string }[];
}

/**
 * Restart the TTL of every target the task still holds, so a dispatch longer
 * than one TTL keeps its locks. Each record is rewritten through a rename so a
 * reader never sees a partial file. A target held by another task, or missing,
 * is reported as lost and never reclaimed here.
 */
export function renewLocks(opts: {
  readonly locksDir: string;
  readonly taskId: string;
  readonly targets: readonly string[];
}): RenewLocksResult {
  const renewed: LockRecord[] = [];
  const lost: { target: string; held_by: string }[] = [];
  const now = new Date().toISOString();
  for (const target of [...new Set(opts.targets)].sort(utf8Compare)) {
    const { substrate, modulePart } = parseTarget(target);
    const path = lockPath(opts.locksDir, substrate, modulePart);
    const observed = observeLock(path);
    if (observed === undefined || observed === 'unreadable') {
      lost.push({ target, held_by: observed === undefined ? '<none>' : '<unreadable>' });
      continue;
    }
    if (observed.task_id !== opts.taskId) {
      lost.push({ target, held_by: observed.task_id });
      continue;
    }
    const record: LockRecord = { ...observed, acquired_at: now };
    const staged = `${path}.renew-${process.pid}-${randomUUID()}`;
    const fd = openSync(staged, 'wx');
    try {
      writeSync(fd, JSON.stringify(record, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staged, path);
    renewed.push(record);
  }
  return { renewed, lost };
}

export function releaseLocks(opts: { locksDir: string; taskId: string }): readonly LockRecord[] {
  const released: LockRecord[] = [];
  if (!existsSync(opts.locksDir)) return released;
  for (const name of readdirSync(opts.locksDir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(opts.locksDir, name);
    let record: LockRecord;
    try {
      record = JSON.parse(readFileSync(path, 'utf8')) as LockRecord;
    } catch {
      continue;
    }
    if (record.task_id === opts.taskId) {
      unlinkSync(path);
      released.push(record);
    }
  }
  return released;
}

export function listLocks(opts: { locksDir: string }): readonly LockRecord[] {
  const records: LockRecord[] = [];
  if (!existsSync(opts.locksDir)) return records;
  for (const name of readdirSync(opts.locksDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(readFileSync(join(opts.locksDir, name), 'utf8')) as LockRecord);
    } catch {
      // skip
    }
  }
  return records.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
}

/** Remove expired locks. Returns the records that were removed. */
export function reapLocks(opts: { locksDir: string }): readonly LockRecord[] {
  const removed: LockRecord[] = [];
  if (!existsSync(opts.locksDir)) return removed;
  const now = Date.now();
  for (const name of readdirSync(opts.locksDir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(opts.locksDir, name);
    const observed = observeLock(path);
    if (observed === undefined || observed === 'unreadable') continue;
    if (expired(observed, now) && removeObservedExpired(path, observed)) {
      removed.push(observed);
    }
  }
  return removed;
}

// Type stub to satisfy linter that statSync import is "used" semantically;
// it's kept available for callers extending lock metadata. (No-op.)
export function lockMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
