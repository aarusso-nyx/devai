import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterAll, describe, expect, it } from 'vitest';
import { listWorktrees } from '../../src/loop/worktrees.js';
import { startRoundTask } from '../../src/loop/task-services.js';
import { saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const roots: string[] = [];
const ROUND = 'R-0007';

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

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-task-resource-options-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'base\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--quiet',
      '-m',
      'base',
    ],
    { cwd: root },
  );
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'README.md'), 'head\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--quiet',
      '-m',
      'head',
    ],
    { cwd: root },
  );
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(
    join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'),
    '# Authorization\n\nstatus: active\n\nGRANTED\n',
  );
  return { root, base, head };
}

function task(id: string): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status: 'ready',
    discipline: 'engineer',
    title: id,
    target_modules: [],
    target_substrates: ['F2'],
    created_at: '2026-08-08T00:00:00.000Z',
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
  };
}

describe('round task resource option forwarding', () => {
  it('creates a worktree from the explicit baseRef rather than ambient HEAD', async () => {
    const { root, base, head } = repository();
    withBoundHostAuthority(() => {
      saveTask(root, task('TASK-8501'));
      const result = startRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-8501',
        withWorktree: true,
        baseRef: base,
      });

      expect(result).toMatchObject({ task: { id: 'TASK-8501', status: 'ready' } });
      expect(result.worktree_path).toBeTruthy();
      expect(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: result.worktree_path ?? '',
          encoding: 'utf8',
        }).trim(),
      ).toBe(base);
      expect(head).not.toBe(base);
      expect(listWorktrees({ repoRoot: root })).toHaveLength(1);
    });
  });

  it('rolls back the worktree when explicit DB provisioning fails', async () => {
    const { root } = repository();
    withBoundHostAuthority(() => {
      saveTask(root, task('TASK-8502'));
      const result = startRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-8502',
        withWorktree: true,
        withDb: true,
        databaseUrl: 'postgresql://nobody@127.0.0.1:1/missing?connect_timeout=1',
      });

      expect(result).toMatchObject({
        task: { id: 'TASK-8502', status: 'cancelled' },
        worktree_path: null,
        database: null,
      });
      expect(result.rollback_reason).toMatch(/^DB provisioning failed:/u);
      expect(listWorktrees({ repoRoot: root })).toEqual([]);
      expect(
        JSON.parse(readFileSync(join(root, '.devai/state/tasks/TASK-8502.json'), 'utf8')).status,
      ).toBe('cancelled');
    });
  });
});
