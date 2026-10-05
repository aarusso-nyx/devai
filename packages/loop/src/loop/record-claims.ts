import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from '@devai-nyx/authority';
import { canonicalSha256 } from '@devai-nyx/utils';
import { randomUUID } from 'node:crypto';
import { hostname, uptime } from 'node:os';
import { basename, join } from 'node:path';
import { TaskServiceError } from './task-queue-services.js';

/**
 * Exclusive JSON records (resource locks, round controllers) that several processes
 * may race to replace or remove.
 *
 * A record file is created exclusively when its path is absent. An existing record is
 * replaced or removed only through `swapObservedRecord`: the writer first claims the
 * exact record it observed by creating that record's claim file exclusively, then
 * re-reads the path under the claim and acts only if it still holds that record.
 * Every writer of an existing record needs the same claim, so the record cannot change
 * between the check and the swap. Nothing is ever moved aside and restored: a record
 * that is not provably the observed one is left exactly where it is.
 */

export type RecordObservation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'record';
      readonly value: Readonly<Record<string, unknown>>;
      readonly identity: string;
    };

/** Identity of one record's exact content: any change to any field is another record. */
export function recordIdentity(value: unknown): string {
  return canonicalSha256(value);
}

/** Read one record; a partial, corrupt, or non-object file is `unreadable`, never absent. */
export function observeRecord(path: string): RecordObservation {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable' };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'unreadable' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unreadable' };
  }
  return {
    kind: 'record',
    value: value as Readonly<Record<string, unknown>>,
    identity: recordIdentity(value),
  };
}

/**
 * True when an exclusive create lost to another writer. The authority broker refuses
 * an effect whose target changed between its prepare and apply steps; for an exclusive
 * create that means another writer created the path first, and nothing was written.
 */
function lostExclusiveCreate(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException).code === 'EEXIST' ||
    (error instanceof Error && error.message === 'AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE')
  );
}

/** Create a new file holding `body`, fsynced; any failure, EEXIST included, throws. */
function writeNewFile(path: string, body: string): void {
  const descriptor = openSync(path, 'wx');
  let written = false;
  try {
    writeSync(descriptor, body);
    fsyncSync(descriptor);
    written = true;
  } finally {
    closeSync(descriptor);
    // Only its creator can touch a record nobody else can read; withdraw a failed one.
    if (!written) {
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Create `path` with `body` only if it is absent (POSIX O_CREAT|O_EXCL), fsynced before
 * returning. Until the write completes, readers see an unreadable file and treat the
 * path as held; nobody can claim it, because a claim names a complete observed record.
 */
export function createRecordExclusive(path: string, body: string): boolean {
  try {
    writeNewFile(path, body);
    return true;
  } catch (error) {
    if (lostExclusiveCreate(error)) return false;
    throw error;
  }
}

/** Write the complete next record privately, then rename it over `path` in one step. */
function installStaged(path: string, body: string): void {
  const staged = `${path}.${String(process.pid)}-${randomUUID()}.staged`;
  writeNewFile(staged, body);
  try {
    renameSync(staged, path);
  } catch (error) {
    try {
      unlinkSync(staged);
    } catch {
      // best-effort
    }
    throw error;
  }
}

function claimFile(claimsDir: string, path: string, identity: string): string {
  return join(claimsDir, `${basename(path)}.${identity}.claim`);
}

/**
 * A claim is held for a few filesystem calls. One older than this that nothing proves
 * abandoned -- a live pid on this host (the claimant, or a pid reused after a crash),
 * another host, or an unreadable claim -- refuses for repair instead of standing down
 * as busy. Age alone never breaks a claim.
 */
export const CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;
/** Boot times computed from uptime agree to well within this on one boot. */
const BOOT_TOLERANCE_MS = 2 * 60 * 1000;

/** True when the pid names a live process; EPERM means alive but not ours. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface ClaimantIdentity {
  readonly token: string;
  readonly hostname: string;
  readonly pid: number;
  /** When this host booted, from its uptime; a different boot means another process. */
  readonly boot_at: number;
  /** Kernel boot identifier, where the platform publishes one. */
  readonly boot_id?: string;
  readonly claimed_at: string;
}

function bootId(): string | undefined {
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function currentBoot(): Pick<ClaimantIdentity, 'boot_at' | 'boot_id'> {
  const id = bootId();
  return { boot_at: Date.now() - uptime() * 1000, ...(id !== undefined && { boot_id: id }) };
}

function claimant(): ClaimantIdentity {
  return {
    token: randomUUID(),
    hostname: hostname(),
    pid: process.pid,
    ...currentBoot(),
    claimed_at: new Date().toISOString(),
  };
}

function parseClaimant(raw: string): ClaimantIdentity | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const claim = value as Partial<Record<keyof ClaimantIdentity, unknown>>;
  if (
    typeof claim.token !== 'string' ||
    typeof claim.hostname !== 'string' ||
    !Number.isSafeInteger(claim.pid) ||
    (claim.pid as number) <= 0 ||
    typeof claim.boot_at !== 'number' ||
    !Number.isFinite(claim.boot_at) ||
    (claim.boot_id !== undefined && typeof claim.boot_id !== 'string') ||
    typeof claim.claimed_at !== 'string' ||
    !Number.isFinite(Date.parse(claim.claimed_at))
  ) {
    return undefined;
  }
  return claim as ClaimantIdentity;
}

type ClaimState =
  | { readonly kind: 'absent' }
  /** Held by a claimant that may still be acting: stand down. */
  | { readonly kind: 'live' }
  /** Provably abandoned: it may be broken, exclusively. */
  | { readonly kind: 'abandoned'; readonly raw: string }
  /** Too old to be live, but nothing proves its claimant gone: refuse for repair. */
  | { readonly kind: 'stuck'; readonly holder: string };

function rebooted(
  claim: ClaimantIdentity,
  current: Pick<ClaimantIdentity, 'boot_at' | 'boot_id'>,
): boolean {
  if (claim.boot_id !== undefined && current.boot_id !== undefined) {
    return claim.boot_id !== current.boot_id;
  }
  return Math.abs(claim.boot_at - current.boot_at) > BOOT_TOLERANCE_MS;
}

/**
 * Judge a claim found in place. It is abandoned only with proof that its claimant is
 * gone: on this host, a dead pid or a boot since the claim. A live pid on this boot is
 * never displaced -- it may be the claimant, still between its check and its swap --
 * so it stands down as busy, and past the age bound refuses for repair. A claim from
 * another host, or one nobody can read, is never broken either.
 */
function claimState(path: string): ClaimState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'stuck', holder: 'a claim that cannot be read' };
  }
  const now = Date.now();
  const claim = parseClaimant(raw);
  if (claim === undefined) {
    // Its claimant may still be writing it; past the bound nobody can tell who made it.
    let age: number;
    try {
      age = now - statSync(path).mtimeMs;
    } catch {
      return { kind: 'absent' };
    }
    return age < CLAIM_STALE_AFTER_MS
      ? { kind: 'live' }
      : { kind: 'stuck', holder: 'an unreadable claim' };
  }
  const age = now - Date.parse(claim.claimed_at);
  const holder = `a claim by pid ${String(claim.pid)} on ${claim.hostname} since ${claim.claimed_at}`;
  if (
    claim.hostname === hostname() &&
    (!processAlive(claim.pid) || rebooted(claim, currentBoot()))
  ) {
    return { kind: 'abandoned', raw };
  }
  return age < CLAIM_STALE_AFTER_MS ? { kind: 'live' } : { kind: 'stuck', holder };
}

function staleClaim(path: string, holder: string): TaskServiceError {
  const error = new TaskServiceError('TASK_RECORD_CLAIM_STALE');
  error.message =
    `TASK_RECORD_CLAIM_STALE: ${path} holds ${holder} that cannot be proven abandoned; ` +
    'remove the file once no process on that host is still changing the record it names';
  return error;
}

interface HeldClaim {
  readonly path: string;
  readonly token: string;
}

/** Create a claim file exclusively; false when it already exists. */
function writeClaimExclusive(claimsDir: string, path: string, body: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, body, { flag: 'wx' });
      return true;
    } catch (error) {
      if (lostExclusiveCreate(error)) return false;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt > 0) throw error;
      mkdirSync(claimsDir, { recursive: true });
    }
  }
  return false;
}

/**
 * Break an abandoned claim, and take it, as at most one writer: the breaker first
 * creates the claim's `.break` marker exclusively, then replaces the claim only if it
 * still is exactly the abandoned one it judged. A marker in place means another breaker
 * is at work; a marker its breaker left by dying mid-break is not broken in turn (that
 * would need a claim on the claim on the claim) and refuses for repair instead.
 */
function breakClaim(claim: string, abandoned: string, mine: string): boolean {
  const marker = `${claim}.break`;
  if (!createRecordExclusive(marker, mine)) {
    const breaker = claimState(marker);
    if (breaker.kind === 'live' || breaker.kind === 'absent') return false;
    throw staleClaim(marker, breaker.kind === 'stuck' ? breaker.holder : 'a breaker that stopped');
  }
  try {
    let current: string | undefined;
    try {
      current = readFileSync(claim, 'utf8');
    } catch {
      current = undefined;
    }
    if (current !== abandoned) return false;
    installStaged(claim, mine);
    return true;
  } finally {
    try {
      unlinkSync(marker);
    } catch {
      // best-effort
    }
  }
}

/** Claim one observed record, breaking an abandoned claim on it; undefined to stand down. */
function acquireClaim(claimsDir: string, claim: string): HeldClaim | undefined {
  const identity = claimant();
  const body = `${JSON.stringify(identity)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (writeClaimExclusive(claimsDir, claim, body)) return { path: claim, token: identity.token };
    const state = claimState(claim);
    if (state.kind === 'absent') continue;
    if (state.kind === 'live') return undefined;
    if (state.kind === 'stuck') throw staleClaim(claim, state.holder);
    return breakClaim(claim, state.raw, body) ? { path: claim, token: identity.token } : undefined;
  }
  return undefined;
}

/** True while the claim file still carries this writer's token (it was not broken). */
function stillClaimed(held: HeldClaim): boolean {
  try {
    return parseClaimant(readFileSync(held.path, 'utf8'))?.token === held.token;
  } catch {
    return false;
  }
}

function releaseClaim(held: HeldClaim): void {
  // A claim broken while its writer stalled now belongs to its breaker; leave it.
  if (!stillClaimed(held)) return;
  try {
    unlinkSync(held.path);
  } catch {
    // A leftover claim names a record that is no longer current, or is judged by
    // `claimState` like any other the next time a writer needs it.
  }
}

export type SwapOutcome =
  /** The observed record was replaced (or removed). */
  | 'swapped'
  /** Another writer holds the claim on the observed record; nothing was touched. */
  | 'claimed'
  /** The path no longer holds the observed record; nothing was touched. */
  | 'changed';

/** True for the refusal raised by a claim that cannot be proven abandoned. */
export function isStaleClaim(error: unknown): boolean {
  return error instanceof TaskServiceError && error.code === 'TASK_RECORD_CLAIM_STALE';
}

/**
 * Replace the record at `path` with `next`, or remove it when `next` is omitted, only
 * if the path still holds exactly the record whose identity was observed. The claim is
 * released only after the swap, so a writer that observed the same record and claims
 * it later re-reads the new state and stands down. A claim left by a claimant that is
 * provably gone is broken first; one that cannot be judged throws
 * `TASK_RECORD_CLAIM_STALE` naming the file to repair. `onVerified` runs under the
 * claim once the record is verified current, before it changes: what it writes is
 * true of exactly the observed record.
 */
export function swapObservedRecord(options: {
  readonly path: string;
  readonly claimsDir: string;
  readonly identity: string;
  readonly next?: string;
  readonly onVerified?: () => void;
}): SwapOutcome {
  const held = acquireClaim(
    options.claimsDir,
    claimFile(options.claimsDir, options.path, options.identity),
  );
  if (held === undefined) return 'claimed';
  try {
    const current = observeRecord(options.path);
    if (current.kind !== 'record' || current.identity !== options.identity) return 'changed';
    // Live claimants are never displaced; a claim removed by hand is still never acted on.
    if (!stillClaimed(held)) return 'claimed';
    options.onVerified?.();
    if (options.next === undefined) unlinkSync(options.path);
    else installStaged(options.path, options.next);
    return 'swapped';
  } finally {
    releaseClaim(held);
  }
}

/**
 * Make a rename in `dir` durable: fsync the directory itself, so the new name survives
 * a power loss before anything that depends on it is written. Platforms that cannot
 * open or fsync a directory (Windows) skip it.
 */
export function fsyncDirectory(dir: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(dir, 'r');
  } catch (error) {
    if (['EISDIR', 'EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) {
      return;
    }
    throw error;
  }
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(String((error as NodeJS.ErrnoException).code))) {
      throw error;
    }
  } finally {
    closeSync(descriptor);
  }
}
