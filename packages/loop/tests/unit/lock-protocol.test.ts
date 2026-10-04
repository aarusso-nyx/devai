import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  acquireLocks,
  listLocks,
  reapLock,
  renewLocks,
  taskLockTargets,
  type LockRecord,
} from '../../src/loop/locks.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { completeTask, saveTask, spawnTask, type TaskRecord } from '../../src/loop/tasks.js';

const roots: string[] = [];
const ROUND = 'R-0007';

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-lock-protocol-'));
  roots.push(root);
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

function locksDir(root: string): string {
  return join(root, '.devai/state/locks');
}

function lockFiles(root: string): readonly string[] {
  return existsSync(locksDir(root)) ? readdirSync(locksDir(root)).sort() : [];
}

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status: 'ready',
    discipline: 'engineer',
    title: id,
    target_modules: ['MOD-a'],
    target_substrates: ['F2'],
    created_at: '2026-10-04T00:00:00.000Z',
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

function expiredRecord(taskId: string, module: string): LockRecord {
  return {
    task_id: taskId,
    substrate: 'F2',
    module,
    acquired_at: '2026-01-01T00:00:00.000Z',
    ttl_ms: 1,
  };
}

describe('task lock targets', () => {
  it('lock every declared substrate and module pair in UTF-8 order', () => {
    expect(
      taskLockTargets({ target_substrates: ['F3', 'F1'], target_modules: ['MOD-b', 'MOD-a'] }),
    ).toEqual(['F1:MOD-a', 'F1:MOD-b', 'F3:MOD-a', 'F3:MOD-b']);
  });

  it('hold no module lock when the task declares no module target', () => {
    expect(taskLockTargets({ target_substrates: ['F2'], target_modules: [] })).toEqual([]);
  });

  it('spawn acquires the full substrate and module cross product', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const result = spawnTask({
        repoRoot: root,
        task: {
          id: 'TASK-0101',
          round_id: ROUND,
          discipline: 'engineer',
          title: 'multi-substrate',
          target_substrates: ['F1', 'F3'],
          target_modules: ['MOD-a', 'MOD-b'],
          db_isolation: 'database',
          executor: task('TASK-0101').executor,
        },
      });
      expect(result.task.status).toBe('ready');
      expect(lockFiles(root)).toEqual([
        'F1~MOD-a.json',
        'F1~MOD-b.json',
        'F3~MOD-a.json',
        'F3~MOD-b.json',
      ]);
    });
  });
});

describe('lock acquisition', () => {
  it('is all-or-nothing and acquires in UTF-8 order', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0900', targets: ['F2:MOD-b'] });
      const result = acquireLocks({
        locksDir: locksDir(root),
        taskId: 'TASK-0102',
        targets: ['F2:MOD-c', 'F2:MOD-a', 'F2:MOD-b'],
      });
      expect(result).toEqual({
        acquired: [],
        denied: [{ target: 'F2:MOD-b', held_by: 'TASK-0900' }],
      });
      // MOD-a was claimed then rolled back; MOD-c sorts after the conflict and was never claimed.
      expect(lockFiles(root)).toEqual(['F2~MOD-b.json']);
    });
  });

  it('treats a key the task already holds as held and keeps it on rollback', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0103', targets: ['F2:MOD-a'] });
      acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0900', targets: ['F2:MOD-c'] });
      expect(
        acquireLocks({
          locksDir: locksDir(root),
          taskId: 'TASK-0103',
          targets: ['F2:MOD-a', 'F2:MOD-b'],
        }).denied,
      ).toEqual([]);
      expect(
        acquireLocks({
          locksDir: locksDir(root),
          taskId: 'TASK-0103',
          targets: ['F2:MOD-a', 'F2:MOD-c'],
        }).denied,
      ).toEqual([{ target: 'F2:MOD-c', held_by: 'TASK-0900' }]);
      expect(listLocks({ locksDir: locksDir(root) }).map((lock) => lock.module)).toEqual(
        expect.arrayContaining(['MOD-a', 'MOD-b', 'MOD-c']),
      );
    });
  });

  it('lets different substrates of one module coexist (Article 25 pairs)', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      expect(
        acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0104', targets: ['F2:MOD-a'] })
          .denied,
      ).toEqual([]);
      expect(
        acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0105', targets: ['F3:MOD-a'] })
          .denied,
      ).toEqual([]);
    });
  });
});

describe('expired lock takeover', () => {
  it('a stale reaper cannot remove a lock another acquirer took over', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      mkdirSync(locksDir(root), { recursive: true });
      const stale = expiredRecord('TASK-0800', 'MOD-a');
      writeFileSync(join(locksDir(root), 'F2~MOD-a.json'), JSON.stringify(stale));

      // A takes the expired lock over after B has already read the expired record.
      expect(
        acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0106', targets: ['F2:MOD-a'] })
          .denied,
      ).toEqual([]);
      // B now acts on its stale observation.
      expect(reapLock({ locksDir: locksDir(root), target: 'F2:MOD-a', expected: stale })).toBe(
        false,
      );

      const current = JSON.parse(
        readFileSync(join(locksDir(root), 'F2~MOD-a.json'), 'utf8'),
      ) as LockRecord;
      expect(current.task_id).toBe('TASK-0106');
      expect(lockFiles(root)).toEqual(['F2~MOD-a.json']);
    });
  });

  it('reaps exactly the observed expired record', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      mkdirSync(locksDir(root), { recursive: true });
      const stale = expiredRecord('TASK-0801', 'MOD-a');
      writeFileSync(join(locksDir(root), 'F2~MOD-a.json'), JSON.stringify(stale));
      expect(reapLock({ locksDir: locksDir(root), target: 'F2:MOD-a', expected: stale })).toBe(
        true,
      );
      expect(lockFiles(root)).toEqual([]);
    });
  });
});

describe('lock renewal', () => {
  it('restarts the TTL of held keys and reports keys held elsewhere as lost', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
      acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0107', targets: ['F2:MOD-a'] });
      acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0900', targets: ['F2:MOD-b'] });
      vi.setSystemTime(new Date('2026-10-04T00:30:00.000Z'));

      const renewal = renewLocks({
        locksDir: locksDir(root),
        taskId: 'TASK-0107',
        targets: ['F2:MOD-a', 'F2:MOD-b', 'F2:MOD-c'],
      });

      expect(renewal.renewed).toMatchObject([
        { task_id: 'TASK-0107', module: 'MOD-a', acquired_at: '2026-10-04T00:30:00.000Z' },
      ]);
      expect(renewal.lost).toEqual([
        { target: 'F2:MOD-b', held_by: 'TASK-0900' },
        { target: 'F2:MOD-c', held_by: '<none>' },
      ]);
      expect(lockFiles(root)).toEqual(['F2~MOD-a.json', 'F2~MOD-b.json']);
    });
  });

  it('the runner refuses a dispatch whose lock was taken during execution', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0108'));
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        lockRenewalIntervalMs: 60_000,
        dispatch: () => {
          // Another holder displaces this task's lock mid-dispatch.
          rmSync(join(locksDir(root), 'F2~MOD-a.json'));
          acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0900', targets: ['F2:MOD-a'] });
          return { ok: true };
        },
      });
      expect(result.results).toEqual([
        { task_id: 'TASK-0108', ok: false, code: 'TASK_RESOURCE_LOCK_LOST' },
      ]);
    });
  });

  it('the runner keeps a dispatch that completed and released its own locks', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0109'));
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => {
          completeTask({ repoRoot: root, taskId: 'TASK-0109' });
          return { ok: true, evidence_id: 'EV-1' };
        },
      });
      expect(result.results).toEqual([{ task_id: 'TASK-0109', ok: true, evidence_id: 'EV-1' }]);
      expect(lockFiles(root)).toEqual([]);
    });
  });
});
