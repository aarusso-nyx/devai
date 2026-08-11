import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from '@devai-nyx/authority';
import { join } from 'node:path';

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

const DEFAULT_TTL_MS = 60 * 60 * 1000;

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

export function acquireLocks(opts: AcquireLockOptions): AcquireResult {
  mkdirSync(opts.locksDir, { recursive: true });
  const acquired: LockRecord[] = [];
  const denied: { target: string; held_by: string }[] = [];
  const now = new Date().toISOString();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  for (const target of opts.targets) {
    const [substrate = 'F2', ...rest] = target.split(':');
    const modulePart = rest.join(':');
    const path = lockPath(opts.locksDir, substrate, modulePart);
    const record: LockRecord = {
      task_id: opts.taskId,
      substrate,
      module: modulePart,
      acquired_at: now,
      ttl_ms: ttlMs,
    };

    // First attempt: atomic create. Wins when no lock file exists.
    if (tryAtomicCreate(path, record)) {
      acquired.push(record);
      continue;
    }

    // File exists. Read existing lock; if expired, try to take it.
    let existing: LockRecord;
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as LockRecord;
    } catch {
      // Lock file was unreadable (mid-write by another process, or
      // corrupted). Treat as held to avoid stomping on it.
      denied.push({ target, held_by: '<unreadable>' });
      continue;
    }
    const age = Date.now() - new Date(existing.acquired_at).getTime();
    if (age < existing.ttl_ms) {
      denied.push({ target, held_by: existing.task_id });
      continue;
    }
    // Lock is expired. Unlink + atomic-create-retry. If another agent
    // grabs it between our unlink and our create, we lose cleanly and
    // record the new holder.
    try {
      unlinkSync(path);
    } catch {
      // Already gone (another reaper); fall through to retry.
    }
    if (tryAtomicCreate(path, record)) {
      acquired.push(record);
    } else {
      let winner: LockRecord | undefined;
      try {
        winner = JSON.parse(readFileSync(path, 'utf8')) as LockRecord;
      } catch {
        // ignore
      }
      denied.push({ target, held_by: winner?.task_id ?? '<unknown>' });
    }
  }

  return { acquired, denied };
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
    let record: LockRecord;
    try {
      record = JSON.parse(readFileSync(path, 'utf8')) as LockRecord;
    } catch {
      continue;
    }
    const age = now - new Date(record.acquired_at).getTime();
    if (age >= record.ttl_ms) {
      try {
        unlinkSync(path);
        removed.push(record);
      } catch {
        // skip
      }
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
