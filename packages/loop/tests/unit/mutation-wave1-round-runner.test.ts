import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { acquireLocks } from '../../src/loop/locks.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const NOW = '2026-09-08T12:00:00.000Z';
const ROUND = 'R-0007';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-mutation-wave1-round-runner-'));
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function task(id: string, change: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status: 'ready',
    discipline: 'engineer',
    title: id,
    target_modules: [],
    target_substrates: ['F2'],
    created_at: NOW,
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'routine',
      argv: ['node', 'fixture.mjs'],
      cwd: '.',
      inputs: [],
      outputs: [],
      effects: ['read'],
      timeout_ms: 1000,
      authority_checks: ['discipline'],
    },
    ...change,
  };
}

function locksDir(): string {
  return join(root, '.devai/state/locks');
}

describe('round runner mutation wave 1 boundaries', () => {
  it('reports a cross-round upstream dependency distinctly from a missing dependency', async () => {
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-9101', { round_id: 'R-0008' }));
      saveTask(root, task('TASK-9102', { upstream_task_id: 'TASK-9101' }));
      const dispatch = vi.fn(() => ({ ok: true }));

      await expect(runRoundTasks({ repoRoot: root, round: ROUND, dispatch })).rejects.toThrow(
        'TASK_COMPOSITE_CROSS_ROUND',
      );
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it('reports an unknown explicit task id as a missing dependency, not a round mismatch', async () => {
    await withAuthorityHostTestScope(async () => {
      const dispatch = vi.fn(() => ({ ok: true }));

      await expect(
        runRoundTasks({ repoRoot: root, round: ROUND, taskIds: ['TASK-UNKNOWN'], dispatch }),
      ).rejects.toThrow('TASK_DEPENDENCY_MISSING');
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it('does not treat partial same-task F2 lock coverage as complete', async () => {
    await withAuthorityHostTestScope(async () => {
      const value = task('TASK-9103', {
        target_modules: ['MOD-a', 'MOD-b'],
      });
      saveTask(root, value);
      expect(
        acquireLocks({ locksDir: locksDir(), taskId: value.id, targets: ['F2:MOD-a'] }).denied,
      ).toEqual([]);
      expect(
        acquireLocks({ locksDir: locksDir(), taskId: 'TASK-9199', targets: ['F2:MOD-b'] }).denied,
      ).toEqual([]);
      const dispatch = vi.fn(() => ({ ok: true }));

      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch,
      });

      expect(result.results).toEqual([
        { task_id: value.id, ok: false, code: 'TASK_RESOURCE_LOCK_DENIED' },
      ]);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it('uses the anchored task error pattern and escalates wrapped errors', async () => {
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-9104'));

      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => {
          throw new Error('wrapper: TASK_BOOM');
        },
      });

      expect(result).toEqual({
        ok: false,
        round_id: ROUND,
        ordered_task_ids: ['TASK-9104'],
        results: [
          {
            task_id: 'TASK-9104',
            ok: false,
            code: 'TASK_EXECUTOR_DISPATCH_FAILED',
          },
        ],
      });
      expect(loadTask(root, 'TASK-9104').status).toBe('escalated');
    });
  });

  it('omits absent evidence and code keys from successful result rows', async () => {
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-9105'));

      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => ({ ok: true }),
      });

      expect(result.results).toStrictEqual([{ task_id: 'TASK-9105', ok: true }]);
    });
  });

  it('implicitly selects only ready tasks in the active round', async () => {
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-9106'));
      saveTask(root, task('TASK-9107', { status: 'queued' }));
      saveTask(root, task('TASK-9108', { round_id: 'R-0008' }));
      const dispatch = vi.fn(() => ({ ok: true }));

      const result = await runRoundTasks({ repoRoot: root, round: ROUND, dispatch });

      expect(result.ordered_task_ids).toEqual(['TASK-9106']);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'TASK-9106' }));
    });
  });
});
