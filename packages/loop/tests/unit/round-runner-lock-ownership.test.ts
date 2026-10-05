import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { acquireLocks, listLocks, releaseLocks } from '../../src/loop/locks.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const roots: string[] = [];
const ROUND = 'R-0007';
const NOW = '2026-09-08T12:00:00.000Z';

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-runner-lock-ownership-'));
  roots.push(root);
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

function task(id: string): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status: 'ready',
    discipline: 'engineer',
    title: id,
    target_modules: ['MOD-a'],
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
      timeout_ms: 1_000,
      authority_checks: ['discipline'],
    },
  };
}

function lockDir(root: string): string {
  return join(root, '.devai/state/locks');
}

function fixedDate(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
}

describe('round runner lock ownership boundaries', () => {
  it('dispatches when every required F2 lock is owned and ignores another same-task module lock', async () => {
    const root = repository();
    const value = task('TASK-9301');
    fixedDate();

    await withAuthorityHostTestScope(async () => {
      saveTask(root, value);
      expect(
        acquireLocks({
          locksDir: lockDir(root),
          taskId: value.id,
          targets: ['F2:MOD-a', 'F2:MOD-b'],
        }).denied,
      ).toEqual([]);
      const dispatch = vi.fn(() => ({ ok: true }));

      const result = await runRoundTasks({ repoRoot: root, round: ROUND, dispatch });

      expect(result).toMatchObject({
        ok: true,
        ordered_task_ids: [value.id],
        results: [{ task_id: value.id, ok: true }],
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it('dispatches when the exact required module is the only owned lock', async () => {
    const root = repository();
    const value = task('TASK-9303');
    fixedDate();

    await withAuthorityHostTestScope(async () => {
      saveTask(root, value);
      expect(
        acquireLocks({
          locksDir: lockDir(root),
          taskId: value.id,
          targets: ['F2:MOD-a'],
        }).denied,
      ).toEqual([]);
      const dispatch = vi.fn(() => ({ ok: true }));

      const result = await runRoundTasks({ repoRoot: root, round: ROUND, dispatch });

      expect(result).toMatchObject({
        ok: true,
        ordered_task_ids: [value.id],
        results: [{ task_id: value.id, ok: true }],
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it('renews held locks while an asynchronous dispatch is pending', async () => {
    const root = repository();
    const value = task('TASK-9304');
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date(NOW));

    await withAuthorityHostTestScope(async () => {
      saveTask(root, value);
      let heldDuringDispatch: string | undefined;

      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        lockRenewalIntervalMs: 10,
        dispatch: async () => {
          // The executor awaits its child process; the renewal timer runs meanwhile.
          await vi.advanceTimersByTimeAsync(25);
          heldDuringDispatch = listLocks({ locksDir: lockDir(root) })[0]?.acquired_at;
          return { ok: true };
        },
      });

      expect(result.results).toEqual([{ task_id: value.id, ok: true }]);
      expect(heldDuringDispatch).toBe(new Date(Date.parse(NOW) + 20).toISOString());
    });
  });

  it('denies dispatch when the required F2 lock belongs to another task', async () => {
    const root = repository();
    const value = task('TASK-9302');
    fixedDate();

    await withAuthorityHostTestScope(async () => {
      saveTask(root, value);
      expect(
        acquireLocks({
          locksDir: lockDir(root),
          taskId: 'TASK-9399',
          targets: ['F2:MOD-a'],
        }).denied,
      ).toEqual([]);
      const dispatch = vi.fn(() => ({ ok: true }));

      const result = await runRoundTasks({ repoRoot: root, round: ROUND, dispatch });

      expect(result).toMatchObject({
        ok: false,
        ordered_task_ids: [value.id],
        results: [{ task_id: value.id, ok: false, code: 'TASK_RESOURCE_LOCK_DENIED' }],
      });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});

describe('lost locks are reconciled whatever status the dispatch left', () => {
  function takeOver(root: string): void {
    rmSync(join(lockDir(root), 'F2~MOD-a.json'));
    expect(
      acquireLocks({ locksDir: lockDir(root), taskId: 'TASK-9399', targets: ['F2:MOD-a'] }).denied,
    ).toEqual([]);
  }

  it('fails and escalates a routine pass recorded after the lock was taken mid-dispatch', async () => {
    const root = repository();
    const value = task('TASK-9305');
    fixedDate();

    await withAuthorityHostTestScope(async () => {
      saveTask(root, value);

      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        lockRenewalIntervalMs: 60_000,
        dispatch: (running) => {
          takeOver(root);
          // The routine dispatcher records its pass by moving the task towards merge.
          saveTask(root, { ...running, status: 'pre_merge' });
          saveTask(root, { ...running, status: 'merging' });
          return { ok: true, evidence_id: 'EV-9305' };
        },
      });

      expect(result.results).toEqual([
        { task_id: value.id, ok: false, code: 'TASK_RESOURCE_LOCK_LOST' },
      ]);
      expect(loadTask(root, value.id).status).toBe('escalated');
      // Escalation releases only this task's records; the new holder keeps its lock.
      expect(listLocks({ locksDir: lockDir(root) })).toMatchObject([{ task_id: 'TASK-9399' }]);
    });
  });

  it('fails an agent pass awaiting review whose lock was lost, even when the key is free again', async () => {
    const root = repository();
    const value = task('TASK-9306');
    fixedDate();

    await withAuthorityHostTestScope(async () => {
      saveTask(root, value);

      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        lockRenewalIntervalMs: 60_000,
        dispatch: (running) => {
          takeOver(root);
          releaseLocks({ locksDir: lockDir(root), taskId: 'TASK-9399' });
          saveTask(root, { ...running, status: 'awaiting_human_review' });
          return { ok: true, evidence_id: 'EV-9306' };
        },
      });

      expect(result.results).toEqual([
        { task_id: value.id, ok: false, code: 'TASK_RESOURCE_LOCK_LOST' },
      ]);
      expect(loadTask(root, value.id).status).toBe('escalated');
    });
  });

  it('keeps a human handoff that still holds its locks', async () => {
    const root = repository();
    const value = task('TASK-9307');
    fixedDate();

    await withAuthorityHostTestScope(async () => {
      saveTask(root, value);

      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: (running) => {
          saveTask(root, { ...running, status: 'awaiting_human_review' });
          return { ok: false, code: 'TASK_HUMAN_COMPLETION_REQUIRED' };
        },
      });

      expect(result.results).toEqual([
        { task_id: value.id, ok: false, code: 'TASK_HUMAN_COMPLETION_REQUIRED' },
      ]);
      expect(loadTask(root, value.id).status).toBe('awaiting_human_review');
      expect(listLocks({ locksDir: lockDir(root) })).toMatchObject([{ task_id: value.id }]);
    });
  });

  it('keeps a pass whose lock outlived its TTL without anyone taking it', async () => {
    const root = repository();
    const value = task('TASK-9308');
    fixedDate();

    await withAuthorityHostTestScope(async () => {
      saveTask(root, value);

      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: (running) => {
          // A dispatch that outran every renewal tick: expired, but never displaced.
          vi.setSystemTime(new Date(Date.parse(NOW) + 2 * 60 * 60 * 1000));
          saveTask(root, { ...running, status: 'merging' });
          return { ok: true, evidence_id: 'EV-9308' };
        },
      });

      expect(result.results).toEqual([{ task_id: value.id, ok: true, evidence_id: 'EV-9308' }]);
      expect(loadTask(root, value.id).status).toBe('merging');
    });
  });
});
