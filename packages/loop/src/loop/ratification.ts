/**
 * Human ratification of reviewed work (ADR-GOV-0025, S4c). A task awaiting human review
 * is accepted into pre_merge or rejected into escalation by a declared human role. The
 * decision is recorded once, create-only, beside the round's execution evidence. Nothing
 * here merges, pushes, closes a round, or accepts a model verdict as ratification
 * (Constitution Article 28; campaign-execution.json gates.review).
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from '@devai-nyx/authority';
import { join } from 'node:path';
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

/**
 * Record one human decision on a task awaiting review: accept moves it to pre_merge,
 * reject escalates it. A second ratification of the same task, any other task state, or
 * a role other than the Owner or Architect is refused before anything is written.
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
  const task = loadTask(options.repoRoot, options.taskId);
  if (task.round_id !== roundId) fail('TASK_ROUND_MISMATCH');
  if (task.status !== 'awaiting_human_review') fail('RATIFICATION_TASK_NOT_AWAITING_REVIEW');
  const path = ratificationPath(options.repoRoot, roundId, task.id);
  if (existsSync(path)) fail('RATIFICATION_EXISTS');

  const resulting: TaskRecord['status'] = options.decision === 'accept' ? 'pre_merge' : 'escalated';
  const record: RatificationRecord = {
    schemaVersion: '1.0.0',
    round_id: roundId,
    task_id: task.id,
    decision: options.decision,
    role: options.role,
    ratified_at: (options.now ?? new Date()).toISOString(),
    reviewed_evidence_ids: reviewedEvidence(options.repoRoot, roundId, task.id),
    branch: task.branch ?? null,
    worktree_id: task.worktree_id ?? null,
    note: options.note ?? null,
    resulting_status: resulting,
  };
  mkdirSync(join(options.repoRoot, '.devai/state/round-runs', roundId, 'ratifications'), {
    recursive: true,
  });
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (options.decision === 'accept') saveTask(options.repoRoot, { ...task, status: 'pre_merge' });
  else escalateTask({ repoRoot: options.repoRoot, taskId: task.id });
  return record;
}
