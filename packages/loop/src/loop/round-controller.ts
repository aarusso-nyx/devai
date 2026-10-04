import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from '@devai-nyx/authority';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fail } from './task-queue-services.js';

/** The process that owns one round's controller. */
export interface RoundControllerRecord {
  readonly round_id: string;
  readonly pid: number;
  readonly hostname: string;
  readonly started_at: string;
  readonly token: string;
}

/**
 * Consecutive lock denials after which a task is escalated for human review
 * instead of re-queued (Constitution Article 25, "after repeated denials").
 */
export const LOCK_DENIAL_ESCALATION_THRESHOLD = 3;

function roundRunDir(repoRoot: string, roundId: string): string {
  return join(repoRoot, '.devai/state/round-runs', roundId);
}

function controllerPath(repoRoot: string, roundId: string): string {
  return join(roundRunDir(repoRoot, roundId), 'controller.json');
}

function writeExclusive(path: string, body: string): boolean {
  try {
    const fd = openSync(path, 'wx');
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function readController(path: string): RoundControllerRecord | undefined | 'unreadable' {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RoundControllerRecord;
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
 * A controller is provably gone only when it ran on this host and its pid is dead.
 * A controller on another host, or one whose record is unreadable, is never reclaimed.
 */
function provablyDead(record: RoundControllerRecord): boolean {
  return record.hostname === hostname() && !processAlive(record.pid);
}

/** Move the exact stale record aside; restore anything else that was moved by mistake. */
function reclaimStale(path: string, stale: RoundControllerRecord): boolean {
  const aside = `${path}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch {
    return false;
  }
  let raw = '';
  let moved: RoundControllerRecord | undefined;
  try {
    raw = readFileSync(aside, 'utf8');
    moved = JSON.parse(raw) as RoundControllerRecord;
  } catch {
    moved = undefined;
  }
  const exact = moved?.token === stale.token;
  if (!exact && raw.length > 0) writeExclusive(path, raw);
  try {
    unlinkSync(aside);
  } catch {
    // best-effort
  }
  return exact;
}

/**
 * Claim exclusive control of one round, so two `round run` processes never advance
 * the same task population. A controller left by a dead process on this host is
 * reclaimed: its in-progress tasks stay in progress for explicit human disposition,
 * because admission dispatches only `ready` tasks. A live controller, one on another
 * host, or an unreadable record refuses with `TASK_ROUND_CONTROLLER_BUSY`.
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
    if (writeExclusive(path, body)) return record;
    const existing = readController(path);
    if (existing === undefined) continue;
    if (existing === 'unreadable' || !provablyDead(existing)) fail('TASK_ROUND_CONTROLLER_BUSY');
    if (!reclaimStale(path, existing)) fail('TASK_ROUND_CONTROLLER_BUSY');
  }
  fail('TASK_ROUND_CONTROLLER_BUSY');
}

/** Release the round only if this exact controller still owns it. */
export function releaseRoundController(repoRoot: string, record: RoundControllerRecord): void {
  const path = controllerPath(repoRoot, record.round_id);
  const current = readController(path);
  if (current === undefined || current === 'unreadable' || current.token !== record.token) return;
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}

function denialsPath(repoRoot: string, roundId: string): string {
  return join(roundRunDir(repoRoot, roundId), 'lock-denials.json');
}

function readDenials(repoRoot: string, roundId: string): Record<string, number> {
  const path = denialsPath(repoRoot, roundId);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

function writeDenials(repoRoot: string, roundId: string, denials: Record<string, number>): void {
  const path = denialsPath(repoRoot, roundId);
  const staged = `${path}.${process.pid}-${randomUUID()}`;
  if (!writeExclusive(staged, JSON.stringify(denials, null, 2) + '\n')) {
    fail('TASK_ROUND_CONTROLLER_BUSY');
  }
  renameSync(staged, path);
}

/** Count one more consecutive lock denial for a task and return the new count. */
export function recordLockDenial(repoRoot: string, roundId: string, taskId: string): number {
  const denials = readDenials(repoRoot, roundId);
  const count = (denials[taskId] ?? 0) + 1;
  writeDenials(repoRoot, roundId, { ...denials, [taskId]: count });
  return count;
}

/** A task that acquired its locks starts its denial count afresh. */
export function clearLockDenials(repoRoot: string, roundId: string, taskId: string): void {
  const denials = readDenials(repoRoot, roundId);
  if (!(taskId in denials)) return;
  const { [taskId]: _cleared, ...rest } = denials;
  void _cleared;
  writeDenials(repoRoot, roundId, rest);
}
