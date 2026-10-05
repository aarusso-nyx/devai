// ADR-MDL-0007 end to end against a scripted fake provider, through the real round
// runner, worktrees, journal and governed spawn: the agent completion path (ratify,
// human merge, task finish), recorded human dispositions after a crash, journal
// quarantine, capacity for every policy worker plus retained reviews, and the engine
// hardening of the independent review. No live provider.
import {
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import {
  EXPERIMENTAL_RUNTIME_EFFORTS,
  WORKTREE_CAP,
  appendDispatchJournalEvent,
  assertNoUncertainDispatch,
  checkExperimentalActivation,
  disposeDispatchTask,
  finishRoundTask,
  holdsWorktreeCapacity,
  listDispatchDispositions,
  listLocks,
  listTasks,
  listWorktrees,
  loadTask,
  quarantineRoundDispatchJournal,
  ratifyRoundTask,
  readDispatchJournal,
  runRoundTasks,
  saveTask,
  startRoundTask,
  type ExperimentalActivation,
  type TaskRecord,
} from '@devai-nyx/loop';
import { composeAgentPrompt } from '@devai-nyx/skills';
import {
  attemptSpend,
  dispatchExperimentalTask,
  experimentalTaskRefusal,
  type ExperimentalBudget,
} from '../../src/services/experimental-dispatch/index.js';

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'experimental-recovery-provider.mjs');
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ROUND = 'R-0012';
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) Reflect.deleteProperty(process.env, name);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-experimental-recovery-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, '.gitignore'), '.devai/\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Fixture adopter\n');
  mkdirSync(join(root, 'packages/app/src'), { recursive: true });
  writeFileSync(join(root, 'packages/app/src/index.ts'), 'export const x = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

function activation(overrides: Partial<ExperimentalActivation> = {}): ExperimentalActivation {
  return {
    schemaVersion: '1.0.0',
    id: 'experimental-activation',
    authority: 'Owner',
    issued_at: '2026-10-04T00:00:00.000Z',
    expires_at: '2026-10-18T00:00:00.000Z',
    runtimes: [{ runtime: 'claude-cli', models: ['sonnet', 'opus'], efforts: ['high'] }],
    disciplines: ['engineer', 'inspector'],
    budgets: {
      attempts_per_task: 4,
      attempts_per_invocation: 32,
      attempt_wall_clock_minutes: 1,
      tokens_per_invocation: 1_000_000,
    },
    ...overrides,
  };
}

function agentTask(root: string, id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const draft = {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status: 'ready',
    discipline: 'engineer',
    title: `Implement ${id}`,
    target_modules: [`MOD-${id}`],
    target_substrates: ['F2'],
    created_at: '2026-10-04T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'agent',
      runtime: 'claude-cli',
      model: 'sonnet',
      effort: 'high',
      selection: { mode: 'exact', registry_id: 'claude-cli' },
      prompt_composition_id: 'PC-0000000000000000',
      max_iterations: 4,
      capabilities: ['repository-context'],
    },
    ...overrides,
  } as TaskRecord;
  const id16 = composeAgentPrompt({ repoRoot: root, task: draft }).composition.id;
  return { ...draft, executor: { ...draft.executor, prompt_composition_id: id16 } } as TaskRecord;
}

async function permissive<T>(
  run: () => Promise<T> | T,
  record?: AuthorityHostEffectRequest[],
): Promise<T> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'experimental-recovery' });
  const scope: AuthorityHostEffectScope = {
    action_id: 'round dispatch',
    invocation_id: 'experimental-recovery',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      record?.push(request);
      return apply();
    },
  };
  try {
    return await runWithAuthorityHostEffects(scope, async () => run());
  } finally {
    issuer.dispose();
  }
}

async function seed(root: string, ...tasks: TaskRecord[]): Promise<void> {
  await permissive(() => {
    for (const task of tasks) saveTask(root, task);
  });
}

async function dispatch(
  root: string,
  options: {
    readonly scenario?: string;
    readonly activation?: ExperimentalActivation;
    readonly env?: Record<string, string>;
    readonly taskIds?: readonly string[];
    readonly workers?: number;
    readonly record?: AuthorityHostEffectRequest[];
    readonly beforeSpawn?: () => void;
  } = {},
) {
  const budget: ExperimentalBudget = { attempts: 0, tokens: 0, unverifiable: false };
  const result = await permissive(
    () =>
      runRoundTasks({
        repoRoot: root,
        round: ROUND,
        ...(options.taskIds !== undefined && { taskIds: options.taskIds }),
        ...(options.workers !== undefined && { maxWorkers: options.workers }),
        dispatch: (task) =>
          dispatchExperimentalTask(
            {
              repoRoot: root,
              roundId: ROUND,
              activation: options.activation ?? activation(),
              budget,
              env: { ...process.env, ...options.env },
              invocation: (selection) => {
                options.beforeSpawn?.();
                return {
                  runtime: selection.runtime,
                  command: process.execPath,
                  args: [FAKE, options.scenario ?? 'writes'],
                };
              },
            },
            task,
          ),
      }),
    options.record,
  );
  return { result, budget };
}

function worktreePath(root: string, id: string): string {
  return join(root, '.devai/worktrees', id);
}

describe('agent completion path (gap 1)', () => {
  it('completes an accepted agent task through task finish with merge evidence and releases its worktree', async () => {
    const root = repository();
    await seed(root, agentTask(root, 'TASK-0201'));
    await dispatch(root);
    expect(loadTask(root, 'TASK-0201')).toMatchObject({
      status: 'awaiting_human_review',
      worktree_id: 'WT-TASK-0201-A1',
    });
    await permissive(() => {
      // Before ratification an agent task cannot be finished.
      expect(() => finishRoundTask({ repoRoot: root, round: ROUND, taskId: 'TASK-0201' })).toThrow(
        'TASK_LIFECYCLE_TRANSITION_FORBIDDEN',
      );
      ratifyRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-0201',
        decision: 'accept',
        role: 'owner',
      });
      expect(loadTask(root, 'TASK-0201').status).toBe('pre_merge');
      // Merge stays a human act; completion needs its evidence.
      expect(() => finishRoundTask({ repoRoot: root, round: ROUND, taskId: 'TASK-0201' })).toThrow(
        'TASK_MERGE_EVIDENCE_REQUIRED',
      );
      expect(() =>
        finishRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0201',
          evidence: ['merged-by-hand'],
        }),
      ).toThrow('TASK_MERGE_EVIDENCE_REQUIRED');
      const completed = finishRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-0201',
        evidence: ['EV-0123456789abcdef'],
      });
      expect(completed.status).toBe('completed');
    });
    const task = loadTask(root, 'TASK-0201');
    expect(task.worktree_id).toBeUndefined();
    expect(task.iteration_trail?.at(-1)).toMatchObject({
      verdict: 'PASS',
      evidence_refs: ['EV-0123456789abcdef'],
    });
    expect(existsSync(worktreePath(root, 'WT-TASK-0201-A1'))).toBe(false);
    expect(listWorktrees({ repoRoot: root })).toEqual([]);
    const completion = JSON.parse(
      readFileSync(
        join(root, '.devai/state/round-runs', ROUND, 'completions', 'TASK-0201.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(completion).toMatchObject({
      task_id: 'TASK-0201',
      merge_evidence_refs: ['EV-0123456789abcdef'],
      released_worktrees: ['WT-TASK-0201-A1'],
      ratification: {
        path: `.devai/state/round-runs/${ROUND}/ratifications/TASK-0201.json`,
      },
    });
  });

  it('refuses completion without an accepted ratification and escalates a rejected attempt, releasing it', async () => {
    const root = repository();
    await seed(root, agentTask(root, 'TASK-0202'), agentTask(root, 'TASK-0203'));
    await dispatch(root);
    await permissive(() => {
      // A pre_merge agent task with no ratification record cannot complete.
      saveTask(root, { ...loadTask(root, 'TASK-0203'), status: 'pre_merge' });
      expect(() =>
        finishRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0203',
          evidence: ['EV-0123456789abcdef'],
        }),
      ).toThrow('TASK_RATIFICATION_REQUIRED');
      ratifyRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-0202',
        decision: 'reject',
        role: 'architect',
      });
    });
    expect(loadTask(root, 'TASK-0202')).toMatchObject({ status: 'escalated' });
    expect(loadTask(root, 'TASK-0202').worktree_id).toBeUndefined();
    expect(existsSync(worktreePath(root, 'WT-TASK-0202-A1'))).toBe(false);
    expect(listWorktrees({ repoRoot: root }).map((worktree) => worktree.id)).toEqual([
      'WT-TASK-0203-A1',
    ]);
  });
});

describe('recorded dispositions and recovery (gap 2)', () => {
  it('keeps every untouched task ready when the invocation budget runs out', async () => {
    const root = repository();
    await seed(root, agentTask(root, 'TASK-0211'), agentTask(root, 'TASK-0212'));
    const { result, budget } = await dispatch(root, {
      activation: activation({ budgets: { ...activation().budgets, attempts_per_invocation: 1 } }),
    });
    expect(budget.attempts).toBe(1);
    expect(result.results).toMatchObject([
      { task_id: 'TASK-0211', ok: true },
      { task_id: 'TASK-0212', ok: false, code: 'EXPERIMENTAL_ATTEMPT_BUDGET_EXHAUSTED' },
    ]);
    expect(loadTask(root, 'TASK-0212')).toMatchObject({ status: 'ready', iteration_count: 0 });
    // release_on frees locks only on completion, escalation, a gap pause or cancellation.
    expect(
      listLocks({ locksDir: join(root, '.devai/state/locks') }).filter(
        (lock) => lock.task_id === 'TASK-0212',
      ),
    ).toHaveLength(1);
    expect(readDispatchJournal(root, ROUND).some((event) => event.task_id === 'TASK-0212')).toBe(
      false,
    );
  });

  it('recovers a crash after intent only through a recorded retry that continues the ladder (IA-004)', async () => {
    const root = repository();
    const task = agentTask(root, 'TASK-0213');
    await seed(root, task);
    // The state a dispatch leaves when its process dies after the intent: the task in
    // progress with its locks, the attempt worktree bound to it, and an open attempt.
    await permissive(() => {
      startRoundTask({ repoRoot: root, round: ROUND, taskId: task.id });
      saveTask(root, { ...loadTask(root, task.id), status: 'in_progress', iteration_count: 1 });
      execFileSync(
        'git',
        [
          'worktree',
          'add',
          '-b',
          'experimental/TASK-0213/attempt-1',
          worktreePath(root, 'WT-TASK-0213-A1'),
        ],
        { cwd: root, stdio: 'ignore' },
      );
      mkdirSync(join(root, '.devai/state'), { recursive: true });
      writeFileSync(
        join(root, '.devai/state/worktrees.json'),
        `${JSON.stringify({
          worktrees: [
            {
              id: 'WT-TASK-0213-A1',
              path: worktreePath(root, 'WT-TASK-0213-A1'),
              branch: 'experimental/TASK-0213/attempt-1',
              task_id: task.id,
              created_at: '2026-10-05T00:00:00.000Z',
              owner: { pid: 2_147_483_646, hostname: 'gone' },
            },
          ],
        })}\n`,
      );
      saveTask(root, {
        ...loadTask(root, task.id),
        worktree_id: 'WT-TASK-0213-A1',
        branch: 'experimental/TASK-0213/attempt-1',
      });
      appendDispatchJournalEvent(root, ROUND, {
        task_id: task.id,
        attempt: 1,
        event: 'intent',
        runtime: 'claude-cli',
        model: 'sonnet',
        effort: 'high',
        tier: 'default',
        prompt_sha256: 'a'.repeat(64),
      });
      appendDispatchJournalEvent(root, ROUND, {
        task_id: task.id,
        attempt: 1,
        event: 'spawned',
        pid: 4242,
      });
    });
    expect(() => assertNoUncertainDispatch(root, ROUND, listTasks(root))).toThrow(
      'TASK_DISPATCH_UNCERTAIN',
    );
    const record = await permissive(() =>
      disposeDispatchTask({ repoRoot: root, round: ROUND, taskId: task.id, disposition: 'retry' }),
    );
    expect(record).toMatchObject({
      kind: 'task',
      role: 'owner',
      disposition: 'retry',
      prior_status: 'in_progress',
      resulting_status: 'ready',
      closed_attempts: [1],
      released_worktrees: ['WT-TASK-0213-A1'],
    });
    expect(readDispatchJournal(root, ROUND).at(-1)).toMatchObject({
      event: 'settled',
      outcome: 'cancelled',
      disposition: 'retry',
      disposition_id: record.id,
    });
    expect(loadTask(root, task.id)).toMatchObject({ status: 'ready' });
    expect(loadTask(root, task.id).worktree_id).toBeUndefined();
    expect(existsSync(worktreePath(root, 'WT-TASK-0213-A1'))).toBe(false);
    expect(() => assertNoUncertainDispatch(root, ROUND, listTasks(root))).not.toThrow();
    // The retry continues the ladder: the next attempt is number 2, never a reused 1.
    const { result } = await dispatch(root);
    expect(result.results).toMatchObject([{ task_id: task.id, ok: true }]);
    expect(loadTask(root, task.id)).toMatchObject({
      status: 'awaiting_human_review',
      worktree_id: 'WT-TASK-0213-A2',
    });
    expect(
      readDispatchJournal(root, ROUND)
        .filter((event) => event.event === 'intent')
        .map((event) => event.attempt),
    ).toEqual([1, 2]);
  });

  it('escalates a blocked task with a record, and refuses a retry once the ladder is spent', async () => {
    const root = repository();
    await seed(root, agentTask(root, 'TASK-0214'));
    await dispatch(root, { scenario: 'fail' });
    const blocked = loadTask(root, 'TASK-0214');
    // IA-006: the final failed attempt's worktree is retained and bound to the blocked task.
    expect(blocked).toMatchObject({
      status: 'experimental_blocked',
      worktree_id: 'WT-TASK-0214-A4',
    });
    expect(existsSync(worktreePath(root, 'WT-TASK-0214-A4'))).toBe(true);
    expect(existsSync(worktreePath(root, 'WT-TASK-0214-A1'))).toBe(false);
    await permissive(() => {
      expect(() =>
        disposeDispatchTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0214',
          disposition: 'retry',
        }),
      ).toThrow('DISPOSITION_ATTEMPTS_EXHAUSTED');
      const record = disposeDispatchTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-0214',
        disposition: 'escalate',
        note: 'needs a smaller task',
      });
      expect(record).toMatchObject({
        resulting_status: 'escalated',
        closed_attempts: [],
        released_worktrees: ['WT-TASK-0214-A4'],
        note: 'needs a smaller task',
      });
      // Only uncertain or blocked work is disposed of this way.
      expect(() =>
        disposeDispatchTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0214',
          disposition: 'escalate',
        }),
      ).toThrow('DISPOSITION_NOT_APPLICABLE');
    });
    expect(loadTask(root, 'TASK-0214').status).toBe('escalated');
    expect(existsSync(worktreePath(root, 'WT-TASK-0214-A4'))).toBe(false);
    expect(listDispatchDispositions(root, ROUND)).toHaveLength(1);
  });

  it('quarantines a damaged journal byte for byte and still demands a disposition for in-flight work', async () => {
    const root = repository();
    await seed(root, agentTask(root, 'TASK-0215'), agentTask(root, 'TASK-0216'));
    await dispatch(root, { taskIds: ['TASK-0215'] });
    const path = join(root, '.devai/state/round-runs', ROUND, 'dispatch-journal.jsonl');
    appendFileSync(path, '{"schemaVersion":"1.0.0","round_id":"R-00');
    const damaged = readFileSync(path);
    await permissive(() => {
      saveTask(root, { ...loadTask(root, 'TASK-0216'), status: 'in_progress' });
    });
    expect(() => assertNoUncertainDispatch(root, ROUND, listTasks(root))).toThrow(
      'TASK_DISPATCH_JOURNAL_INVALID',
    );
    const record = await permissive(() =>
      quarantineRoundDispatchJournal({ repoRoot: root, round: ROUND }),
    );
    expect(record).toMatchObject({
      kind: 'journal-quarantine',
      in_flight_task_ids: ['TASK-0216'],
      attempt_floors: { 'TASK-0215': 1 },
    });
    expect(readFileSync(join(root, record.quarantined_journal?.path ?? '')).equals(damaged)).toBe(
      true,
    );
    expect(existsSync(path)).toBe(false);
    // The in-flight task still blocks the round until its own disposition.
    expect(() => assertNoUncertainDispatch(root, ROUND, listTasks(root))).toThrow(
      'TASK_DISPATCH_UNCERTAIN',
    );
    await permissive(() =>
      disposeDispatchTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-0216',
        disposition: 'escalate',
      }),
    );
    expect(() => assertNoUncertainDispatch(root, ROUND, listTasks(root))).not.toThrow();
    // A readable journal is never quarantined.
    await permissive(() => {
      appendDispatchJournalEvent(root, ROUND, {
        task_id: 'TASK-0216',
        attempt: 1,
        event: 'intent',
        runtime: 'claude-cli',
        model: 'sonnet',
        effort: 'high',
        tier: 'default',
        prompt_sha256: 'a'.repeat(64),
      });
      expect(() => quarantineRoundDispatchJournal({ repoRoot: root, round: ROUND })).toThrow(
        'TASK_DISPATCH_JOURNAL_VALID',
      );
    });
  });

  it('treats a failure after the provider started as uncertain and keeps its worktree (crash boundary)', async () => {
    const root = repository();
    await seed(root, agentTask(root, 'TASK-0217'));
    const journal = join(root, '.devai/state/round-runs', ROUND, 'dispatch-journal.jsonl');
    const { result } = await dispatch(root, {
      // The journal is damaged after the intent and before the spawned record.
      beforeSpawn: () => appendFileSync(journal, 'torn'),
    });
    expect(result.results).toMatchObject([{ task_id: 'TASK-0217', ok: false }]);
    expect(loadTask(root, 'TASK-0217')).toMatchObject({
      status: 'experimental_blocked',
      worktree_id: 'WT-TASK-0217-A1',
    });
    expect(existsSync(worktreePath(root, 'WT-TASK-0217-A1'))).toBe(true);
    const retained = listWorktrees({ repoRoot: root }).find(
      (worktree) => worktree.id === 'WT-TASK-0217-A1',
    );
    expect(retained?.retained).toBe(true);
  });
});

describe('capacity for every policy worker plus retained reviews (gap 3)', () => {
  it('runs four concurrent workers and keeps each passing worktree retained for review', async () => {
    const root = repository();
    const trace = join(root, '..', `${String(process.pid)}-trace-${String(Date.now())}`);
    roots.push(trace);
    const ids = ['TASK-0221', 'TASK-0222', 'TASK-0223', 'TASK-0224'];
    await seed(root, ...ids.map((id) => agentTask(root, id)));
    const { result } = await dispatch(root, {
      scenario: 'slow-writes',
      workers: 4,
      env: { FAKE_TRACE_FILE: trace, FAKE_DELAY_MS: '600' },
    });
    expect(result.results.map((entry) => entry.ok)).toEqual([true, true, true, true]);
    for (const id of ids) expect(loadTask(root, id).status).toBe('awaiting_human_review');
    // All four providers ran at the same time.
    let running = 0;
    let peak = 0;
    for (const line of readFileSync(trace, 'utf8').trim().split('\n')) {
      running += line.startsWith('start') ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBe(WORKTREE_CAP);
    const worktrees = listWorktrees({ repoRoot: root });
    expect(worktrees).toHaveLength(4);
    expect(worktrees.every((worktree) => !holdsWorktreeCapacity(worktree))).toBe(true);
  });

  it('dispatches a fourth task while three reviews hold retained worktrees', async () => {
    const root = repository();
    const reviews = ['TASK-0231', 'TASK-0232', 'TASK-0233'];
    await seed(root, ...reviews.map((id) => agentTask(root, id)));
    await dispatch(root);
    await seed(root, agentTask(root, 'TASK-0234'));
    const { result } = await dispatch(root, { taskIds: ['TASK-0234'] });
    expect(result.results).toMatchObject([{ task_id: 'TASK-0234', ok: true }]);
    for (const id of [...reviews, 'TASK-0234']) {
      expect(loadTask(root, id)).toMatchObject({
        status: 'awaiting_human_review',
        worktree_id: `WT-${id}-A1`,
      });
    }
    // Four more concurrent workers still fit beside four retained reviews.
    const more = ['TASK-0235', 'TASK-0236', 'TASK-0237', 'TASK-0238'];
    await seed(root, ...more.map((id) => agentTask(root, id)));
    const second = await dispatch(root, { taskIds: more, workers: 4 });
    expect(second.result.results.every((entry) => entry.ok)).toBe(true);
    expect(listWorktrees({ repoRoot: root })).toHaveLength(8);
  });
});

describe('engine hardening (independent review)', () => {
  it('fails an attempt that leaves a symbolic link resolving outside the worktree', async () => {
    const root = repository();
    const outside = join(root, '..', `outside-${String(Date.now())}.txt`);
    roots.push(outside);
    writeFileSync(outside, 'outside\n');
    await seed(root, agentTask(root, 'TASK-0241'));
    const { result } = await dispatch(root, {
      scenario: 'symlink-out',
      activation: activation({
        runtimes: [{ runtime: 'claude-cli', models: ['sonnet'], efforts: ['high'] }],
        budgets: { ...activation().budgets, attempts_per_task: 1 },
      }),
      env: { FAKE_LINK_TARGET: outside },
    });
    expect(result.results).toMatchObject([
      { task_id: 'TASK-0241', ok: false, code: 'EXPERIMENTAL_SYMLINK_ESCAPE' },
    ]);
    expect(loadTask(root, 'TASK-0241').status).toBe('experimental_blocked');
  });

  it('refuses before any provider starts when the base tree holds an escaping link, leaving the task ready', async () => {
    const root = repository();
    execFileSync('ln', ['-s', '/etc', join(root, 'packages/app/escape')]);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'escaping link');
    await seed(root, agentTask(root, 'TASK-0242'));
    const { result, budget } = await dispatch(root);
    expect(result.results).toMatchObject([{ ok: false, code: 'EXPERIMENTAL_SYMLINK_ESCAPE' }]);
    expect(budget.attempts).toBe(0);
    expect(loadTask(root, 'TASK-0242')).toMatchObject({ status: 'ready' });
    expect(listWorktrees({ repoRoot: root })).toEqual([]);
  });

  it('never persists a pass after the task lost its lock', async () => {
    const root = repository();
    await seed(root, agentTask(root, 'TASK-0243'));
    const { result } = await dispatch(root, {
      scenario: 'drop-locks',
      env: { FAKE_LOCKS_DIR: join(root, '.devai/state/locks') },
    });
    expect(result.results).toMatchObject([{ task_id: 'TASK-0243', ok: false }]);
    expect(loadTask(root, 'TASK-0243').status).not.toBe('awaiting_human_review');
    const evidence = readdirSync(join(root, '.devai/state/round-runs', ROUND, 'task-executions'));
    expect(evidence).toHaveLength(1);
  });

  it('makes usage unverifiable when a cache counter is missing, never charging it as zero', async () => {
    const root = repository();
    await seed(root, agentTask(root, 'TASK-0244'), agentTask(root, 'TASK-0245'));
    const { result, budget } = await dispatch(root, { scenario: 'no-cache' });
    expect(budget).toMatchObject({ attempts: 1, unverifiable: true });
    expect(result.results).toMatchObject([
      { task_id: 'TASK-0244', ok: true },
      { task_id: 'TASK-0245', ok: false, code: 'EXPERIMENTAL_USAGE_UNVERIFIABLE' },
    ]);
    expect(loadTask(root, 'TASK-0245').status).toBe('ready');
    const reported = { value: 1, status: 'reported' as const };
    const missing = { value: null, status: 'missing' as const };
    expect(
      attemptSpend({
        usage_version: 2,
        counter_mode: 'per-attempt',
        derivation: 'test',
        input_tokens: reported,
        output_tokens: reported,
        cache_read_tokens: reported,
        cache_write_tokens: missing,
      }),
    ).toBeUndefined();
  });

  it('persists the task outcome and worktree binding before the attempt settles', async () => {
    const root = repository();
    await seed(root, agentTask(root, 'TASK-0246'));
    const record: AuthorityHostEffectRequest[] = [];
    await dispatch(root, { record });
    const taskWrite = record.findIndex(
      (effect) =>
        effect.symbol === 'writeFileSync' &&
        String(effect.arguments[0]).endsWith('TASK-0246.json') &&
        String(effect.arguments[1]).includes('"awaiting_human_review"') &&
        String(effect.arguments[1]).includes('WT-TASK-0246-A1'),
    );
    const settled = record.findIndex(
      (effect) =>
        effect.symbol === 'writeSync' &&
        Buffer.isBuffer(effect.arguments[1]) &&
        effect.arguments[1].toString('utf8').includes('"event":"settled"'),
    );
    expect(taskWrite).toBeGreaterThanOrEqual(0);
    expect(settled).toBeGreaterThan(taskWrite);
  });

  it('validates efforts against the model runtime registry before any spawn', () => {
    const registry = JSON.parse(
      readFileSync(join(ROOT, 'law/policy/model-runtime-registry.json'), 'utf8'),
    ) as { runtimes: { id: string; efforts: string[] }[] };
    for (const runtime of ['claude-cli', 'codex-cli'] as const) {
      expect(EXPERIMENTAL_RUNTIME_EFFORTS[runtime]).toEqual(
        registry.runtimes.find((entry) => entry.id === runtime)?.efforts,
      );
    }
    const now = new Date('2026-10-05T00:00:00.000Z');
    expect(
      checkExperimentalActivation(
        activation({
          runtimes: [{ runtime: 'claude-cli', models: ['sonnet'], efforts: ['xhigh'] }],
        }),
        now,
      ),
    ).toEqual({ ok: false, code: 'EXPERIMENTAL_ACTIVATION_EFFORT_UNSUPPORTED' });
    const root = repository();
    const task = agentTask(root, 'TASK-0249');
    expect(
      experimentalTaskRefusal(
        { ...task, executor: { ...task.executor, effort: 'xhigh' } } as TaskRecord,
        activation({
          runtimes: [{ runtime: 'claude-cli', models: ['sonnet'], efforts: ['xhigh'] }],
        }),
      ),
    ).toBe('EXPERIMENTAL_EFFORT_NOT_SUPPORTED');
  });
});
