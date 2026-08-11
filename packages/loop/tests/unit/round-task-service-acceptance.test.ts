// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: tasks are round-subordinate, dependency ordered,
// resource-contained, and fail closed before or during bounded dispatch.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import {
  addRoundQueueEntry,
  completeRoundQueueEntry,
  escalateRoundTask,
  finishRoundTask,
  listRoundQueue,
  nextRoundQueueEntry,
  pauseRoundTask,
  requireActiveTaskRound,
  resumeRoundTask,
  roundTaskResourceStatus,
  roundTaskStatus,
  startRoundTask,
  TaskServiceError,
} from '../../src/loop/task-services.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true });
});

function repository(round = 'R-0007'): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-r0007-task-acceptance-'));
  roots.push(root);
  const directory = join(root, 'work/rounds', round);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'AUTHORIZATION.md'),
    '# Authorization\n\nstatus: active\n\nGRANTED\n',
    'utf8',
  );
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
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : undefined;
  }
}

describe('round task service acceptance', () => {
  it('enforces active round ownership across queue, task, and resource projections', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      expect(requireActiveTaskRound({ repoRoot: root, round: 'R-0007' })).toBe('R-0007');
      expect(errorCode(() => requireActiveTaskRound({ repoRoot: root }))).toBe(
        'TASK_ROUND_REQUIRED',
      );
      try {
        requireActiveTaskRound({ repoRoot: root });
      } catch (error) {
        expect(error).toBeInstanceOf(TaskServiceError);
        expect(error).toMatchObject({ code: 'TASK_ROUND_REQUIRED', exitCode: 2 });
      }
      expect(errorCode(() => requireActiveTaskRound({ repoRoot: root, round: 'R-9999' }))).toBe(
        'TASK_ROUND_INACTIVE',
      );

      const low = addRoundQueueEntry({
        repoRoot: root,
        round: 'R-0007',
        title: 'low',
        priority: 1,
      });
      const high = addRoundQueueEntry({
        repoRoot: root,
        round: 'R-0007',
        title: 'high',
        priority: 99,
        description: 'bounded acceptance',
        discipline: 'engineer',
        targetModules: ['cli'],
        targetSubstrates: ['F2'],
      });
      expect(listRoundQueue({ repoRoot: root, round: 'R-0007' }).map((entry) => entry.id)).toEqual([
        high.id,
        low.id,
      ]);
      expect(nextRoundQueueEntry({ repoRoot: root, round: 'R-0007' })?.id).toBe(high.id);
      expect(
        completeRoundQueueEntry({ repoRoot: root, round: 'R-0007', taskId: high.id }).status,
      ).toBe('completed');
      expect(
        errorCode(() =>
          completeRoundQueueEntry({ repoRoot: root, round: 'R-0007', taskId: 'TASK-X' }),
        ),
      ).toBe('TASK_QUEUE_ENTRY_NOT_FOUND');
      expect(
        errorCode(() => addRoundQueueEntry({ repoRoot: root, round: 'R-0007', title: ' ' })),
      ).toBe('TASK_QUEUE_TITLE_REQUIRED');

      saveTask(root, routineTask('TASK-7501'));
      expect(roundTaskStatus({ repoRoot: root, round: 'R-0007' }).count).toBe(1);
      expect(roundTaskStatus({ repoRoot: root, round: 'R-0007', taskId: 'TASK-7501' }).count).toBe(
        1,
      );
      expect(
        errorCode(() => roundTaskStatus({ repoRoot: root, round: 'R-0007', taskId: 'TASK-X' })),
      ).toBe('TASK_NOT_FOUND');
      expect(
        roundTaskResourceStatus({ repoRoot: root, round: 'R-0007', resource: 'locks' }),
      ).toMatchObject({ resource: 'locks', count: 0 });
      expect(
        roundTaskResourceStatus({ repoRoot: root, round: 'R-0007', resource: 'worktrees' }),
      ).toMatchObject({ resource: 'worktrees', count: 0 });
    });
  });

  it('executes start, pause, resume, escalate, and finish transitions without external resources', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      saveTask(root, routineTask('TASK-7601', { status: 'queued' }));
      expect(
        startRoundTask({ repoRoot: root, round: 'R-0007', taskId: 'TASK-7601' }).task.status,
      ).toBe('ready');
      saveTask(root, { ...loadTask(root, 'TASK-7601'), status: 'in_progress' });
      expect(
        pauseRoundTask({ repoRoot: root, round: 'R-0007', taskId: 'TASK-7601', gapId: 'RGR-7601' })
          .status,
      ).toBe('rgr_pending');
      expect(
        resumeRoundTask({ repoRoot: root, round: 'R-0007', taskId: 'TASK-7601', gapId: 'RGR-7601' })
          .status,
      ).toBe('queued');
      expect(
        errorCode(() =>
          resumeRoundTask({ repoRoot: root, round: 'R-0007', taskId: 'TASK-7601', gapId: 'RGR-X' }),
        ),
      ).toBe('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');

      saveTask(root, {
        ...loadTask(root, 'TASK-7601'),
        status: 'in_progress',
        branch: 'task-7601',
      });
      expect(
        escalateRoundTask({ repoRoot: root, round: 'R-0007', taskId: 'TASK-7601' }),
      ).toMatchObject({
        status: 'escalated',
        branch: 'escalated/task-7601',
      });
      expect(
        errorCode(() => startRoundTask({ repoRoot: root, round: 'R-0007', taskId: 'TASK-7601' })),
      ).toBe('TASK_START_STATUS_INVALID');

      saveTask(root, routineTask('TASK-7602', { status: 'merging' }));
      expect(finishRoundTask({ repoRoot: root, round: 'R-0007', taskId: 'TASK-7602' }).status).toBe(
        'completed',
      );
      saveTask(root, routineTask('TASK-7603', { status: 'ready' }));
      expect(
        errorCode(() => finishRoundTask({ repoRoot: root, round: 'R-0007', taskId: 'TASK-7603' })),
      ).toBe('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');
    });
  });
});

describe('round runner acceptance', () => {
  it('orders coupled and upstream dependencies before dispatch', async () => {
    const root = repository();
    const dispatched: string[] = [];
    await withAuthorityHostTestScope(async () => {
      saveTask(
        root,
        routineTask('TASK-7701', {
          coupled_task_group: 'CTG-0001',
          coupled_pipeline_position: 'inspector',
        }),
      );
      saveTask(
        root,
        routineTask('TASK-7702', {
          coupled_task_group: 'CTG-0001',
          coupled_pipeline_position: 'architect',
        }),
      );
      saveTask(
        root,
        routineTask('TASK-7703', {
          coupled_task_group: 'CTG-0001',
          coupled_pipeline_position: 'engineer',
        }),
      );
      saveTask(root, routineTask('TASK-7704', { upstream_task_id: 'TASK-7703', priority: 100 }));
      const result = await runRoundTasks({
        repoRoot: root,
        round: 'R-0007',
        taskIds: ['TASK-7704'],
        dispatch: (task) => {
          dispatched.push(task.id);
          return { ok: true, evidence_id: `TEE-${task.id}` };
        },
      });
      expect(result.ok).toBe(true);
      expect(result.ordered_task_ids).toEqual(['TASK-7701', 'TASK-7702', 'TASK-7703', 'TASK-7704']);
      expect(dispatched).toEqual(result.ordered_task_ids);
      expect(result.results.every((entry) => entry.evidence_id !== undefined)).toBe(true);
    });
  });

  it('blocks dependents, escalates failed or over-iterated work, and contains dispatch exceptions', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, routineTask('TASK-7801'));
      saveTask(root, routineTask('TASK-7802', { upstream_task_id: 'TASK-7801' }));
      saveTask(root, routineTask('TASK-7803', { iteration_count: 1, max_iterations: 1 }));
      saveTask(root, routineTask('TASK-7804'));
      const dispatch = vi.fn((task: TaskRecord) => {
        if (task.id === 'TASK-7801') return { ok: false, code: 'FIXTURE_FAIL' };
        if (task.id === 'TASK-7804') throw new Error('fixture crash');
        return { ok: true };
      });
      const result = await runRoundTasks({ repoRoot: root, round: 'R-0007', dispatch });
      expect(result.ok).toBe(false);
      expect(result.results).toEqual(
        expect.arrayContaining([
          { task_id: 'TASK-7801', ok: false, code: 'FIXTURE_FAIL' },
          { task_id: 'TASK-7802', ok: false, code: 'TASK_DEPENDENCY_FAILED' },
          { task_id: 'TASK-7803', ok: false, code: 'TASK_MAX_ITERATIONS_EXCEEDED' },
          { task_id: 'TASK-7804', ok: false, code: 'TASK_EXECUTOR_DISPATCH_FAILED' },
        ]),
      );
      expect(loadTask(root, 'TASK-7801').status).toBe('escalated');
      expect(loadTask(root, 'TASK-7803').status).toBe('escalated');
      expect(loadTask(root, 'TASK-7804').status).toBe('escalated');
    });
  });

  it('refuses not-ready, missing, cross-round, and cyclic populations before dispatch', async () => {
    const notReady = repository();
    const missing = repository();
    const cross = repository();
    const cyclic = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(notReady, routineTask('TASK-7901', { status: 'in_progress' }));
      await expect(
        runRoundTasks({
          repoRoot: notReady,
          round: 'R-0007',
          taskIds: ['TASK-7901'],
          dispatch: () => ({ ok: true }),
        }),
      ).rejects.toThrow('TASK_NOT_READY');

      saveTask(missing, routineTask('TASK-7902', { upstream_task_id: 'TASK-7999' }));
      await expect(
        runRoundTasks({ repoRoot: missing, round: 'R-0007', dispatch: () => ({ ok: true }) }),
      ).rejects.toThrow('TASK_DEPENDENCY_MISSING');

      mkdirSync(join(cross, 'work/rounds/R-0008'), { recursive: true });
      writeFileSync(
        join(cross, 'work/rounds/R-0008/AUTHORIZATION.md'),
        'status: active\nGRANTED\n',
      );
      saveTask(cross, routineTask('TASK-7903', { round_id: 'R-0008' }));
      await expect(
        runRoundTasks({
          repoRoot: cross,
          round: 'R-0007',
          taskIds: ['TASK-7903'],
          dispatch: () => ({ ok: true }),
        }),
      ).rejects.toThrow('TASK_ROUND_MISMATCH');

      saveTask(cyclic, routineTask('TASK-7904', { upstream_task_id: 'TASK-7905' }));
      saveTask(cyclic, routineTask('TASK-7905', { upstream_task_id: 'TASK-7904' }));
      await expect(
        runRoundTasks({ repoRoot: cyclic, round: 'R-0007', dispatch: () => ({ ok: true }) }),
      ).rejects.toThrow('TASK_COMPOSITE_CYCLE');
    });
  });
});
