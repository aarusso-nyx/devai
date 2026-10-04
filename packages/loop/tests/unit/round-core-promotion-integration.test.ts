// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020.
// The real existing routine adapter is exercised only against owned temporary repositories.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchRoundTask } from '../../../cli/src/commands/round/dispatch.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runRoundTasks } from '../../src/loop/round-runner.js';
import { finishRoundTask } from '../../src/loop/task-services.js';
import { loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';

const ROUND = 'R-0007';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-core-promotion-integration-'));
  roots.push(root);
  const authorization = join(root, 'work/rounds', ROUND);
  mkdirSync(authorization, { recursive: true });
  writeFileSync(join(authorization, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  writeFileSync(join(root, 'input.txt'), 'owned fixture input\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', 'input.txt'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=DEVAI Inspector',
      '-c',
      'user.email=inspector@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: root },
  );
  return root;
}

function task(id: string, upstream?: string): TaskRecord {
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
      argv: [process.execPath, '-e', 'process.exit(0)'],
      cwd: '.',
      inputs: ['input.txt'],
      outputs: [],
      effects: ['read'],
      timeout_ms: 10_000,
      authority_checks: ['discipline'],
    },
    ...(upstream !== undefined && { upstream_task_id: upstream }),
  };
}

function receipts(root: string): readonly {
  id: string;
  task_id: string;
  candidate_sha: string;
  verdict: string;
  resolved_executor: { argv: string[] };
}[] {
  const directory = join(root, '.devai/state/round-runs', ROUND, 'task-executions');
  return readdirSync(directory)
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')));
}

describe('bounded core promotion real routine integration', () => {
  it('records a routine verification but blocks its dependent until explicit completion', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      const upstream = task('TASK-8201');
      const dependent = task('TASK-8202', upstream.id);
      saveTask(root, upstream);
      saveTask(root, dependent);
      const originalDependent = readFileSync(
        join(root, '.devai/state/tasks', `${dependent.id}.json`),
        'utf8',
      );
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        taskIds: [dependent.id],
        dispatch: (value) => dispatchRoundTask(root, value),
      });
      expect(result.results).toEqual([
        { task_id: upstream.id, ok: true, evidence_id: expect.stringMatching(/^TXE-/u) },
        { task_id: dependent.id, ok: false, code: 'TASK_DEPENDENCY_NOT_COMPLETED' },
      ]);
      expect(loadTask(root, upstream.id).status).toBe('merging');
      expect(readFileSync(join(root, '.devai/state/tasks', `${dependent.id}.json`), 'utf8')).toBe(
        originalDependent,
      );
      expect(receipts(root)).toHaveLength(1);
      expect(receipts(root)[0]).toMatchObject({
        task_id: upstream.id,
        verdict: 'pass',
        candidate_sha: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
      });
    });
  });

  it('executes both declared routines only when the caller explicitly completes each verified task', async () => {
    const root = repository();
    const originalCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    await withAuthorityHostTestScope(async () => {
      const upstream = task('TASK-8201');
      const dependent = task('TASK-8202', upstream.id);
      saveTask(root, upstream);
      saveTask(root, dependent);
      const result = await runRoundTasks({
        repoRoot: root,
        round: ROUND,
        taskIds: [dependent.id],
        dispatch: async (value) => {
          const verified = await dispatchRoundTask(root, value);
          expect(loadTask(root, value.id).status).toBe('merging');
          if (verified.ok) finishRoundTask({ repoRoot: root, round: ROUND, taskId: value.id });
          return verified;
        },
      });
      expect(result.ok).toBe(true);
      expect(result.ordered_task_ids).toEqual([upstream.id, dependent.id]);
      expect(
        result.results.every((entry) => entry.ok && /^TXE-/u.test(entry.evidence_id ?? '')),
      ).toBe(true);
      expect(loadTask(root, upstream.id).status).toBe('completed');
      expect(loadTask(root, dependent.id).status).toBe('completed');
      const evidence = receipts(root);
      expect(evidence).toHaveLength(2);
      expect(evidence.map((receipt) => receipt.task_id).sort()).toEqual([
        upstream.id,
        dependent.id,
      ]);
      for (const receipt of evidence)
        expect(receipt).toMatchObject({
          verdict: 'pass',
          candidate_sha: originalCommit,
          resolved_executor: { argv: [process.execPath, '-e', 'process.exit(0)'] },
        });
      expect(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      ).toBe(originalCommit);
    });
  });
});
