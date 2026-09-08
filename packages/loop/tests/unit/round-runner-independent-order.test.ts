import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const roots: string[] = [];
const ROUND = 'R-0007';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-runner-independent-order-'));
  roots.push(root);
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

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
      timeout_ms: 1_000,
      authority_checks: ['discipline'],
    },
    ...overrides,
  };
}

describe('round runner independent dependency and order boundaries', () => {
  it('does not import a prior-position task from an unrelated coupled group', async () => {
    const root = repository();
    const selected = task('TASK-1601', {
      coupled_task_group: 'CTG-1601',
      coupled_pipeline_position: 'engineer',
    });
    const unrelated = task('TASK-1602', {
      coupled_task_group: 'CTG-1602',
      coupled_pipeline_position: 'architect',
    });

    await withAuthorityHostTestScope(async () => {
      saveTask(root, selected);
      saveTask(root, unrelated);
      const dispatched: string[] = [];
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        taskIds: [selected.id],
        dispatch: (value) => {
          dispatched.push(value.id);
          return { ok: true };
        },
      });

      expect(result.ordered_task_ids).toEqual([selected.id]);
      expect(dispatched).toEqual([selected.id]);
    });
  });

  it('orders independent coupled positions before priority', async () => {
    const root = repository();
    const architect = task('TASK-1604', {
      coupled_task_group: 'CTG-1603',
      coupled_pipeline_position: 'architect',
      priority: 1,
    });
    const engineer = task('TASK-1603', {
      coupled_task_group: 'CTG-1604',
      coupled_pipeline_position: 'engineer',
      priority: 100,
    });

    await withAuthorityHostTestScope(async () => {
      saveTask(root, engineer);
      saveTask(root, architect);
      const dispatched: string[] = [];
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        dispatch: (value) => {
          dispatched.push(value.id);
          return { ok: true };
        },
      });

      expect(result.ordered_task_ids).toEqual([architect.id, engineer.id]);
      expect(dispatched).toEqual([architect.id, engineer.id]);
    });
  });
});
