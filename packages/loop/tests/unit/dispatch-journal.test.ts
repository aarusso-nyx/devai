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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  DISPATCH_JOURNAL_EVENTS,
  appendDispatchJournalEvent,
  assertNoUncertainDispatch,
  dispatchJournalPath,
  readDispatchJournal,
  uncertainDispatches,
  type DispatchJournalEntry,
} from '../../src/loop/dispatch-journal.js';

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

  it('blocks the round on uncertain work until a human disposes of the task', async () => {
    const root = repository();
    await withAuthorityHostTestScope(async () => {
      appendThrough(root, 2);
      appendThrough(root, 5, 'TASK-0041');
      expect(() =>
        assertNoUncertainDispatch(root, ROUND, [
          { id: 'TASK-0040', status: 'in_progress' },
          { id: 'TASK-0041', status: 'completed' },
        ]),
      ).toThrow('TASK_DISPATCH_UNCERTAIN');
      // An unknown task is treated as undisposed, never as safe.
      expect(() => assertNoUncertainDispatch(root, ROUND, [])).toThrow('TASK_DISPATCH_UNCERTAIN');
      expect(() =>
        assertNoUncertainDispatch(root, ROUND, [{ id: 'TASK-0040', status: 'escalated' }]),
      ).not.toThrow();
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
