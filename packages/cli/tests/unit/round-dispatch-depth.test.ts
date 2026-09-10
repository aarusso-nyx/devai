import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function initializeRepository(repoRoot: string): Readonly<{ commit: string }> {
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'input.txt'), 'managed input\n');
  execFileSync('git', ['add', 'input.txt'], { cwd: repoRoot });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=devai-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: repoRoot },
  );
  return {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  };
}

const ROUTINE_ARGV = [process.execPath, '-e', 'process.exit(0)'] as const;

function routineTask(worktreeId?: string): TaskRecord {
  return {
    ...task({
      kind: 'routine',
      argv: [...ROUTINE_ARGV],
      cwd: '.',
      inputs: ['input.txt'],
      outputs: [],
      effects: ['read'],
      timeout_ms: 60_000,
      authority_checks: ['discipline'],
    }),
    ...(worktreeId === undefined ? {} : { worktree_id: worktreeId }),
  };
}

function writeWorktreeRegistry(
  repoRoot: string,
  records: readonly Readonly<{
    id: string;
    path: string;
    task_id: string;
  }>[],
): void {
  mkdirSync(join(repoRoot, '.devai/state'), { recursive: true });
  writeFileSync(
    join(repoRoot, '.devai/state/worktrees.json'),
    `${JSON.stringify({
      worktrees: records.map((record) => ({
        ...record,
        branch: record.id,
        created_at: '2026-09-09T00:00:00.000Z',
      })),
    })}\n`,
  );
}

describe('round task dispatch adapter boundaries', () => {
  it.each([
    ['repository root', false],
    ['registered managed worktree', true],
  ] as const)(
    'executes a literal routine from the exact %s and records its candidate identity',
    async (_label, managed) => {
      const repoRoot = root();
      const executionRoot = managed ? join(repoRoot, '.devai/worktrees/WT-TASK-9701') : repoRoot;
      const expected = initializeRepository(executionRoot);
      if (managed) {
        writeWorktreeRegistry(repoRoot, [
          {
            id: 'WT-TASK-9701',
            path: executionRoot,
            task_id: 'TASK-9701',
          },
        ]);
      }

      const result = await withAuthorityHostTestScope(() =>
        dispatchRoundTask(repoRoot, routineTask(managed ? 'WT-TASK-9701' : undefined)),
      );

      expect(result).toMatchObject({ ok: true });
      const evidenceRoot = join(repoRoot, '.devai/state/round-runs/R-9701/task-executions');
      const evidenceFiles = readdirSync(evidenceRoot);
      expect(evidenceFiles).toHaveLength(1);
      const evidence = JSON.parse(
        readFileSync(join(evidenceRoot, evidenceFiles[0] ?? ''), 'utf8'),
      ) as {
        candidate_sha: string;
        resolved_executor: { cwd: string; argv: string[] };
        input_digests: Array<{ id: string; digest_sha256: string }>;
      };
      expect(evidence).toMatchObject({
        candidate_sha: expected.commit,
        resolved_executor: { cwd: '.', argv: [...ROUTINE_ARGV] },
        input_digests: [
          {
            id: 'input.txt',
            digest_sha256: '58afcc1b90477cc362db5750419f3e2f987da770c119b3c94f5480a4294303d0',
          },
        ],
      });
      expect(
        JSON.parse(readFileSync(join(repoRoot, '.devai/state/tasks/TASK-9701.json'), 'utf8')),
      ).toMatchObject({ status: 'merging' });
    },
  );

  it.each([
    [
      'different task owner',
      join('.devai', 'worktrees', 'WT-TASK-9701'),
      { id: 'WT-TASK-9701', task_id: 'TASK-OTHER' },
      'TASK_WORKTREE_REGISTRY_MISMATCH',
    ],
    [
      'different worktree id',
      join('.devai', 'worktrees', 'WT-OTHER'),
      { id: 'WT-OTHER', task_id: 'TASK-9701' },
      'TASK_WORKTREE_REGISTRY_MISMATCH',
    ],
    [
      'managed-root parent',
      '.devai',
      { id: 'WT-TASK-9701', task_id: 'TASK-9701' },
      'TASK_WORKTREE_PATH_ESCAPE',
    ],
    [
      'managed-root sibling',
      join('.devai', 'outside'),
      { id: 'WT-TASK-9701', task_id: 'TASK-9701' },
      'TASK_WORKTREE_PATH_ESCAPE',
    ],
  ] as const)(
    'refuses a registered worktree with %s before invoking its routine',
    async (_label, relativePath, record, code) => {
      const repoRoot = root();
      const path = join(repoRoot, relativePath);
      mkdirSync(path, { recursive: true });
      writeWorktreeRegistry(repoRoot, [{ ...record, path }]);

      await expect(
        withAuthorityHostTestScope(() => dispatchRoundTask(repoRoot, routineTask('WT-TASK-9701'))),
      ).rejects.toThrow(code);
    },
  );

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
