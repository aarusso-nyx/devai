// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// A downstream resource failure leaves no task-owned lock, worktree, or branch.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, describe, expect, it } from 'vitest';
import { listLocks } from '../../src/loop/locks.js';
import { loadTask, spawnTask, type TaskRecord } from '../../src/loop/tasks.js';
import { listWorktrees } from '../../src/loop/worktrees.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-task-resource-boundary-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=DEVAI Inspector',
      '-c',
      'user.email=aarusso@nyxk.com.br',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'fixture base',
    ],
    { cwd: root },
  );
  const round = join(root, 'work/rounds/R-1234');
  mkdirSync(round, { recursive: true });
  writeFileSync(
    join(round, 'AUTHORIZATION.md'),
    '# Authorization\n\nstatus: active\n\nGRANTED\n',
    'utf8',
  );
  return root;
}

function routineExecutor(): TaskRecord['executor'] {
  return {
    kind: 'routine',
    argv: ['node', 'fixture.mjs'],
    cwd: '.',
    inputs: [],
    outputs: [],
    effects: ['read'],
    timeout_ms: 1_000,
    authority_checks: ['discipline'],
  };
}

function withBoundHostAuthority<T>(callback: () => T): T {
  let ordinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'task-resource-boundary-test',
    issuer_version: '1.0.0',
    invocation_id: 'task-resource-boundary-invocation',
    canonicalSha256: () => 'a'.repeat(64),
    randomId: () => `task-resource-boundary-${String(++ordinal).padStart(8, '0')}`,
    now: () => '2026-08-08T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'task resource boundary acceptance',
    invocation_id: 'task-resource-boundary-invocation',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

describe('task resource boundaries', () => {
  it('rolls back every acquired task resource when downstream DB provisioning fails', () => {
    const root = repository();
    const taskId = 'TASK-8402';
    const result = withBoundHostAuthority(() =>
      spawnTask({
        repoRoot: root,
        task: {
          id: taskId,
          round_id: 'R-1234',
          discipline: 'engineer',
          title: 'Rollback partially created resources',
          target_modules: ['MOD-ROLLBACK'],
          target_substrates: ['F2'],
          db_isolation: 'database',
          executor: routineExecutor(),
        },
        withWorktree: true,
        withDb: true,
        databaseUrl: 'postgresql://nobody@127.0.0.1:1/missing?connect_timeout=1',
      }),
    );

    expect(result).toMatchObject({
      task: { id: taskId, status: 'cancelled' },
      lock_denied: [],
      worktree_path: null,
      database: null,
    });
    expect(result.rollback_reason).toMatch(/^DB provisioning failed:/u);
    expect(loadTask(root, taskId).status).toBe('cancelled');
    expect(listLocks({ locksDir: join(root, '.devai/state/locks') })).toEqual([]);
    expect(listWorktrees({ repoRoot: root })).toEqual([]);
    expect(existsSync(join(root, '.devai/worktrees', `WT-${taskId}`))).toBe(false);
    expect(
      execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter((line) => line.startsWith('worktree ')),
    ).toHaveLength(1);
    expect(
      execFileSync('git', ['branch', '--list', taskId], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
  });
});
