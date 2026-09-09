import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskRecord } from '@devai-nyx/loop';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { dispatchRoundTask } from '../../src/commands/round/dispatch.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-round-dispatch-'));
  roots.push(value);
  return value;
}

function task(executor: TaskRecord['executor']): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id: 'TASK-9701',
    round_id: 'R-9701',
    status: 'queued',
    discipline: 'engineer',
    title: 'Dispatch boundary fixture',
    target_modules: [],
    target_substrates: ['F2'],
    created_at: '2026-09-09T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor,
  };
}

describe('round task dispatch adapter boundaries', () => {
  it('records a human task as awaiting review before reporting the completion requirement', async () => {
    const repoRoot = root();
    const result = await withAuthorityHostTestScope(() =>
      dispatchRoundTask(
        repoRoot,
        task({
          kind: 'human',
          role: 'inspector',
          instructions_ref: 'work/rounds/R-9701/review.md',
          completion_evidence: ['EV-review'],
          timeout_ms: 60_000,
          timeout_behavior: 'block',
        }),
      ),
    );

    expect(result).toEqual({ ok: false, code: 'TASK_HUMAN_COMPLETION_REQUIRED' });
    const stored = JSON.parse(
      readFileSync(join(repoRoot, '.devai/state/tasks/TASK-9701.json'), 'utf8'),
    ) as TaskRecord;
    expect(stored).toMatchObject({
      id: 'TASK-9701',
      status: 'awaiting_human_review',
      executor: { kind: 'human', role: 'inspector' },
    });
    expect(stored.spawned_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it.each([
    [
      'agent',
      {
        kind: 'agent',
        runtime: 'fixture',
        model: 'fixture',
        effort: 'low',
        selection: { mode: 'exact', registry_id: 'fixture' },
        prompt_composition_id: 'fixture',
        max_iterations: 1,
        capabilities: [],
      } satisfies TaskRecord['executor'],
      'TASK_AGENT_ADAPTER_UNBOUND',
    ],
    [
      'composite',
      {
        kind: 'composite',
        child_task_ids: ['TASK-9702'],
        dependencies: [{ task_id: 'TASK-9702', depends_on: [] }],
        failure_policy: 'stop-composite',
      } satisfies TaskRecord['executor'],
      'TASK_COMPOSITE_DISPATCH_UNBOUND',
    ],
  ] as const)(
    'keeps the %s adapter unbound without persisting a task',
    async (_kind, executor, code) => {
      const repoRoot = root();
      await expect(dispatchRoundTask(repoRoot, task(executor))).resolves.toEqual({
        ok: false,
        code,
      });
      expect(() => readFileSync(join(repoRoot, '.devai/state/tasks/TASK-9701.json'))).toThrow();
    },
  );

  it('refuses routine action dispatch before starting or persisting execution', async () => {
    const repoRoot = root();
    const result = await dispatchRoundTask(
      repoRoot,
      task({
        kind: 'routine',
        action_id: 'release publish',
        cwd: '.',
        inputs: [],
        outputs: [],
        effects: ['remote-write'],
        timeout_ms: 60_000,
        authority_checks: ['discipline'],
      }),
    );
    expect(result).toEqual({ ok: false, code: 'TASK_ROUTINE_ACTION_DISPATCH_UNBOUND' });
    expect(() => readFileSync(join(repoRoot, '.devai/state/tasks/TASK-9701.json'))).toThrow();
  });
});
