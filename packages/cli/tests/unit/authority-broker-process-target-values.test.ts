// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { processTarget } from '../../src/authority/broker.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REPOSITORY = 'devai-test';

function request(executable: string, args: readonly string[]): AuthorityHostEffectRequest {
  return { kind: 'process', symbol: 'spawnSync', arguments: [executable, args] };
}

function target(
  action: string,
  executable: string,
  args: readonly string[],
  invocationArgv: readonly string[] = [],
): Record<string, unknown> | undefined {
  return processTarget(request(executable, args), action, ROOT, REPOSITORY, invocationArgv);
}

describe('authority broker process target values', () => {
  it.each([
    ['CREATE TABLE x()', 'ddl'],
    ['DROP TABLE x', 'ddl'],
    ['ALTER TABLE x ADD COLUMN y int', 'ddl'],
    ['TRUNCATE x', 'ddl'],
    ['INSERT INTO x VALUES (1)', 'insert'],
    ['UPDATE x SET a=1', 'update'],
    ['DELETE FROM x', 'delete'],
    ['SELECT 1', 'execute'],
  ] as const)('classifies SQL %s as %s', (sql, operation) => {
    expect(target('task start', 'psql', ['postgres://host/db-name', '-c', sql])).toEqual({
      kind: 'db',
      id: 'db:devai-control:db-name:task-start',
      connection_id: 'devai-control',
      database_id: 'db-name',
      object_id: 'task-start',
      operation,
    });
  });

  it('uses closed database and action fallbacks for malformed SQL input', () => {
    expect(target('task start', 'psql', ['not-a-url', 'SELECT 1'])).toEqual({
      kind: 'db',
      id: 'db:devai-control:postgres:task-start',
      connection_id: 'devai-control',
      database_id: 'postgres',
      object_id: 'task-start',
      operation: 'execute',
    });
  });

  it.each([
    [['run', '--name', 'fixture-db'], 'fixture-db'],
    [['run'], 'devai-shared-pg'],
    [['start', 'fixture-db'], 'fixture-db'],
    [['stop', 'fixture-db'], 'fixture-db'],
  ] as const)('binds Docker %j to database cluster %s', (args, container) => {
    expect(target('task start', 'docker', args)).toEqual({
      kind: 'db',
      id: `db:devai-control:cluster:${container}`,
      connection_id: 'devai-control',
      database_id: 'cluster',
      object_id: container,
      operation: 'execute',
    });
  });

  it.each([
    ['docker', ['run', '--rm', 'fixture']],
    ['sandbox-exec', ['-p', '(version 1)', 'node']],
  ] as const)('binds check sandbox process %s to the worktree namespace', (executable, args) => {
    expect(target('check', executable, args)).toEqual({
      kind: 'fs',
      id: 'fs:.devai/worktrees',
      repository_id: REPOSITORY,
      canonical_relative_path: '.devai/worktrees',
      operation: 'update',
    });
  });

  it('normalizes fetched remote and branch names into an unprotected ref target', () => {
    expect(target('init bind', 'git', ['fetch', 'upstream remote!', 'branch/name'])).toEqual({
      kind: 'git-ref',
      id: 'git-ref:devai-test:refs/remotes/upstream-remote/branch-name',
      repository_id: REPOSITORY,
      ref: 'refs/remotes/upstream-remote/branch-name',
      remote_id: 'upstream-remote',
      operation: 'update',
      protected: false,
    });
  });

  it.each([
    [['checkout', '--orphan', 'new branch'], 'refs/heads/new-branch', 'create'],
    [['branch', '-D', 'old branch'], 'refs/heads/old-branch', 'delete'],
    [['worktree', 'add', '-b', 'topic branch', '/tmp/wt'], 'refs/worktrees/topic-branch', 'create'],
    [['worktree', 'remove', '/tmp/wt'], 'refs/worktrees/detached', 'delete'],
    [['add', 'packages/cli/src/bin.ts'], 'refs/devai/index', 'update'],
    [['rm', 'packages/cli/src/bin.ts'], 'refs/devai/index', 'update'],
    [['commit', '-m', 'fixture'], 'refs/heads/HEAD', 'update'],
  ] as const)('classifies Git %j as %s %s', (args, ref, operation) => {
    expect(target('round run', 'git', args)).toMatchObject({
      kind: 'git-ref',
      repository_id: REPOSITORY,
      ref,
      operation,
      protected: false,
    });
  });

  it('classifies an exact Git move as a repository-local rename', () => {
    expect(target('round run', 'git', ['mv', 'scratch/a', 'scratch/b'])).toEqual({
      kind: 'fs',
      id: 'fs:scratch/a->scratch/b',
      repository_id: REPOSITORY,
      canonical_relative_path: 'scratch/b',
      rename_from_canonical_relative_path: 'scratch/a',
      operation: 'rename',
    });
  });

  it('classifies GitHub pull-request creation as publication', () => {
    expect(target('task start', 'gh', ['pr', 'create', '--draft'])).toEqual({
      kind: 'remote',
      id: 'remote:github:pull-requests',
      system_id: 'github',
      endpoint_id: 'pull-requests',
      operation_id: 'create',
      publication: true,
    });
  });

  it('binds only the exact evidence test command to the local runner', () => {
    const argv = ['devai', 'evidence', 'record', '--kind', 'test', '--cmd', 'pnpm test'];
    expect(target('evidence record', 'sh', ['-c', 'pnpm test'], argv)).toEqual({
      kind: 'remote',
      id: 'remote:local-command:test-runner',
      system_id: 'local-command',
      endpoint_id: 'test-runner',
      operation_id: 'invoke',
      publication: false,
    });
    expect(target('evidence record', 'sh', ['-c', 'pnpm other'], argv)).toBeUndefined();
  });

  it.each(['claude', 'codex'] as const)('classifies %s only for sense execution', (executable) => {
    expect(target('sense run', executable, ['exec', 'fixture'])).toEqual({
      kind: 'remote',
      id: `remote:local-llm:${executable}`,
      system_id: 'local-llm',
      endpoint_id: executable,
      operation_id: 'invoke',
      publication: false,
    });
    expect(target('round run', executable, ['exec', 'fixture'])).toBeUndefined();
  });
});
