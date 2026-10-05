import { mkdirSync, readFileSync, renameSync } from '@devai-nyx/authority';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  createRecordExclusive,
  observeRecord,
  processAlive,
  swapObservedRecord,
} from './record-claims.js';
import type { TaskStatus } from './task-contract.js';
import { fail, TaskServiceError } from './task-queue-services.js';

/** The process that owns one round's controller. */
export interface RoundControllerRecord {
  readonly round_id: string;
  readonly pid: number;
  readonly hostname: string;
  readonly started_at: string;
  readonly token: string;
}

/*
 * Mirrors of `law/policy/round-execution.json`; a contract test pins them.
 */
/** Workers when a run does not opt in: serial (capacity.default_workers). */
export const ROUND_DEFAULT_WORKERS = 1;
/** The opt-in ceiling for concurrent workers in one round (capacity.max_workers). */
export const ROUND_MAX_WORKERS = 4;
/**
 * Consecutive lock denials after which a task is escalated for human review
 * instead of re-queued (Constitution Article 25, "after repeated denials";
 * capacity.lock_denial_escalation_threshold).
 */
export const LOCK_DENIAL_ESCALATION_THRESHOLD = 3;
/** Transitions that release a task's locks (resources.release_on). */
export const LOCK_RELEASE_STATUSES: readonly TaskStatus[] = [
  'completed',
  'escalated',
  'rgr_pending',
  'cancelled',
];

function roundRunDir(repoRoot: string, roundId: string): string {
  return join(repoRoot, '.devai/state/round-runs', roundId);
}

function controllerPath(repoRoot: string, roundId: string): string {
  return join(roundRunDir(repoRoot, roundId), 'controller.json');
}

function controllerClaimsDir(repoRoot: string, roundId: string): string {
  return join(roundRunDir(repoRoot, roundId), 'controller-claims');
}

type ControllerObservation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'record'; readonly record: RoundControllerRecord; readonly identity: string };

function isControllerRecord(value: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof value.round_id === 'string' &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.hostname === 'string' &&
    typeof value.started_at === 'string' &&
    typeof value.token === 'string'
  );
}

function readController(path: string): ControllerObservation {
  const observed = observeRecord(path);
  if (observed.kind !== 'record') return observed;
  if (!isControllerRecord(observed.value)) return { kind: 'unreadable' };
  return {
    kind: 'record',
    record: observed.value as unknown as RoundControllerRecord,
    identity: observed.identity,
  };
}

/**
 * A controller is provably gone only when it ran on this host and its pid is dead.
 * A controller on another host, or one whose record is unreadable, is never reclaimed.
 */
function provablyDead(record: RoundControllerRecord): boolean {
  return record.hostname === hostname() && !processAlive(record.pid);
}

/**
 * Claim exclusive control of one round, so two `round run` processes never advance
 * the same task population. A controller left by a dead process on this host is
 * replaced in one step, and only while the path still holds exactly that dead record:
 * a controller another process has just claimed is never removed. Its in-progress
 * tasks stay in progress for explicit human disposition, because admission dispatches
 * only `ready` tasks. A live controller, one on another host, an unreadable record,
 * or a reclamation another process is already making refuses with
 * `TASK_ROUND_CONTROLLER_BUSY`. A claim a dead reclaimer left on the dead record is
 * broken when its claimant is provably gone; otherwise the reclamation refuses with
 * `TASK_RECORD_CLAIM_STALE`, naming the claim to repair.
 */
export function acquireRoundController(repoRoot: string, roundId: string): RoundControllerRecord {
  mkdirSync(roundRunDir(repoRoot, roundId), { recursive: true });
  const path = controllerPath(repoRoot, roundId);
  const record: RoundControllerRecord = {
    round_id: roundId,
    pid: process.pid,
    hostname: hostname(),
    started_at: new Date().toISOString(),
    token: randomUUID(),
  };
  const body = JSON.stringify(record, null, 2) + '\n';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createRecordExclusive(path, body)) return record;
    const existing = readController(path);
    if (existing.kind === 'absent') continue;
    if (existing.kind === 'unreadable' || !provablyDead(existing.record)) {
      fail('TASK_ROUND_CONTROLLER_BUSY');
    }
    const replaced = swapObservedRecord({
      path,
      claimsDir: controllerClaimsDir(repoRoot, roundId),
      identity: existing.identity,
      next: body,
    });
    if (replaced === 'swapped') return record;
    fail('TASK_ROUND_CONTROLLER_BUSY');
  }
  fail('TASK_ROUND_CONTROLLER_BUSY');
}

/** Release the round only if this exact controller still owns it. */
export function releaseRoundController(repoRoot: string, record: RoundControllerRecord): void {
  const path = controllerPath(repoRoot, record.round_id);
  const current = readController(path);
  if (current.kind !== 'record' || current.record.token !== record.token) return;
  try {
    swapObservedRecord({
      path,
      claimsDir: controllerClaimsDir(repoRoot, record.round_id),
      identity: current.identity,
    });
  } catch {
    // best-effort
  }
}

function denialsPath(repoRoot: string, roundId: string): string {
  return join(roundRunDir(repoRoot, roundId), 'lock-denials.json');
}

/**
 * Corrupt denial counts refuse the run instead of silently resetting: a count that
 * never reaches the threshold would re-queue a conflicting task forever.
 */
function invalidDenialState(roundId: string): TaskServiceError {
  const error = new TaskServiceError('TASK_LOCK_DENIAL_STATE_INVALID');
  error.message =
    `TASK_LOCK_DENIAL_STATE_INVALID: .devai/state/round-runs/${roundId}/lock-denials.json ` +
    'must be a JSON object of non-negative integer counts; repair the entry, or remove the ' +
    "file to reset every task's lock-denial count";
  return error;
}

function readDenials(repoRoot: string, roundId: string): Record<string, number> {
  let raw: string;
  try {
    raw = readFileSync(denialsPath(repoRoot, roundId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw invalidDenialState(roundId);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw invalidDenialState(roundId);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidDenialState(roundId);
  }
  for (const count of Object.values(parsed)) {
    if (!Number.isSafeInteger(count) || (count as number) < 0) throw invalidDenialState(roundId);
  }
  return parsed as Record<string, number>;
}

function writeDenials(repoRoot: string, roundId: string, denials: Record<string, number>): void {
  const path = denialsPath(repoRoot, roundId);
  const staged = `${path}.${String(process.pid)}-${randomUUID()}`;
  if (!createRecordExclusive(staged, JSON.stringify(denials, null, 2) + '\n')) {
    fail('TASK_ROUND_CONTROLLER_BUSY');
  }
  renameSync(staged, path);
}

/** Refuse to run a round whose recorded lock-denial counts are corrupt. */
export function assertLockDenialsValid(repoRoot: string, roundId: string): void {
  readDenials(repoRoot, roundId);
}

/** The consecutive lock denials recorded for a task; 0 when none are recorded. */
export function lockDenialCount(repoRoot: string, roundId: string, taskId: string): number {
  const denials = readDenials(repoRoot, roundId);
  return Object.hasOwn(denials, taskId) ? (denials[taskId] ?? 0) : 0;
}

/** Count one more consecutive lock denial for a task and return the new count. */
export function recordLockDenial(repoRoot: string, roundId: string, taskId: string): number {
  const denials = readDenials(repoRoot, roundId);
  const count = (Object.hasOwn(denials, taskId) ? (denials[taskId] ?? 0) : 0) + 1;
  writeDenials(repoRoot, roundId, { ...denials, [taskId]: count });
  return count;
}

/** A task that acquired its locks starts its denial count afresh. */
export function clearLockDenials(repoRoot: string, roundId: string, taskId: string): void {
  const denials = readDenials(repoRoot, roundId);
  if (!Object.hasOwn(denials, taskId)) return;
  const { [taskId]: _cleared, ...rest } = denials;
  void _cleared;
  writeDenials(repoRoot, roundId, rest);
}
