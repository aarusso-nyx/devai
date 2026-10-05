// ADR-MDL-0007 recovery under constructed crash states, without a provider: attempts a
// quarantined journal leaves open keep blocking whatever their task's status; escalating
// an agent task left in progress is recorded; escalation and disposition serialize with
// dispatch under the round controller; an interrupted disposition resumes; and agent
// completion writes its record atomically before it releases the attempt worktree.
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
  readdirSync,
  readFileSync,
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
  disposeDispatchTask,
  listDispatchDispositions,
  pendingTaskDispositions,
  quarantineRoundDispatchJournal,
  uncertainDispatchFindings,
} from '../../src/loop/dispatch-disposition.js';
import {
  DISPATCH_JOURNAL_EVENTS,
  appendDispatchJournalEvent,
  dispatchJournalPath,
  readDispatchJournal,
  type DispatchJournalEntry,
} from '../../src/loop/dispatch-journal.js';
import { ratifyRoundTask } from '../../src/loop/ratification.js';
import { acquireRoundController, releaseRoundController } from '../../src/loop/round-controller.js';
import { escalateRoundTask, finishRoundTask } from '../../src/loop/task-services.js';
import { listTasks, loadTask, saveTask, type TaskRecord } from '../../src/loop/tasks.js';
import { createWorktree, listWorktrees, retainWorktree } from '../../src/loop/worktrees.js';

const ROUND = 'R-0021';
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) Reflect.deleteProperty(process.env, name);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-disposition-recovery-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'fixture');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, '.gitignore'), '.devai/\n');
  writeFileSync(join(root, 'fixture.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

function agentTask(id: string, status: TaskRecord['status']): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status,
    discipline: 'engineer',
    title: `Implement ${id}`,
    target_modules: [`MOD-${id}`],
    target_substrates: ['F2'],
    created_at: '2026-10-05T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 1,
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
  } as TaskRecord;
}

const FACTS: Record<string, Partial<DispatchJournalEntry>> = {
  intent: {
    runtime: 'claude-cli',
    model: 'sonnet',
    effort: 'high',
    tier: 'default',
    prompt_sha256: 'a'.repeat(64),
  },
  spawned: { pid: 4242 },
  exited: { exit_code: 0, signal: null, timed_out: false },
  'evidence-written': { evidence_id: 'TXE-0123456789abcdef' },
  settled: { outcome: 'pass' },
};

function journal(root: string, task: string, attempt: number, through: number): void {
  for (const event of DISPATCH_JOURNAL_EVENTS.slice(0, through)) {
    appendDispatchJournalEvent(root, ROUND, {
      task_id: task,
      attempt,
      event,
      ...FACTS[event],
    } as DispatchJournalEntry);
  }
}

/** Run with every host effect permitted, optionally intercepted before it applies. */
async function effects<T>(
  run: () => T,
  intercept?: (request: AuthorityHostEffectRequest, apply: () => unknown) => unknown,
): Promise<T> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'disposition-recovery' });
  const scope: AuthorityHostEffectScope = {
    action_id: 'round dispatch dispose',
    invocation_id: 'disposition-recovery',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: intercept ?? ((_request, apply) => apply()),
  };
  try {
    return await runWithAuthorityHostEffects(scope, async () => run());
  } finally {
    issuer.dispose();
  }
}

/** A task with a bound, retained attempt worktree. */
function withWorktree(root: string, task: TaskRecord, attempt = 1): TaskRecord {
  const worktree = createWorktree({
    repoRoot: root,
    id: `WT-${task.id}-A${String(attempt)}`,
    branch: `experimental/${task.id}/attempt-${String(attempt)}`,
    taskId: task.id,
  });
  retainWorktree({ repoRoot: root, id: worktree.id });
  return { ...task, worktree_id: worktree.id, branch: worktree.branch };
}

const findingTasks = (root: string) =>
  uncertainDispatchFindings(root, ROUND, listTasks(root)).map((finding) => finding.task_id);

describe('journal quarantine keeps every open attempt blocking (FIX 1)', () => {
  it('blocks on an attempt its quarantined journal left open whatever the task status, until a disposition resolves it', async () => {
    const root = repository();
    await effects(() => {
      saveTask(root, agentTask('TASK-0301', 'awaiting_human_review'));
      saveTask(root, agentTask('TASK-0302', 'experimental_blocked'));
      saveTask(root, agentTask('TASK-0303', 'awaiting_human_review'));
      journal(root, 'TASK-0303', 1, 5);
      journal(root, 'TASK-0301', 1, 4);
      journal(root, 'TASK-0302', 2, 3);
    });
    appendFileSync(dispatchJournalPath(root, ROUND), '{"schemaVersion":"1.0.0","round');
    const quarantine = await effects(() =>
      quarantineRoundDispatchJournal({ repoRoot: root, round: ROUND }),
    );
    expect(quarantine).toMatchObject({
      open_attempts: [
        { task_id: 'TASK-0301', attempt: 1, last_event: 'evidence-written' },
        { task_id: 'TASK-0302', attempt: 2, last_event: 'exited' },
      ],
      in_flight_task_ids: ['TASK-0301', 'TASK-0302'],
    });
    expect(existsSync(dispatchJournalPath(root, ROUND))).toBe(false);
    // Neither task is in progress, yet both attempts keep blocking the round.
    expect(uncertainDispatchFindings(root, ROUND, listTasks(root))).toEqual([
      {
        task_id: 'TASK-0301',
        attempt: 1,
        last_event: 'evidence-written',
        quarantine_id: quarantine.id,
      },
      { task_id: 'TASK-0302', attempt: 2, last_event: 'exited', quarantine_id: quarantine.id },
    ]);
    await effects(() => {
      expect(() =>
        ratifyRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0301',
          decision: 'accept',
          role: 'owner',
        }),
      ).toThrow('TASK_DISPATCH_UNCERTAIN');
      const resolved = disposeDispatchTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-0302',
        disposition: 'escalate',
      });
      expect(resolved.resolved_quarantined_attempts).toEqual([
        { quarantine_id: quarantine.id, attempt: 2 },
      ]);
    });
    expect(findingTasks(root)).toEqual(['TASK-0301']);
    await effects(() =>
      disposeDispatchTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-0301',
        disposition: 'escalate',
      }),
    );
    expect(findingTasks(root)).toEqual([]);
    // TASK-0303's settled attempt never blocked anything.
    expect(loadTask(root, 'TASK-0303').status).toBe('awaiting_human_review');
  });
});

describe('agent escalation is a recorded disposition (FIX 2)', () => {
  it('records the escalation of an agent task left in progress with no journal record', async () => {
    const root = repository();
    await effects(() => {
      saveTask(root, agentTask('TASK-0311', 'in_progress'));
      saveTask(root, agentTask('TASK-0312', 'experimental_blocked'));
    });
    expect(findingTasks(root)).toEqual(['TASK-0311']);
    await effects(() => {
      escalateRoundTask({ repoRoot: root, round: ROUND, taskId: 'TASK-0311' });
      // Settled work with nothing uncertain escalates without a record, as before.
      escalateRoundTask({ repoRoot: root, round: ROUND, taskId: 'TASK-0312' });
    });
    const records = listDispatchDispositions(root, ROUND);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: 'escalation',
      task_id: 'TASK-0311',
      disposition: 'escalate',
      prior_status: 'in_progress',
      resulting_status: 'escalated',
      closed_attempts: [],
    });
    expect(pendingTaskDispositions(root, ROUND)).toEqual([]);
    expect(loadTask(root, 'TASK-0311').status).toBe('escalated');
    expect(findingTasks(root)).toEqual([]);
  });
});

describe('escalation and disposition serialize with dispatch (FIX 3)', () => {
  it('refuses while a dispatch owns the round, leaving the running attempt and its worktree alone', async () => {
    const root = repository();
    await effects(() => {
      saveTask(root, withWorktree(root, agentTask('TASK-0321', 'in_progress')));
      journal(root, 'TASK-0321', 1, 2);
    });
    // A live dispatch holds the round controller while its provider runs.
    const dispatching = await effects(() => acquireRoundController(root, ROUND));
    await effects(() => {
      expect(() =>
        escalateRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0321',
          acquireRoundController: true,
        }),
      ).toThrow('TASK_ROUND_CONTROLLER_BUSY');
      expect(() =>
        disposeDispatchTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0321',
          disposition: 'escalate',
        }),
      ).toThrow('TASK_ROUND_CONTROLLER_BUSY');
    });
    expect(readDispatchJournal(root, ROUND).map((event) => event.event)).toEqual([
      'intent',
      'spawned',
    ]);
    expect(existsSync(join(root, '.devai/worktrees/WT-TASK-0321-A1'))).toBe(true);
    expect(loadTask(root, 'TASK-0321').status).toBe('in_progress');
    await effects(() => releaseRoundController(root, dispatching));
    await effects(() =>
      escalateRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-0321',
        acquireRoundController: true,
      }),
    );
    expect(loadTask(root, 'TASK-0321').status).toBe('escalated');
    expect(readDispatchJournal(root, ROUND).at(-1)).toMatchObject({
      event: 'settled',
      outcome: 'cancelled',
      disposition: 'escalate',
    });
    expect(existsSync(join(root, '.devai/worktrees/WT-TASK-0321-A1'))).toBe(false);
    expect(existsSync(join(root, '.devai/state/round-runs', ROUND, 'controller.json'))).toBe(false);
  });
});

describe('an interrupted disposition resumes (FIX 5)', () => {
  it('blocks the round and resumes when the same disposition is issued again', async () => {
    const root = repository();
    await effects(() => {
      // The state a dispatch leaves when it saved the review status but crashed before
      // settling the attempt.
      saveTask(root, withWorktree(root, agentTask('TASK-0331', 'awaiting_human_review')));
      journal(root, 'TASK-0331', 1, 4);
    });
    const taskFile = join(root, '.devai/state/tasks/TASK-0331.json');
    let interrupted = false;
    await effects(
      () => {
        expect(() =>
          disposeDispatchTask({
            repoRoot: root,
            round: ROUND,
            taskId: 'TASK-0331',
            disposition: 'retry',
          }),
        ).toThrow('INTERRUPTED');
      },
      (request, apply) => {
        if (
          !interrupted &&
          request.symbol === 'writeFileSync' &&
          request.arguments[0] === taskFile &&
          String(request.arguments[1]).includes('"status": "ready"')
        ) {
          interrupted = true;
          throw new Error('INTERRUPTED');
        }
        return apply();
      },
    );
    const [record] = listDispatchDispositions(root, ROUND);
    expect(record).toBeDefined();
    // The attempt is settled, but the task never moved: the record alone blocks the round.
    expect(readDispatchJournal(root, ROUND).at(-1)).toMatchObject({
      event: 'settled',
      outcome: 'cancelled',
      disposition_id: record?.id,
    });
    expect(loadTask(root, 'TASK-0331').status).toBe('awaiting_human_review');
    expect(uncertainDispatchFindings(root, ROUND, listTasks(root))).toEqual([
      { task_id: 'TASK-0331', attempt: null, last_event: null, disposition_id: record?.id },
    ]);
    await effects(() => {
      expect(() =>
        ratifyRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0331',
          decision: 'accept',
          role: 'owner',
        }),
      ).toThrow('TASK_DISPATCH_UNCERTAIN');
      expect(() =>
        disposeDispatchTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0331',
          disposition: 'escalate',
        }),
      ).toThrow('DISPOSITION_INCOMPLETE');
      expect(
        disposeDispatchTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0331',
          disposition: 'retry',
        }).id,
      ).toBe(record?.id);
    });
    expect(loadTask(root, 'TASK-0331').status).toBe('ready');
    expect(listDispatchDispositions(root, ROUND)).toHaveLength(1);
    expect(pendingTaskDispositions(root, ROUND)).toEqual([]);
    expect(findingTasks(root)).toEqual([]);
  });
});

describe('agent completion is durable before it releases anything (FIX 4, FIX 8)', () => {
  async function accepted(root: string): Promise<void> {
    await effects(() => {
      saveTask(root, withWorktree(root, agentTask('TASK-0341', 'awaiting_human_review')));
      journal(root, 'TASK-0341', 1, 5);
      ratifyRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-0341',
        decision: 'accept',
        role: 'owner',
      });
    });
  }
  const completionPath = (root: string) =>
    join(root, '.devai/state/round-runs', ROUND, 'completions/TASK-0341.json');

  it('records the completion before releasing the worktree and resumes after an interruption', async () => {
    const root = repository();
    await accepted(root);
    const recorded: AuthorityHostEffectRequest[] = [];
    let interrupted = false;
    await effects(
      () => {
        expect(() =>
          finishRoundTask({
            repoRoot: root,
            round: ROUND,
            taskId: 'TASK-0341',
            evidence: ['EV-0123456789abcdef'],
          }),
        ).toThrow('INTERRUPTED');
      },
      (request, apply) => {
        recorded.push(request);
        const args = request.arguments[1];
        if (
          !interrupted &&
          request.symbol === 'execFileSync' &&
          Array.isArray(args) &&
          args[0] === 'worktree' &&
          args[1] === 'list'
        ) {
          interrupted = true;
          throw new Error('INTERRUPTED');
        }
        return apply();
      },
    );
    // The record was renamed into place, complete, before the worktree release began.
    expect(
      recorded.some(
        (request) =>
          request.symbol === 'openSync' &&
          request.arguments[0] === completionPath(root) &&
          request.arguments[1] === 'wx',
      ),
    ).toBe(false);
    const first = JSON.parse(readFileSync(completionPath(root), 'utf8')) as {
      completed_at: string;
      released_worktrees: string[];
    };
    expect(first.released_worktrees).toEqual(['WT-TASK-0341-A1']);
    expect(existsSync(join(root, '.devai/worktrees/WT-TASK-0341-A1'))).toBe(true);
    expect(loadTask(root, 'TASK-0341').status).toBe('pre_merge');
    await effects(() => {
      expect(() =>
        finishRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0341',
          evidence: ['EV-fedcba9876543210'],
        }),
      ).toThrow('TASK_COMPLETION_CONFLICT');
      expect(
        finishRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0341',
          evidence: ['EV-0123456789abcdef'],
        }).status,
      ).toBe('completed');
    });
    expect(
      (JSON.parse(readFileSync(completionPath(root), 'utf8')) as { completed_at: string })
        .completed_at,
    ).toBe(first.completed_at);
    expect(existsSync(join(root, '.devai/worktrees/WT-TASK-0341-A1'))).toBe(false);
    expect(listWorktrees({ repoRoot: root })).toEqual([]);
  });

  it('serializes agent completion with escalation under the round controller', async () => {
    const root = repository();
    await accepted(root);
    // An escalation that owns the round blocks completion; nothing is recorded meanwhile.
    const escalating = await effects(() => acquireRoundController(root, ROUND));
    await effects(() => {
      expect(() =>
        finishRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0341',
          evidence: ['EV-0123456789abcdef'],
        }),
      ).toThrow('TASK_ROUND_CONTROLLER_BUSY');
    });
    expect(existsSync(completionPath(root))).toBe(false);
    expect(loadTask(root, 'TASK-0341').status).toBe('pre_merge');
    await effects(() => releaseRoundController(root, escalating));
    // An escalation arriving inside completion's load-to-save window is refused.
    const taskFile = join(root, '.devai/state/tasks/TASK-0341.json');
    let concurrent: unknown;
    await effects(
      () =>
        finishRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: 'TASK-0341',
          evidence: ['EV-0123456789abcdef'],
        }),
      (request, apply) => {
        if (
          concurrent === undefined &&
          request.symbol === 'writeFileSync' &&
          request.arguments[0] === taskFile &&
          String(request.arguments[1]).includes('"status": "merging"')
        ) {
          concurrent = 'attempted';
          try {
            escalateRoundTask({
              repoRoot: root,
              round: ROUND,
              taskId: 'TASK-0341',
              acquireRoundController: true,
            });
            concurrent = 'escalated';
          } catch (error) {
            concurrent = (error as { code?: string }).code;
          }
        }
        return apply();
      },
    );
    expect(concurrent).toBe('TASK_ROUND_CONTROLLER_BUSY');
    expect(loadTask(root, 'TASK-0341').status).toBe('completed');
  });

  it('moves a truncated completion record aside instead of accepting it', async () => {
    const root = repository();
    await accepted(root);
    mkdirSync(join(root, '.devai/state/round-runs', ROUND, 'completions'), { recursive: true });
    writeFileSync(completionPath(root), '{"schemaVersion":"1.0.0","round_id":"R-00');
    await effects(() =>
      finishRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-0341',
        evidence: ['EV-0123456789abcdef'],
      }),
    );
    expect(loadTask(root, 'TASK-0341').status).toBe('completed');
    expect(JSON.parse(readFileSync(completionPath(root), 'utf8'))).toMatchObject({
      task_id: 'TASK-0341',
      merge_evidence_refs: ['EV-0123456789abcdef'],
    });
    expect(
      readdirSync(join(root, '.devai/state/round-runs', ROUND, 'completions')).some((name) =>
        name.startsWith('TASK-0341.json.torn-'),
      ),
    ).toBe(true);
  });
});
