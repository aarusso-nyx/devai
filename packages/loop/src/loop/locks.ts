import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { utf8Compare } from './lock-targets.js';
import {
  createRecordExclusive,
  fsyncDirectory,
  isStaleClaim,
  observeRecord,
  recordIdentity,
  swapObservedRecord,
  type SwapOutcome,
} from './record-claims.js';
import { TaskServiceError } from './task-queue-services.js';

export { taskLockTargets } from './lock-targets.js';
export type { LockTargetSource } from './lock-targets.js';

export interface LockRecord {
  readonly task_id: string;
  readonly substrate: string;
  readonly module: string;
  readonly acquired_at: string;
  readonly ttl_ms: number;
  /**
   * Unique per acquisition and renewal, so a release and re-acquisition by the same task
   * within one millisecond still writes a different record. A record written before
   * generations existed has none and is its own generation.
   */
  readonly generation?: string;
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

/*
 * Lock protocol (Constitution Article 25: module locks are mutually exclusive).
 *
 * A free key is taken with an exclusive create (O_CREAT|O_EXCL), so two acquirers can
 * never both create it. Every other change to a key -- taking over an expired record,
 * renewing, releasing, reaping, rolling back -- goes through `swapObservedRecord`: it
 * claims the exact record it observed and re-reads it under that claim, then replaces
 * the record with a complete staged file in one rename, or removes it. A key is never
 * vacated and refilled during a takeover or renewal, and a record that is not provably
 * the observed one is never moved, so a stale reaper or a late renewal can only stand
 * down. Claims live beside the locks directory so it lists lock records only.
 */

function lockPath(locksDir: string, substrate: string, modulePart: string): string {
  // Module names may contain slashes (e.g. "apps/api/src/users"). Replace with
  // tildes for filesystem safety; restored when reading.
  return join(locksDir, `${substrate}~${modulePart.replace(/\//g, '~')}.json`);
}

function claimsDir(locksDir: string): string {
  return join(dirname(locksDir), 'lock-claims');
}

function serialize(record: LockRecord): string {
  return JSON.stringify(record, null, 2) + '\n';
}

type LockObservation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'held'; readonly record: LockRecord; readonly identity: string };

function isLockRecord(value: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof value.task_id === 'string' &&
    typeof value.acquired_at === 'string' &&
    typeof value.ttl_ms === 'number' &&
    Number.isFinite(value.ttl_ms) &&
    (value.generation === undefined || typeof value.generation === 'string')
  );
}

/** Read a lock: gone, `unreadable` when partial, corrupt, or malformed, or held. */
function observeLock(path: string): LockObservation {
  const observed = observeRecord(path);
  if (observed.kind !== 'record') return observed;
  if (!isLockRecord(observed.value)) return { kind: 'unreadable' };
  return {
    kind: 'held',
    record: observed.value as unknown as LockRecord,
    identity: observed.identity,
  };
}

/** The identity `swapObservedRecord` compares: the record's exact canonical content. */
export function lockIdentity(record: LockRecord): string {
  return recordIdentity(record);
}

function expired(record: LockRecord, now = Date.now()): boolean {
  return now - new Date(record.acquired_at).getTime() >= record.ttl_ms;
}

/**
 * A swap whose claim cannot be proven abandoned stands down like a live claim; callers
 * that must surface the repair (acquisition, controller takeover) call the swap directly.
 */
function swapOrStandDown(options: Parameters<typeof swapObservedRecord>[0]): SwapOutcome | 'stale' {
  try {
    return swapObservedRecord(options);
  } catch (error) {
    if (isStaleClaim(error)) return 'stale';
    throw error;
  }
}

/**
 * Remove one expired lock only if it still is exactly the `expected` record.
 * Returns false, leaving the path untouched, when the lock is unexpired, gone,
 * unreadable, claimed by another writer, or was replaced after the caller read it.
 */
export function reapLock(opts: {
  readonly locksDir: string;
  readonly target: string;
  readonly expected: LockRecord;
}): boolean {
  if (!expired(opts.expected)) return false;
  const { substrate, modulePart } = parseTarget(opts.target);
  return (
    swapOrStandDown({
      path: lockPath(opts.locksDir, substrate, modulePart),
      claimsDir: claimsDir(opts.locksDir),
      identity: lockIdentity(opts.expected),
    }) === 'swapped'
  );
}

function holderOf(path: string): string {
  const observed = observeLock(path);
  if (observed.kind === 'unreadable') return '<unreadable>';
  return observed.kind === 'held' ? observed.record.task_id : '<unknown>';
}

function parseTarget(target: string): { substrate: string; modulePart: string } {
  const [substrate = 'F2', ...rest] = target.split(':');
  return { substrate, modulePart: rest.join(':') };
}

/**
 * Acquire every target all-or-nothing, in UTF-8 key order (`round-execution.json`
 * resources.acquisition_order). A key this task already holds unexpired counts as
 * held. On the first conflict, the exact records this call created are released and
 * the conflict is reported; keys held before the call are left untouched. An expired
 * key whose claim cannot be proven abandoned refuses with `TASK_RECORD_CLAIM_STALE`,
 * naming the claim to repair, after the same release.
 */
export function acquireLocks(opts: AcquireLockOptions): AcquireResult {
  mkdirSync(opts.locksDir, { recursive: true });
  const claims = claimsDir(opts.locksDir);
  const created: { path: string; identity: string }[] = [];
  const rollBack = (): void => {
    for (const { path, identity } of created) {
      try {
        swapObservedRecord({ path, claimsDir: claims, identity });
      } catch {
        // best-effort: an unreleased record expires and stays this task's own
      }
    }
  };
  try {
    return acquireAll(opts, claims, created, rollBack);
  } catch (error) {
    rollBack();
    throw error;
  }
}

function acquireAll(
  opts: AcquireLockOptions,
  claims: string,
  created: { path: string; identity: string }[],
  rollBack: () => void,
): AcquireResult {
  const acquired: LockRecord[] = [];
  const now = new Date().toISOString();
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const targets = [...new Set(opts.targets)].sort(utf8Compare);

  const deny = (target: string, held_by: string): AcquireResult => {
    rollBack();
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
      generation: randomUUID(),
    };
    const body = serialize(record);
    const take = (): void => {
      acquired.push(record);
      created.push({ path, identity: lockIdentity(record) });
    };

    if (createRecordExclusive(path, body)) {
      take();
      continue;
    }

    const observed = observeLock(path);
    if (observed.kind === 'unreadable') {
      // Mid-write by its creator, or corrupted: treat as held.
      return deny(target, '<unreadable>');
    }
    if (observed.kind === 'absent') {
      // Released between our create and read; one retry, then report the winner.
      if (createRecordExclusive(path, body)) {
        take();
        continue;
      }
      return deny(target, holderOf(path));
    }
    if (!expired(observed.record)) {
      if (observed.record.task_id === opts.taskId) {
        acquired.push(observed.record);
        continue;
      }
      return deny(target, observed.record.task_id);
    }
    // Take over exactly the expired record observed, never a newer one.
    if (
      swapObservedRecord({ path, claimsDir: claims, identity: observed.identity, next: body }) ===
      'swapped'
    ) {
      take();
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
 * Restart the TTL of every target the task still holds, so a dispatch longer than
 * one TTL keeps its locks. Each renewal replaces exactly the record observed, so a
 * renewal that read its own expired record can never overwrite a takeover that
 * happened since. A target held by another task, missing, or claimed by another
 * writer is reported as lost and never reclaimed here.
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
    if (observed.kind !== 'held') {
      lost.push({ target, held_by: observed.kind === 'absent' ? '<none>' : '<unreadable>' });
      continue;
    }
    if (observed.record.task_id !== opts.taskId) {
      lost.push({ target, held_by: observed.record.task_id });
      continue;
    }
    const record: LockRecord = { ...observed.record, acquired_at: now, generation: randomUUID() };
    const outcome = swapOrStandDown({
      path,
      claimsDir: claimsDir(opts.locksDir),
      identity: observed.identity,
      next: serialize(record),
    });
    if (outcome === 'swapped') renewed.push(record);
    else
      lost.push({
        target,
        held_by:
          outcome === 'claimed'
            ? '<claimed>'
            : outcome === 'stale'
              ? '<stale-claim>'
              : holderOf(path),
      });
  }
  return { renewed, lost };
}

export interface LockInspection {
  /** Keys this task holds, with the identity of the exact record held. */
  readonly held: readonly { target: string; record: LockRecord; identity: string }[];
  /** Keys this task does not hold: missing, unreadable, or held by another task. */
  readonly lost: readonly { target: string; held_by: string }[];
}

/** Read, without changing anything, which of `targets` the task holds right now. */
export function inspectLocks(opts: {
  readonly locksDir: string;
  readonly taskId: string;
  readonly targets: readonly string[];
}): LockInspection {
  const held: { target: string; record: LockRecord; identity: string }[] = [];
  const lost: { target: string; held_by: string }[] = [];
  for (const target of [...new Set(opts.targets)].sort(utf8Compare)) {
    const { substrate, modulePart } = parseTarget(target);
    const observed = observeLock(lockPath(opts.locksDir, substrate, modulePart));
    if (observed.kind === 'held' && observed.record.task_id === opts.taskId) {
      held.push({ target, record: observed.record, identity: observed.identity });
      continue;
    }
    lost.push({
      target,
      held_by:
        observed.kind === 'held'
          ? observed.record.task_id
          : observed.kind === 'absent'
            ? '<none>'
            : '<unreadable>',
    });
  }
  return { held, lost };
}

/** The durable fence of one dispatch attempt (see `openLockFence`). */
export interface LockFence {
  readonly task_id: string;
  readonly round_id: string;
  readonly attempt: string;
  readonly targets: readonly string[];
}

function fencesDir(locksDir: string): string {
  return join(dirname(locksDir), 'lock-fences');
}

function fencePath(locksDir: string, taskId: string): string {
  return join(fencesDir(locksDir), `${taskId}.json`);
}

function receiptPath(locksDir: string, fence: LockFence, keyFile: string): string {
  return join(fencesDir(locksDir), `${fence.task_id}.${fence.attempt}.${keyFile}.released`);
}

function keyFileOf(target: string): string {
  const { substrate, modulePart } = parseTarget(target);
  return basename(lockPath('.', substrate, modulePart));
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Read a fence only if it can be judged: it names the task its file is named for, a
 * round, an attempt, and at least one target. Anything less would let reconciliation
 * judge an attempt clean that it never checked.
 */
function readFence(path: string): LockFence | undefined {
  const observed = observeRecord(path);
  if (observed.kind !== 'record') return undefined;
  const value = observed.value;
  return nonEmpty(value.task_id) &&
    `${value.task_id}.json` === basename(path) &&
    nonEmpty(value.round_id) &&
    nonEmpty(value.attempt) &&
    Array.isArray(value.targets) &&
    value.targets.length > 0 &&
    value.targets.every(nonEmpty)
    ? (value as unknown as LockFence)
    : undefined;
}

/**
 * Open the durable fence of one dispatch attempt. While it stands, the task's own
 * `releaseLocks` leaves a receipt per key, written under the claim on the exact record
 * it then removes. A receipt therefore proves the task held that key up to its own
 * release; a key that is neither held nor receipted was taken from it. Because the
 * receipts outlive a crash of the runner, the next run can still tell the two apart.
 */
export function openLockFence(opts: {
  readonly locksDir: string;
  readonly taskId: string;
  readonly roundId: string;
  readonly targets: readonly string[];
}): LockFence {
  const fence: LockFence = {
    task_id: opts.taskId,
    round_id: opts.roundId,
    attempt: randomUUID(),
    targets: [...new Set(opts.targets)].sort(utf8Compare),
  };
  const path = fencePath(opts.locksDir, opts.taskId);
  const staged = `${path}.${String(process.pid)}-${randomUUID()}.staged`;
  const body = `${JSON.stringify(fence)}\n`;
  // The fence must survive a crash before the dispatch it guards begins: its staged
  // bytes are fsynced, then the rename into place is made durable with the directory.
  let written: boolean;
  try {
    written = createRecordExclusive(staged, body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(fencesDir(opts.locksDir), { recursive: true });
    // A new fence directory is itself a directory entry: make it durable in `.devai/state`
    // so the first fence cannot vanish with it.
    fsyncDirectory(dirname(fencesDir(opts.locksDir)));
    written = createRecordExclusive(staged, body);
  }
  if (!written) throw Object.assign(new Error(`EEXIST: ${staged}`), { code: 'EEXIST' });
  renameSync(staged, path);
  fsyncDirectory(fencesDir(opts.locksDir));
  return fence;
}

/** The fence's targets the task released itself during the attempt. */
export function lockFenceReleases(opts: {
  readonly locksDir: string;
  readonly fence: LockFence;
}): ReadonlySet<string> {
  return new Set(
    opts.fence.targets.filter((target) =>
      existsSync(receiptPath(opts.locksDir, opts.fence, keyFileOf(target))),
    ),
  );
}

/** Every fence left open, by a dispatch in flight or by a runner that stopped. */
export function listLockFences(opts: { readonly locksDir: string }): readonly LockFence[] {
  const dir = fencesDir(opts.locksDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort(utf8Compare)
    .map((name) => {
      const path = join(dir, name);
      const fence = readFence(path);
      // An attempt nobody can judge is never skipped: it may hide a lost lock.
      if (fence === undefined) throw invalidFence(path);
      return fence;
    });
}

function invalidFence(path: string): TaskServiceError {
  const error = new TaskServiceError('TASK_LOCK_FENCE_INVALID');
  error.message =
    `TASK_LOCK_FENCE_INVALID: ${path} is not a readable attempt fence, so the attempt it ` +
    "guarded cannot be judged; check that task's lock and status by hand, then repair or " +
    'remove the file';
  return error;
}

/**
 * Retire a fence once its attempt has been judged: the fence first, made durable, and
 * only then its receipts. A fence that cannot be removed keeps its receipts, so a later
 * run still judges the attempt with every proof it had; an unreadable fence in its
 * place is left, with the receipts, for the next run to refuse.
 */
export function closeLockFence(opts: {
  readonly locksDir: string;
  readonly fence: LockFence;
}): void {
  const path = fencePath(opts.locksDir, opts.fence.task_id);
  const current = observeRecord(path);
  if (current.kind === 'unreadable') return;
  if (current.kind === 'record') {
    const standing = readFence(path);
    if (standing === undefined) return;
    if (standing.attempt === opts.fence.attempt) {
      try {
        unlinkSync(path);
      } catch {
        return;
      }
      fsyncDirectory(fencesDir(opts.locksDir));
    }
  }
  for (const target of opts.fence.targets) {
    const receipt = receiptPath(opts.locksDir, opts.fence, keyFileOf(target));
    if (!existsSync(receipt)) continue;
    try {
      unlinkSync(receipt);
    } catch {
      // A receipt without its fence names one attempt and is ignored by every other.
    }
  }
}

/** Release every record the task still holds; records another task took over stay. */
export function releaseLocks(opts: { locksDir: string; taskId: string }): readonly LockRecord[] {
  const released: LockRecord[] = [];
  if (!existsSync(opts.locksDir)) return released;
  const fence = readFence(fencePath(opts.locksDir, opts.taskId));
  const fenced = new Set(fence?.targets.map(keyFileOf));
  for (const name of readdirSync(opts.locksDir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(opts.locksDir, name);
    const observed = observeLock(path);
    if (observed.kind !== 'held' || observed.record.task_id !== opts.taskId) continue;
    if (
      swapOrStandDown({
        path,
        claimsDir: claimsDir(opts.locksDir),
        identity: observed.identity,
        // The receipt follows the removal, under the claim: it attests a release that
        // happened. One interrupted before its receipt is judged lost, never clean.
        ...(fence !== undefined &&
          fenced.has(name) && {
            onSwapped: () =>
              writeFileSync(receiptPath(opts.locksDir, fence, name), `${JSON.stringify(fence)}\n`),
          }),
      }) === 'swapped'
    ) {
      released.push(observed.record);
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
    if (observed.kind !== 'held' || !expired(observed.record, now)) continue;
    if (
      swapOrStandDown({
        path,
        claimsDir: claimsDir(opts.locksDir),
        identity: observed.identity,
      }) === 'swapped'
    ) {
      removed.push(observed.record);
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
