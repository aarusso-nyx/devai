import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';
let root: string;
const now = '2026-09-08T12:00:00.000Z';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-round-dispatch-'));
  const dir = join(root, 'work/rounds/R-0007');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
function task(id: string, change: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id,
    round_id: 'R-0007',
    status: 'ready',
    discipline: 'engineer',
    title: id,
    target_modules: [],
    target_substrates: ['F2'],
    created_at: now,
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

describe('round dispatch boundaries', () => {
  it('returns an exact empty result without invoking a dispatcher', async () => {
    const dispatch = vi.fn(() => ({ ok: true }));
    await withAuthorityHostTestScope(async () => {
      expect(await runRoundTasks({ repoRoot: root, round: 'R-0007', dispatch })).toEqual({
        ok: true,
        round_id: 'R-0007',
        ordered_task_ids: [],
        results: [],
      });
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('honors explicit empty selection without changing stored ready tasks', async () => {
    await withAuthorityHostTestScope(async () => {
      const value = task('TASK-9701');
      saveTask(root, value);
      const dispatch = vi.fn(() => ({ ok: true }));
      expect(
        await runRoundTasks({ repoRoot: root, round: 'R-0007', taskIds: [], dispatch }),
      ).toEqual({ ok: true, round_id: 'R-0007', ordered_task_ids: [], results: [] });
      expect(loadTask(root, value.id)).toEqual(value);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
  it('orders ready tasks by descending priority and exact ID for ties, and retains immutable dispatch fields', async () => {
    await withAuthorityHostTestScope(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
      const values = [
        task('TASK-9703', { priority: 5 }),
        task('TASK-9701', { priority: 5 }),
        task('TASK-9702', { priority: 10 }),
        task('TASK-9704'),
      ];
      for (const value of values) saveTask(root, value);
      const seen: TaskRecord[] = [];
      const result = await runRoundTasks({
        repoRoot: root,
        round: 'R-0007',
        dispatch: (value) => {
          seen.push(value);
          return { ok: true, evidence_id: 'EV-' + value.id };
        },
      });
      expect(result).toEqual({
        ok: true,
        round_id: 'R-0007',
        ordered_task_ids: ['TASK-9702', 'TASK-9701', 'TASK-9703', 'TASK-9704'],
        results: ['TASK-9702', 'TASK-9701', 'TASK-9703', 'TASK-9704'].map((task_id) => ({
          task_id,
          ok: true,
          evidence_id: 'EV-' + task_id,
        })),
      });
      for (const value of seen) {
        const original = values.find((v) => v.id === value.id);
        expect(value).toEqual({
          ...original,
          status: 'in_progress',
          iteration_count: 1,
          spawned_at: now,
        });
        expect(loadTask(root, value.id)).toEqual(value);
      }
    });
  });
  it.each(['cancelled', 'escalated'] as const)(
    'blocks dependents of a terminal %s task but still dispatches independent work',
    async (status) => {
      await withAuthorityHostTestScope(async () => {
        saveTask(root, task('TASK-9701', { status }));
        saveTask(root, task('TASK-9702', { upstream_task_id: 'TASK-9701' }));
        saveTask(root, task('TASK-9703', { upstream_task_id: 'TASK-9702' }));
        saveTask(root, task('TASK-9704'));
        const dispatched: string[] = [];
        const result = await runRoundTasks({
          repoRoot: root,
          round: 'R-0007',
          dispatch: (t) => {
            dispatched.push(t.id);
            return { ok: true };
          },
        });
        expect(dispatched).toEqual(['TASK-9704']);
        expect(result).toEqual({
          ok: false,
          round_id: 'R-0007',
          ordered_task_ids: ['TASK-9702', 'TASK-9703', 'TASK-9704'],
          results: [
            { task_id: 'TASK-9702', ok: false, code: 'TASK_DEPENDENCY_FAILED' },
            { task_id: 'TASK-9703', ok: false, code: 'TASK_DEPENDENCY_FAILED' },
            { task_id: 'TASK-9704', ok: true },
          ],
        });
        expect(loadTask(root, 'TASK-9702').status).toBe('ready');
        expect(loadTask(root, 'TASK-9703').status).toBe('ready');
      });
    },
  );
  it('accepts completed dependencies without dispatching them again', async () => {
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-9701', { status: 'completed' }));
      saveTask(root, task('TASK-9702', { upstream_task_id: 'TASK-9701' }));
      const dispatch = vi.fn(() => ({ ok: true }));
      const result = await runRoundTasks({
        repoRoot: root,
        round: 'R-0007',
        taskIds: ['TASK-9702'],
        dispatch,
      });
      expect(result.ordered_task_ids).toEqual(['TASK-9702']);
      expect(result.ok).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(loadTask(root, 'TASK-9701').status).toBe('completed');
    });
  });
  it('dispatches the last permitted iteration, and escalates the next without invoking its dispatcher', async () => {
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-9701', { iteration_count: 0, max_iterations: 1 }));
      saveTask(root, task('TASK-9702', { iteration_count: 1, max_iterations: 1 }));
      const ids: string[] = [];
      const result = await runRoundTasks({
        repoRoot: root,
        round: 'R-0007',
        dispatch: (t) => {
          ids.push(t.id);
          return { ok: true };
        },
      });
      expect(ids).toEqual(['TASK-9701']);
      expect(result.results).toEqual([
        { task_id: 'TASK-9701', ok: true },
        { task_id: 'TASK-9702', ok: false, code: 'TASK_MAX_ITERATIONS_EXCEEDED' },
      ]);
      expect(loadTask(root, 'TASK-9701').iteration_count).toBe(1);
      expect(loadTask(root, 'TASK-9702')).toMatchObject({
        iteration_count: 2,
        status: 'escalated',
      });
    });
  });
  it.each([
    { label: 'declared code', error: new Error('TASK_CONTROL_123'), code: 'TASK_CONTROL_123' },
    {
      label: 'ordinary message',
      error: new Error('internal diagnostic'),
      code: 'TASK_EXECUTOR_DISPATCH_FAILED',
    },
    { label: 'non-Error value', error: 'TASK_CONTROL_123', code: 'TASK_EXECUTOR_DISPATCH_FAILED' },
    {
      label: 'lowercase suffix',
      error: new Error('TASK_Control'),
      code: 'TASK_EXECUTOR_DISPATCH_FAILED',
    },
    {
      label: 'trailing newline',
      error: new Error('TASK_CONTROL_123\n'),
      code: 'TASK_EXECUTOR_DISPATCH_FAILED',
    },
  ])('returns a closed failure code for $label and escalates the task', async ({ error, code }) => {
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-9701'));
      const result = await runRoundTasks({
        repoRoot: root,
        round: 'R-0007',
        dispatch: () => {
          throw error;
        },
      });
      expect(result).toEqual({
        ok: false,
        round_id: 'R-0007',
        ordered_task_ids: ['TASK-9701'],
        results: [{ task_id: 'TASK-9701', ok: false, code }],
      });
      expect(loadTask(root, 'TASK-9701').status).toBe('escalated');
    });
  });
  it('preserves a dispatch refusal and its evidence without overwriting a terminal status already recorded by the dispatcher', async () => {
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-9701'));
      const result = await runRoundTasks({
        repoRoot: root,
        round: 'R-0007',
        dispatch: (t) => {
          saveTask(root, { ...t, status: 'cancelled' });
          return { ok: false, code: 'TASK_CANCELLED_BY_CONTROL', evidence_id: 'EV-refusal' };
        },
      });
      expect(result.results).toEqual([
        {
          task_id: 'TASK-9701',
          ok: false,
          code: 'TASK_CANCELLED_BY_CONTROL',
          evidence_id: 'EV-refusal',
        },
      ]);
      expect(loadTask(root, 'TASK-9701').status).toBe('cancelled');
    });
  });
  it('refuses an explicitly selected invalid task before dispatching another selected valid task', async () => {
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-9701'));
      saveTask(root, task('TASK-9702'));
      const dir = join(root, '.devai/state/tasks');
      const malformed = join(dir, 'TASK-9702.json');
      const stored = JSON.parse(readFileSync(malformed, 'utf8')) as Record<string, unknown>;
      stored['status'] = 'invented';
      writeFileSync(malformed, JSON.stringify(stored));
      const dispatch = vi.fn(() => ({ ok: true }));
      await expect(
        runRoundTasks({
          repoRoot: root,
          round: 'R-0007',
          taskIds: ['TASK-9701', 'TASK-9702'],
          dispatch,
        }),
      ).rejects.toThrow('TASK_DEPENDENCY_MISSING');
      expect(dispatch).not.toHaveBeenCalled();
      expect(loadTask(root, 'TASK-9701').status).toBe('ready');
    });
  });
});
