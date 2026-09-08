import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  closePhase,
  computeLedger,
  readClosures,
  type PhaseClosureDraft,
  type PhaseClosureRecord,
} from '../../src/closure/index.js';

/**
 * Closure boundaries the ledger contract states but the existing suite only
 * observes through generic diagnostics: the exact identity named in each
 * refusal, the persisted receipt bytes, the append-only guard against a record
 * that appears after the ledger snapshot, and the supersession graph.
 */

const interloper = vi.hoisted(() => ({
  afterMkdir: undefined as ((dir: string) => void) | undefined,
}));
vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const original = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...original,
    mkdirSync: (...args: Parameters<typeof original.mkdirSync>) => {
      const result = original.mkdirSync(...args);
      if (typeof args[0] === 'string' && interloper.afterMkdir !== undefined) {
        const callback = interloper.afterMkdir;
        interloper.afterMkdir = undefined;
        callback(args[0]);
      }
      return result;
    },
  };
});

const roots: string[] = [];

function repository(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), 'devai-closure-boundaries-'));
  roots.push(root);
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=devai-test@example.invalid',
      'commit',
      '-m',
      'test: initialize closure boundary fixture',
    ],
    { cwd: root },
  );
  return {
    root,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  };
}

afterEach(() => {
  interloper.afterMkdir = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CLOSURES = 'record/proofs/compliance/closures';
const UNREACHABLE_COMMIT = '0'.repeat(40);
const UNREACHABLE_MERGE = '1'.repeat(40);

function shippedDraft(head: string): PhaseClosureDraft {
  return {
    round_id: 'closure-boundaries',
    title: 'Closure boundary evidence',
    declaring_decision: 'D-110',
    closing_decision: 'D-111',
    batches: [{ id: 'B1', roles: ['Engineer'], headline: 'Closure ledger diagnostics' }],
    gates: { coverage: { status: 'pass', detail: 'thresholds met' } },
    source_repo_deleted: false,
    validation_criteria: [{ criterion: 'coverage', verdict: 'pass' }],
    merged_as: head,
    release_disposition: 'none-needed',
    closed_at: '2026-09-08T00:00:00.000Z',
  };
}

async function refusalMessage(action: () => unknown): Promise<string> {
  const failure = await withAuthorityHostTestScope(action).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  return (failure as Error).message;
}

describe('closure refusals name the exact rejected identity', () => {
  it.each(['\ud83d', '\ude80'])(
    'does not acknowledge a gate by matching only one UTF-16 half of an emoji: %j',
    async (gate) => {
      const { root, head } = repository();
      // Gate property names currently allow any nonblank JSON string. Matching
      // a fragment of an astral character must not acknowledge a different ID.
      const message = await refusalMessage(() =>
        closePhase(root, {
          ...shippedDraft(head),
          gates: { [gate]: { status: 'fail' } },
          validation_criteria: [{ criterion: 'failed 🚀 gate', verdict: 'fail' }],
        }),
      );
      expect(message).toBe(
        `phase close: failed gates require explicit failing validation criteria naming each gate: ${gate}`,
      );
      expect(await withAuthorityHostTestScope(() => readClosures(root))).toEqual([]);
    },
  );

  it.each(['🚀', '\ud83d', '\ude80'])(
    'accepts an explicitly acknowledged Unicode gate identity %j',
    async (gate) => {
      const { root, head } = repository();
      const result = await withAuthorityHostTestScope(() =>
        closePhase(root, {
          ...shippedDraft(head),
          gates: { [gate]: { status: 'fail' } },
          validation_criteria: [{ criterion: `failed ${gate} gate`, verdict: 'fail' }],
        }),
      );
      expect(result.record.gates).toEqual({ [gate]: { status: 'fail' } });
      expect(result.record.validation_criteria).toEqual([
        { criterion: `failed ${gate} gate`, verdict: 'fail' },
      ]);
    },
  );

  it('names the batch and the commit identity that does not resolve', async () => {
    const { root, head } = repository();
    const message = await refusalMessage(() =>
      closePhase(root, {
        ...shippedDraft(head),
        batches: [
          {
            id: 'B1',
            roles: ['Engineer'],
            commit: UNREACHABLE_COMMIT,
            headline: 'Closure ledger diagnostics',
          },
        ],
      }),
    );
    expect(message).toBe(
      `phase close: batch 'B1' commit '${UNREACHABLE_COMMIT}' does not resolve to a Git commit`,
    );
    expect(await withAuthorityHostTestScope(() => readClosures(root))).toEqual([]);
  });

  it('names merged_as and the merge identity that does not resolve', async () => {
    const { root, head } = repository();
    const message = await refusalMessage(() =>
      closePhase(root, { ...shippedDraft(head), merged_as: UNREACHABLE_MERGE }),
    );
    expect(message).toBe(
      `phase close: merged_as '${UNREACHABLE_MERGE}' does not resolve to a Git commit`,
    );
    expect(await withAuthorityHostTestScope(() => readClosures(root))).toEqual([]);
  });

  it('lists every unacknowledged failed gate in one refusal', async () => {
    const { root, head } = repository();
    const message = await refusalMessage(() =>
      closePhase(root, {
        ...shippedDraft(head),
        gates: {
          coverage: { status: 'fail' },
          mutation: { status: 'fail' },
          build: { status: 'pass' },
        },
        validation_criteria: [{ criterion: 'build', verdict: 'pass' }],
      }),
    );
    expect(message).toBe(
      'phase close: failed gates require explicit failing validation criteria naming each gate: coverage, mutation',
    );
    expect(await withAuthorityHostTestScope(() => readClosures(root))).toEqual([]);
  });
});

describe('closure schema diagnostics keep the offending location', () => {
  it('reports a missing top-level draft field at the document root', async () => {
    const { root, head } = repository();
    const { gates: _gates, ...withoutGates } = shippedDraft(head);
    const message = await refusalMessage(() =>
      closePhase(root, withoutGates as unknown as PhaseClosureDraft),
    );
    expect(message).toBe(
      "phase close: draft does not validate against phase-closure.schema.json: / must have required property 'gates'",
    );
    expect(await withAuthorityHostTestScope(() => readClosures(root))).toEqual([]);
  });

  it('reports a missing top-level field of a stored closure at the document root', async () => {
    const { root, head } = repository();
    const first = await withAuthorityHostTestScope(() => closePhase(root, shippedDraft(head)));
    const { closed_at: _closedAt, ...withoutClosedAt } = first.record;
    const broken = JSON.stringify(withoutClosedAt);
    writeFileSync(first.path, broken);
    const message = await refusalMessage(() => readClosures(root));
    expect(message).toBe(
      'phase closure PC-0001.json does not validate against phase-closure.schema.json: ' +
        "/ must have required property 'closed_at'",
    );
    expect(readFileSync(first.path, 'utf8')).toBe(broken);
  });
});

describe('closure supersession graph', () => {
  it('refuses a supersedes target that no stored closure carries', async () => {
    const { root, head } = repository();
    const first = await withAuthorityHostTestScope(() => closePhase(root, shippedDraft(head)));
    expect(first.record.id).toBe('PC-0001');
    const message = await refusalMessage(() =>
      closePhase(root, {
        ...shippedDraft(head),
        round_id: 'later-round',
        supersedes: 'PC-9999',
      }),
    );
    expect(message).toBe('phase close: supersedes PC-9999 does not exist');
    const records = await withAuthorityHostTestScope(() => readClosures(root));
    expect(records.map((record) => record.id)).toEqual(['PC-0001']);
  });

  /**
   * The declared contract binds `supersedes` to an existing closure id and
   * nothing else: the schema calls it "set when this record corrects an earlier
   * closure", and `closePhase` only checks that the target exists. Correcting
   * across round_ids is therefore accepted, and the ledger annotates the target
   * rather than dropping it — this test records that declared behaviour, not a
   * restriction the contract does not state.
   */
  it('accepts a correction whose target closed a different round and annotates it', async () => {
    const { root, head } = repository();
    const first = await withAuthorityHostTestScope(() => closePhase(root, shippedDraft(head)));
    const correction = await withAuthorityHostTestScope(() =>
      closePhase(root, {
        ...shippedDraft(head),
        round_id: 'later-round',
        supersedes: first.record.id,
        closed_at: '2026-09-08T00:01:00.000Z',
      }),
    );
    expect(correction.record.id).toBe('PC-0002');
    const ledger = computeLedger(await withAuthorityHostTestScope(() => readClosures(root)));
    expect(ledger.rounds).toMatchObject([
      { id: 'PC-0001', round_id: 'closure-boundaries', superseded_by: 'PC-0002' },
      { id: 'PC-0002', round_id: 'later-round' },
    ]);
    expect(ledger.count).toBe(1);
  });
});

describe('closure receipts and append-only writes', () => {
  it('returns the canonical path and writes exactly the returned record', async () => {
    const { root, head } = repository();
    const result = await withAuthorityHostTestScope(() => closePhase(root, shippedDraft(head)));
    expect(result.path).toBe(join(root, CLOSURES, 'PC-0001.json'));
    const bytes = readFileSync(result.path, 'utf8');
    expect(bytes).toBe(`${JSON.stringify(result.record, null, 2)}\n`);
    expect(await withAuthorityHostTestScope(() => readClosures(root))).toStrictEqual([
      result.record,
    ]);
  });

  it('refuses to overwrite a closure that appears after the ledger read', async () => {
    const { root, head } = repository();
    const retained = 'a concurrently written closure record must survive untouched\n';
    let occupied: string | undefined;
    interloper.afterMkdir = (dir) => {
      occupied = join(dir, 'PC-0001.json');
      writeFileSync(occupied, retained);
    };
    const message = await refusalMessage(() => closePhase(root, shippedDraft(head)));
    expect(occupied).toBe(join(root, CLOSURES, 'PC-0001.json'));
    expect(message).toBe(
      `phase close: ${join(root, CLOSURES, 'PC-0001.json')} already exists (closures are append-only)`,
    );
    expect(readFileSync(join(root, CLOSURES, 'PC-0001.json'), 'utf8')).toBe(retained);
  });
});

describe('closure ledger rounds', () => {
  it('omits optional fields the record does not carry instead of emitting them as undefined', () => {
    const record: PhaseClosureRecord = {
      schemaVersion: '1.0.0',
      id: 'PC-0001',
      round_id: 'untitled-round',
      closed_at: '2026-09-08T00:00:00.000Z',
      declaring_decision: 'D-110',
      closing_decision: 'D-111',
      batches: [{ id: 'B1', roles: ['Engineer'], headline: 'Closure ledger diagnostics' }],
      gates: { coverage: { status: 'pass' } },
      source_repo_deleted: false,
      validation_criteria: [{ criterion: 'coverage', verdict: 'pass' }],
    };
    const round = computeLedger([record]).rounds[0];
    expect(round).toStrictEqual({
      id: 'PC-0001',
      round_id: 'untitled-round',
      closed_at: '2026-09-08T00:00:00.000Z',
      declaring_decision: 'D-110',
      closing_decision: 'D-111',
      batch_count: 1,
      roles: ['Engineer'],
      gates_failed: [],
      source_repo_deleted: false,
    });
    expect(Object.keys(round ?? {})).not.toContain('title');
    expect(computeLedger([{ ...record, title: 'Titled round' }]).rounds[0]?.title).toBe(
      'Titled round',
    );
  });
});
