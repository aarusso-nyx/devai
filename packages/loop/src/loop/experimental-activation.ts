import { existsSync, readFileSync, statSync, unlinkSync } from '@devai-nyx/authority';
import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PublicationIndeterminate,
  fsyncDirectorySync,
  mkdirDurableSync,
  publishCreateOnlyDurableSync,
  replaceDurableSync,
  writeCreateOnlyDurableSync,
} from './durable-files.js';
import { TaskServiceError, fail } from './task-queue-services.js';

/*
 * Mirrors of law/policy/experimental-execution.json (ADR-MDL-0005, ADR-MDL-0006);
 * a contract test pins them to the policy.
 */
export const EXPERIMENTAL_ACTIVATION_RECORD = '.devai/state/experimental/activation.json';
/** Owner withdrawals of the activation (`round dispatch deactivate`, ADR-MDL-0007). */
export const EXPERIMENTAL_WITHDRAWALS_DIR = '.devai/state/experimental/withdrawals';
export const EXPERIMENTAL_MAX_VALIDITY_DAYS = 30;
export const EXPERIMENTAL_DISCIPLINES = ['engineer', 'inspector'] as const;
export const EXPERIMENTAL_RUNTIMES = ['claude-cli', 'codex-cli'] as const;
export const EXPERIMENTAL_CEILINGS = {
  attempts_per_task: 4,
  attempts_per_invocation: 32,
  attempt_wall_clock_minutes: 60,
} as const;
/**
 * The efforts each experimental runtime accepts, mirroring `efforts` in
 * law/policy/model-runtime-registry.json; a contract test pins this mirror. An
 * activation or task naming any other effort refuses before a provider starts.
 */
export const EXPERIMENTAL_RUNTIME_EFFORTS: Readonly<
  Record<(typeof EXPERIMENTAL_RUNTIMES)[number], readonly string[]>
> = {
  'claude-cli': ['default', 'low', 'medium', 'high'],
  'codex-cli': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};

/** The Owner activation (law/schemas/experimental-activation.schema.json). */
export interface ExperimentalActivation {
  readonly schemaVersion: '1.0.0';
  readonly id: 'experimental-activation';
  readonly authority: 'Owner';
  readonly issued_at: string;
  readonly expires_at: string;
  readonly runtimes: readonly {
    readonly runtime: (typeof EXPERIMENTAL_RUNTIMES)[number];
    readonly models: readonly string[];
    readonly efforts: readonly string[];
  }[];
  readonly disciplines: readonly (typeof EXPERIMENTAL_DISCIPLINES)[number][];
  readonly budgets: {
    readonly attempts_per_task: number;
    readonly attempts_per_invocation: number;
    readonly attempt_wall_clock_minutes: number;
    readonly tokens_per_invocation: number;
  };
  readonly note?: string;
}

export type ExperimentalActivationCheck =
  | { readonly ok: true; readonly activation: ExperimentalActivation }
  | { readonly ok: false; readonly code: string };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Clock skew tolerated for an activation issued "now" on another machine. */
const ISSUE_SKEW_MS = 5 * 60 * 1000;

/**
 * Validate an activation against its schema and the policy: it must be in force at
 * `now`, valid for at most the policy's maximum days, and within every ceiling.
 * The schema already confines runtimes and disciplines to the policy's sets.
 */
export function checkExperimentalActivation(
  value: unknown,
  now: Date,
): ExperimentalActivationCheck {
  const parsed = parsers.experimentalActivation.safeParse<ExperimentalActivation>(value);
  if (!parsed.ok) return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_INVALID' };
  const activation = parsed.value;
  const issued = Date.parse(activation.issued_at);
  const expires = Date.parse(activation.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_INVALID' };
  }
  if (issued > now.getTime() + ISSUE_SKEW_MS) {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_NOT_YET_VALID' };
  }
  if (expires <= now.getTime()) return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_EXPIRED' };
  if (expires - issued > EXPERIMENTAL_MAX_VALIDITY_DAYS * DAY_MS) {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_WINDOW_EXCEEDED' };
  }
  const budgets = activation.budgets;
  if (
    budgets.attempts_per_task > EXPERIMENTAL_CEILINGS.attempts_per_task ||
    budgets.attempts_per_invocation > EXPERIMENTAL_CEILINGS.attempts_per_invocation ||
    budgets.attempt_wall_clock_minutes > EXPERIMENTAL_CEILINGS.attempt_wall_clock_minutes
  ) {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_BUDGET_EXCEEDS_CEILING' };
  }
  const runtimes = activation.runtimes.map((entry) => entry.runtime);
  if (new Set(runtimes).size !== runtimes.length) {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_INVALID' };
  }
  if (
    activation.runtimes.some((entry) =>
      entry.efforts.some((effort) => !EXPERIMENTAL_RUNTIME_EFFORTS[entry.runtime].includes(effort)),
    )
  ) {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_EFFORT_UNSUPPORTED' };
  }
  return { ok: true, activation };
}

export function experimentalActivationPath(repoRoot: string): string {
  return join(repoRoot, EXPERIMENTAL_ACTIVATION_RECORD);
}

/**
 * Read the activation `round dispatch` relies on. Only the runtime-state record is
 * ever read (ADR-MDL-0006); a file anywhere else, including .devai/config, has no
 * effect. Absent, unreadable, invalid, or expired records refuse with their code.
 */
export function readExperimentalActivation(
  repoRoot: string,
  now: Date,
): ExperimentalActivationCheck {
  const path = experimentalActivationPath(repoRoot);
  if (!existsSync(path)) return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_MISSING' };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_INVALID' };
  }
  return checkExperimentalActivation(value, now);
}

/**
 * Replace the activation atomically with an already-checked record. A failed check
 * never reaches this point, so an earlier record is left untouched; every byte is
 * written and fsynced before the rename, so a short write can never replace a valid
 * activation with a partial one.
 */
export function writeExperimentalActivation(
  repoRoot: string,
  activation: ExperimentalActivation,
): string {
  const path = experimentalActivationPath(repoRoot);
  withActivationLock(repoRoot, () => {
    replaceDurableSync(path, `${JSON.stringify(activation, null, 2)}\n`);
  });
  return path;
}

/** Serializes every writer of the activation record: activation and withdrawal. */
export const EXPERIMENTAL_ACTIVATION_LOCK = '.devai/state/experimental/activation.lock';
/** An unreadable lock older than this was left by a writer that died mid-create. */
const UNREADABLE_LOCK_STALE_MS = 60_000;

interface ActivationLockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly token: string;
  readonly acquired_at: string;
}

/**
 * The lock appears only with its complete owner record (ADR-AUT-0005), never empty. An
 * indeterminate publication left this owner's lock in place, so it is removed before the
 * refusal propagates.
 */
function createLock(path: string, owner: ActivationLockOwner): boolean {
  try {
    return publishCreateOnlyDurableSync(path, `${JSON.stringify(owner)}\n`);
  } catch (error) {
    if (error instanceof PublicationIndeterminate) {
      const held = readLock(path);
      if (held !== undefined && held !== 'unreadable' && held.token === owner.token) {
        unlinkSync(path);
        fsyncDirectorySync(dirname(path));
      }
    }
    throw error;
  }
}

function readLock(path: string): ActivationLockOwner | 'unreadable' | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ActivationLockOwner>;
    return typeof value.pid === 'number' &&
      typeof value.hostname === 'string' &&
      typeof value.token === 'string'
      ? (value as ActivationLockOwner)
      : 'unreadable';
  } catch {
    return existsSync(path) ? 'unreadable' : undefined;
  }
}

/** True when the pid names a live process; EPERM means alive but not ours. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether a held lock was left behind: its owner ran on this host and is gone, or it is
 * unreadable and old enough that its writer must have died mid-create. A live owner, or
 * one on another host, is never judged stale.
 */
function staleLock(path: string, held: ActivationLockOwner | 'unreadable'): boolean {
  if (held === 'unreadable') {
    return Date.now() - statSync(path).mtimeMs > UNREADABLE_LOCK_STALE_MS;
  }
  return held.hostname === hostname() && !processAlive(held.pid);
}

/**
 * `EXPERIMENTAL_ACTIVATION_LOCK_STALE`: the activation lock was left by a writer that is
 * gone. It is never taken over automatically, because two contenders could both judge it
 * stale and remove each other's lock; removing it is a human step, named here.
 */
export class ExperimentalActivationLockStale extends TaskServiceError {
  readonly detail: string;
  readonly removal: string;

  constructor(path: string) {
    super('EXPERIMENTAL_ACTIVATION_LOCK_STALE');
    this.removal = `rm "${path}"`;
    this.detail = `${EXPERIMENTAL_ACTIVATION_LOCK} was left by an activation or withdrawal that is no longer running; once none is running, remove it with: ${this.removal}`;
  }
}

/**
 * Run `run` holding the activation lock, refusing with `EXPERIMENTAL_ACTIVATION_BUSY`
 * while another activation or withdrawal holds it, and with
 * `EXPERIMENTAL_ACTIVATION_LOCK_STALE` when the holder is gone. Nothing takes a lock over:
 * only the owner whose token it records removes it.
 */
function withActivationLock<T>(repoRoot: string, run: () => T): T {
  const path = join(repoRoot, EXPERIMENTAL_ACTIVATION_LOCK);
  mkdirDurableSync(dirname(path));
  const owner: ActivationLockOwner = {
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    acquired_at: new Date().toISOString(),
  };
  if (!createLock(path, owner)) {
    const held = readLock(path);
    if (held !== undefined && staleLock(path, held))
      throw new ExperimentalActivationLockStale(path);
    fail('EXPERIMENTAL_ACTIVATION_BUSY');
  }
  try {
    return run();
  } finally {
    const current = readLock(path);
    if (current !== undefined && current !== 'unreadable' && current.token === owner.token) {
      unlinkSync(path);
    }
  }
}

/** The Owner's audit record of one withdrawn activation (ADR-MDL-0007). */
export interface ExperimentalActivationWithdrawal {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly withdrawn_at: string;
  readonly role: 'owner';
  /** SHA-256 of the withdrawn record's exact bytes. */
  readonly record_sha256: string;
  /** Canonical digest of the withdrawn activation, as `round dispatch activate` reported it; null when it no longer parses. */
  readonly activation_digest_sha256: string | null;
  readonly issued_at: string | null;
  readonly expires_at: string | null;
  /** Whether the withdrawn activation was still in force when it was withdrawn. */
  readonly was_in_force: boolean;
  readonly note: string | null;
}

/**
 * Withdraw the activation: write a create-only withdrawal record naming the Owner, the
 * time and the prior activation's digests, then remove the record that `round
 * dispatch` reads, durably. An expired or invalid record is withdrawn just the same; a
 * missing one refuses with `EXPERIMENTAL_ACTIVATION_MISSING`.
 */
export function withdrawExperimentalActivation(options: {
  readonly repoRoot: string;
  readonly now?: Date;
  readonly note?: string;
}): Readonly<{ path: string; withdrawal: ExperimentalActivationWithdrawal }> {
  // Under the activation lock no activation can replace the record between the read
  // that names it in the withdrawal and the removal.
  return withActivationLock(options.repoRoot, () => withdrawLocked(options));
}

function withdrawLocked(options: {
  readonly repoRoot: string;
  readonly now?: Date;
  readonly note?: string;
}): Readonly<{ path: string; withdrawal: ExperimentalActivationWithdrawal }> {
  const now = options.now ?? new Date();
  const path = experimentalActivationPath(options.repoRoot);
  if (!existsSync(path)) fail('EXPERIMENTAL_ACTIVATION_MISSING');
  const bytes = readFileSync(path);
  let parsed: ExperimentalActivation | undefined;
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    const checked = parsers.experimentalActivation.safeParse<ExperimentalActivation>(value);
    parsed = checked.ok ? checked.value : undefined;
  } catch {
    parsed = undefined;
  }
  const recordSha256 = createHash('sha256').update(bytes).digest('hex');
  const withdrawnAt = now.toISOString();
  const id = `EXW-${canonicalSha256({ record: recordSha256, at: withdrawnAt }).slice(0, 16)}`;
  const withdrawal: ExperimentalActivationWithdrawal = {
    schemaVersion: '1.0.0',
    id,
    withdrawn_at: withdrawnAt,
    role: 'owner',
    record_sha256: recordSha256,
    activation_digest_sha256: parsed === undefined ? null : canonicalSha256(parsed),
    issued_at: parsed?.issued_at ?? null,
    expires_at: parsed?.expires_at ?? null,
    was_in_force: checkExperimentalActivation(parsed, now).ok,
    note: options.note ?? null,
  };
  const recordPath = join(options.repoRoot, EXPERIMENTAL_WITHDRAWALS_DIR, `${id}.json`);
  writeCreateOnlyDurableSync(recordPath, `${JSON.stringify(withdrawal, null, 2)}\n`);
  // Remove only the exact record the withdrawal names.
  if (
    !existsSync(path) ||
    createHash('sha256').update(readFileSync(path)).digest('hex') !== recordSha256
  ) {
    fail('EXPERIMENTAL_ACTIVATION_CHANGED');
  }
  unlinkSync(path);
  fsyncDirectorySync(dirname(path));
  return { path: recordPath, withdrawal };
}
