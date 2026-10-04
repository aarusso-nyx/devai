// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020.
// Inspector acceptance: canonical complete-population planning never grants dispatch authority.
import { describe, expect, it } from 'vitest';
import {
  decideRoundTaskAdmission,
  planRoundTaskAdmission,
} from '../../src/loop/round-task-admission.js';
import type { TaskRecord } from '../../src/loop/tasks.js';

const ROUND = 'R-0007';

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status: 'ready',
    discipline: 'engineer',
    title: id,
    target_modules: [],
    target_substrates: ['F2'],
    created_at: '2026-09-08T12:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'routine',
      argv: ['node', 'fixture.mjs'],
      cwd: '.',
      inputs: [],
      outputs: [],
      effects: ['read'],
      timeout_ms: 1000,
      authority_checks: ['discipline'],
    },
    ...overrides,
  };
}

function plan(tasks: readonly TaskRecord[], selectedTaskIds?: readonly string[]) {
  return planRoundTaskAdmission({
    roundId: ROUND,
    tasks,
    ...(selectedTaskIds !== undefined && { selectedTaskIds }),
  });
}

describe('canonical round task admission planning', () => {
  it('retains priority and UTF8 ID order independently of input insertion order', () => {
    const tasks = [
      task('TASK-8203', { priority: 5 }),
      task('TASK-8202', { priority: 10 }),
      task('TASK-8201', { priority: 5 }),
    ];
    const expected = ['TASK-8202', 'TASK-8201', 'TASK-8203'];
    expect(plan(tasks).orderedTaskIds).toEqual(expected);
    expect(plan([...tasks].reverse()).orderedTaskIds).toEqual(expected);
  });

  it('gives every zero-dependency task generation zero and finishes it before descendants', () => {
    const parent = task('TASK-8201', { priority: 90 });
    const child = task('TASK-8202', { upstream_task_id: parent.id, priority: 100 });
    const independent = task('TASK-8203', { priority: 0 });
    const result = plan([child, independent, parent]);
    expect(result.orderedTaskIds).toEqual([parent.id, independent.id, child.id]);
    expect(result.tasks.find((node) => node.id === parent.id)?.generation).toBe(0);
    expect(result.tasks.find((node) => node.id === child.id)?.generation).toBe(1);
  });

  it('adds composite row dependencies to children as well as parent dependencies', () => {
    const first = task('TASK-8203', { priority: 0 });
    const second = task('TASK-8202', { priority: 100 });
    const parent = task('TASK-8201', {
      executor: {
        kind: 'composite',
        child_task_ids: [second.id, first.id],
        dependencies: [{ task_id: second.id, depends_on: [first.id] }],
        failure_policy: 'stop-dependent-branch',
      },
    });
    const result = plan([parent, second, first], [parent.id]);
    expect(result.orderedTaskIds).toEqual([first.id, second.id, parent.id]);
    expect(result.tasks.find((node) => node.id === second.id)?.dependsOn).toContain(first.id);
    expect(result.tasks.find((node) => node.id === parent.id)?.dependsOn).toEqual([
      second.id,
      first.id,
    ]);
  });

  it('does not create dependencies across unrelated coupled groups', () => {
    const selected = task('TASK-8201', {
      coupled_task_group: 'CTG-8201',
      coupled_pipeline_position: 'engineer',
    });
    const unrelated = task('TASK-8202', {
      coupled_task_group: 'CTG-8202',
      coupled_pipeline_position: 'architect',
    });
    const result = plan([selected, unrelated], [selected.id]);
    expect(result.orderedTaskIds).toEqual([selected.id]);
    expect(result.tasks.find((node) => node.id === selected.id)?.dependsOn).toEqual([]);
  });

  it('retains an explicit empty selection and does not mutate the input records', () => {
    const tasks = [task('TASK-8201')];
    const original = JSON.stringify(tasks);
    expect(plan(tasks, []).orderedTaskIds).toEqual([]);
    expect(JSON.stringify(tasks)).toBe(original);
  });

  it('never redispatches completed, escalated, or cancelled explicit selections', () => {
    const tasks = [
      task('TASK-8201', { status: 'completed' }),
      task('TASK-8202', { status: 'escalated' }),
      task('TASK-8203', { status: 'cancelled' }),
    ];
    expect(
      plan(
        tasks,
        tasks.map((value) => value.id),
      ).orderedTaskIds,
    ).toEqual([]);
  });

  it('rejects duplicate canonical identities rather than collapsing a Map', () => {
    expect(() =>
      plan([task('TASK-8201'), task('TASK-8201', { title: 'different request' })]),
    ).toThrow('TASK_ID_DUPLICATE');
  });

  it('rejects a missing dependency even when its task is not selected', () => {
    expect(() =>
      plan(
        [task('TASK-8201'), task('TASK-8202', { status: 'queued', upstream_task_id: 'TASK-8299' })],
        ['TASK-8201'],
      ),
    ).toThrow('TASK_DEPENDENCY_MISSING');
  });

  it('rejects a cycle even when both tasks are already completed', () => {
    expect(() =>
      plan(
        [
          task('TASK-8201', { status: 'completed', upstream_task_id: 'TASK-8202' }),
          task('TASK-8202', { status: 'completed', upstream_task_id: 'TASK-8201' }),
        ],
        [],
      ),
    ).toThrow('TASK_COMPOSITE_CYCLE');
  });

  it('rejects a cross-round dependency and cross-round explicit selection distinctly', () => {
    const tasks = [
      task('TASK-8201', { upstream_task_id: 'TASK-8202' }),
      task('TASK-8202', { round_id: 'R-0008' }),
    ];
    expect(() => plan(tasks, ['TASK-8201'])).toThrow('TASK_COMPOSITE_CROSS_ROUND');
    expect(() => plan([tasks[1] as TaskRecord], ['TASK-8202'])).toThrow('TASK_ROUND_MISMATCH');
  });

  it('conservatively exposes every declared substrate-module resource pair', () => {
    const value = task('TASK-8201', {
      target_substrates: ['F3', 'F2'],
      target_modules: ['MOD-b', 'MOD-a'],
    });
    expect(plan([value]).tasks.find((node) => node.id === value.id)?.resourceKeys).toEqual([
      'F2:MOD-a',
      'F2:MOD-b',
      'F3:MOD-a',
      'F3:MOD-b',
    ]);
  });
});

describe('canonical round admission live state', () => {
  it.each([
    'ready',
    'in_progress',
    'checkpoint',
    'pre_merge',
    'merging',
    'awaiting_human_review',
  ] as const)('does not equate upstream %s with completed', (status) => {
    const upstream = task('TASK-8201', { status: 'completed' });
    const dependent = task('TASK-8202', { upstream_task_id: upstream.id });
    const admission = decideRoundTaskAdmission(plan([upstream, dependent]), {
      taskId: dependent.id,
      tasks: [{ ...upstream, status }, dependent],
      failedTaskIds: [],
    });
    expect(admission.admitted).toBe(false);
    expect(admission.blockers).toContain('TASK_DEPENDENCY_NOT_COMPLETED');
  });

  it('admits a dependent after durable completed status without making that transition itself', () => {
    const upstream = task('TASK-8201');
    const dependent = task('TASK-8202', { upstream_task_id: upstream.id });
    const tasks = [{ ...upstream, status: 'completed' as const, iteration_count: 1 }, dependent];
    const before = JSON.stringify(tasks);
    expect(
      decideRoundTaskAdmission(plan([upstream, dependent]), {
        taskId: dependent.id,
        tasks,
        failedTaskIds: [],
      }),
    ).toEqual({ admitted: true, blockers: [] });
    expect(JSON.stringify(tasks)).toBe(before);
  });

  it.each(['escalated', 'cancelled', 'experimental_blocked', 'rgr_pending'] as const)(
    'blocks a durable %s prerequisite even when not present in the transient failed list',
    (status) => {
      const upstream = task('TASK-8201', { status: 'completed' });
      const dependent = task('TASK-8202', { upstream_task_id: upstream.id });
      const admission = decideRoundTaskAdmission(plan([upstream, dependent]), {
        taskId: dependent.id,
        tasks: [{ ...upstream, status }, dependent],
        failedTaskIds: [],
      });
      expect(admission.admitted).toBe(false);
      expect(admission.blockers).toContain('TASK_DEPENDENCY_FAILED');
    },
  );

  it('retains the failed attempt blocker even if a callback later presents completed state', () => {
    const upstream = task('TASK-8201', { status: 'completed' });
    const dependent = task('TASK-8202', { upstream_task_id: upstream.id });
    const tasks = [upstream, dependent];
    const admission = decideRoundTaskAdmission(plan(tasks), {
      taskId: dependent.id,
      tasks,
      failedTaskIds: [upstream.id],
    });
    expect(admission.admitted).toBe(false);
    expect(admission.blockers).toContain('TASK_DEPENDENCY_FAILED');
  });

  it('blocks a changed executor request and a newly added task after plan construction', () => {
    const value = task('TASK-8201');
    const initial = plan([value]);
    const changed = { ...value, title: 'mutated request' };
    expect(
      decideRoundTaskAdmission(initial, { taskId: value.id, tasks: [changed], failedTaskIds: [] })
        .blockers,
    ).toContain('TASK_RECORD_CHANGED');
    expect(
      decideRoundTaskAdmission(initial, {
        taskId: value.id,
        tasks: [value, task('TASK-8202')],
        failedTaskIds: [],
      }).blockers,
    ).toContain('TASK_RECORD_CHANGED');
  });

  it('refuses a missing live task instead of admitting the frozen planned record', () => {
    const value = task('TASK-8201');
    const initial = plan([value]);
    const inspect = () =>
      decideRoundTaskAdmission(initial, { taskId: value.id, tasks: [], failedTaskIds: [] });
    expect(inspect).toThrow('TASK_DEPENDENCY_MISSING');
  });

  it('does not dispatch a planned ready task that is now awaiting human review', () => {
    const value = task('TASK-8201');
    const admission = decideRoundTaskAdmission(plan([value]), {
      taskId: value.id,
      tasks: [{ ...value, status: 'awaiting_human_review' }],
      failedTaskIds: [],
    });
    expect(admission.admitted).toBe(false);
    expect(admission.blockers).toContain('TASK_NOT_READY');
  });

  it('blocks intersecting active resources and retains the fixed one-worker cap', () => {
    const first = task('TASK-8201', { target_modules: ['MOD-a'], target_substrates: ['F2', 'F3'] });
    const second = task('TASK-8202', { target_modules: ['MOD-a'], target_substrates: ['F3'] });
    const tasks = [first, second];
    const result = decideRoundTaskAdmission(plan(tasks), {
      taskId: second.id,
      tasks,
      failedTaskIds: [],
      activeTaskIds: [first.id],
    });
    expect(result.admitted).toBe(false);
    expect(result.blockers).toContain('TASK_RESOURCE_CONFLICT');
    expect(result.blockers).toContain('TASK_WORKER_CAP');
  });

  it('retains the fixed one-worker cap even when active resource keys are disjoint', () => {
    const first = task('TASK-8201', { target_modules: ['MOD-a'] });
    const second = task('TASK-8202', { target_modules: ['MOD-b'] });
    const tasks = [first, second];
    const result = decideRoundTaskAdmission(plan(tasks), {
      taskId: second.id,
      tasks,
      failedTaskIds: [],
      activeTaskIds: [first.id],
    });
    expect(result.admitted).toBe(false);
    expect(result.blockers).toContain('TASK_WORKER_CAP');
    expect(result.blockers).not.toContain('TASK_RESOURCE_CONFLICT');
  });

  it('refuses a serialized copy of a plan instead of treating it as execution authority', () => {
    const value = task('TASK-8201');
    const initial = plan([value]);
    const forged = JSON.parse(JSON.stringify(initial)) as ReturnType<typeof planRoundTaskAdmission>;
    expect(() =>
      decideRoundTaskAdmission(forged, { taskId: value.id, tasks: [value], failedTaskIds: [] }),
    ).toThrow();
  });

  it.each([
    { label: 'branch', context: { branch: 'redirected-branch' } },
    { label: 'worktree', context: { worktree_id: 'WT-TASK-redirected' } },
  ])('blocks a current ready task whose $label changes after planning', ({ context }) => {
    const value = task('TASK-8201');
    const initial = plan([value]);
    const result = decideRoundTaskAdmission(initial, {
      taskId: value.id,
      tasks: [{ ...value, ...context }],
      failedTaskIds: [],
    });
    expect(result.admitted).toBe(false);
    expect(result.blockers).toContain('TASK_RECORD_CHANGED');
  });

  it('permits terminal upstream branch assignment while requiring its completed status', () => {
    const upstream = task('TASK-8201');
    const dependent = task('TASK-8202', { upstream_task_id: upstream.id });
    const initial = plan([upstream, dependent]);
    const result = decideRoundTaskAdmission(initial, {
      taskId: dependent.id,
      tasks: [
        {
          ...upstream,
          status: 'completed',
          branch: 'completed-upstream-branch',
          worktree_id: 'WT-TASK-completed',
        },
        dependent,
      ],
      failedTaskIds: [],
    });
    expect(result).toEqual({ admitted: true, blockers: [] });
  });
});
