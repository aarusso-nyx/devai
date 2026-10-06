// ADR-MDL-0009 IA-001..IA-003: the reviewer capacity reserve of round-execution.json.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { ROUND_MAX_WORKERS } from '../../src/loop/round-controller.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import {
  ROUND_REVIEW_RESERVE,
  decideRoundTaskAdmission,
  planRoundTaskAdmission,
} from '../../src/loop/round-task-admission.js';
import { completeTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const roots: string[] = [];
const ROUND = 'R-0008';
const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-review-reserve-'));
  roots.push(root);
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

function task(
  id: string,
  module: string,
  discipline: TaskRecord['discipline'] = 'engineer',
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status: 'ready',
    discipline,
    title: id,
    target_modules: [module],
    target_substrates: ['F2'],
    created_at: '2026-10-05T00:00:00.000Z',
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

function decide(
  tasks: readonly TaskRecord[],
  taskId: string,
  activeTaskIds: readonly string[],
  maxWorkers: number,
  failedTaskIds: readonly string[] = [],
) {
  const plan = planRoundTaskAdmission({ roundId: ROUND, tasks });
  return decideRoundTaskAdmission(plan, {
    taskId,
    tasks,
    failedTaskIds,
    activeTaskIds,
    maxWorkers,
  });
}

describe('review reserve policy', () => {
  it('mirrors round-execution.json capacity.review_reserve', () => {
    const policy = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, 'law/policy/round-execution.json'), 'utf8'),
    ) as { capacity: { review_reserve: Record<string, unknown> } };
    expect(policy.capacity.review_reserve).toEqual({
      disciplines: [...ROUND_REVIEW_RESERVE.disciplines],
      reserved_workers: ROUND_REVIEW_RESERVE.reserved_workers,
      applies_when:
        'run-workers-exceed-reserved-and-a-same-generation-review-task-awaits-admission',
      non_review_ceiling: 'run-workers-minus-reserved-workers',
      review_tasks: 'may-use-every-run-worker',
      serial_runs: 'unreserved',
      refusal: 'TASK_WORKER_CAP',
    });
    // The reserve must leave at least one worker for implementation at the ceiling.
    expect(ROUND_REVIEW_RESERVE.reserved_workers).toBeLessThan(ROUND_MAX_WORKERS);
  });
});

describe('review reserve admission (IA-001, IA-002)', () => {
  const population = [
    task('TASK-0801', 'MOD-a'),
    task('TASK-0802', 'MOD-b'),
    task('TASK-0803', 'MOD-c', 'inspector'),
  ];

  it('caps non-review tasks below the run workers while a review task awaits admission', () => {
    expect(decide(population, 'TASK-0802', ['TASK-0801'], 2)).toEqual({
      admitted: false,
      blockers: ['TASK_WORKER_CAP'],
    });
    expect(decide(population, 'TASK-0803', ['TASK-0801'], 2)).toEqual({
      admitted: true,
      blockers: [],
    });
  });

  it('lets review tasks use every worker', () => {
    const reviews = [
      task('TASK-0804', 'MOD-a', 'inspector'),
      task('TASK-0805', 'MOD-b', 'auditor'),
      task('TASK-0806', 'MOD-c', 'inspector'),
    ];
    expect(decide(reviews, 'TASK-0806', ['TASK-0804', 'TASK-0805'], 3).admitted).toBe(true);
  });

  it('holds nothing when no review task awaits admission', () => {
    const implementation = [task('TASK-0807', 'MOD-a'), task('TASK-0808', 'MOD-b')];
    expect(decide(implementation, 'TASK-0808', ['TASK-0807'], 2).admitted).toBe(true);
    // The only review task is already running: the reserve has served it.
    expect(decide(population, 'TASK-0802', ['TASK-0803'], 2).admitted).toBe(true);
    // A failed review task can never use the reserve.
    expect(decide(population, 'TASK-0802', ['TASK-0801'], 2, ['TASK-0803']).admitted).toBe(true);
  });

  it('holds nothing for a review task whose dependency cannot complete', () => {
    const tasks = [
      task('TASK-0809', 'MOD-x', 'engineer', { status: 'escalated' }),
      task('TASK-0810', 'MOD-a'),
      task('TASK-0811', 'MOD-b'),
      task('TASK-0812', 'MOD-c', 'inspector', { upstream_task_id: 'TASK-0809' }),
    ];
    expect(decide(tasks, 'TASK-0811', ['TASK-0810'], 2).admitted).toBe(true);
  });

  it('leaves the serial runner unreserved', () => {
    expect(decide(population, 'TASK-0801', [], 1).admitted).toBe(true);
  });
});

describe('review reserve in the round runner (IA-003)', () => {
  it('admits a waiting review task ahead of later implementation work', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      // Implementation tasks come first in plan order by priority.
      saveTask(root, task('TASK-0821', 'MOD-a', 'engineer', { priority: 90 }));
      saveTask(root, task('TASK-0822', 'MOD-b', 'engineer', { priority: 80 }));
      saveTask(root, task('TASK-0823', 'MOD-c', 'engineer', { priority: 70 }));
      saveTask(root, task('TASK-0824', 'MOD-d', 'inspector', { priority: 10 }));
      const gates = new Map<string, () => void>();
      const signals = new Map<string, () => void>();
      const started = new Map<string, Promise<void>>();
      const startedOf = (id: string): Promise<void> => {
        let entry = started.get(id);
        if (entry === undefined) {
          entry = new Promise<void>((resolve) => signals.set(id, resolve));
          started.set(id, entry);
        }
        return entry;
      };
      const events: string[] = [];
      const run = runRoundTasks({
        repoRoot: root,
        round: ROUND,
        maxWorkers: 2,
        dispatch: async (running) => {
          events.push(`start:${running.id}`);
          void startedOf(running.id);
          signals.get(running.id)?.();
          await new Promise<void>((resolve) => gates.set(running.id, resolve));
          completeTask({ repoRoot: root, taskId: running.id });
          events.push(`end:${running.id}`);
          return { ok: true };
        },
      });
      await startedOf('TASK-0821');
      await startedOf('TASK-0824');
      // Without the reserve TASK-0822 would have taken the second worker.
      expect(events).toEqual(['start:TASK-0821', 'start:TASK-0824']);
      for (const id of ['TASK-0821', 'TASK-0824', 'TASK-0822', 'TASK-0823']) {
        await startedOf(id);
        gates.get(id)?.();
      }
      const result = await run;
      expect(result.ok).toBe(true);
      expect(events.filter((event) => event.startsWith('start:'))).toHaveLength(4);
    });
  });
});
