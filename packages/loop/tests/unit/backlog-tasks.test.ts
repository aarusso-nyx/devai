// Invariants: INV-DEVAI-003, INV-DEVAI-004, INV-DEVAI-005
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendBacklog,
  backlogPath,
  compactBacklog,
  pickNextTask,
  readBacklog,
  updateBacklogStatus,
} from '../../src/loop/backlog.js';
import {
  completeTask,
  escalateTask,
  getPausedRgrId,
  listTasks,
  loadTask,
  pauseTaskForRgr,
  resumeTaskFromRgr,
  saveTask,
  spawnTask,
  type TaskRecord,
} from '../../src/loop/tasks.js';
import { acquireLocks, listLocks, lockMtimeMs, reapLocks } from '../../src/loop/locks.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-backlog-tasks-'));
  roots.push(path);
  return path;
}

function routineExecutor(): TaskRecord['executor'] {
  return {
    kind: 'routine',
    argv: ['pnpm', 'test'],
    cwd: '.',
    inputs: [],
    outputs: [],
    effects: ['read'],
    timeout_ms: 1_000,
    authority_checks: ['discipline'],
  };
}

function task(id: string): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id,
    round_id: 'R-0007',
    status: 'queued',
    discipline: 'inspector',
    title: `Test ${id}`,
    target_modules: ['MOD-TEST'],
    target_substrates: ['F3'],
    created_at: '2026-07-24T12:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: routineExecutor(),
  };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('backlog persistence', () => {
  it('handles absent, malformed, superseded, sorted, and compacted records', async () => {
    const repo = root();
    expect(backlogPath(repo)).toBe(join(repo, '.devai/state/backlog.jsonl'));
    expect(readBacklog(repo)).toEqual([]);
    expect(pickNextTask(repo)).toBeNull();
    expect(updateBacklogStatus(repo, 'TASK-4040', 'completed')).toBeNull();

    mkdirSync(dirname(backlogPath(repo)), { recursive: true });
    writeFileSync(
      backlogPath(repo),
      '{bad json}\n' + `${JSON.stringify({ id: 'TASK-0008', title: 'Unbound', priority: 99 })}\n`,
    );
    await withAuthorityHostTestScope(async () => {
      const low = appendBacklog(repo, {
        id: 'TASK-0009',
        round_id: 'R-0007',
        title: 'Low',
        priority: 1,
        created_at: '2026-07-24T12:01:00.000Z',
      });
      expect(low).toMatchObject({ id: 'TASK-0009', status: 'queued' });
      const high = appendBacklog(repo, {
        round_id: 'R-0007',
        title: 'High',
        priority: 9,
        created_at: '2026-07-24T12:00:00.000Z',
        discipline: 'engineer',
        target_modules: ['MOD-TEST'],
        target_substrates: ['F2', 'F3'],
        description: 'exercise optional fields',
        lifecycle: 'supported',
        acceptance_commands: [['pnpm', 'test']],
        db_isolation: 'cluster',
      });
      expect(high.id).toBe('TASK-0010');
      expect(readBacklog(repo).map(({ id }) => id)).toEqual(['TASK-0010', 'TASK-0009']);
      expect(pickNextTask(repo)?.id).toBe('TASK-0010');

      expect(updateBacklogStatus(repo, high.id, 'completed')).toMatchObject({
        id: high.id,
        status: 'completed',
      });
      expect(pickNextTask(repo)?.id).toBe('TASK-0009');
      expect(updateBacklogStatus(repo, low.id, 'cancelled')).toMatchObject({
        status: 'cancelled',
      });
      expect(pickNextTask(repo)).toBeNull();
      expect(compactBacklog(repo)).toBe(2);
      expect(readBacklog(repo)).toHaveLength(2);
    });
  });

  it('sorts equal priorities by creation time and accepts an explicit status', async () => {
    const repo = root();
    await withAuthorityHostTestScope(async () => {
      appendBacklog(repo, {
        round_id: 'R-0007',
        title: 'Later',
        priority: 5,
        status: 'in_progress',
        created_at: '2026-07-24T13:00:00.000Z',
      });
      appendBacklog(repo, {
        round_id: 'R-0007',
        title: 'Earlier',
        priority: 5,
        created_at: '2026-07-24T12:00:00.000Z',
      });
      expect(readBacklog(repo).map(({ title }) => title)).toEqual(['Earlier', 'Later']);
    });
  });
});

describe('task record persistence', () => {
  it('saves, loads, sorts, skips malformed files, and reports missing tasks', async () => {
    const repo = root();
    expect(listTasks(repo)).toEqual([]);
    expect(() => loadTask(repo, 'TASK-9999')).toThrow('task TASK-9999 not found');

    await withAuthorityHostTestScope(async () => {
      saveTask(repo, task('TASK-0002'));
      saveTask(repo, { ...task('TASK-0001'), tags: ['alpha', 'rgr_pause:RGR-7'] });
      writeFileSync(join(repo, '.devai/state/tasks/broken.json'), '{');
      expect(loadTask(repo, 'TASK-0002')).toMatchObject({ id: 'TASK-0002' });
      expect(listTasks(repo).map(({ id }) => id)).toEqual(['TASK-0001', 'TASK-0002']);
    });
  });

  it('extracts the first pause tag and handles absent tags', () => {
    expect(getPausedRgrId({})).toBeNull();
    expect(getPausedRgrId({ tags: ['alpha', 'rgr_pause:RGR-9', 'rgr_pause:RGR-10'] })).toBe(
      'RGR-9',
    );
  });

  it('spawns a local task and completes and escalates persisted tasks', async () => {
    const repo = root();
    await withAuthorityHostTestScope(async () => {
      const spawned = spawnTask({
        repoRoot: repo,
        task: {
          id: 'TASK-0001',
          round_id: 'R-0007',
          discipline: 'engineer',
          title: 'Spawn fixture',
          target_modules: [],
          target_substrates: ['F2'],
          db_isolation: 'database',
          executor: routineExecutor(),
        },
      });
      expect(spawned).toMatchObject({
        task: { id: 'TASK-0001', status: 'ready' },
        lock_denied: [],
        worktree_path: null,
        database: null,
        rollback_reason: null,
      });
      expect(completeTask({ repoRoot: repo, taskId: 'TASK-0001' }).status).toBe('completed');

      saveTask(repo, { ...task('TASK-0002'), branch: 'feature/demo' });
      expect(escalateTask({ repoRoot: repo, taskId: 'TASK-0002' })).toMatchObject({
        status: 'escalated',
        branch: 'escalated/feature/demo',
      });
    });
  });

  it('pauses and resumes by RGR while preserving unrelated tags', async () => {
    const repo = root();
    await withAuthorityHostTestScope(async () => {
      saveTask(repo, { ...task('TASK-0003'), branch: 'feature/rgr', tags: ['keep'] });
      expect(
        pauseTaskForRgr({ repoRoot: repo, taskId: 'TASK-0003', rgrId: 'RGR-12' }),
      ).toMatchObject({
        status: 'rgr_pending',
        branch: 'rgr/feature/rgr',
        tags: ['keep', 'rgr_pause:RGR-12'],
      });
      expect(resumeTaskFromRgr({ repoRoot: repo, rgrId: 'RGR-12' })).toMatchObject({
        status: 'queued',
        tags: ['keep'],
      });
      expect(() => resumeTaskFromRgr({ repoRoot: repo, rgrId: 'RGR-missing' })).toThrow(
        'no task paused',
      );
    });
  });

  it('persists lock denial when two tasks contend for the same module', async () => {
    const repo = root();
    await withAuthorityHostTestScope(async () => {
      const first = spawnTask({
        repoRoot: repo,
        task: {
          id: 'TASK-0011',
          round_id: 'R-0007',
          discipline: 'engineer',
          title: 'Lock holder',
          target_modules: ['MOD-SHARED'],
          target_substrates: ['F2'],
          db_isolation: 'database',
          executor: routineExecutor(),
        },
      });
      expect(first.task.status).toBe('ready');

      const second = spawnTask({
        repoRoot: repo,
        task: {
          id: 'TASK-0012',
          round_id: 'R-0007',
          discipline: 'inspector',
          title: 'Lock contender',
          target_modules: ['MOD-SHARED'],
          target_substrates: ['F3'],
          db_isolation: 'database',
          executor: routineExecutor(),
        },
      });
      expect(second.task.status).toBe('lock_denied');
      expect(second.lock_denied).toEqual([{ target: 'F2:MOD-SHARED', held_by: 'TASK-0011' }]);
      expect(completeTask({ repoRoot: repo, taskId: 'TASK-0011' }).status).toBe('completed');
    });
  });

  it('lists and reaps expired locks and reports lock-file mtimes safely', async () => {
    const repo = root();
    const locksDir = join(repo, '.devai/state/locks');
    expect(listLocks({ locksDir })).toEqual([]);
    expect(reapLocks({ locksDir })).toEqual([]);
    expect(lockMtimeMs(join(locksDir, 'missing.json'))).toBe(0);
    await withAuthorityHostTestScope(async () => {
      expect(
        acquireLocks({
          locksDir,
          taskId: 'TASK-0020',
          targets: ['F2:MOD-OLD'],
          ttlMs: 0,
        }).acquired,
      ).toHaveLength(1);
      expect(listLocks({ locksDir })).toHaveLength(1);
      expect(lockMtimeMs(join(locksDir, 'F2~MOD-OLD.json'))).toBeGreaterThan(0);
      expect(reapLocks({ locksDir })).toMatchObject([{ task_id: 'TASK-0020' }]);
      expect(listLocks({ locksDir })).toEqual([]);
    });
  });
});
