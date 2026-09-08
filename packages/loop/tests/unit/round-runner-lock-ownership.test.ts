import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { acquireLocks } from '../../src/loop/locks.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { saveTask, type TaskRecord } from '../../src/loop/tasks.js';

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
