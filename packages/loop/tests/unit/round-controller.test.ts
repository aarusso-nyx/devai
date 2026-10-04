import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { acquireLocks, releaseLocks } from '../../src/loop/locks.js';
import {
  LOCK_DENIAL_ESCALATION_THRESHOLD,
  acquireRoundController,
  releaseRoundController,
} from '../../src/loop/round-controller.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const roots: string[] = [];
const ROUND = 'R-0007';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-controller-'));
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
  };
}

function controllerFile(root: string): string {
  return join(root, '.devai/state/round-runs', ROUND, 'controller.json');
}

function writeController(root: string, pid: number, host: string): void {
  mkdirSync(join(root, '.devai/state/round-runs', ROUND), { recursive: true });
  writeFileSync(
    controllerFile(root),
    JSON.stringify({
      round_id: ROUND,
      pid,
      hostname: host,
      started_at: '2026-10-04T00:00:00.000Z',
      token: 'previous',
    }),
  );
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined) throw new Error('no child pid');
  return child.pid;
}

describe('round controller exclusivity', () => {
  it('refuses a second controller while a live one owns the round', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0201'));
      writeController(root, process.pid, hostname());
      const dispatch = vi.fn(() => ({ ok: true }));
      await expect(runRoundTasks({ repoRoot: root, round: ROUND, dispatch })).rejects.toThrow(
        'TASK_ROUND_CONTROLLER_BUSY',
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(loadTask(root, 'TASK-0201').status).toBe('ready');
    });
  });

  it('never reclaims a controller recorded on another host', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      writeController(root, deadPid(), `${hostname()}-elsewhere`);
      expect(() => acquireRoundController(root, ROUND)).toThrow('TASK_ROUND_CONTROLLER_BUSY');
    });
  });

  it('refuses an unreadable controller record', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      mkdirSync(join(root, '.devai/state/round-runs', ROUND), { recursive: true });
      writeFileSync(controllerFile(root), '{');
      expect(() => acquireRoundController(root, ROUND)).toThrow('TASK_ROUND_CONTROLLER_BUSY');
    });
  });

  it('reclaims a controller left by a dead process on this host and releases it after', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0202'));
      writeController(root, deadPid(), hostname());
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => ({ ok: true }),
      });
      expect(result.results).toEqual([{ task_id: 'TASK-0202', ok: true }]);
      expect(existsSync(controllerFile(root))).toBe(false);
    });
  });

  it('releases only the controller it owns', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const first = acquireRoundController(root, ROUND);
      releaseRoundController(root, { ...first, token: 'someone-else' });
      expect(existsSync(controllerFile(root))).toBe(true);
      releaseRoundController(root, first);
      expect(existsSync(controllerFile(root))).toBe(false);
    });
  });
});

describe('lock denial requeue and escalation', () => {
  it('re-queues a denied task with a priority bump, then escalates after repeated denials', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0203'));
      acquireLocks({
        locksDir: join(root, '.devai/state/locks'),
        taskId: 'TASK-0900',
        targets: ['F2:MOD-a'],
      });
      const dispatch = vi.fn(() => ({ ok: true }));

      for (let denial = 1; denial < LOCK_DENIAL_ESCALATION_THRESHOLD; denial += 1) {
        const result = await runRoundTasks({ repoRoot: root, round: ROUND, dispatch });
        expect(result.results).toEqual([
          { task_id: 'TASK-0203', ok: false, code: 'TASK_RESOURCE_LOCK_DENIED' },
        ]);
        expect(loadTask(root, 'TASK-0203')).toMatchObject({ status: 'ready', priority: denial });
      }

      const final = await runRoundTasks({ repoRoot: root, round: ROUND, dispatch });
      expect(final.results).toEqual([
        { task_id: 'TASK-0203', ok: false, code: 'TASK_RESOURCE_LOCK_DENIED_REPEATED' },
      ]);
      expect(loadTask(root, 'TASK-0203').status).toBe('escalated');
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it('starts the denial count afresh once the task acquires its locks', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const locksDir = join(root, '.devai/state/locks');
      saveTask(root, task('TASK-0204'));
      acquireLocks({ locksDir, taskId: 'TASK-0900', targets: ['F2:MOD-a'] });
      await runRoundTasks({ repoRoot: root, round: ROUND, dispatch: () => ({ ok: true }) });
      releaseLocks({ locksDir, taskId: 'TASK-0900' });

      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => ({ ok: true }),
      });
      expect(result.results).toEqual([{ task_id: 'TASK-0204', ok: true }]);
      const denials = JSON.parse(
        readFileSync(join(root, '.devai/state/round-runs', ROUND, 'lock-denials.json'), 'utf8'),
      ) as Record<string, number>;
      expect(denials).toEqual({});
    });
  });
});
