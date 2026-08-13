import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matchDeclaredRoundTaskProcess } from '../../src/services/round-run/authority-process.js';

const roots: string[] = [];

function fixture(status = 'in_progress', worktreeId?: string) {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-process-'));
  roots.push(root);
  mkdirSync(join(root, '.devai/state/tasks'), { recursive: true });
  const task = {
    schemaVersion: '2.0.0',
    id: 'TASK-7001',
    round_id: 'R-0007',
    status,
    discipline: 'engineer',
    title: 'Exact routine',
    target_modules: [],
    target_substrates: ['F2'],
    created_at: '2026-08-13T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 1,
    ...(worktreeId === undefined ? {} : { worktree_id: worktreeId }),
    executor: {
      kind: 'routine',
      argv: ['pnpm', 'run', 'verify'],
      cwd: '.',
      inputs: [],
      outputs: [],
      effects: ['read'],
      timeout_ms: 12_000,
    },
  };
  writeFileSync(
    join(root, '.devai/state/tasks/TASK-7001.json'),
    `${JSON.stringify(task, null, 2)}\n`,
  );
  return root;
}

function request(cwd: string, overrides: Partial<AuthorityHostEffectRequest> = {}) {
  return {
    kind: 'process',
    symbol: 'spawnSync',
    arguments: ['pnpm', ['run', 'verify'], { cwd, shell: false, timeout: 12_000 }],
    ...overrides,
  } as AuthorityHostEffectRequest;
}

const invocation = [
  process.execPath,
  'devai',
  'round',
  'run',
  '--round',
  'R-0007',
  '--task',
  'TASK-7001',
  '--as-role',
  'engineer',
  '--write',
];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('round-run authority process matching', () => {
  it('matches only the exact selected in-progress routine process', () => {
    const root = fixture();
    expect(matchDeclaredRoundTaskProcess(root, invocation, request(root))).toEqual({
      taskId: 'TASK-7001',
      cwd: realpathSync(root),
    });
    expect(
      matchDeclaredRoundTaskProcess(
        root,
        invocation,
        request(root, {
          arguments: ['pnpm', ['run', 'different'], { cwd: root, shell: false, timeout: 12_000 }],
        }),
      ),
    ).toBeUndefined();
    expect(
      matchDeclaredRoundTaskProcess(root, invocation, request(root, { symbol: 'execFileSync' })),
    ).toBeUndefined();
    expect(
      matchDeclaredRoundTaskProcess(root, invocation.with(7, 'TASK-9999'), request(root)),
    ).toBeUndefined();
  });

  it('rejects non-running tasks and process option drift', () => {
    const root = fixture('ready');
    expect(matchDeclaredRoundTaskProcess(root, invocation, request(root))).toBeUndefined();
    expect(
      matchDeclaredRoundTaskProcess(
        root,
        invocation,
        request(root, {
          arguments: ['pnpm', ['run', 'verify'], { cwd: root, shell: true, timeout: 12_000 }],
        }),
      ),
    ).toBeUndefined();
  });

  it('binds managed routines to the registered contained worktree', () => {
    const root = fixture('in_progress', 'WT-TASK-7001');
    const worktree = join(root, '.devai/worktrees/WT-TASK-7001');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(
      join(root, '.devai/state/worktrees.json'),
      `${JSON.stringify({
        worktrees: [
          {
            id: 'WT-TASK-7001',
            path: worktree,
            branch: 'TASK-7001',
            task_id: 'TASK-7001',
            created_at: '2026-08-13T00:00:00.000Z',
          },
        ],
      })}\n`,
    );
    expect(matchDeclaredRoundTaskProcess(root, invocation, request(worktree))).toEqual({
      taskId: 'TASK-7001',
      cwd: realpathSync(worktree),
    });
    expect(matchDeclaredRoundTaskProcess(root, invocation, request(root))).toBeUndefined();
  });
});
