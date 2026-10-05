import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { acquireLocks, listLocks, releaseLocks } from '../../src/loop/locks.js';
import {
  LOCK_DENIAL_ESCALATION_THRESHOLD,
  acquireRoundController,
  releaseRoundController,
} from '../../src/loop/round-controller.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { completeTask, loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

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

function denialsFile(root: string): string {
  return join(root, '.devai/state/round-runs', ROUND, 'lock-denials.json');
}

function writeDenials(root: string, denials: Record<string, number>): void {
  mkdirSync(join(root, '.devai/state/round-runs', ROUND), { recursive: true });
  writeFileSync(denialsFile(root), JSON.stringify(denials));
}

function readDenials(root: string): Record<string, number> {
  return JSON.parse(readFileSync(denialsFile(root), 'utf8')) as Record<string, number>;
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

  it('lets an independent task run after a denial in the same run', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0205'));
      saveTask(root, { ...task('TASK-0206'), target_modules: ['MOD-b'] });
      acquireLocks({
        locksDir: join(root, '.devai/state/locks'),
        taskId: 'TASK-0900',
        targets: ['F2:MOD-a'],
      });
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => ({ ok: true }),
      });
      expect(result.results).toEqual([
        { task_id: 'TASK-0205', ok: false, code: 'TASK_RESOURCE_LOCK_DENIED' },
        { task_id: 'TASK-0206', ok: true },
      ]);
      expect(loadTask(root, 'TASK-0205')).toMatchObject({ status: 'ready', priority: 1 });
    });
  });

  it('requeues a task an interrupted denial left in lock_denied before planning the run', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      // The denial was counted, then the process stopped before the re-queue.
      saveTask(root, { ...task('TASK-0207'), status: 'lock_denied' });
      writeDenials(root, { 'TASK-0207': 1 });
      const dispatch = vi.fn((running: TaskRecord) => {
        expect(running).toMatchObject({ id: 'TASK-0207', priority: 1 });
        return { ok: true };
      });

      const result = await runRoundTasks({ repoRoot: root, round: ROUND, dispatch });

      expect(result.results).toEqual([{ task_id: 'TASK-0207', ok: true }]);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it('a stranded lock_denied dependency no longer refuses planning of its dependants', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, { ...task('TASK-0208'), status: 'lock_denied' });
      saveTask(root, {
        ...task('TASK-0209'),
        target_modules: ['MOD-b'],
        upstream_task_id: 'TASK-0208',
      });

      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: (running) => {
          completeTask({ repoRoot: root, taskId: running.id });
          return { ok: true };
        },
      });

      expect(result.results).toEqual([
        { task_id: 'TASK-0208', ok: true },
        { task_id: 'TASK-0209', ok: true },
      ]);
    });
  });

  it('escalates a stranded task whose counted denials already reached the threshold', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, { ...task('TASK-0210'), status: 'lock_denied' });
      writeDenials(root, { 'TASK-0210': LOCK_DENIAL_ESCALATION_THRESHOLD });
      const dispatch = vi.fn(() => ({ ok: true }));

      await runRoundTasks({ repoRoot: root, round: ROUND, dispatch });

      expect(loadTask(root, 'TASK-0210').status).toBe('escalated');
      expect(dispatch).not.toHaveBeenCalled();
      expect(readDenials(root)).toEqual({});
    });
  });

  it.each([
    ['unparseable', '{'],
    ['a non-object', '[2]'],
    ['a non-numeric count', JSON.stringify({ 'TASK-0211': 'two' })],
    ['a negative count', JSON.stringify({ 'TASK-0211': -1 })],
    ['a fractional count', JSON.stringify({ 'TASK-0211': 1.5 })],
  ])('refuses %s lock-denial state before touching any task', async (_case, body) => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0211'));
      mkdirSync(join(root, '.devai/state/round-runs', ROUND), { recursive: true });
      writeFileSync(denialsFile(root), body);
      const dispatch = vi.fn(() => ({ ok: true }));

      await expect(runRoundTasks({ repoRoot: root, round: ROUND, dispatch })).rejects.toMatchObject(
        { code: 'TASK_LOCK_DENIAL_STATE_INVALID' },
      );

      expect(dispatch).not.toHaveBeenCalled();
      expect(loadTask(root, 'TASK-0211').status).toBe('ready');
      expect(listLocks({ locksDir: join(root, '.devai/state/locks') })).toEqual([]);
      expect(existsSync(controllerFile(root))).toBe(false);
    });
  });

  it('names the corrupt denial file and its repair, and runs again once it is repaired', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0212'));
      mkdirSync(join(root, '.devai/state/round-runs', ROUND), { recursive: true });
      writeFileSync(denialsFile(root), JSON.stringify({ 'TASK-0212': 'NaN' }));

      const refusal = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => ({ ok: true }),
      }).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain(
        `.devai/state/round-runs/${ROUND}/lock-denials.json`,
      );
      expect((refusal as Error).message).toMatch(/remove the file to reset/u);

      rmSync(denialsFile(root));
      const repaired = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => ({ ok: true }),
      });
      expect(repaired.results).toEqual([{ task_id: 'TASK-0212', ok: true }]);
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
      expect(readDenials(root)).toEqual({});
    });
  });
});
