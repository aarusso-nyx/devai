// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
// Additive mutation-wave1 coverage for task-services.ts round/queue guards.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_PRECONDITION, EXIT_USAGE } from '@devai-nyx/utils';
import { afterAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  addRoundQueueEntry,
  completeRoundQueueEntry,
  escalateRoundTask,
  finishRoundTask,
  materializeRoundQueueTask,
  nextRoundQueueEntry,
  requireActiveTaskRound,
  roundTaskStatus,
  startRoundTask,
  TaskServiceError,
} from '../../src/loop/task-services.js';
import { backlogPath } from '../../src/loop/backlog.js';
import { saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true });
});

function repository(
  round = 'R-0007',
  authorization = '# Authorization\n\nstatus: active\n\nGRANTED\n',
): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-r0007-task-services-mutation-'));
  roots.push(root);
  const directory = join(root, 'work/rounds', round);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'AUTHORIZATION.md'), authorization, 'utf8');
  return root;
}

function routineTask(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id,
    round_id: 'R-0007',
    status: 'ready',
    discipline: 'engineer',
    title: id,
    target_modules: [],
    target_substrates: ['F2'],
    created_at: '2026-08-08T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'routine',
      argv: ['node', 'fixture.mjs'],
      cwd: '.',
      inputs: [],
      outputs: [],
      effects: ['read'],
      timeout_ms: 1_000,
      authority_checks: ['discipline'],
    },
    ...overrides,
  };
}

function errorCode(callback: () => unknown): string | undefined {
  try {
    callback();
    return undefined;
  } catch (error) {
    return error instanceof Error && 'code' in error
      ? String((error as TaskServiceError).code)
      : error instanceof Error
        ? error.message
        : undefined;
  }
}

describe('task-services round and queue guard coverage', () => {
  it('rejects a whitespace-only round with the exact usage error shape', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      try {
        requireActiveTaskRound({ repoRoot: root, round: '   ' });
        throw new Error('expected requireActiveTaskRound to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(TaskServiceError);
        expect((error as TaskServiceError).name).toBe('TaskServiceError');
        expect((error as TaskServiceError).code).toBe('TASK_ROUND_REQUIRED');
        expect((error as TaskServiceError).exitCode).toBe(EXIT_USAGE);
      }
    });
  });

  it('accepts activation status with no space or extra spacing around active', async () => {
    const tight = repository('R-0007', '# Authorization\n\nstatus:active\n\nGRANTED\n');
    const loose = repository('R-0007', '# Authorization\n\nstatus:    active\n\nGRANTED\n');
    await withAuthorityHostTestScope(() => {
      expect(requireActiveTaskRound({ repoRoot: tight, round: 'R-0007' })).toBe('R-0007');
      expect(requireActiveTaskRound({ repoRoot: loose, round: 'R-0007' })).toBe('R-0007');
    });
  });

  it('rejects a closed status and a status missing the GRANTED marker', async () => {
    const closed = repository('R-0007', '# Authorization\n\nstatus: closed\n\nGRANTED\n');
    const ungranted = repository('R-0007', '# Authorization\n\nstatus: active\n');
    await withAuthorityHostTestScope(() => {
      try {
        requireActiveTaskRound({ repoRoot: closed, round: 'R-0007' });
        throw new Error('expected TASK_ROUND_INACTIVE for closed status');
      } catch (error) {
        expect((error as TaskServiceError).code).toBe('TASK_ROUND_INACTIVE');
        expect((error as TaskServiceError).exitCode).toBe(EXIT_PRECONDITION);
      }
      expect(
        errorCode(() => requireActiveTaskRound({ repoRoot: ungranted, round: 'R-0007' })),
      ).toBe('TASK_ROUND_INACTIVE');
    });
  });

  it('reports TASK_NOT_FOUND for an unknown task across start, escalate, and finish', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      expect(
        errorCode(() =>
          startRoundTask({ repoRoot: root, round: 'R-0007', taskId: 'TASK-MISSING' }),
        ),
      ).toBe('TASK_NOT_FOUND');
      expect(
        errorCode(() =>
          escalateRoundTask({ repoRoot: root, round: 'R-0007', taskId: 'TASK-MISSING' }),
        ),
      ).toBe('TASK_NOT_FOUND');
      expect(
        errorCode(() =>
          finishRoundTask({ repoRoot: root, round: 'R-0007', taskId: 'TASK-MISSING' }),
        ),
      ).toBe('TASK_NOT_FOUND');
    });
  });

  it('refuses to materialize a declared task that is not in queued status', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      const readyTask = routineTask('TASK-8001', { status: 'ready' });
      try {
        materializeRoundQueueTask({ repoRoot: root, round: 'R-0007', task: readyTask });
        throw new Error('expected TASK_QUEUE_STATUS_INVALID');
      } catch (error) {
        expect((error as TaskServiceError).code).toBe('TASK_QUEUE_STATUS_INVALID');
        expect((error as TaskServiceError).exitCode).toBe(EXIT_USAGE);
      }
    });
  });

  it('is idempotent on repeated identical materialization and rejects mutated identity fields', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      const queued = addRoundQueueEntry({
        repoRoot: root,
        round: 'R-0007',
        title: 'idempotent target',
        priority: 42,
        description: 'fixture description',
      });
      const declared = routineTask(queued.id, {
        status: 'queued',
        title: queued.title,
        priority: queued.priority,
        description: queued.description,
        created_at: queued.created_at,
      });
      const first = materializeRoundQueueTask({ repoRoot: root, round: 'R-0007', task: declared });
      const backlogBeforeRepeat = readFileSync(backlogPath(root), 'utf8');
      const second = materializeRoundQueueTask({ repoRoot: root, round: 'R-0007', task: declared });
      expect(second).toEqual(first);
      expect(readFileSync(backlogPath(root), 'utf8')).toBe(backlogBeforeRepeat);

      expect(
        errorCode(() =>
          materializeRoundQueueTask({
            repoRoot: root,
            round: 'R-0007',
            task: { ...declared, title: 'renamed target' },
          }),
        ),
      ).toBe('TASK_QUEUE_MATERIALIZATION_CONFLICT');
      expect(
        errorCode(() =>
          materializeRoundQueueTask({
            repoRoot: root,
            round: 'R-0007',
            task: { ...declared, priority: 7 },
          }),
        ),
      ).toBe('TASK_QUEUE_MATERIALIZATION_CONFLICT');
      expect(
        errorCode(() =>
          materializeRoundQueueTask({
            repoRoot: root,
            round: 'R-0007',
            task: { ...declared, created_at: '2020-01-01T00:00:00.000Z' },
          }),
        ),
      ).toBe('TASK_QUEUE_MATERIALIZATION_CONFLICT');
    });
  });

  it('reports TASK_RECORD_CONFLICT when an enriched task record disagrees with the saved task', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      const entry = addRoundQueueEntry({
        repoRoot: root,
        round: 'R-0007',
        title: 'conflict target',
        priority: 55,
        description: 'stable description',
      });
      const savedTask = routineTask(entry.id, {
        status: 'queued',
        title: entry.title,
        priority: entry.priority,
        description: entry.description,
        created_at: entry.created_at,
      });
      saveTask(root, savedTask);

      const conflictingDeclared: TaskRecord = {
        ...savedTask,
        discipline: 'architect',
      };
      expect(
        errorCode(() =>
          materializeRoundQueueTask({
            repoRoot: root,
            round: 'R-0007',
            task: conflictingDeclared,
          }),
        ),
      ).toBe('TASK_RECORD_CONFLICT');
    });
  });

  it('scopes roundTaskStatus by taskId, returning a single match or TASK_NOT_FOUND', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      saveTask(root, routineTask('TASK-8101'));
      saveTask(root, routineTask('TASK-8102'));

      const all = roundTaskStatus({ repoRoot: root, round: 'R-0007' });
      expect(all.count).toBe(2);

      const filtered = roundTaskStatus({ repoRoot: root, round: 'R-0007', taskId: 'TASK-8101' });
      expect(filtered.count).toBe(1);
      expect(filtered.tasks.map((task) => task.id)).toEqual(['TASK-8101']);

      expect(
        errorCode(() =>
          roundTaskStatus({ repoRoot: root, round: 'R-0007', taskId: 'TASK-UNKNOWN' }),
        ),
      ).toBe('TASK_NOT_FOUND');
    });
  });

  it('skips completed and cross-round entries when picking the next queued entry', async () => {
    const root = repository();
    mkdirSync(join(root, 'work/rounds/R-0008'), { recursive: true });
    writeFileSync(
      join(root, 'work/rounds/R-0008/AUTHORIZATION.md'),
      '# Authorization\n\nstatus: active\n\nGRANTED\n',
      'utf8',
    );
    await withAuthorityHostTestScope(() => {
      const other = addRoundQueueEntry({ repoRoot: root, round: 'R-0008', title: 'other round' });
      const done = addRoundQueueEntry({ repoRoot: root, round: 'R-0007', title: 'already done' });
      completeRoundQueueEntry({ repoRoot: root, round: 'R-0007', taskId: done.id });
      const pending = addRoundQueueEntry({
        repoRoot: root,
        round: 'R-0007',
        title: 'pending work',
      });

      const next = nextRoundQueueEntry({ repoRoot: root, round: 'R-0007' });
      expect(next?.id).toBe(pending.id);
      expect(next?.id).not.toBe(other.id);
      expect(next?.id).not.toBe(done.id);
    });
  });

  it('persists optional queue fields when supplied and omits their keys when absent', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      const withExtras = addRoundQueueEntry({
        repoRoot: root,
        round: 'R-0007',
        title: 'full entry',
        description: 'has extras',
        discipline: 'engineer',
        targetModules: ['loop'],
        targetSubstrates: ['F2'],
      });
      expect(withExtras.description).toBe('has extras');
      expect(withExtras.discipline).toBe('engineer');
      expect(withExtras.target_modules).toEqual(['loop']);
      expect(withExtras.target_substrates).toEqual(['F2']);

      const bare = addRoundQueueEntry({ repoRoot: root, round: 'R-0007', title: 'bare entry' });
      expect('description' in bare).toBe(false);
      expect('discipline' in bare).toBe(false);
      expect('target_modules' in bare).toBe(false);
      expect('target_substrates' in bare).toBe(false);
    });
  });
});
