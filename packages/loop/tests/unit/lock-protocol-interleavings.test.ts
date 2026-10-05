// Deterministic interleavings of the lock and round-controller protocols. A seam
// around the authority filesystem effects runs a competing actor at an exact point
// inside another actor's operation; nothing here depends on timing.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Hook = (symbol: string, args: readonly unknown[]) => void;
const seam = vi.hoisted(() => ({
  before: undefined as undefined | Hook,
  after: undefined as undefined | Hook,
  read: undefined as undefined | ((path: string) => string | undefined),
}));
vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  const wrap = <T extends (...args: never[]) => unknown>(symbol: string, effect: T): T =>
    ((...args: Parameters<T>) => {
      seam.before?.(symbol, args);
      const result = effect(...args);
      seam.after?.(symbol, args);
      return result;
    }) as T;
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    const injected = typeof path === 'string' ? seam.read?.(path) : undefined;
    if (injected !== undefined) return injected;
    return Reflect.apply(actual.readFileSync, undefined, [path, ...rest]) as unknown;
  }) as typeof actual.readFileSync;
  return {
    ...actual,
    openSync: wrap('openSync', actual.openSync),
    renameSync: wrap('renameSync', actual.renameSync),
    unlinkSync: wrap('unlinkSync', actual.unlinkSync),
    writeFileSync: wrap('writeFileSync', actual.writeFileSync),
    readFileSync,
  };
});

import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  acquireLocks,
  listLocks,
  reapLock,
  releaseLocks,
  renewLocks,
  type LockRecord,
} from '../../src/loop/locks.js';
import { acquireRoundController } from '../../src/loop/round-controller.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const roots: string[] = [];
const ROUND = 'R-0007';
const KEY = 'F2~MOD-a.json';

afterEach(() => {
  seam.before = undefined;
  seam.after = undefined;
  seam.read = undefined;
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-lock-interleavings-'));
  roots.push(root);
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

function locksDir(root: string): string {
  return join(root, '.devai/state/locks');
}

function keyFile(root: string): string {
  return join(locksDir(root), KEY);
}

function inode(path: string): number | undefined {
  return existsSync(path) ? statSync(path).ino : undefined;
}

/** Run `actor` once, immediately before the first governed mutation that follows. */
function beforeNextMutation(actor: () => void): void {
  seam.before = () => {
    seam.before = undefined;
    actor();
  };
}

/** Run `actor` once, right after a mutation leaves `path` holding a file other than `original`. */
function onceReplaced(path: string, original: number | undefined, actor: () => void): void {
  seam.after = () => {
    const current = inode(path);
    if (current === undefined || current === original) return;
    seam.after = undefined;
    actor();
  };
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

describe('lock renewal against a concurrent takeover', () => {
  it('never overwrites a lock another task took over after the renewal read it', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
      acquireLocks({
        locksDir: locksDir(root),
        taskId: 'TASK-0401',
        targets: ['F2:MOD-a'],
        ttlMs: 1_000,
      });
      // TASK-0401 stalls past its TTL; its renewal reads its own (expired) record...
      vi.setSystemTime(new Date('2026-10-04T00:00:05.000Z'));
      // ...and TASK-0402 takes the expired lock over before the renewal acts.
      beforeNextMutation(() => {
        expect(
          acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0402', targets: ['F2:MOD-a'] })
            .denied,
        ).toEqual([]);
      });

      const renewal = renewLocks({
        locksDir: locksDir(root),
        taskId: 'TASK-0401',
        targets: ['F2:MOD-a'],
      });

      expect(renewal.renewed).toEqual([]);
      expect(renewal.lost).toEqual([{ target: 'F2:MOD-a', held_by: 'TASK-0402' }]);
      expect(listLocks({ locksDir: locksDir(root) })).toMatchObject([{ task_id: 'TASK-0402' }]);
    });
  });
});

describe('expired lock takeover against a stale reaper', () => {
  it('a stale reaper acting as a takeover installs its record cannot displace the new holder', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      mkdirSync(locksDir(root), { recursive: true });
      const stale: LockRecord = {
        task_id: 'TASK-0800',
        substrate: 'F2',
        module: 'MOD-a',
        acquired_at: '2026-01-01T00:00:00.000Z',
        ttl_ms: 1,
      };
      writeFileSync(keyFile(root), JSON.stringify(stale));
      // A reaper observed the expired record earlier and acts the moment a replacement appears.
      let reaped: boolean | undefined;
      onceReplaced(keyFile(root), inode(keyFile(root)), () => {
        reaped = reapLock({ locksDir: locksDir(root), target: 'F2:MOD-a', expected: stale });
      });

      expect(
        acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0403', targets: ['F2:MOD-a'] })
          .denied,
      ).toEqual([]);

      expect(reaped).toBe(false);
      // The new holder's record is in place and complete, so nobody else can take the key.
      expect((JSON.parse(readFileSync(keyFile(root), 'utf8')) as LockRecord).task_id).toBe(
        'TASK-0403',
      );
      expect(
        acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0404', targets: ['F2:MOD-a'] })
          .denied,
      ).toEqual([{ target: 'F2:MOD-a', held_by: 'TASK-0403' }]);
      expect(
        renewLocks({ locksDir: locksDir(root), taskId: 'TASK-0403', targets: ['F2:MOD-a'] }).lost,
      ).toEqual([]);
    });
  });

  it('an expired-lock takeover never leaves the key absent or partially written', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      mkdirSync(locksDir(root), { recursive: true });
      writeFileSync(
        keyFile(root),
        JSON.stringify({
          task_id: 'TASK-0801',
          substrate: 'F2',
          module: 'MOD-a',
          acquired_at: '2026-01-01T00:00:00.000Z',
          ttl_ms: 1,
        }),
      );
      const observed: string[] = [];
      seam.after = () => {
        if (!existsSync(keyFile(root))) observed.push('<absent>');
        else {
          try {
            observed.push((JSON.parse(readFileSync(keyFile(root), 'utf8')) as LockRecord).task_id);
          } catch {
            observed.push('<partial>');
          }
        }
      };

      expect(
        acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0405', targets: ['F2:MOD-a'] })
          .denied,
      ).toEqual([]);
      seam.after = undefined;

      expect(observed).not.toContain('<absent>');
      expect(observed).not.toContain('<partial>');
      expect(observed.at(-1)).toBe('TASK-0405');
    });
  });
});

describe('round controller reclamation against a stale reclaimer', () => {
  function controllerFile(root: string): string {
    return join(root, '.devai/state/round-runs', ROUND, 'controller.json');
  }

  function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', '']);
    if (child.pid === undefined) throw new Error('no child pid');
    return child.pid;
  }

  it('never removes a controller another runner just claimed over a dead one', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      mkdirSync(join(root, '.devai/state/round-runs', ROUND), { recursive: true });
      const stale = JSON.stringify({
        round_id: ROUND,
        pid: deadPid(),
        hostname: hostname(),
        started_at: '2026-10-04T00:00:00.000Z',
        token: 'previous',
      });
      writeFileSync(controllerFile(root), stale);
      // A second runner read the dead controller earlier; it acts the moment a new one appears.
      let second: unknown;
      onceReplaced(controllerFile(root), inode(controllerFile(root)), () => {
        let served = false;
        seam.read = (path) => {
          if (served || path !== controllerFile(root)) return undefined;
          served = true;
          return stale;
        };
        try {
          second = acquireRoundController(root, ROUND);
        } catch (error) {
          second = error instanceof Error ? error.message : error;
        } finally {
          seam.read = undefined;
        }
      });

      const first = acquireRoundController(root, ROUND);

      expect(second).toBe('TASK_ROUND_CONTROLLER_BUSY');
      expect(
        (JSON.parse(readFileSync(controllerFile(root), 'utf8')) as { token: string }).token,
      ).toBe(first.token);
      expect(() => acquireRoundController(root, ROUND)).toThrow('TASK_ROUND_CONTROLLER_BUSY');
    });
  });
});

describe('lock denial recovery', () => {
  it('a denial-counter write failure never strands the task: the next run requeues it', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0406'));
      acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0900', targets: ['F2:MOD-a'] });
      const denials = join(root, '.devai/state/round-runs', ROUND, 'lock-denials.json');
      seam.before = (symbol, args) => {
        if (symbol === 'renameSync' && args[1] === denials) {
          seam.before = undefined;
          throw Object.assign(new Error('EIO: injected denial-counter write failure'), {
            code: 'EIO',
          });
        }
      };
      const dispatch = vi.fn(() => ({ ok: true }));

      await expect(runRoundTasks({ repoRoot: root, round: ROUND, dispatch })).rejects.toThrow(
        'EIO',
      );
      expect(loadTask(root, 'TASK-0406').status).toBe('lock_denied');

      releaseLocks({ locksDir: locksDir(root), taskId: 'TASK-0900' });
      const recovered = await runRoundTasks({ repoRoot: root, round: ROUND, dispatch });

      expect(recovered.results).toEqual([{ task_id: 'TASK-0406', ok: true }]);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });
});
