// Real task/registry files; the database observation is injected, not Docker acceptance.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const database = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('../../src/loop/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/loop/db.js')>()),
  clusterStatus: database.status,
}));
import { roundTaskResourceStatus, roundTaskStatus } from '../../src/loop/task-services.js';
import type { TaskRecord } from '../../src/loop/tasks.js';

const roots: string[] = [];
beforeEach(() => {
  database.status.mockReset();
  database.status.mockReturnValue({
    ok: true,
    container: { name: 'fixture-pg', running: true },
    task_dbs: [
      'devai_task_TASK-9701',
      'devai_task_TASK-9702',
      'devai_task_TASK-9703',
      'devai_task_TASK-97010',
      'prefix_devai_task_TASK-9701',
      'devai_task_UNKNOWN',
    ],
  });
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function write(root: string, path: string, value: unknown): void {
  writeFileSync(join(root, path), JSON.stringify(value) + '\n');
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-resources-'));
  roots.push(root);
  for (const path of ['work/rounds/R-0007', '.devai/state/tasks', '.devai/state/locks'])
    mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'work/rounds/R-0007/AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  for (const [id, round] of [
    ['TASK-9701', 'R-0007'],
    ['TASK-9702', 'R-0007'],
    ['TASK-9703', 'R-0008'],
  ] as const) {
    const record: TaskRecord = {
      schemaVersion: '2.0.0',
      id,
      round_id: round,
      status: 'queued',
      discipline: 'engineer',
      title: id,
      target_modules: [],
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
    };
    write(root, `.devai/state/tasks/${id}.json`, record);
    write(root, `.devai/state/locks/${id}.json`, {
      task_id: id,
      substrate: 'F2',
      module: id,
      acquired_at: record.created_at,
      ttl_ms: 3600000,
    });
  }
  write(root, '.devai/state/worktrees.json', {
    worktrees: [
      ...['TASK-9701', 'TASK-9702', 'TASK-9703', 'TASK-97010'].map((id) => ({
        id: `WT-${id}`,
        path: join(root, id),
        branch: id,
        task_id: id,
        created_at: '2026-09-08T00:00:00.000Z',
      })),
      {
        id: 'WT-human',
        path: join(root, 'human'),
        branch: 'review',
        created_at: '2026-09-08T00:00:00.000Z',
        human_adopted: true,
      },
    ],
  });
  return root;
}

describe('resource visibility is confined to the requested active round and exact task', () => {
  it('returns the complete own-round task population and filters one exact identity', () => {
    const root = fixture();
    expect(roundTaskStatus({ repoRoot: root, round: 'R-0007' })).toMatchObject({
      round_id: 'R-0007',
      count: 2,
      tasks: [{ id: 'TASK-9701' }, { id: 'TASK-9702' }],
    });
    expect(roundTaskStatus({ repoRoot: root, round: 'R-0007', taskId: 'TASK-9702' })).toMatchObject(
      { round_id: 'R-0007', count: 1, tasks: [{ id: 'TASK-9702' }] },
    );
  });
  it.each(['locks', 'worktrees'] as const)(
    'filters %s without changing registry bytes or querying the database',
    (resource) => {
      const root = fixture();
      const before = readFileSync(join(root, '.devai/state/worktrees.json'));
      const all = roundTaskResourceStatus({ repoRoot: root, round: 'R-0007', resource });
      const one = roundTaskResourceStatus({
        repoRoot: root,
        round: 'R-0007',
        taskId: 'TASK-9702',
        resource,
      });
      expect(all).toMatchObject({
        round_id: 'R-0007',
        resource,
        count: 2,
        [resource]: [{ task_id: 'TASK-9701' }, { task_id: 'TASK-9702' }],
      });
      expect(one).toMatchObject({
        round_id: 'R-0007',
        resource,
        count: 1,
        [resource]: [{ task_id: 'TASK-9702' }],
      });
      expect(readFileSync(join(root, '.devai/state/worktrees.json'))).toEqual(before);
      expect(database.status).not.toHaveBeenCalled();
    },
  );
  it('filters exact database names and forwards explicit observation controls', () => {
    const root = fixture();
    const result = roundTaskResourceStatus({
      repoRoot: root,
      round: 'R-0007',
      resource: 'db',
      containerName: 'fixture-pg',
      databaseUrl: 'postgresql://fixture/db',
    });
    expect(result).toEqual({
      ok: true,
      container: { name: 'fixture-pg', running: true },
      round_id: 'R-0007',
      resource: 'db',
      task_dbs: ['devai_task_TASK-9701', 'devai_task_TASK-9702'],
    });
    expect(database.status).toHaveBeenCalledWith({
      containerName: 'fixture-pg',
      databaseUrl: 'postgresql://fixture/db',
    });
    expect(
      roundTaskResourceStatus({
        repoRoot: root,
        round: 'R-0007',
        taskId: 'TASK-9702',
        resource: 'db',
      }),
    ).toMatchObject({ task_dbs: ['devai_task_TASK-9702'] });
    expect(database.status).toHaveBeenLastCalledWith({});
  });
  it('preserves an unavailable database observation as unavailable', () => {
    const root = fixture();
    database.status.mockReturnValue({
      ok: false,
      container: { name: 'fixture-pg', running: false },
      task_dbs: [],
      error: 'fixture unavailable',
    });
    expect(roundTaskResourceStatus({ repoRoot: root, round: 'R-0007', resource: 'db' })).toEqual({
      ok: false,
      container: { name: 'fixture-pg', running: false },
      task_dbs: [],
      error: 'fixture unavailable',
      round_id: 'R-0007',
      resource: 'db',
    });
  });
  for (const resource of ['locks', 'worktrees', 'db'] as const) {
    it.each(['missing-round', 'inactive', 'closed', 'missing-task', 'other-round-task'] as const)(
      `refuses ${resource} for %s before resource access`,
      (invalid) => {
        const root = fixture();
        writeFileSync(join(root, '.devai/state/worktrees.json'), '{invalid registry');
        let round: string | undefined = 'R-0007';
        let taskId: string | undefined;
        let code = 'TASK_NOT_FOUND';
        if (invalid === 'missing-round') {
          round = undefined;
          code = 'TASK_ROUND_REQUIRED';
        }
        if (invalid === 'inactive') {
          writeFileSync(
            join(root, 'work/rounds/R-0007/AUTHORIZATION.md'),
            'status: inactive\nGRANTED\n',
          );
          code = 'TASK_ROUND_INACTIVE';
        }
        if (invalid === 'closed') {
          writeFileSync(join(root, 'work/rounds/R-0007/close-state.jsonl'), '{}\n');
          code = 'TASK_ROUND_INACTIVE';
        }
        if (invalid === 'missing-task') taskId = 'TASK-9799';
        if (invalid === 'other-round-task') taskId = 'TASK-9703';
        expect(() => roundTaskResourceStatus({ repoRoot: root, round, taskId, resource })).toThrow(
          code,
        );
        expect(database.status).not.toHaveBeenCalled();
      },
    );
  }
});
