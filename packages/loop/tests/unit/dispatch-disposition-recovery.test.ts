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
import {
  WAITING_LOCK_TTL_MS,
  acquireLocks,
  assertLockOwnership,
  inspectLocks,
  taskLockTargets,
} from '../../src/loop/locks.js';
import { ratifyRoundTask } from '../../src/loop/ratification.js';
import { acquireRoundController, releaseRoundController } from '../../src/loop/round-controller.js';
import { escalateRoundTask, finishRoundTask } from '../../src/loop/task-services.js';
import { computeManifestHash, extractManifestInputs } from '@devai-nyx/evidence';
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

/**
 * Writes the evidence chain `task finish` resolves merge evidence against (#319): schema-valid
 * records whose manifest hashes and predecessor links pass the evidence package's
 * `verifyChain`, so the context can name a task as no verb writer does.
 */
function recordEvidence(
  root: string,
  entries: readonly { id: string; task_id?: string | null; notes?: string[] }[],
): void {
  mkdirSync(join(root, 'record/proofs'), { recursive: true });
  let previous: string | null = null;
  const records = entries.map((entry, index) => {
    const draft = {
      schemaVersion: '1.0.0' as const,
      id: entry.id,
      timestamp: new Date(Date.UTC(2026, 9, 6, 0, 0, index)).toISOString(),
      actor: 'devai',
      actor_role: 'harness',
      action: 'evidence record',
      status: 'completed',
      context: {
        repo_root: root,
        task_id: entry.task_id ?? null,
        git: { head_sha: null, dirty_files: [] },
      },
      artifacts: [],
      ...(entry.notes === undefined ? {} : { notes: entry.notes }),
      previous_run_hash: previous,
      manifest_hash: '',
    };
    draft.manifest_hash = computeManifestHash(extractManifestInputs(draft));
    previous = draft.manifest_hash;
    return draft;
  });
  writeChain(root, { head: previous, records });
}

function writeChain(root: string, chain: unknown): void {
  mkdirSync(join(root, 'record/proofs'), { recursive: true });
  writeFileSync(join(root, 'record/proofs/chain.json'), `${JSON.stringify(chain, null, 2)}\n`);
}

function readChain(root: string): { head: string | null; records: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(join(root, 'record/proofs/chain.json'), 'utf8')) as {
    head: string | null;
    records: Record<string, unknown>[];
  };
}

/** Every lock file's bytes, to prove a refusal renewed nothing. */
function lockBytes(root: string): Record<string, string> {
  const dir = join(root, '.devai/state/locks');
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, readFileSync(path, 'utf8')];
      }),
  );
}

/**
 * Leaves each of the task's own lock records one minute before expiry, inside
 * `COMPLETION_LOCK_MARGIN_MS`, so the next lock-ownership check would renew it in place.
 */
function nearExpiry(root: string, taskId: string): void {
  for (const path of Object.keys(lockBytes(root))) {
    if (!path.endsWith('.json')) continue;
    const record = JSON.parse(readFileSync(path, 'utf8')) as {
      task_id?: unknown;
      substrate?: unknown;
      acquired_at?: unknown;
      ttl_ms: number;
    };
    if (
      record.task_id !== taskId ||
      typeof record.substrate !== 'string' ||
      typeof record.acquired_at !== 'string' ||
      typeof record.ttl_ms !== 'number'
    ) {
      continue;
    }
    const acquiredAt = new Date(Date.now() - record.ttl_ms + 60_000).toISOString();
    writeFileSync(path, `${JSON.stringify({ ...record, acquired_at: acquiredAt }, null, 2)}\n`);
  }
}

describe('agent completion is durable before it releases anything (FIX 4, FIX 8)', () => {
  async function accepted(root: string): Promise<void> {
    recordEvidence(root, [
      { id: 'EV-0123456789abcdef', task_id: 'TASK-0341', notes: [`round_id=${ROUND}`] },
      { id: 'EV-fedcba9876543210' },
    ]);
    await effects(() => {
      const task = withWorktree(root, agentTask('TASK-0341', 'awaiting_human_review'));
      saveTask(root, task);
      // A task awaiting review still holds the locks its dispatch acquired.
      acquireLocks({
        locksDir: join(root, '.devai/state/locks'),
        taskId: task.id,
        targets: taskLockTargets(task),
      });
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

  it('refuses merge evidence the chain does not hold, cannot verify, or binds elsewhere, writing nothing (#319)', async () => {
    const root = repository();
    await accepted(root);
    // Own locks inside the completion margin: a finish that reached its lock check would
    // renew them, so unchanged bytes prove every refusal came before it.
    nearExpiry(root, 'TASK-0341');
    const locks = lockBytes(root);
    const finish = (evidence: string[]) => () =>
      finishRoundTask({ repoRoot: root, round: ROUND, taskId: 'TASK-0341', evidence });
    await effects(() => {
      // Shaped like an evidence id but never recorded.
      expect(finish(['EV-0000000000000000'])).toThrow('TASK_MERGE_EVIDENCE_REQUIRED');
      expect(finish(['EV-0123456789abcdef', 'EV-0000000000000000'])).toThrow(
        'TASK_MERGE_EVIDENCE_REQUIRED',
      );
    });
    recordEvidence(root, [
      { id: 'EV-0123456789abcdef', task_id: 'TASK-0341' },
      { id: 'EV-1111111111111111', task_id: 'TASK-9999' },
      { id: 'EV-2222222222222222', notes: ['round_id=R-9999'] },
    ]);
    await effects(() => {
      expect(finish(['EV-1111111111111111'])).toThrow('TASK_MERGE_EVIDENCE_REQUIRED');
      expect(finish(['EV-2222222222222222'])).toThrow('TASK_MERGE_EVIDENCE_REQUIRED');
    });
    const intact = readChain(root);
    // A readable chain whose referenced entry is a bare id is not evidence.
    writeChain(root, { head: null, records: [{ id: 'EV-0123456789abcdef' }] });
    await effects(() => {
      expect(finish(['EV-0123456789abcdef'])).toThrow('TASK_MERGE_EVIDENCE_REQUIRED');
    });
    // An entry whose manifest hash no longer recomputes breaks the chain.
    writeChain(root, {
      ...intact,
      records: intact.records.map((record, index) =>
        index === 0 ? { ...record, action: 'evidence forged' } : record,
      ),
    });
    await effects(() => {
      expect(finish(['EV-0123456789abcdef'])).toThrow('TASK_MERGE_EVIDENCE_REQUIRED');
    });
    // A dropped predecessor breaks the links of every later entry.
    writeChain(root, { ...intact, records: intact.records.slice(1) });
    await effects(() => {
      expect(finish(['EV-1111111111111111'])).toThrow('TASK_MERGE_EVIDENCE_REQUIRED');
    });
    // An unreadable chain resolves nothing.
    writeFileSync(join(root, 'record/proofs/chain.json'), '{"head":null,"rec');
    await effects(() => {
      expect(finish(['EV-0123456789abcdef'])).toThrow('TASK_MERGE_EVIDENCE_REQUIRED');
    });
    rmSync(join(root, 'record'), { recursive: true, force: true });
    await effects(() => {
      expect(finish(['EV-0123456789abcdef'])).toThrow('TASK_MERGE_EVIDENCE_REQUIRED');
    });
    // Nothing was recorded, renewed or released by any refusal.
    expect(lockBytes(root)).toEqual(locks);
    expect(existsSync(completionPath(root))).toBe(false);
    expect(loadTask(root, 'TASK-0341').status).toBe('pre_merge');
    expect(listWorktrees({ repoRoot: root }).map((worktree) => worktree.id)).toEqual([
      'WT-TASK-0341-A1',
    ]);
    // Control: the lock check itself does renew these records.
    await effects(() => {
      const task = loadTask(root, 'TASK-0341');
      assertLockOwnership({
        locksDir: join(root, '.devai/state/locks'),
        taskId: task.id,
        targets: taskLockTargets(task),
      });
    });
    expect(lockBytes(root)).not.toEqual(locks);
  });

  it('revalidates the completion record and its evidence on a retry from merging (#319)', async () => {
    const root = repository();
    await accepted(root);
    const taskFile = join(root, '.devai/state/tasks/TASK-0341.json');
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
        if (
          request.symbol === 'writeFileSync' &&
          request.arguments[0] === taskFile &&
          String(request.arguments[1]).includes('"status": "completed"')
        ) {
          throw new Error('INTERRUPTED');
        }
        return apply();
      },
    );
    expect(loadTask(root, 'TASK-0341').status).toBe('merging');
    const finish = (evidence?: string[]) => () =>
      finishRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: 'TASK-0341',
        ...(evidence === undefined ? {} : { evidence }),
      });
    const ratification = join(
      root,
      '.devai/state/round-runs',
      ROUND,
      'ratifications/TASK-0341.json',
    );
    const ratified = readFileSync(ratification, 'utf8');
    const chain = readFileSync(join(root, 'record/proofs/chain.json'), 'utf8');
    await effects(() => {
      // No evidence, or evidence other than the record names, does not complete it.
      expect(finish()).toThrow('TASK_MERGE_EVIDENCE_REQUIRED');
      expect(finish(['EV-fedcba9876543210'])).toThrow('TASK_COMPLETION_CONFLICT');
    });
    // The recorded evidence must still resolve.
    rmSync(join(root, 'record'), { recursive: true, force: true });
    await effects(() => {
      expect(finish(['EV-0123456789abcdef'])).toThrow('TASK_MERGE_EVIDENCE_REQUIRED');
    });
    mkdirSync(join(root, 'record/proofs'), { recursive: true });
    writeFileSync(join(root, 'record/proofs/chain.json'), chain);
    // The ratification bytes the record binds must be unchanged.
    writeFileSync(ratification, `${ratified}\n`);
    await effects(() => {
      expect(finish(['EV-0123456789abcdef'])).toThrow('TASK_COMPLETION_CONFLICT');
    });
    writeFileSync(ratification, ratified);
    // A missing completion record cannot be rebuilt from merging.
    const completion = readFileSync(completionPath(root), 'utf8');
    // An incomplete or mistyped completion record is not trusted.
    const parsed = JSON.parse(completion) as Record<string, unknown>;
    for (const broken of [
      { ...parsed, released_worktrees: [1] },
      { ...parsed, ratification: { sha256: (parsed.ratification as { sha256: string }).sha256 } },
      { ...parsed, completed_at: 'yesterday' },
    ]) {
      writeFileSync(completionPath(root), `${JSON.stringify(broken, null, 2)}\n`);
      await effects(() => {
        expect(finish(['EV-0123456789abcdef'])).toThrow('TASK_COMPLETION_CONFLICT');
      });
    }
    rmSync(completionPath(root));
    await effects(() => {
      expect(finish(['EV-0123456789abcdef'])).toThrow('TASK_COMPLETION_CONFLICT');
    });
    writeFileSync(completionPath(root), completion);
    expect(loadTask(root, 'TASK-0341').status).toBe('merging');
    await effects(() => {
      expect(finish(['EV-0123456789abcdef'])().status).toBe('completed');
    });
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

describe('a lock taken over while an agent task waits is caught before acceptance or completion (#285)', () => {
  const locksDir = (root: string) => join(root, '.devai/state/locks');

  /** Another task takes the waiting task's key, as it may once the lease lapsed. */
  function takeOver(root: string, task: TaskRecord): void {
    rmSync(join(locksDir(root), `F2~MOD-${task.id}.json`));
    expect(
      acquireLocks({
        locksDir: locksDir(root),
        taskId: 'TASK-0999',
        targets: taskLockTargets(task),
      }).denied,
    ).toEqual([]);
  }

  it('refuses to accept a review whose lock was taken over, before recording any decision', async () => {
    const root = repository();
    await effects(() => {
      const task = withWorktree(root, agentTask('TASK-0351', 'awaiting_human_review'));
      saveTask(root, task);
      acquireLocks({ locksDir: locksDir(root), taskId: task.id, targets: taskLockTargets(task) });
      journal(root, task.id, 1, 5);
      takeOver(root, task);

      expect(() =>
        ratifyRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: task.id,
          decision: 'accept',
          role: 'owner',
        }),
      ).toThrow('TASK_RESOURCE_LOCK_LOST');
      expect(loadTask(root, task.id).status).toBe('awaiting_human_review');
      expect(existsSync(join(root, '.devai/state/round-runs', ROUND, 'ratifications'))).toBe(false);
      // Rejecting it still escalates, and leaves the new holder's lock alone.
      ratifyRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: task.id,
        decision: 'reject',
        role: 'owner',
      });
      expect(loadTask(root, task.id).status).toBe('escalated');
      expect(
        inspectLocks({
          locksDir: locksDir(root),
          taskId: 'TASK-0999',
          targets: taskLockTargets(task),
        }).lost,
      ).toEqual([]);
    });
  });

  it('refuses to apply a recorded acceptance after a takeover when the ratification is retried', async () => {
    const root = repository();
    const task = await effects(() => {
      const value = withWorktree(root, agentTask('TASK-0353', 'awaiting_human_review'));
      saveTask(root, value);
      acquireLocks({ locksDir: locksDir(root), taskId: value.id, targets: taskLockTargets(value) });
      journal(root, value.id, 1, 5);
      return value;
    });
    const taskFile = join(root, '.devai/state/tasks/TASK-0353.json');
    // The decision is recorded, then the process stops before the task moves to pre_merge.
    await effects(
      () => {
        expect(() =>
          ratifyRoundTask({
            repoRoot: root,
            round: ROUND,
            taskId: task.id,
            decision: 'accept',
            role: 'owner',
          }),
        ).toThrow('INTERRUPTED');
      },
      (request, apply) => {
        if (request.symbol === 'writeFileSync' && request.arguments[0] === taskFile) {
          throw new Error('INTERRUPTED');
        }
        return apply();
      },
    );
    expect(existsSync(join(root, '.devai/state/round-runs', ROUND, 'ratifications'))).toBe(true);

    await effects(() => {
      takeOver(root, task);
      expect(() =>
        ratifyRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: task.id,
          decision: 'accept',
          role: 'owner',
        }),
      ).toThrow('TASK_RESOURCE_LOCK_LOST');
      expect(loadTask(root, task.id).status).toBe('awaiting_human_review');
    });
  });

  it('renews an expired own lock with the waiting lease before recording an acceptance', async () => {
    const root = repository();
    await effects(() => {
      const task = withWorktree(root, agentTask('TASK-0354', 'awaiting_human_review'));
      saveTask(root, task);
      acquireLocks({
        locksDir: locksDir(root),
        taskId: task.id,
        targets: taskLockTargets(task),
        ttlMs: 1,
      });
      const start = Date.now();
      while (Date.now() - start < 5) {
        // let the one-millisecond record expire, untaken
      }
      journal(root, task.id, 1, 5);

      ratifyRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: task.id,
        decision: 'accept',
        role: 'owner',
      });

      expect(loadTask(root, task.id).status).toBe('pre_merge');
      const [held] = inspectLocks({
        locksDir: locksDir(root),
        taskId: task.id,
        targets: taskLockTargets(task),
      }).held;
      expect(held?.record.ttl_ms).toBe(WAITING_LOCK_TTL_MS);
      expect(Date.parse(held?.record.acquired_at ?? '')).toBeGreaterThanOrEqual(start + 5);
    });
  });

  it('refuses to finish an accepted task whose lock was taken over, before writing anything', async () => {
    const root = repository();
    recordEvidence(root, [{ id: 'EV-0123456789abcdef' }]);
    await effects(() => {
      const task = withWorktree(root, agentTask('TASK-0352', 'awaiting_human_review'));
      saveTask(root, task);
      acquireLocks({ locksDir: locksDir(root), taskId: task.id, targets: taskLockTargets(task) });
      journal(root, task.id, 1, 5);
      ratifyRoundTask({
        repoRoot: root,
        round: ROUND,
        taskId: task.id,
        decision: 'accept',
        role: 'owner',
      });
      takeOver(root, task);

      expect(() =>
        finishRoundTask({
          repoRoot: root,
          round: ROUND,
          taskId: task.id,
          evidence: ['EV-0123456789abcdef'],
        }),
      ).toThrow('TASK_RESOURCE_LOCK_LOST');
      expect(loadTask(root, task.id).status).toBe('pre_merge');
      expect(
        existsSync(join(root, '.devai/state/round-runs', ROUND, 'completions', `${task.id}.json`)),
      ).toBe(false);
      expect(listWorktrees({ repoRoot: root }).map((worktree) => worktree.task_id)).toContain(
        task.id,
      );
    });
  });
});
