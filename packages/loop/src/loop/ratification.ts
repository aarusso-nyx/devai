/**
 * Human ratification of reviewed agent work (ADR-GOV-0025, S4c; ADR-MDL-0007). An agent
 * task awaiting human review is accepted into pre_merge or rejected into escalation by a
 * declared human role. The decision is recorded once, beside the round's execution
 * evidence, and the decision and its transition form one recoverable operation: a retry
 * after an interrupted ratification completes the identical decision and refuses a
 * different one. Nothing here merges, pushes, closes a round, or accepts a model verdict as
 * ratification (Constitution Article 28; campaign-execution.json gates.review).
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from '@devai-nyx/authority';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { recordAgentEscalation } from './dispatch-disposition.js';
import { dispatchJournalPath, openDispatchAttempts } from './dispatch-journal.js';
import { fsyncDirectorySync, mkdirDurableSync, writeAllSync } from './durable-files.js';
import { acquireRoundController, releaseRoundController } from './round-controller.js';
import { escalateTask, loadTask, saveTask, type TaskRecord } from './tasks.js';
import { fail, requireActiveTaskRound } from './task-queue-services.js';

export type RatificationDecision = 'accept' | 'reject';

export interface RatificationRecord {
  readonly schemaVersion: '1.0.0';
  readonly round_id: string;
  readonly task_id: string;
  readonly decision: RatificationDecision;
  readonly role: 'owner' | 'architect';
  readonly ratified_at: string;
  readonly reviewed_evidence_ids: readonly string[];
  readonly branch: string | null;
  readonly worktree_id: string | null;
  readonly note: string | null;
  readonly resulting_status: TaskRecord['status'];
}

export function ratificationPath(repoRoot: string, roundId: string, taskId: string): string {
  return join(repoRoot, '.devai/state/round-runs', roundId, 'ratifications', `${taskId}.json`);
}

/** Evidence identities recorded for the task in this round, in name order. */
function reviewedEvidence(repoRoot: string, roundId: string, taskId: string): string[] {
  const dir = join(repoRoot, '.devai/state/round-runs', roundId, 'task-executions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      try {
        const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
          readonly id?: unknown;
          readonly task_id?: unknown;
        };
        return record.task_id === taskId && typeof record.id === 'string' ? [record.id] : [];
      } catch {
        return [];
      }
    });
}

function isRecord(value: unknown, roundId: string, taskId: string): value is RatificationRecord {
  const record = value as Partial<RatificationRecord> | null;
  return (
    record !== null &&
    typeof record === 'object' &&
    record.schemaVersion === '1.0.0' &&
    record.round_id === roundId &&
    record.task_id === taskId &&
    (record.decision === 'accept' || record.decision === 'reject') &&
    (record.role === 'owner' || record.role === 'architect') &&
    record.resulting_status === (record.decision === 'accept' ? 'pre_merge' : 'escalated')
  );
}

/**
 * The decision already recorded for the task, if any. A file that is not a complete
 * decision for this task (a torn write) is moved aside under its SHA-256 and treated as
 * absent, so it can never wedge the task; the bytes are kept for inspection.
 */
function priorDecision(
  path: string,
  roundId: string,
  taskId: string,
): RatificationRecord | undefined {
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (isRecord(value, roundId, taskId)) return value;
  } catch {
    // Fall through to quarantine.
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  renameSync(path, `${path}.torn-${digest}`);
  fsyncDirectorySync(dirname(path));
  return undefined;
}

/** Write the decision atomically: a staged, fsynced file renamed into an absent path. */
function writeDecision(path: string, record: RatificationRecord): void {
  mkdirDurableSync(dirname(path));
  const staged = `${path}.${String(process.pid)}-${randomUUID()}`;
  const fd = openSync(staged, 'wx');
  try {
    writeAllSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (existsSync(path)) {
    unlinkSync(staged);
    fail('RATIFICATION_EXISTS');
  }
  renameSync(staged, path);
  fsyncDirectorySync(dirname(path));
}

/**
 * Apply a recorded decision as a compare-and-swap on the task: it re-reads the record and
 * transitions it only while it is still awaiting review, so a concurrent escalation is
 * never overwritten back into pre_merge.
 */
function applyDecision(repoRoot: string, roundId: string, record: RatificationRecord): void {
  const current = loadTask(repoRoot, record.task_id);
  if (current.status !== 'awaiting_human_review') fail('RATIFICATION_TASK_CHANGED');
  if (record.decision === 'accept') {
    saveTask(repoRoot, { ...current, status: 'pre_merge' });
    return;
  }
  // A rejected agent attempt releases its worktree (ADR-MDL-0007); the branch is kept.
  recordAgentEscalation({ repoRoot, roundId, task: current });
  escalateTask({ repoRoot, taskId: current.id });
}

/**
 * Record one human decision on an agent task awaiting review: accept moves it to
 * pre_merge, reject escalates it. It holds the round controller throughout. Human
 * executors are refused: they complete through their own evidence contract with `task
 * finish`. A different decision for the same task, any other task state, uncertain
 * journal work, or a role other than the Owner or Architect is refused before anything is
 * written; a retry of an interrupted ratification completes the identical decision.
 */
export function ratifyRoundTask(options: {
  readonly repoRoot: string;
  readonly round?: string;
  readonly taskId: string;
  readonly decision: RatificationDecision;
  readonly role: string;
  readonly note?: string;
  readonly now?: Date;
}): RatificationRecord {
  const roundId = requireActiveTaskRound(options);
  if (options.decision !== 'accept' && options.decision !== 'reject') {
    fail('RATIFICATION_DECISION_INVALID');
  }
  if (options.role !== 'owner' && options.role !== 'architect') fail('RATIFICATION_ROLE_DENIED');
  const role = options.role;
  const controller = acquireRoundController(options.repoRoot, roundId);
  try {
    const task = loadTask(options.repoRoot, options.taskId);
    if (task.round_id !== roundId) fail('TASK_ROUND_MISMATCH');
    if (task.executor.kind !== 'agent') fail('RATIFICATION_EXECUTOR_INELIGIBLE');
    const path = ratificationPath(options.repoRoot, roundId, task.id);
    const prior = priorDecision(path, roundId, task.id);
    if (prior !== undefined) {
      if (prior.decision !== options.decision || prior.role !== role) {
        fail('RATIFICATION_EXISTS');
      }
      if (task.status === prior.resulting_status) return prior;
      if (task.status !== 'awaiting_human_review') fail('RATIFICATION_EXISTS');
      // The decision was recorded but its transition was interrupted: complete it.
      applyDecision(options.repoRoot, roundId, prior);
      return prior;
    }
    if (task.status !== 'awaiting_human_review') fail('RATIFICATION_TASK_NOT_AWAITING_REVIEW');
    if (
      existsSync(dispatchJournalPath(options.repoRoot, roundId)) &&
      openDispatchAttempts(options.repoRoot, roundId, task.id).length > 0
    ) {
      // Reviewed evidence must come from a settled attempt; uncertain work needs a disposition.
      fail('TASK_DISPATCH_UNCERTAIN');
    }
    const record: RatificationRecord = {
      schemaVersion: '1.0.0',
      round_id: roundId,
      task_id: task.id,
      decision: options.decision,
      role,
      ratified_at: (options.now ?? new Date()).toISOString(),
      reviewed_evidence_ids: reviewedEvidence(options.repoRoot, roundId, task.id),
      branch: task.branch ?? null,
      worktree_id: task.worktree_id ?? null,
      note: options.note ?? null,
      resulting_status: options.decision === 'accept' ? 'pre_merge' : 'escalated',
    };
    writeDecision(path, record);
    applyDecision(options.repoRoot, roundId, record);
    return record;
  } finally {
    releaseRoundController(options.repoRoot, controller);
  }
}
