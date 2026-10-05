import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from '@devai-nyx/authority';
import { canonicalSha256 } from '@devai-nyx/utils';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';

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

function tryClaim(claimsDir: string, claim: string): boolean {
  const body = `${JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    claimed_at: new Date().toISOString(),
  })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(claim, body, { flag: 'wx' });
      return true;
    } catch (error) {
      if (lostExclusiveCreate(error)) return false;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt > 0) throw error;
      mkdirSync(claimsDir, { recursive: true });
    }
  }
  return false;
}

export type SwapOutcome =
  /** The observed record was replaced (or removed). */
  | 'swapped'
  /** Another writer holds the claim on the observed record; nothing was touched. */
  | 'claimed'
  /** The path no longer holds the observed record; nothing was touched. */
  | 'changed';

/**
 * Replace the record at `path` with `next`, or remove it when `next` is omitted, only
 * if the path still holds exactly the record whose identity was observed. The claim is
 * released only after the swap, so a writer that observed the same record and claims
 * it later re-reads the new state and stands down.
 */
export function swapObservedRecord(options: {
  readonly path: string;
  readonly claimsDir: string;
  readonly identity: string;
  readonly next?: string;
}): SwapOutcome {
  const claim = claimFile(options.claimsDir, options.path, options.identity);
  if (!tryClaim(options.claimsDir, claim)) return 'claimed';
  try {
    const current = observeRecord(options.path);
    if (current.kind !== 'record' || current.identity !== options.identity) return 'changed';
    if (options.next === undefined) unlinkSync(options.path);
    else installStaged(options.path, options.next);
    return 'swapped';
  } finally {
    try {
      unlinkSync(claim);
    } catch {
      // A leftover claim names a record that is no longer current, or blocks the
      // current one fail-closed until it is removed.
    }
  }
}
