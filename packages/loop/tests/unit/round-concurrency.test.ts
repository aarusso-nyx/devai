import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  LOCK_DENIAL_ESCALATION_THRESHOLD,
  ROUND_DEFAULT_WORKERS,
  ROUND_MAX_WORKERS,
} from '../../src/loop/round-controller.js';
import { resolveRoundWorkers, runRoundTasks } from '../../src/loop/round-runner.js';
import {
  decideRoundTaskAdmission,
  planRoundTaskAdmission,
} from '../../src/loop/round-task-admission.js';
import { completeTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const roots: string[] = [];
const ROUND = 'R-0007';
const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-concurrency-'));
  roots.push(root);
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

function task(id: string, module: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status: 'ready',
    discipline: 'engineer',
    title: id,
    target_modules: [module],
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

/** A dispatcher whose tasks finish only when the test releases them, recording overlap. */
function gatedDispatch(root: string) {
  const gates = new Map<string, () => void>();
  const events: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const started = new Map<string, Promise<void>>();
  const startedSignals = new Map<string, () => void>();
  const startedOf = (id: string): Promise<void> => {
    let entry = started.get(id);
    if (entry === undefined) {
      entry = new Promise<void>((resolve) => startedSignals.set(id, resolve));
      started.set(id, entry);
    }
    return entry;
  };
  const dispatch = async (running: TaskRecord) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    events.push(`start:${running.id}`);
    startedOf(running.id);
    startedSignals.get(running.id)?.();
    await new Promise<void>((resolve) => gates.set(running.id, resolve));
    completeTask({ repoRoot: root, taskId: running.id });
    events.push(`end:${running.id}`);
    inFlight -= 1;
    return { ok: true };
  };
  const release = async (id: string): Promise<void> => {
    await startedOf(id);
    gates.get(id)?.();
  };
  return { dispatch, release, events, maxInFlight: () => maxInFlight, startedOf };
}

describe('round worker capacity', () => {
  it('mirrors the round-execution.json capacity block', () => {
    const policy = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, 'law/policy/round-execution.json'), 'utf8'),
    ) as { capacity: Record<string, unknown> };
    expect(policy.capacity).toMatchObject({
      default_workers: ROUND_DEFAULT_WORKERS,
      max_workers: ROUND_MAX_WORKERS,
      lock_denial_escalation_threshold: LOCK_DENIAL_ESCALATION_THRESHOLD,
      admission: 'same-topological-generation-and-resource-disjoint-only',
      cross_round_controller: 'forbidden',
    });
  });

  it('is serial unless a run opts in, and refuses a cap outside the ceiling', () => {
    expect(resolveRoundWorkers(undefined)).toBe(1);
    expect(resolveRoundWorkers(ROUND_MAX_WORKERS)).toBe(ROUND_MAX_WORKERS);
    for (const invalid of [0, ROUND_MAX_WORKERS + 1, 1.5, Number.NaN]) {
      expect(() => resolveRoundWorkers(invalid)).toThrow('TASK_WORKER_CAP_INVALID');
    }
  });

  it('refuses an invalid cap before any task is touched', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0301', 'MOD-a'));
      await expect(
        runRoundTasks({
          repoRoot: root,
          round: ROUND,
          maxWorkers: 0,
          dispatch: () => ({ ok: true }),
        }),
      ).rejects.toThrow('TASK_WORKER_CAP_INVALID');
    });
  });
});

describe('bounded concurrent dispatch', () => {
  it('overlaps resource-disjoint tasks of one generation up to the cap', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0302', 'MOD-a'));
      saveTask(root, task('TASK-0303', 'MOD-b'));
      saveTask(root, task('TASK-0304', 'MOD-c'));
      const gate = gatedDispatch(root);
      const run = runRoundTasks({
        repoRoot: root,
        round: ROUND,
        maxWorkers: 2,
        dispatch: gate.dispatch,
      });
      await gate.startedOf('TASK-0302');
      await gate.startedOf('TASK-0303');
      expect(gate.events).toEqual(['start:TASK-0302', 'start:TASK-0303']);
      await gate.release('TASK-0302');
      await gate.release('TASK-0303');
      await gate.release('TASK-0304');
      const result = await run;
      expect(result.ok).toBe(true);
      expect(result.results.map((entry) => entry.task_id)).toEqual([
        'TASK-0302',
        'TASK-0303',
        'TASK-0304',
      ]);
      expect(gate.maxInFlight()).toBe(2);
    });
  });

  it('never overlaps tasks that share a lock key', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0305', 'MOD-a'));
      saveTask(root, task('TASK-0306', 'MOD-a'));
      const gate = gatedDispatch(root);
      const run = runRoundTasks({
        repoRoot: root,
        round: ROUND,
        maxWorkers: 2,
        dispatch: gate.dispatch,
      });
      await gate.release('TASK-0305');
      await gate.release('TASK-0306');
      const result = await run;
      expect(result.ok).toBe(true);
      expect(gate.maxInFlight()).toBe(1);
      expect(gate.events).toEqual([
        'start:TASK-0305',
        'end:TASK-0305',
        'start:TASK-0306',
        'end:TASK-0306',
      ]);
    });
  });

  it('keeps a later generation behind every active task of an earlier one', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      saveTask(root, task('TASK-0307', 'MOD-a'));
      saveTask(root, task('TASK-0308', 'MOD-b'));
      saveTask(root, task('TASK-0309', 'MOD-c', { upstream_task_id: 'TASK-0308' }));
      const gate = gatedDispatch(root);
      const run = runRoundTasks({
        repoRoot: root,
        round: ROUND,
        maxWorkers: 3,
        dispatch: gate.dispatch,
      });
      await gate.release('TASK-0308');
      // TASK-0309's dependency is complete, but TASK-0307 of generation 0 is still active.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(gate.events).not.toContain('start:TASK-0309');
      await gate.release('TASK-0307');
      await gate.release('TASK-0309');
      const result = await run;
      expect(result.ok).toBe(true);
      expect(gate.events.indexOf('start:TASK-0309')).toBeGreaterThan(
        gate.events.indexOf('end:TASK-0307'),
      );
    });
  });
});

describe('concurrent admission decision', () => {
  it('admits a second disjoint same-generation task only under a larger cap', () => {
    const tasks = [task('TASK-0310', 'MOD-a'), task('TASK-0311', 'MOD-b')];
    const plan = planRoundTaskAdmission({ roundId: ROUND, tasks });
    const decide = (maxWorkers?: number) =>
      decideRoundTaskAdmission(plan, {
        taskId: 'TASK-0311',
        tasks,
        failedTaskIds: [],
        activeTaskIds: ['TASK-0310'],
        ...(maxWorkers !== undefined && { maxWorkers }),
      });
    expect(decide().blockers).toEqual(['TASK_WORKER_CAP']);
    expect(decide(2)).toEqual({ admitted: true, blockers: [] });
  });

  it('refuses a later-generation task beside an active earlier-generation task', () => {
    const planned = [
      task('TASK-0312', 'MOD-a'),
      task('TASK-0313', 'MOD-b'),
      task('TASK-0314', 'MOD-c', { upstream_task_id: 'TASK-0313' }),
    ];
    const plan = planRoundTaskAdmission({ roundId: ROUND, tasks: planned });
    // TASK-0313 has since completed; TASK-0312 of generation 0 is still active.
    const live = planned.map((entry) =>
      entry.id === 'TASK-0313' ? { ...entry, status: 'completed' as const } : entry,
    );
    const decision = decideRoundTaskAdmission(plan, {
      taskId: 'TASK-0314',
      tasks: live,
      failedTaskIds: [],
      activeTaskIds: ['TASK-0312'],
      maxWorkers: 2,
    });
    expect(decision.blockers).toEqual(['TASK_GENERATION_BARRIER']);
  });
});
