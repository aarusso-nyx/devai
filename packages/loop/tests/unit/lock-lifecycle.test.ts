// Lock lifecycle outside a dispatch (#285, #288, #296): the waiting lease, the completion
// ownership fence, quarantined locks, and the orphan receipts a stop leaves behind.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  COMPLETION_LOCK_MARGIN_MS,
  DEFAULT_LOCK_TTL_MS,
  WAITING_LOCK_TTL_MS,
  acquireLocks,
  assertLockOwnership,
  holdsLiveLocks,
  inspectLocks,
  listLocks,
  locksQuarantined,
  quarantineLocks,
  releaseLocks,
  removeOrphanLockReceipts,
} from '../../src/loop/locks.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { finishRoundTask } from '../../src/loop/task-services.js';
import {
  completeTask,
  escalateTask,
  loadTask,
  saveTask,
  type TaskRecord,
} from '../../src/loop/tasks.js';

const roots: string[] = [];
const ROUND = 'R-0007';
const NOW = '2026-10-05T12:00:00.000Z';
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-lock-lifecycle-'));
  roots.push(root);
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

function task(id: string, kind: 'routine' | 'human' = 'routine'): TaskRecord {
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
    executor:
      kind === 'routine'
        ? {
            kind: 'routine',
            argv: ['node', 'fixture.mjs'],
            cwd: '.',
            inputs: [],
            outputs: [],
            effects: ['read'],
            timeout_ms: 1_000,
            authority_checks: ['discipline'],
          }
        : {
            kind: 'human',
            role: 'engineer',
            instructions_ref: 'docs/review.md',
            timeout_ms: 3_600_000,
            timeout_behavior: 'block',
            completion_evidence: ['EV-review'],
          },
  } as TaskRecord;
}

const locksDir = (root: string): string => join(root, '.devai/state/locks');
const KEY = 'F2:MOD-a';

function fixedDate(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
}

function advance(ms: number): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

/** Another task takes the key over once it is free or expired, as `acquireLocks` allows. */
function takeOver(root: string): void {
  expect(
    acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0999', targets: [KEY] }).denied,
  ).toEqual([]);
}

/** Run one dispatch that leaves the task in `status`. */
async function handOff(root: string, value: TaskRecord, status: TaskRecord['status']) {
  saveTask(root, value);
  return runRoundTasks({
    repoRoot: root,
    round: ROUND,
    dispatch: (running) => {
      saveTask(root, { ...running, status });
      return status === 'awaiting_human_review'
        ? { ok: false, code: 'TASK_HUMAN_COMPLETION_REQUIRED' }
        : { ok: true, evidence_id: `EV-${value.id}` };
    },
  });
}

describe('a task waiting outside a dispatch keeps its locks under the waiting lease (#285)', () => {
  it.each(['merging', 'awaiting_human_review'] as const)(
    'hands a task left %s the waiting lease, which outlives the dispatch TTL',
    async (status) => {
      const root = repository();
      fixedDate();
      await withAuthorityHostTestScope(async () => {
        await handOff(root, task('TASK-0501'), status);

        expect(loadTask(root, 'TASK-0501').status).toBe(status);
        expect(listLocks({ locksDir: locksDir(root) })).toMatchObject([
          { task_id: 'TASK-0501', ttl_ms: WAITING_LOCK_TTL_MS, acquired_at: NOW },
        ]);
        // Well past the dispatch TTL nobody can take the module from the waiting task.
        advance(DEFAULT_LOCK_TTL_MS * 2);
        expect(
          acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0999', targets: [KEY] }).denied,
        ).toEqual([{ target: KEY, held_by: 'TASK-0501' }]);
      });
    },
  );

  it('leaves a task the runner escalates no lease', async () => {
    const root = repository();
    fixedDate();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0502'));
      await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => ({ ok: false, code: 'TASK_ROUTINE_EXIT_NONZERO' }),
      });
      expect(loadTask(root, 'TASK-0502').status).toBe('escalated');
      expect(listLocks({ locksDir: locksDir(root) })).toEqual([]);
    });
  });
});

describe('a completion proves exact lock ownership before it persists (#285)', () => {
  it('lets `task finish` complete a waiting routine pass that still holds its lock', async () => {
    const root = repository();
    fixedDate();
    await withAuthorityHostTestScope(async () => {
      await handOff(root, task('TASK-0511'), 'merging');
      advance(DEFAULT_LOCK_TTL_MS * 3);

      expect(finishRoundTask({ repoRoot: root, round: ROUND, taskId: 'TASK-0511' }).status).toBe(
        'completed',
      );
      expect(listLocks({ locksDir: locksDir(root) })).toEqual([]);
    });
  });

  it('refuses `task finish` with TASK_RESOURCE_LOCK_LOST after the lapsed lease was taken over', async () => {
    const root = repository();
    fixedDate();
    await withAuthorityHostTestScope(async () => {
      await handOff(root, task('TASK-0512'), 'merging');
      advance(WAITING_LOCK_TTL_MS + HOUR);
      takeOver(root);

      expect(() => finishRoundTask({ repoRoot: root, round: ROUND, taskId: 'TASK-0512' })).toThrow(
        'TASK_RESOURCE_LOCK_LOST',
      );
      expect(loadTask(root, 'TASK-0512').status).toBe('merging');
      expect(listLocks({ locksDir: locksDir(root) })).toMatchObject([{ task_id: 'TASK-0999' }]);
    });
  });

  it('detects a takeover during awaiting_human_review before a human completion writes anything', async () => {
    const root = repository();
    fixedDate();
    await withAuthorityHostTestScope(async () => {
      await handOff(root, task('TASK-0513', 'human'), 'awaiting_human_review');
      advance(WAITING_LOCK_TTL_MS + HOUR);
      takeOver(root);

      expect(() =>
        finishRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0513',
          evidence: ['EV-review'],
        }),
      ).toThrow('TASK_RESOURCE_LOCK_LOST');
      expect(loadTask(root, 'TASK-0513').status).toBe('awaiting_human_review');
      expect(listLocks({ locksDir: locksDir(root) })).toMatchObject([{ task_id: 'TASK-0999' }]);
    });
  });

  it('refuses `completeTask` itself after a takeover, persisting nothing and releasing nothing', async () => {
    const root = repository();
    fixedDate();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, { ...task('TASK-0514'), status: 'merging' });
      acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0514', targets: [KEY] });
      rmSync(join(locksDir(root), 'F2~MOD-a.json'));
      takeOver(root);

      expect(() => completeTask({ repoRoot: root, taskId: 'TASK-0514' })).toThrow(
        'TASK_RESOURCE_LOCK_LOST',
      );
      expect(loadTask(root, 'TASK-0514').status).toBe('merging');
      expect(listLocks({ locksDir: locksDir(root) })).toMatchObject([{ task_id: 'TASK-0999' }]);
    });
  });

  it('refuses `completeTask` for a key that is simply gone: nothing proves nobody held it', async () => {
    const root = repository();
    fixedDate();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, { ...task('TASK-0515'), status: 'merging' });

      expect(() => completeTask({ repoRoot: root, taskId: 'TASK-0515' })).toThrow(
        'TASK_RESOURCE_LOCK_LOST',
      );
      expect(loadTask(root, 'TASK-0515').status).toBe('merging');
    });
  });

  it('renews a lapsing record before the completion, and leaves a fresh one untouched', () => {
    const root = repository();
    fixedDate();
    return withAuthorityHostTestScope(() => {
      acquireLocks({
        locksDir: locksDir(root),
        taskId: 'TASK-0516',
        targets: [KEY],
        ttlMs: COMPLETION_LOCK_MARGIN_MS * 4,
      });
      const fresh = inspectLocks({ locksDir: locksDir(root), taskId: 'TASK-0516', targets: [KEY] });
      assertLockOwnership({ locksDir: locksDir(root), taskId: 'TASK-0516', targets: [KEY] });
      expect(
        inspectLocks({ locksDir: locksDir(root), taskId: 'TASK-0516', targets: [KEY] }).held,
      ).toEqual(fresh.held);

      // Inside the margin (and once expired) the record is renewed in place, never retaken.
      advance(COMPLETION_LOCK_MARGIN_MS * 3 + 1);
      assertLockOwnership({ locksDir: locksDir(root), taskId: 'TASK-0516', targets: [KEY] });
      const [renewed] = inspectLocks({
        locksDir: locksDir(root),
        taskId: 'TASK-0516',
        targets: [KEY],
      }).held;
      expect(renewed?.record.acquired_at).toBe(new Date().toISOString());
      expect(renewed?.identity).not.toBe(fresh.held[0]?.identity);
      expect(renewed?.record.generation).not.toBe(fresh.held[0]?.record.generation);
    });
  });
});

describe('read-only lock checks', () => {
  it('holds live locks only when every declared key is this task own unexpired record', () => {
    const root = repository();
    fixedDate();
    return withAuthorityHostTestScope(() => {
      const query = { locksDir: locksDir(root), taskId: 'TASK-0521', targets: [KEY] };
      expect(holdsLiveLocks(query)).toBe(false);
      acquireLocks({ ...query, targets: [KEY, 'F2:MOD-b'] });
      expect(holdsLiveLocks(query)).toBe(true);
      advance(DEFAULT_LOCK_TTL_MS);
      expect(holdsLiveLocks(query)).toBe(false);
      takeOver(root);
      expect(holdsLiveLocks({ ...query, taskId: 'TASK-0999' })).toBe(true);
      expect(holdsLiveLocks(query)).toBe(false);
    });
  });
});

describe('quarantined locks outlive their task release (#288)', () => {
  const quarantine = (taskId: string) => ({
    task_id: taskId,
    round_id: ROUND,
    reason: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED' as const,
    pid: 4343,
    evidence_id: 'TXE-0123456789abcdef',
    targets: [KEY],
    recorded_at: NOW,
  });

  it('keeps the locks of an escalation, then lets them lapse by TTL', () => {
    const root = repository();
    fixedDate();
    return withAuthorityHostTestScope(() => {
      saveTask(root, { ...task('TASK-0531'), status: 'in_progress' });
      acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0531', targets: [KEY] });
      quarantineLocks({ locksDir: locksDir(root), quarantine: quarantine('TASK-0531') });

      escalateTask({ repoRoot: root, taskId: 'TASK-0531' });

      expect(loadTask(root, 'TASK-0531').status).toBe('escalated');
      expect(locksQuarantined({ locksDir: locksDir(root), taskId: 'TASK-0531' })).toBe(true);
      expect(releaseLocks({ locksDir: locksDir(root), taskId: 'TASK-0531' })).toEqual([]);
      expect(
        acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0999', targets: [KEY] }).denied,
      ).toEqual([{ target: KEY, held_by: 'TASK-0531' }]);
      advance(DEFAULT_LOCK_TTL_MS);
      takeOver(root);
    });
  });

  it('is never released by the reconciliation of a stopped runner', async () => {
    const root = repository();
    fixedDate();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, { ...task('TASK-0532'), status: 'escalated' });
      acquireLocks({ locksDir: locksDir(root), taskId: 'TASK-0532', targets: [KEY] });
      quarantineLocks({ locksDir: locksDir(root), quarantine: quarantine('TASK-0532') });
      const fences = join(root, '.devai/state/lock-fences');
      mkdirSync(fences, { recursive: true });
      writeFileSync(
        join(fences, 'TASK-0532.json'),
        JSON.stringify({ task_id: 'TASK-0532', round_id: ROUND, attempt: 'a-1', targets: [KEY] }),
      );

      const result = await runRoundTasks({ repoRoot: root, round: ROUND, dispatch: vi.fn() });

      expect(result.reconciled).toBeUndefined();
      expect(listLocks({ locksDir: locksDir(root) })).toMatchObject([{ task_id: 'TASK-0532' }]);
      expect(readdirSync(fences)).toEqual([]);
    });
  });
});

describe('orphan receipts are cleaned up (#296)', () => {
  const fences = (root: string) => join(root, '.devai/state/lock-fences');
  const fence = (taskId: string, attempt: string) =>
    JSON.stringify({ task_id: taskId, round_id: ROUND, attempt, targets: [KEY] });

  function seed(root: string): void {
    mkdirSync(fences(root), { recursive: true });
    const put = (name: string, body = '{}') => writeFileSync(join(fences(root), name), body);
    // A standing fence keeps its own receipts and loses those of an earlier attempt.
    put('TASK-0541.json', fence('TASK-0541', 'attempt-new'));
    put('TASK-0541.attempt-new.F2~MOD-a.json.released');
    put('TASK-0541.attempt-old.F2~MOD-a.json.released');
    // A fence already retired leaves its receipts orphaned.
    put('TASK-0542.attempt-1.F2~MOD-a.json.released');
    // A fence nobody can read keeps every receipt of its task.
    put('TASK-0543.json', '{"task_id": "TASK-0543"');
    put('TASK-0543.attempt-1.F2~MOD-a.json.released');
  }

  it('removes exactly the receipts no standing fence names', () => {
    const root = repository();
    return withAuthorityHostTestScope(() => {
      seed(root);

      expect(removeOrphanLockReceipts({ locksDir: locksDir(root) })).toEqual([
        'TASK-0541.attempt-old.F2~MOD-a.json.released',
        'TASK-0542.attempt-1.F2~MOD-a.json.released',
      ]);
      expect(readdirSync(fences(root)).sort()).toEqual([
        'TASK-0541.attempt-new.F2~MOD-a.json.released',
        'TASK-0541.json',
        'TASK-0543.attempt-1.F2~MOD-a.json.released',
        'TASK-0543.json',
      ]);
    });
  });

  it('cleans them up when a run starts', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      mkdirSync(fences(root), { recursive: true });
      writeFileSync(join(fences(root), 'TASK-0544.attempt-1.F2~MOD-a.json.released'), '{}');

      await runRoundTasks({ repoRoot: root, round: ROUND, dispatch: vi.fn() });

      expect(existsSync(join(fences(root), 'TASK-0544.attempt-1.F2~MOD-a.json.released'))).toBe(
        false,
      );
    });
  });

  it('keeps the receipts of a fenced release until the fence is closed', async () => {
    const root = repository();
    fixedDate();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0545'));
      let receipts: readonly string[] = [];
      await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: () => {
          completeTask({ repoRoot: root, taskId: 'TASK-0545' });
          // A concurrent cleanup in the middle of the attempt removes nothing it needs.
          removeOrphanLockReceipts({ locksDir: locksDir(root) });
          receipts = readdirSync(fences(root)).filter((name) => name.endsWith('.released'));
          return { ok: true };
        },
      });
      expect(receipts).toHaveLength(1);
      expect(loadTask(root, 'TASK-0545').status).toBe('completed');
      expect(readdirSync(fences(root))).toEqual([]);
    });
  });
});
