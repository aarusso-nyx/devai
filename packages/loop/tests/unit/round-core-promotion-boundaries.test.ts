// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020.
// Inspector acceptance: whole-round planning and live prerequisites fail closed before dispatch.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const ROUND = 'R-0007';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-core-promotion-'));
  roots.push(root);
  const authorization = join(root, 'work/rounds', ROUND);
  mkdirSync(authorization, { recursive: true });
  writeFileSync(join(authorization, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status: 'ready',
    discipline: 'engineer',
    title: id,
    target_modules: [],
    target_substrates: ['F2'],
    created_at: '2026-09-08T12:00:00.000Z',
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
    ...overrides,
  };
}

function taskBytes(root: string, id: string): string {
  return readFileSync(join(root, '.devai/state/tasks', `${id}.json`), 'utf8');
}

describe('core promotion round admission boundaries', () => {
  it('does not mistake callback success for durable prerequisite completion', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const upstream = task('TASK-8201');
      const dependent = task('TASK-8202', { upstream_task_id: upstream.id });
      saveTask(root, upstream);
      saveTask(root, dependent);
      const original = taskBytes(root, dependent.id);
      const dispatched: string[] = [];
      const dispatch = (value: TaskRecord) => {
        dispatched.push(value.id);
        return { ok: true, evidence_id: 'EV-advisory-only' };
      };
      const result = await runRoundTasks({ repoRoot: root, round: ROUND, dispatch });

      expect(dispatched).toEqual([upstream.id]);
      expect(result.results).toEqual([
        { task_id: upstream.id, ok: true, evidence_id: 'EV-advisory-only' },
        { task_id: dependent.id, ok: false, code: 'TASK_DEPENDENCY_NOT_COMPLETED' },
      ]);
      expect(result.ok).toBe(false);
      expect(loadTask(root, upstream.id).status).toBe('in_progress');
      expect(taskBytes(root, dependent.id)).toBe(original);
    });
  });

  it('permits the dependent only after the callback persists completed status', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const upstream = task('TASK-8201');
      const dependent = task('TASK-8202', { upstream_task_id: upstream.id });
      saveTask(root, upstream);
      saveTask(root, dependent);
      const ids: string[] = [];
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        taskIds: [dependent.id],
        dispatch: (value) => {
          ids.push(value.id);
          saveTask(root, { ...value, status: 'completed' });
          return { ok: true };
        },
      });
      expect(ids).toEqual([upstream.id, dependent.id]);
      expect(result.ok).toBe(true);
    });
  });

  it('keeps an entire generation ahead of a newly unlocked high-priority descendant', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const upstream = task('TASK-8201', { priority: 90 });
      const dependent = task('TASK-8202', { priority: 100, upstream_task_id: upstream.id });
      const independent = task('TASK-8203', { priority: 0 });
      for (const value of [dependent, independent, upstream]) saveTask(root, value);
      const ids: string[] = [];
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: (value) => {
          ids.push(value.id);
          saveTask(root, { ...value, status: 'completed' });
          return { ok: true };
        },
      });
      expect(result.ordered_task_ids).toEqual([upstream.id, independent.id, dependent.id]);
      expect(ids).toEqual(result.ordered_task_ids);
    });
  });

  it('uses the canonical Architect then Inspector coupled prerequisite order', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const architect = task('TASK-8203', {
        discipline: 'architect',
        target_substrates: ['F1'],
        coupled_task_group: 'CTG-8201',
        coupled_pipeline_position: 'architect',
      });
      const inspector = task('TASK-8202', {
        discipline: 'inspector',
        target_substrates: ['F3'],
        coupled_task_group: 'CTG-8201',
        coupled_pipeline_position: 'inspector',
      });
      const engineer = task('TASK-8201', {
        coupled_task_group: 'CTG-8201',
        coupled_pipeline_position: 'engineer',
        priority: 100,
      });
      for (const value of [engineer, inspector, architect]) saveTask(root, value);
      const ids: string[] = [];
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        taskIds: [engineer.id],
        dispatch: (value) => {
          ids.push(value.id);
          saveTask(root, { ...value, status: 'completed' });
          return { ok: true };
        },
      });
      expect(result.ordered_task_ids).toEqual([architect.id, inspector.id, engineer.id]);
      expect(ids).toEqual(result.ordered_task_ids);
    });
  });

  it.each([
    ['missing dependency', 'TASK_DEPENDENCY_MISSING'],
    ['cycle', 'TASK_COMPOSITE_CYCLE'],
  ] as const)(
    'rejects a %s in unselected same-round queued tasks before mutation',
    async (kind, code) => {
      const root = repository();
      await withAuthorityHostTestScope(async () => {
        const selected = task('TASK-8201');
        saveTask(root, selected);
        saveTask(root, task('TASK-8202', { status: 'queued', upstream_task_id: 'TASK-8203' }));
        if (kind === 'cycle') {
          saveTask(root, task('TASK-8203', { status: 'queued', upstream_task_id: 'TASK-8202' }));
        }
        const original = taskBytes(root, selected.id);
        const dispatch = vi.fn(() => ({ ok: true }));
        await expect(
          runRoundTasks({ repoRoot: root, round: ROUND, taskIds: [selected.id], dispatch }),
        ).rejects.toThrow(code);
        expect(dispatch).not.toHaveBeenCalled();
        expect(taskBytes(root, selected.id)).toBe(original);
      });
    },
  );

  it('rejects duplicate canonical IDs stored under different filenames before mutation', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const selected = task('TASK-8201');
      saveTask(root, selected);
      const original = taskBytes(root, selected.id);
      writeFileSync(join(root, '.devai/state/tasks/TASK-8299.json'), original);
      const dispatch = vi.fn(() => ({ ok: true }));
      await expect(runRoundTasks({ repoRoot: root, round: ROUND, dispatch })).rejects.toThrow(
        'TASK_ID_DUPLICATE',
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(taskBytes(root, selected.id)).toBe(original);
    });
  });

  it.each([
    'queued',
    'lock_denied',
    'in_progress',
    'checkpoint',
    'pre_merge',
    'merging',
    'awaiting_human_review',
    'experimental_blocked',
    'rgr_pending',
  ] as const)(
    'rejects an explicitly selected %s task before dispatching any selected ready task',
    async (status) => {
      const root = repository();
      await withAuthorityHostTestScope(async () => {
        const ready = task('TASK-8201');
        const blocked = task('TASK-8202', { status });
        saveTask(root, ready);
        saveTask(root, blocked);
        const original = taskBytes(root, ready.id);
        const dispatch = vi.fn(() => ({ ok: true }));
        await expect(
          runRoundTasks({
            repoRoot: root,
            round: ROUND,
            taskIds: [ready.id, blocked.id],
            dispatch,
          }),
        ).rejects.toThrow('TASK_NOT_READY');
        expect(dispatch).not.toHaveBeenCalled();
        expect(taskBytes(root, ready.id)).toBe(original);
      });
    },
  );

  it('rechecks the immutable request before dispatching a later planned task', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const first = task('TASK-8201');
      const second = task('TASK-8202');
      saveTask(root, first);
      saveTask(root, second);
      const dispatched: string[] = [];
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: (value) => {
          dispatched.push(value.id);
          saveTask(root, { ...second, title: 'request changed after planning' });
          return { ok: true };
        },
      });
      expect(dispatched).toEqual([first.id]);
      expect(result.results).toEqual([
        { task_id: first.id, ok: true },
        { task_id: second.id, ok: false, code: 'TASK_RECORD_CHANGED' },
      ]);
      expect(loadTask(root, second.id)).toEqual({
        ...second,
        title: 'request changed after planning',
      });
    });
  });

  it('preserves a human-review wait recorded before a later planned task dispatch', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const first = task('TASK-8201');
      const second = task('TASK-8202');
      saveTask(root, first);
      saveTask(root, second);
      const dispatched: string[] = [];
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: (value) => {
          dispatched.push(value.id);
          saveTask(root, { ...second, status: 'awaiting_human_review' });
          return { ok: true };
        },
      });
      expect(dispatched).toEqual([first.id]);
      expect(result.results).toEqual([
        { task_id: first.id, ok: true },
        { task_id: second.id, ok: false, code: 'TASK_NOT_READY' },
      ]);
      expect(loadTask(root, second.id).status).toBe('awaiting_human_review');
    });
  });

  it('refuses a malformed unselected stored record before selecting or mutating ready work', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const ready = task('TASK-8201');
      saveTask(root, ready);
      const original = taskBytes(root, ready.id);
      const malformedPath = join(root, '.devai/state/tasks/TASK-8299.json');
      const malformedBytes = '{"status":';
      writeFileSync(malformedPath, malformedBytes);
      const dispatch = vi.fn(() => ({ ok: true }));
      await expect(
        runRoundTasks({ repoRoot: root, round: ROUND, taskIds: [ready.id], dispatch }),
      ).rejects.toThrow('TASK_RECORD_INVALID');
      expect(dispatch).not.toHaveBeenCalled();
      expect(taskBytes(root, ready.id)).toBe(original);
      expect(readFileSync(malformedPath, 'utf8')).toBe(malformedBytes);
    });
  });

  it('refuses a malformed record inserted after a callback before dispatching any later planned work', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const first = task('TASK-8201');
      const second = task('TASK-8202');
      saveTask(root, first);
      saveTask(root, second);
      const originalSecond = taskBytes(root, second.id);
      const malformedPath = join(root, '.devai/state/tasks/TASK-8299.json');
      const malformedBytes = '{"schemaVersion":';
      const dispatched: string[] = [];
      await expect(
        runRoundTasks({
          repoRoot: root,
          round: ROUND,
          dispatch: (value) => {
            dispatched.push(value.id);
            writeFileSync(malformedPath, malformedBytes);
            return { ok: true };
          },
        }),
      ).rejects.toThrow('TASK_RECORD_INVALID');
      expect(dispatched).toEqual([first.id]);
      expect(taskBytes(root, second.id)).toBe(originalSecond);
      expect(readFileSync(malformedPath, 'utf8')).toBe(malformedBytes);
    });
  });

  it('refuses an unsupported unselected task version without rewriting its diagnostic bytes', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const ready = task('TASK-8201');
      saveTask(root, ready);
      const original = taskBytes(root, ready.id);
      const unsupportedPath = join(root, '.devai/state/tasks/TASK-8299.json');
      const unsupportedBytes = JSON.stringify({ ...task('TASK-8299'), schemaVersion: '99.0.0' });
      writeFileSync(unsupportedPath, unsupportedBytes);
      const dispatch = vi.fn(() => ({ ok: true }));
      await expect(
        runRoundTasks({ repoRoot: root, round: ROUND, taskIds: [ready.id], dispatch }),
      ).rejects.toThrow('TASK_SCHEMA_VERSION_UNSUPPORTED');
      expect(dispatch).not.toHaveBeenCalled();
      expect(taskBytes(root, ready.id)).toBe(original);
      expect(readFileSync(unsupportedPath, 'utf8')).toBe(unsupportedBytes);
    });
  });

  it('blocks a later ready task whose execution worktree is redirected after planning', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const first = task('TASK-8201');
      const second = task('TASK-8202');
      saveTask(root, first);
      saveTask(root, second);
      const dispatched: string[] = [];
      const redirected = { ...second, worktree_id: 'WT-TASK-redirected' };
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: (value) => {
          dispatched.push(value.id);
          saveTask(root, redirected);
          return { ok: true };
        },
      });
      expect(dispatched).toEqual([first.id]);
      expect(result.results).toEqual([
        { task_id: first.id, ok: true },
        { task_id: second.id, ok: false, code: 'TASK_RECORD_CHANGED' },
      ]);
      expect(loadTask(root, second.id)).toEqual(redirected);
    });
  });
});
