// Deterministic interleavings of the lock and round-controller protocols. A seam
// around the authority filesystem effects runs a competing actor at an exact point
// inside another actor's operation; nothing here depends on timing.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname, tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Hook = (symbol: string, args: readonly unknown[], result?: unknown) => void;
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
      seam.after?.(symbol, args, result);
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
    fsyncSync: wrap('fsyncSync', actual.fsyncSync),
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
  lockIdentity,
  reapLock,
  releaseLocks,
  renewLocks,
  type AcquireResult,
  type LockRecord,
} from '../../src/loop/locks.js';
import { recordIdentity } from '../../src/loop/record-claims.js';
import { acquireRoundController } from '../../src/loop/round-controller.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { completeTask, loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

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

const HOUR = 60 * 60 * 1000;

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined) throw new Error('no child pid');
  return child.pid;
}

/** A claim file as its claimant writes it: who claimed, on which boot, and when. */
function claimBody(overrides: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify({
    token: 'claim-left-behind',
    hostname: hostname(),
    pid: deadPid(),
    boot_at: Date.now() - uptime() * 1000,
    claimed_at: new Date().toISOString(),
    ...overrides,
  })}\n`;
}

/** An expired lock, optionally with the claim its last writer left on it. */
function abandonedLock(root: string, claim?: string): { record: LockRecord; claim: string } {
  mkdirSync(locksDir(root), { recursive: true });
  mkdirSync(join(root, '.devai/state/lock-claims'), { recursive: true });
  const record: LockRecord = {
    task_id: 'TASK-0810',
    substrate: 'F2',
    module: 'MOD-a',
    acquired_at: '2026-01-01T00:00:00.000Z',
    ttl_ms: 1,
  };
  writeFileSync(keyFile(root), JSON.stringify(record));
  const path = join(root, '.devai/state/lock-claims', `${KEY}.${lockIdentity(record)}.claim`);
  if (claim !== undefined) writeFileSync(path, claim);
  return { record, claim: path };
}

function refusal(action: () => unknown): { code?: string; message?: string } {
  try {
    action();
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
  return {};
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

function controllerFile(root: string): string {
  return join(root, '.devai/state/round-runs', ROUND, 'controller.json');
}

describe('round controller reclamation against a stale reclaimer', () => {
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

  it('a crash right after the re-queue never loses the priority bump', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0407'));
      acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0900', targets: ['F2:MOD-a'] });
      const taskFile = join(root, '.devai/state/tasks/TASK-0407.json');
      seam.after = (symbol, args) => {
        if (symbol !== 'writeFileSync' || args[0] !== taskFile) return;
        if (!String(args[1]).includes('"status": "ready"')) return;
        seam.after = undefined;
        throw new Error('injected crash right after the re-queue');
      };

      await expect(
        runRoundTasks({ repoRoot: root, round: ROUND, dispatch: () => ({ ok: true }) }),
      ).rejects.toThrow('injected crash');
      expect(loadTask(root, 'TASK-0407').status).toBe('ready');

      releaseLocks({ locksDir: locksDir(root), taskId: 'TASK-0900' });
      const dispatched: (number | undefined)[] = [];
      const recovered = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: (running) => {
          dispatched.push(running.priority);
          return { ok: true };
        },
      });

      expect(recovered.results).toEqual([{ task_id: 'TASK-0407', ok: true }]);
      expect(dispatched).toEqual([1]);
    });
  });
});

describe('durable denials and judged completions', () => {
  it('makes the denial count and owed bump durable before the task is re-queued', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0408'));
      acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0900', targets: ['F2:MOD-a'] });
      const runDir = join(root, '.devai/state/round-runs', ROUND);
      const denials = join(runDir, 'lock-denials.json');
      const taskFile = join(root, '.devai/state/tasks/TASK-0408.json');
      const opened = new Map<number, string>();
      const events: string[] = [];
      seam.after = (symbol, args, result) => {
        if (symbol === 'openSync' && typeof result === 'number') {
          opened.set(result, String(args[0]));
        }
        if (symbol === 'renameSync' && args[1] === denials) events.push('rename the denials');
        if (symbol === 'fsyncSync' && opened.get(args[0] as number) === runDir) {
          events.push('fsync the round-run directory');
        }
        if (
          symbol === 'writeFileSync' &&
          args[0] === taskFile &&
          String(args[1]).includes('"status": "ready"')
        ) {
          events.push('re-queue the task');
        }
      };

      await runRoundTasks({ repoRoot: root, round: ROUND, dispatch: () => ({ ok: true }) });
      seam.after = undefined;

      expect(events.slice(0, 3)).toEqual([
        'rename the denials',
        'fsync the round-run directory',
        're-queue the task',
      ]);
    });
  });

  it('a runner that stops between a completion and its judgment is reconciled next run', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0409'));
      const taskFile = join(root, '.devai/state/tasks/TASK-0409.json');
      // The runner stops right before it can persist its verdict on the attempt.
      seam.before = (symbol, args) => {
        if (symbol !== 'writeFileSync' || args[0] !== taskFile) return;
        if (!String(args[1]).includes('"status": "escalated"')) return;
        seam.before = undefined;
        throw new Error('injected stop before the runner judged the attempt');
      };

      await expect(
        runRoundTasks({
          repoRoot: root,
          round: ROUND,
          lockRenewalIntervalMs: 60_000,
          dispatch: () => {
            rmSync(keyFile(root));
            acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0900', targets: ['F2:MOD-a'] });
            completeTask({ repoRoot: root, taskId: 'TASK-0409' });
            return { ok: true };
          },
        }),
      ).rejects.toThrow('injected stop');
      expect(loadTask(root, 'TASK-0409').status).toBe('completed');

      const next = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => ({ ok: true }),
      });

      expect(next.reconciled).toEqual([
        { task_id: 'TASK-0409', ok: false, code: 'TASK_RESOURCE_LOCK_LOST' },
      ]);
      expect(next.ok).toBe(false);
      expect(loadTask(root, 'TASK-0409').status).toBe('escalated');
      expect(listLocks({ locksDir: locksDir(root) })).toMatchObject([{ task_id: 'TASK-0900' }]);
    });
  });
});

describe('attempt fences', () => {
  function fencesDir(root: string): string {
    return join(root, '.devai/state/lock-fences');
  }

  function completing(root: string) {
    return (running: TaskRecord) => {
      completeTask({ repoRoot: root, taskId: running.id });
      return { ok: true };
    };
  }

  it('makes the attempt fence durable before the dispatch starts', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0419'));
      const fence = join(fencesDir(root), 'TASK-0419.json');
      const opened = new Map<number, string>();
      const events: string[] = [];
      seam.after = (symbol, args, result) => {
        if (symbol === 'openSync' && typeof result === 'number') {
          opened.set(result, String(args[0]));
        }
        const synced = symbol === 'fsyncSync' ? opened.get(args[0] as number) : undefined;
        if (synced?.startsWith(`${fence}.`) === true) events.push('fsync the staged fence');
        if (symbol === 'renameSync' && args[1] === fence) events.push('rename the fence');
        if (synced === fencesDir(root)) events.push('fsync the fence directory');
      };

      await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => {
          events.push('dispatch');
          return { ok: true };
        },
      });
      seam.after = undefined;

      expect(events.slice(0, 4)).toEqual([
        'fsync the staged fence',
        'rename the fence',
        'fsync the fence directory',
        'dispatch',
      ]);
    });
  });

  it('makes a newly created fence directory durable in its parent before the dispatch', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0424'));
      const state = join(root, '.devai/state');
      const fence = join(fencesDir(root), 'TASK-0424.json');
      const opened = new Map<number, string>();
      const events: string[] = [];
      seam.after = (symbol, args, result) => {
        if (symbol === 'openSync' && typeof result === 'number') {
          opened.set(result, String(args[0]));
        }
        if (symbol === 'fsyncSync' && opened.get(args[0] as number) === state) {
          events.push('fsync the state directory');
        }
        if (symbol === 'renameSync' && args[1] === fence) events.push('rename the fence');
      };

      await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => {
          events.push('dispatch');
          return { ok: true };
        },
      });
      seam.after = undefined;

      expect(events.slice(0, 3)).toEqual([
        'fsync the state directory',
        'rename the fence',
        'dispatch',
      ]);
    });
  });

  it('writes the release receipt only after the lock record is removed', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0420'));
      const events: string[] = [];
      seam.after = (symbol, args) => {
        if (symbol === 'unlinkSync' && args[0] === keyFile(root)) events.push('remove the lock');
        if (symbol === 'writeFileSync' && String(args[0]).endsWith('.released')) {
          events.push('write the receipt');
        }
      };

      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: completing(root),
      });
      seam.after = undefined;

      expect(result.results).toEqual([{ task_id: 'TASK-0420', ok: true }]);
      expect(events).toEqual(['remove the lock', 'write the receipt']);
    });
  });

  it('retires the fence, durably, before its receipts', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0421'));
      const fence = join(fencesDir(root), 'TASK-0421.json');
      const opened = new Map<number, string>();
      const events: string[] = [];
      let dispatched = false;
      seam.after = (symbol, args, result) => {
        if (symbol === 'openSync' && typeof result === 'number') {
          opened.set(result, String(args[0]));
        }
        if (!dispatched) return;
        if (symbol === 'unlinkSync' && args[0] === fence) events.push('remove the fence');
        if (symbol === 'fsyncSync' && opened.get(args[0] as number) === fencesDir(root)) {
          events.push('fsync the fence directory');
        }
        if (symbol === 'unlinkSync' && String(args[0]).endsWith('.released')) {
          events.push('remove the receipt');
        }
      };

      await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: (running) => {
          const outcome = completing(root)(running);
          dispatched = true;
          return outcome;
        },
      });
      seam.after = undefined;

      expect(events).toEqual([
        'remove the fence',
        'fsync the fence directory',
        'remove the receipt',
      ]);
      expect(readdirSync(fencesDir(root))).toEqual([]);
    });
  });

  it('keeps the receipts of a fence it could not retire', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0422'));
      const fence = join(fencesDir(root), 'TASK-0422.json');
      seam.before = (symbol, args) => {
        if (symbol !== 'unlinkSync' || args[0] !== fence) return;
        seam.before = undefined;
        throw Object.assign(new Error('EIO: injected fence retirement failure'), { code: 'EIO' });
      };

      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: completing(root),
      });

      expect(result.results).toEqual([{ task_id: 'TASK-0422', ok: true }]);
      expect(readdirSync(fencesDir(root)).sort()).toEqual([
        expect.stringMatching(/^TASK-0422\..+\.F2~MOD-a\.json\.released$/u),
        'TASK-0422.json',
      ]);
    });
  });

  it.each([
    ['unreadable', '{'],
    ['malformed', JSON.stringify({ task_id: 'TASK-0423' })],
    [
      'empty-target',
      JSON.stringify({ task_id: 'TASK-0423', round_id: ROUND, attempt: 'attempt-1', targets: [] }),
    ],
    [
      'misnamed',
      JSON.stringify({
        task_id: 'TASK-0499',
        round_id: ROUND,
        attempt: 'attempt-1',
        targets: ['F2:MOD-a'],
      }),
    ],
  ])('refuses the run while an %s fence remains, naming it', async (_case, body) => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0423'));
      mkdirSync(fencesDir(root), { recursive: true });
      const fence = join(fencesDir(root), 'TASK-0423.json');
      writeFileSync(fence, body);
      const dispatch = vi.fn(() => ({ ok: true }));

      const refused = await runRoundTasks({ repoRoot: root, round: ROUND, dispatch }).catch(
        (error: unknown) => error,
      );

      expect((refused as { code?: string }).code).toBe('TASK_LOCK_FENCE_INVALID');
      expect((refused as Error).message).toContain(fence);
      expect(dispatch).not.toHaveBeenCalled();
      expect(loadTask(root, 'TASK-0423').status).toBe('ready');
      expect(readFileSync(fence, 'utf8')).toBe(body);
    });
  });
});

describe('claims left by a claimant that stopped', () => {
  const elsewhere = () => `${hostname()}-elsewhere`;

  it('breaks a claim whose claimant died on this host and takes the expired lock over', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const { claim } = abandonedLock(root, claimBody());

      expect(
        acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0411', targets: ['F2:MOD-a'] })
          .denied,
      ).toEqual([]);

      expect(listLocks({ locksDir: locksDir(root) })).toMatchObject([{ task_id: 'TASK-0411' }]);
      expect(existsSync(claim)).toBe(false);
      expect(readdirSync(join(root, '.devai/state/lock-claims'))).toEqual([]);
    });
  });

  it('breaks a same-host claim whose pid is alive but whose host has rebooted since', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      abandonedLock(
        root,
        claimBody({ pid: process.pid, boot_at: Date.now() - uptime() * 1000 - 10 * HOUR }),
      );

      expect(
        acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0412', targets: ['F2:MOD-a'] })
          .denied,
      ).toEqual([]);
    });
  });

  it.each([
    ['another host within the age bound', () => claimBody({ hostname: elsewhere() })],
    ['a live claimant on this host', () => claimBody({ pid: process.pid })],
    ['a claimant still writing its claim', () => ''],
  ])('stands down before a claim held by %s', async (_case, body) => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const held = body();
      const { claim } = abandonedLock(root, held);

      expect(
        acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0413', targets: ['F2:MOD-a'] })
          .denied,
      ).toEqual([{ target: 'F2:MOD-a', held_by: 'TASK-0810' }]);
      expect(readFileSync(claim, 'utf8')).toBe(held);
    });
  });

  it.each([
    [
      'a live pid on this host past the age bound (never displaced)',
      (claim: string) =>
        writeFileSync(
          claim,
          claimBody({ pid: process.pid, claimed_at: new Date(Date.now() - HOUR).toISOString() }),
        ),
    ],
    [
      'another host past the age bound',
      (claim: string) =>
        writeFileSync(
          claim,
          claimBody({
            hostname: elsewhere(),
            claimed_at: new Date(Date.now() - HOUR).toISOString(),
          }),
        ),
    ],
    [
      'an unreadable claim past the age bound',
      (claim: string) => {
        writeFileSync(claim, '');
        const past = new Date(Date.now() - HOUR);
        utimesSync(claim, past, past);
      },
    ],
  ])('refuses with a repair code naming the claim left by %s', async (_case, leave) => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const { record, claim } = abandonedLock(root);
      leave(claim);
      const left = readFileSync(claim, 'utf8');

      const refused = refusal(() =>
        acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0414', targets: ['F2:MOD-a'] }),
      );

      expect(refused.code).toBe('TASK_RECORD_CLAIM_STALE');
      expect(refused.message).toContain(claim);
      expect(readFileSync(claim, 'utf8')).toBe(left);
      expect(JSON.parse(readFileSync(keyFile(root), 'utf8'))).toEqual(record);
    });
  });

  it('two breakers of one abandoned claim never both win', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const { claim } = abandonedLock(root, claimBody());
      let second: AcquireResult | undefined;
      // The first breaker holds the claim on the claim; a second arrives before it finishes.
      seam.before = (symbol, args) => {
        if (symbol !== 'renameSync' || args[1] !== claim) return;
        seam.before = undefined;
        second = acquireLocks({
          locksDir: locksDir(root),
          taskId: 'TASK-0416',
          targets: ['F2:MOD-a'],
        });
      };

      const first = acquireLocks({
        locksDir: locksDir(root),
        taskId: 'TASK-0415',
        targets: ['F2:MOD-a'],
      });

      expect(first.denied).toEqual([]);
      expect(second?.denied).toEqual([{ target: 'F2:MOD-a', held_by: 'TASK-0810' }]);
      expect(listLocks({ locksDir: locksDir(root) })).toMatchObject([{ task_id: 'TASK-0415' }]);
    });
  });

  it('refuses with a repair code naming the marker of a breaker that died mid-break', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const { claim } = abandonedLock(root, claimBody());
      writeFileSync(`${claim}.break`, claimBody());

      const refused = refusal(() =>
        acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0417', targets: ['F2:MOD-a'] }),
      );

      expect(refused.code).toBe('TASK_RECORD_CLAIM_STALE');
      expect(refused.message).toContain(`${claim}.break`);
    });
  });

  it('reclaims a dead controller whose runner died holding the claim on it', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const claims = join(root, '.devai/state/round-runs', ROUND, 'controller-claims');
      mkdirSync(claims, { recursive: true });
      const dead = {
        round_id: ROUND,
        pid: deadPid(),
        hostname: hostname(),
        started_at: '2026-10-04T00:00:00.000Z',
        token: 'previous',
      };
      writeFileSync(controllerFile(root), JSON.stringify(dead));
      writeFileSync(
        join(claims, `controller.json.${recordIdentity(dead)}.claim`),
        claimBody({ pid: dead.pid }),
      );

      const controller = acquireRoundController(root, ROUND);

      expect(
        (JSON.parse(readFileSync(controllerFile(root), 'utf8')) as { token: string }).token,
      ).toBe(controller.token);
    });
  });

  it('refuses a dead controller whose claim another host left, naming the claim', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const claims = join(root, '.devai/state/round-runs', ROUND, 'controller-claims');
      mkdirSync(claims, { recursive: true });
      const dead = {
        round_id: ROUND,
        pid: deadPid(),
        hostname: hostname(),
        started_at: '2026-10-04T00:00:00.000Z',
        token: 'previous',
      };
      writeFileSync(controllerFile(root), JSON.stringify(dead));
      const claim = join(claims, `controller.json.${recordIdentity(dead)}.claim`);
      writeFileSync(
        claim,
        claimBody({ hostname: elsewhere(), claimed_at: new Date(Date.now() - HOUR).toISOString() }),
      );

      const refused = refusal(() => acquireRoundController(root, ROUND));

      expect(refused.code).toBe('TASK_RECORD_CLAIM_STALE');
      expect(refused.message).toContain(claim);
    });
  });
});

describe('lock record generations', () => {
  it('a release racing a same-millisecond re-acquisition never removes the new lock', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
      acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0418', targets: ['F2:MOD-a'] });
      // While one release holds its read of the record, the task releases and re-acquires
      // the key within the same millisecond: the two records differ only in generation.
      beforeNextMutation(() => {
        releaseLocks({ locksDir: locksDir(root), taskId: 'TASK-0418' });
        expect(
          acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0418', targets: ['F2:MOD-a'] })
            .denied,
        ).toEqual([]);
      });

      expect(releaseLocks({ locksDir: locksDir(root), taskId: 'TASK-0418' })).toEqual([]);

      expect(listLocks({ locksDir: locksDir(root) })).toMatchObject([{ task_id: 'TASK-0418' }]);
    });
  });
});
