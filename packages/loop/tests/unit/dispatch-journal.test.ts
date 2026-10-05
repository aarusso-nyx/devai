// ADR-MDL-0005 D-6 and IA-004: the dispatch journal leaves every crash boundary either
// untouched or uncertain, and uncertain work blocks the round until a human disposition.
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  DISPATCH_JOURNAL_EVENTS,
  DispatchUncertainError,
  appendDispatchJournalEvent,
  applyDispatchJournalQuarantine,
  assertNoUncertainDispatch,
  dispatchJournalPath,
  planDispatchJournalQuarantine,
  quarantinedJournalPath,
  readDispatchJournal,
  uncertainDispatchFindings,
  uncertainDispatches,
  type DispatchDisposition,
  type DispatchJournalEntry,
} from '../../src/loop/dispatch-journal.js';
import type { TaskRecord } from '../../src/loop/tasks.js';

const ROUND = 'R-0012';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-dispatch-journal-'));
  roots.push(root);
  return root;
}

const FACTS: Record<string, Partial<DispatchJournalEntry>> = {
  intent: {
    runtime: 'claude-cli',
    model: 'claude-opus-5-5',
    effort: 'high',
    tier: 'default',
    prompt_sha256: 'a'.repeat(64),
  },
  spawned: { pid: 4242 },
  exited: { exit_code: 0, signal: null, timed_out: false },
  'evidence-written': { evidence_id: 'TXE-0123456789abcdef' },
  settled: { outcome: 'pass' },
};

function entry(event: string, task = 'TASK-0040', attempt = 1): DispatchJournalEntry {
  return { task_id: task, attempt, event, ...FACTS[event] } as DispatchJournalEntry;
}

function appendThrough(root: string, count: number, task = 'TASK-0040', attempt = 1): void {
  for (const event of DISPATCH_JOURNAL_EVENTS.slice(0, count)) {
    appendDispatchJournalEvent(root, ROUND, entry(event, task, attempt));
  }
}

function disposition(
  task: string,
  attempt: number,
  as: DispatchDisposition = 'escalate',
): DispatchJournalEntry {
  return {
    task_id: task,
    attempt,
    event: 'settled',
    outcome: 'cancelled',
    disposition: as,
    disposition_id: 'DSP-0123456789abcdef',
  };
}

type Uncertainty = Pick<TaskRecord, 'id' | 'round_id' | 'status' | 'executor'>;

function agent(id: string, status: TaskRecord['status']): Uncertainty {
  return { id, round_id: ROUND, status, executor: { kind: 'agent' } as TaskRecord['executor'] };
}

/** Run with every host effect recorded in order, then applied. */
async function recording(effects: AuthorityHostEffectRequest[], run: () => void): Promise<void> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'journal-durability' });
  const scope: AuthorityHostEffectScope = {
    action_id: 'round dispatch',
    invocation_id: 'journal-durability',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      effects.push(request);
      return apply();
    },
  };
  try {
    await runWithAuthorityHostEffects(scope, async () => {
      run();
    });
  } finally {
    issuer.dispose();
  }
}

describe('dispatch journal', () => {
  it('records a complete attempt as a hash-linked chain with nothing uncertain', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      appendThrough(root, 5);
      const events = readDispatchJournal(root, ROUND);
      expect(events.map((event) => event.event)).toEqual([...DISPATCH_JOURNAL_EVENTS]);
      expect(events[0]?.previous_sha256).toBeNull();
      expect(events.every((event) => event.experimental)).toBe(true);
      expect(
        events.slice(1).every((event) => /^[a-f0-9]{64}$/u.test(event.previous_sha256 ?? '')),
      ).toBe(true);
      expect(uncertainDispatches(events)).toEqual([]);
    });
  });

  it.each([1, 2, 3, 4])(
    'leaves an attempt that stopped after %i boundary event(s) uncertain',
    async (count) => {
      const root = repository();
      await withAuthorityHostTestScope(async () => {
        appendThrough(root, count);
        expect(uncertainDispatches(readDispatchJournal(root, ROUND))).toEqual([
          { task_id: 'TASK-0040', attempt: 1, last_event: DISPATCH_JOURNAL_EVENTS[count - 1] },
        ]);
      });
    },
  );

  it('leaves no trace when a crash precedes the intent', () => {
    const root = repository();
    expect(readDispatchJournal(root, ROUND)).toEqual([]);
    expect(existsSync(dispatchJournalPath(root, ROUND))).toBe(false);
  });

  it('records a process that never started as intent then exited, without a spawned event', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      appendDispatchJournalEvent(root, ROUND, entry('intent'));
      appendDispatchJournalEvent(root, ROUND, {
        task_id: 'TASK-0040',
        attempt: 1,
        event: 'exited',
        exit_code: null,
        signal: null,
        timed_out: false,
      });
      appendDispatchJournalEvent(root, ROUND, entry('evidence-written'));
      appendDispatchJournalEvent(root, ROUND, entry('settled'));
      expect(uncertainDispatches(readDispatchJournal(root, ROUND))).toEqual([]);
    });
  });

  it('blocks the round on uncertain work until a recorded human disposition closes it', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      appendThrough(root, 2);
      appendThrough(root, 5, 'TASK-0041');
      // A task status, even a terminal one, never clears an open attempt (ADR-MDL-0007).
      for (const status of ['in_progress', 'escalated', 'completed', 'cancelled'] as const) {
        expect(() => assertNoUncertainDispatch(root, ROUND, [agent('TASK-0040', status)])).toThrow(
          'TASK_DISPATCH_UNCERTAIN',
        );
      }
      // The refusal names the task and attempt that need a disposition.
      let refusal: unknown;
      try {
        assertNoUncertainDispatch(root, ROUND, []);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(DispatchUncertainError);
      expect((refusal as DispatchUncertainError).uncertain).toEqual([
        { task_id: 'TASK-0040', attempt: 1, last_event: 'spawned' },
      ]);
      appendDispatchJournalEvent(root, ROUND, disposition('TASK-0040', 1));
      expect(() => assertNoUncertainDispatch(root, ROUND, [])).not.toThrow();
      expect(readDispatchJournal(root, ROUND).at(-1)).toMatchObject({
        event: 'settled',
        outcome: 'cancelled',
        disposition: 'escalate',
      });
    });
  });

  it('treats an agent task left in progress with no journal record as uncertain (IA-004, before intent)', async () => {
    const root = repository();
    expect(uncertainDispatchFindings(root, ROUND, [agent('TASK-0040', 'in_progress')])).toEqual([
      { task_id: 'TASK-0040', attempt: null, last_event: null },
    ]);
    expect(() =>
      assertNoUncertainDispatch(root, ROUND, [agent('TASK-0040', 'in_progress')]),
    ).toThrow('TASK_DISPATCH_UNCERTAIN');
    // Other rounds, other executors and settled states are not this round's uncertainty.
    expect(
      uncertainDispatchFindings(root, ROUND, [
        { ...agent('TASK-0041', 'in_progress'), round_id: 'R-0013' },
        {
          ...agent('TASK-0042', 'in_progress'),
          executor: { kind: 'routine' } as TaskRecord['executor'],
        },
        agent('TASK-0043', 'awaiting_human_review'),
        agent('TASK-0044', 'ready'),
      ]),
    ).toEqual([]);
  });

  it('admits a disposition at any open boundary and refuses an incomplete or misplaced one', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      appendThrough(root, 1);
      expect(() =>
        appendDispatchJournalEvent(root, ROUND, {
          task_id: 'TASK-0040',
          attempt: 1,
          event: 'settled',
          outcome: 'cancelled',
        }),
      ).toThrow('TASK_DISPATCH_JOURNAL_INVALID');
      expect(() =>
        appendDispatchJournalEvent(root, ROUND, {
          ...entry('spawned'),
          disposition: 'retry',
          disposition_id: 'DSP-0123456789abcdef',
        }),
      ).toThrow('TASK_DISPATCH_JOURNAL_INVALID');
      // A provider outcome still needs every boundary; only a human disposition skips them.
      expect(() => appendDispatchJournalEvent(root, ROUND, entry('settled'))).toThrow(
        'TASK_DISPATCH_JOURNAL_ORDER',
      );
      appendDispatchJournalEvent(root, ROUND, disposition('TASK-0040', 1, 'retry'));
      expect(uncertainDispatches(readDispatchJournal(root, ROUND))).toEqual([]);
      // A closed attempt cannot be disposed of again, and nothing opens without an intent.
      expect(() =>
        appendDispatchJournalEvent(root, ROUND, disposition('TASK-0040', 1, 'retry')),
      ).toThrow('TASK_DISPATCH_JOURNAL_ORDER');
      expect(() =>
        appendDispatchJournalEvent(root, ROUND, disposition('TASK-0040', 2, 'retry')),
      ).toThrow('TASK_DISPATCH_JOURNAL_ORDER');
    });
  });

  it('fsyncs the journal directory and every directory it created on the first append', async () => {
    const root = repository();
    const effects: AuthorityHostEffectRequest[] = [];
    await recording(effects, () => {
      appendDispatchJournalEvent(root, ROUND, entry('intent'));
    });
    const journalDir = join(root, '.devai/state/round-runs', ROUND);
    const opened = (path: string): number =>
      effects.findIndex((effect) => effect.symbol === 'openSync' && effect.arguments[0] === path);
    const fileOpened = opened(dispatchJournalPath(root, ROUND));
    const fileSync = effects.findIndex(
      (effect, index) => index > fileOpened && effect.symbol === 'fsyncSync',
    );
    const dirOpened = effects.findIndex(
      (effect, index) =>
        index > fileSync && effect.symbol === 'openSync' && effect.arguments[0] === journalDir,
    );
    expect(fileOpened).toBeGreaterThanOrEqual(0);
    expect(fileSync).toBeGreaterThan(fileOpened);
    expect(dirOpened).toBeGreaterThan(fileSync);
    expect(effects[dirOpened + 1]?.symbol).toBe('fsyncSync');
    // Each created parent is made durable in its own parent before the journal is written.
    for (const parent of [join(root, '.devai'), join(root, '.devai/state'), journalDir]) {
      expect(opened(join(parent, '..')), parent).toBeGreaterThanOrEqual(0);
    }
    // A later append to the existing journal does not need the directory again.
    effects.length = 0;
    await recording(effects, () => {
      appendDispatchJournalEvent(root, ROUND, entry('spawned'));
    });
    expect(opened(journalDir)).toBe(-1);
  });

  it('plans a quarantine only for a damaged journal and moves exactly its bytes aside', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      expect(() => planDispatchJournalQuarantine(root, ROUND)).toThrow(
        'TASK_DISPATCH_JOURNAL_MISSING',
      );
      appendThrough(root, 2);
      expect(() => planDispatchJournalQuarantine(root, ROUND)).toThrow(
        'TASK_DISPATCH_JOURNAL_VALID',
      );
    });
    const path = dispatchJournalPath(root, ROUND);
    appendFileSync(path, '{"schemaVersion":"1.0.0"');
    const damaged = readFileSync(path);
    await withAuthorityHostTestScope(async () => {
      const plan = planDispatchJournalQuarantine(root, ROUND);
      expect(plan.sha256).toBe(createHash('sha256').update(damaged).digest('hex'));
      expect(plan.path).toBe(quarantinedJournalPath(root, ROUND, plan.sha256));
      appendFileSync(path, 'more');
      expect(() => applyDispatchJournalQuarantine(root, ROUND, plan)).toThrow(
        'TASK_DISPATCH_JOURNAL_CHANGED',
      );
      writeFileSync(path, damaged);
      applyDispatchJournalQuarantine(root, ROUND, plan);
      expect(existsSync(path)).toBe(false);
      expect(readFileSync(plan.path).equals(damaged)).toBe(true);
      // The next attempt starts a fresh hash chain.
      expect(
        appendDispatchJournalEvent(root, ROUND, entry('intent', 'TASK-0040', 2)),
      ).toMatchObject({ previous_sha256: null });
    });
  });

  it('refuses an out-of-order or incomplete event before writing a byte', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      expect(() => appendDispatchJournalEvent(root, ROUND, entry('spawned'))).toThrow(
        'TASK_DISPATCH_JOURNAL_ORDER',
      );
      expect(() =>
        appendDispatchJournalEvent(root, ROUND, {
          task_id: 'TASK-0040',
          attempt: 1,
          event: 'intent',
        }),
      ).toThrow('TASK_DISPATCH_JOURNAL_INVALID');
      expect(existsSync(dispatchJournalPath(root, ROUND))).toBe(false);
      appendThrough(root, 5);
      expect(() => appendDispatchJournalEvent(root, ROUND, entry('settled'))).toThrow(
        'TASK_DISPATCH_JOURNAL_ORDER',
      );
    });
  });

  it('refuses a torn final line and a tampered earlier line without repairing them', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      appendThrough(root, 3);
    });
    const path = dispatchJournalPath(root, ROUND);
    const intact = readFileSync(path, 'utf8');

    appendFileSync(path, '{"schemaVersion":"1.0.0","round_id"');
    expect(() => readDispatchJournal(root, ROUND)).toThrow('TASK_DISPATCH_JOURNAL_INVALID');
    expect(() => assertNoUncertainDispatch(root, ROUND, [])).toThrow(
      'TASK_DISPATCH_JOURNAL_INVALID',
    );

    writeFileSync(path, intact.replace('"pid":4242', '"pid":4243'));
    expect(() => readDispatchJournal(root, ROUND)).toThrow('TASK_DISPATCH_JOURNAL_INVALID');

    writeFileSync(path, intact.replace(ROUND, 'R-0099'));
    expect(() => readDispatchJournal(root, ROUND)).toThrow('TASK_DISPATCH_JOURNAL_INVALID');
  });
});
