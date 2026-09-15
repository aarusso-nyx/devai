import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { finishRoundTask } from '../../src/loop/task-services.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';
import type { HumanExecutorRole } from '../../src/loop/human-executor.js';
const roots: string[] = [];
const NOW = '2026-09-08T12:00:00.000Z';
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-human-finish-'));
  roots.push(root);
  mkdirSync(join(root, 'work/rounds/R-0007'), { recursive: true });
  writeFileSync(join(root, 'work/rounds/R-0007/AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id: 'TASK-9701',
    round_id: 'R-0007',
    status: 'awaiting_human_review',
    discipline: 'inspector',
    title: 'Review exact evidence',
    target_modules: [],
    target_substrates: ['F2'],
    created_at: '2026-09-08T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 2,
    executor: {
      kind: 'human',
      role: 'inspector',
      instructions_ref: 'docs/review.md',
      timeout_ms: 3600000,
      timeout_behavior: 'block',
      completion_evidence: ['EV-review', 'EV-tests'],
    },
    ...overrides,
  };
}
function request(repoRoot: string) {
  return { repoRoot, round: 'R-0007', taskId: 'TASK-9701' };
}
function recordBytes(root: string) {
  return readFileSync(join(root, '.devai/state/tasks/TASK-9701.json'));
}

describe('human completion crosses the real persisted round task boundary', () => {
  it.each(['owner', 'architect', 'inspector', 'engineer', 'auditor'] as HumanExecutorRole[])(
    'retains %s evidence and prior iterations, releasing only the completed task locks',
    async (role) => {
      const root = fixture();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      const prior = {
        iteration: 1,
        started_at: '2026-09-08T09:00:00.000Z',
        ended_at: '2026-09-08T09:30:00.000Z',
        verdict: 'REVIEW' as const,
        evidence_refs: ['EV-prior'],
      };
      const record = task({
        executor: {
          kind: 'human',
          role,
          instructions_ref: 'docs/review.md',
          timeout_ms: 3600000,
          timeout_behavior: 'block',
          completion_evidence: ['EV-review', 'EV-tests'],
        },
        spawned_at: '2026-09-08T10:00:00.000Z',
        iteration_trail: [prior],
      });
      await withAuthorityHostTestScope(() => {
        saveTask(root, record);
        const locks = join(root, '.devai/state/locks');
        mkdirSync(locks, { recursive: true });
        for (const id of ['TASK-9701', 'TASK-9702'])
          writeFileSync(
            join(locks, `${id}.json`),
            JSON.stringify({
              task_id: id,
              substrate: 'F2',
              module: id,
              acquired_at: NOW,
              ttl_ms: 3600000,
            }),
          );
        const other = readFileSync(join(locks, 'TASK-9702.json'));
        const evidence = Object.freeze(['EV-tests', 'EV-extra', 'EV-review']);
        const completed = finishRoundTask({ ...request(root), evidence, completedByRole: role });
        expect(completed).toEqual({
          ...record,
          status: 'completed',
          completed_at: NOW,
          iteration_trail: [
            prior,
            {
              iteration: 2,
              started_at: record.spawned_at,
              ended_at: NOW,
              verdict: 'PASS',
              evidence_refs: evidence,
            },
          ],
        });
        expect(loadTask(root, record.id)).toEqual(completed);
        expect(existsSync(join(locks, 'TASK-9701.json'))).toBe(false);
        expect(readFileSync(join(locks, 'TASK-9702.json'))).toEqual(other);
        expect(evidence).toEqual(['EV-tests', 'EV-extra', 'EV-review']);
      });
    },
  );
  it('uses the completion instant only when no spawned timestamp or prior trail exists', async () => {
    const root = fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await withAuthorityHostTestScope(() => {
      saveTask(root, task());
      const result = finishRoundTask({ ...request(root), evidence: ['EV-review', 'EV-tests'] });
      expect(result.iteration_trail).toEqual([
        {
          iteration: 2,
          started_at: NOW,
          ended_at: NOW,
          verdict: 'PASS',
          evidence_refs: ['EV-review', 'EV-tests'],
        },
      ]);
    });
  });
  it.each([
    undefined,
    [],
    ['EV-review'],
    ['EV-review', 'EV-tests', 'EV-tests'],
    ['EV-review', ' '],
  ])('refuses incomplete or invalid evidence %j without changing the task', async (evidence) => {
    const root = fixture();
    await withAuthorityHostTestScope(() => {
      saveTask(root, task());
      const before = recordBytes(root);
      expect(() => finishRoundTask({ ...request(root), evidence })).toThrow(
        'TASK_HUMAN_EVIDENCE_REQUIRED',
      );
      expect(recordBytes(root)).toEqual(before);
    });
  });
  it('refuses a substituted completing role before any intermediate state is saved', async () => {
    const root = fixture();
    await withAuthorityHostTestScope(() => {
      saveTask(root, task());
      const before = recordBytes(root);
      expect(() =>
        finishRoundTask({
          ...request(root),
          evidence: ['EV-review', 'EV-tests'],
          completedByRole: 'owner',
        }),
      ).toThrow('TASK_HUMAN_ROLE_MISMATCH');
      expect(recordBytes(root)).toEqual(before);
    });
  });
  it.each([
    'queued',
    'ready',
    'in_progress',
    'checkpoint',
    'pre_merge',
    'merging',
    'completed',
    'escalated',
  ] as const)('refuses human completion from %s without rewriting the record', async (status) => {
    const root = fixture();
    await withAuthorityHostTestScope(() => {
      saveTask(root, task({ status }));
      const before = recordBytes(root);
      expect(() =>
        finishRoundTask({ ...request(root), evidence: ['EV-review', 'EV-tests'] }),
      ).toThrow('TASK_LIFECYCLE_TRANSITION_FORBIDDEN');
      expect(recordBytes(root)).toEqual(before);
    });
  });
  it('reports a missing task in the active round without creating state', () => {
    const root = fixture();
    expect(() => finishRoundTask(request(root))).toThrow('TASK_NOT_FOUND');
    expect(existsSync(join(root, '.devai/state/tasks'))).toBe(false);
  });
});
