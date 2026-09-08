// Round queue behavior uses real temporary files and the explicit authority test boundary.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { backlogPath } from '../../src/loop/backlog.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';
import {
  addRoundQueueEntry,
  completeRoundQueueEntry,
  listRoundQueue,
  materializeRoundQueueTask,
  nextRoundQueueEntry,
  requireActiveTaskRound,
  roundTaskStatus,
} from '../../src/loop/task-services.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-queue-boundaries-'));
  roots.push(root);
  for (const round of ['R-0007', 'R-0008']) {
    const dir = join(root, 'work/rounds', round);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'AUTHORIZATION.md'), '# Authorization\nstatus: active\nGRANTED\n');
  }
  return root;
}
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id: 'TASK-9701',
    round_id: 'R-0007',
    status: 'queued',
    discipline: 'engineer',
    title: 'Retain task identity',
    priority: 70,
    description: 'Approved scope',
    target_modules: ['MOD-QUEUE'],
    target_substrates: ['F2'],
    created_at: '2026-09-08T00:00:00.000Z',
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

describe('round-specific queue selection', () => {
  it('selects an own-round legacy queued entry even when another round owns the global first task', () => {
    const root = repository();
    mkdirSync(join(root, '.devai/state'), { recursive: true });
    const entries = [
      {
        id: 'TASK-9700',
        round_id: 'R-0008',
        title: 'Other round',
        priority: 100,
        status: 'queued',
        created_at: '2026-09-08T00:00:00.000Z',
      },
      {
        id: 'TASK-9701',
        round_id: 'R-0007',
        title: 'Legacy own round',
        priority: 90,
        created_at: '2026-09-08T00:00:01.000Z',
      },
      {
        id: 'TASK-9702',
        round_id: 'R-0007',
        title: 'Newer own round',
        priority: 50,
        status: 'queued',
        created_at: '2026-09-08T00:00:02.000Z',
      },
    ];
    writeFileSync(
      backlogPath(root),
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    );
    const before = readFileSync(backlogPath(root));
    expect(nextRoundQueueEntry({ repoRoot: root, round: 'R-0007' })?.id).toBe('TASK-9701');
    expect(readFileSync(backlogPath(root))).toEqual(before);
  });

  it('returns null when only another round has queued work', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() =>
      addRoundQueueEntry({ repoRoot: root, round: 'R-0008', title: 'Other round', priority: 99 }),
    );
    expect(nextRoundQueueEntry({ repoRoot: root, round: 'R-0007' })).toBeNull();
    expect(listRoundQueue({ repoRoot: root, round: 'R-0007' })).toEqual([]);
  });

  it('cannot complete another round task and preserves the queue bytes on refusal', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      const other = addRoundQueueEntry({ repoRoot: root, round: 'R-0008', title: 'Other round' });
      const before = readFileSync(backlogPath(root));
      expect(() =>
        completeRoundQueueEntry({ repoRoot: root, round: 'R-0007', taskId: other.id }),
      ).toThrow('TASK_ROUND_MISMATCH');
      expect(readFileSync(backlogPath(root))).toEqual(before);
    });
  });

  it.each(['missing', 'inactive', 'ungranted', 'closed'] as const)(
    'rejects a %s round before a queue write',
    (state) => {
      const root = repository();
      const round = join(root, 'work/rounds/R-0007');
      if (state === 'missing') rmSync(join(round, 'AUTHORIZATION.md'));
      if (state === 'inactive')
        writeFileSync(join(round, 'AUTHORIZATION.md'), 'status: inactive\nGRANTED\n');
      if (state === 'ungranted')
        writeFileSync(join(round, 'AUTHORIZATION.md'), 'status: active\nPENDING\n');
      if (state === 'closed') writeFileSync(join(round, 'close-state.jsonl'), '{}\n');
      expect(() => requireActiveTaskRound({ repoRoot: root, round: 'R-0007' })).toThrow(
        'TASK_ROUND_INACTIVE',
      );
      expect(() =>
        addRoundQueueEntry({ repoRoot: root, round: 'R-0007', title: 'Must not append' }),
      ).toThrow('TASK_ROUND_INACTIVE');
    },
  );
});

describe('queue materialization preserves immutable declaration data', () => {
  const changes: ReadonlyArray<readonly [string, Partial<TaskRecord>]> = [
    ['title', { title: 'Different title' }],
    ['priority', { priority: 71 }],
    ['description', { description: 'Different scope' }],
    ['creation time', { created_at: '2026-09-09T00:00:00.000Z' }],
  ];
  it.each(changes)(
    'refuses changed %s without altering the queue or task',
    async (_field, change) => {
      const root = repository();
      await withAuthorityHostTestScope(() => {
        const declared = task();
        materializeRoundQueueTask({ repoRoot: root, round: 'R-0007', task: declared });
        const before = readFileSync(backlogPath(root));
        expect(() =>
          materializeRoundQueueTask({
            repoRoot: root,
            round: 'R-0007',
            task: { ...declared, ...change },
          }),
        ).toThrow('TASK_QUEUE_MATERIALIZATION_CONFLICT');
        expect(readFileSync(backlogPath(root))).toEqual(before);
        expect(loadTask(root, declared.id)).toEqual(declared);
      });
    },
  );

  it('is a no-write result when both task and enriched queue entry already match', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      const declared = task({
        lifecycle: 'supported',
        acceptance_commands: [['node', '--version']],
      });
      const first = materializeRoundQueueTask({ repoRoot: root, round: 'R-0007', task: declared });
      const before = readFileSync(backlogPath(root));
      const repeated = materializeRoundQueueTask({
        repoRoot: root,
        round: 'R-0007',
        task: structuredClone(declared),
      });
      expect(repeated).toEqual(first);
      expect(readFileSync(backlogPath(root))).toEqual(before);
      expect(first.entry).toMatchObject({
        discipline: declared.discipline,
        target_modules: declared.target_modules,
        target_substrates: declared.target_substrates,
        db_isolation: declared.db_isolation,
        lifecycle: 'supported',
        acceptance_commands: [['node', '--version']],
      });
    });
  });

  it('refuses an existing task with a different executor even when the queue identity matches', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      const declared = task();
      materializeRoundQueueTask({ repoRoot: root, round: 'R-0007', task: declared });
      const altered = {
        ...declared,
        executor: { ...declared.executor, timeout_ms: 2000 },
      } as TaskRecord;
      saveTask(root, altered);
      const before = readFileSync(backlogPath(root));
      expect(() =>
        materializeRoundQueueTask({ repoRoot: root, round: 'R-0007', task: declared }),
      ).toThrow('TASK_RECORD_CONFLICT');
      expect(loadTask(root, declared.id)).toEqual(altered);
      expect(readFileSync(backlogPath(root))).toEqual(before);
    });
  });

  it.each(['ready', 'completed'] as const)(
    'refuses materialization in %s state',
    async (status) => {
      const root = repository();
      await withAuthorityHostTestScope(() => {
        expect(() =>
          materializeRoundQueueTask({ repoRoot: root, round: 'R-0007', task: task({ status }) }),
        ).toThrow('TASK_QUEUE_STATUS_INVALID');
        expect(listRoundQueue({ repoRoot: root, round: 'R-0007' })).toEqual([]);
      });
    },
  );

  it('keeps task status and task-id selection subordinate to the requested round', async () => {
    const root = repository();
    await withAuthorityHostTestScope(() => {
      saveTask(root, task());
      saveTask(root, task({ id: 'TASK-9702', round_id: 'R-0008' }));
      expect(roundTaskStatus({ repoRoot: root, round: 'R-0007' })).toEqual({
        round_id: 'R-0007',
        count: 1,
        tasks: [task()],
      });
      expect(() =>
        roundTaskStatus({ repoRoot: root, round: 'R-0007', taskId: 'TASK-9702' }),
      ).toThrow('TASK_NOT_FOUND');
    });
  });
});
