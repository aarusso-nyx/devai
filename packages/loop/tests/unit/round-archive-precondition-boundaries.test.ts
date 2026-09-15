import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  closeGovernedRound,
  declareGovernedRound,
  scaffoldGovernedRound,
} from '../../src/round-lifecycle/index.js';

const roots: string[] = [];
const ROUND = 'R-0005';
const CLOSURE = 'PC-0001';
const CLOSE_STATE = join('work/rounds', ROUND, 'close-state.jsonl');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, value: unknown): string {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  return target;
}

function record(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: ROUND,
    title: 'Archive precondition fixture',
    type: 'round-record',
    status: 'closed',
    date: '2026-07-24',
    authority: 'Architect',
    kind: 'round',
    goal: 'Verify archive preconditions',
    declared_by: 'DII-1',
    closed_by: 'DII-2',
    phase_closure: CLOSURE,
    merged_as: 'b'.repeat(40),
    isolation: { kind: 'worktree', branch: 'fixture', base_sha: 'a'.repeat(40) },
    waves: [
      {
        id: 'W1',
        title: 'Verify',
        roles: ['Inspector'],
        type: 'serial',
        lock_scopes: ['tests/**'],
        gates: ['unit'],
      },
    ],
    gates: ['unit'],
    orchestrator_prompt: 'prompts/00-orchestrator.md',
    plan_path: 'plan.md',
  };
}

function closure(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: CLOSURE,
    round_id: ROUND,
    declaring_decision: 'DII-1',
    closing_decision: 'DII-2',
    batches: [{ id: 'B1', roles: ['Architect'], headline: 'fixture' }],
    gates: { unit: { status: 'pass' } },
    source_repo_deleted: false,
    validation_criteria: [{ criterion: 'fixture', verdict: 'pass', evidence: 'unit' }],
    closed_at: '2026-07-26T00:00:00.000Z',
    merged_as: 'b'.repeat(40),
    release_disposition: 'none-needed',
  };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-archive-preconditions-'));
  roots.push(root);
  scaffoldGovernedRound({ repoRoot: root, round: 5 });
  const value = record();
  expect(validators.recordMeta(value), JSON.stringify(validators.recordMeta.errors)).toBe(true);
  declareGovernedRound({ repoRoot: root, round: 5, recordPath: write(root, 'record.json', value) });
  const proof = closure();
  expect(validators.phaseClosure(proof), JSON.stringify(validators.phaseClosure.errors)).toBe(true);
  write(root, 'record/proofs/compliance/closures/PC-0001.json', proof);
  write(
    root,
    'law/register/DECISIONS.md',
    '### DII-1 — Declare fixture\n\n### DII-2 — Close fixture\n',
  );
  write(root, 'record/derived/indexes/rounds.md', 'PC-0001\n');
  return root;
}

function closeStateExists(root: string): boolean {
  return existsSync(join(root, CLOSE_STATE));
}

describe('round archive preconditions', () => {
  it('refuses an invalid archived record before writing close state', async () => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      write(root, 'work/rounds/R-0005/record.md', '---\nid: R-0005\nstatus: closed\n---\n');

      expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
        'ROUND_ARCHIVE_RECORD_INVALID',
      );
      expect(closeStateExists(root)).toBe(false);
    });
  });

  it('refuses an archived record whose id differs from the requested round', async () => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      const path = join(root, 'work/rounds/R-0005/record.md');
      writeFileSync(path, readFileSync(path, 'utf8').replace('id: "R-0005"', 'id: "R-0006"'));

      expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
        'ROUND_ARCHIVE_RECORD_ID_MISMATCH',
      );
      expect(closeStateExists(root)).toBe(false);
    });
  });

  it('refuses an archived record that is not closed', async () => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      const path = join(root, 'work/rounds/R-0005/record.md');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace('status: "closed"', 'status: "active"'),
      );

      expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
        'ROUND_ARCHIVE_RECORD_NOT_CLOSED',
      );
      expect(closeStateExists(root)).toBe(false);
    });
  });

  it('refuses a missing phase-closure proof', async () => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      rmSync(join(root, 'record/proofs/compliance/closures/PC-0001.json'));

      expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
        'ROUND_ARCHIVE_PHASE_CLOSURE_MISSING:PC-0001',
      );
      expect(closeStateExists(root)).toBe(false);
    });
  });

  it('refuses an invalid phase-closure proof', async () => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      write(root, 'record/proofs/compliance/closures/PC-0001.json', '{}');

      expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
        'ROUND_ARCHIVE_PHASE_CLOSURE_INVALID',
      );
      expect(closeStateExists(root)).toBe(false);
    });
  });

  it('refuses malformed phase-closure JSON with the archive-specific error', async () => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      write(root, 'record/proofs/compliance/closures/PC-0001.json', '{');

      expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
        'ROUND_ARCHIVE_PHASE_CLOSURE_INVALID',
      );
      expect(closeStateExists(root)).toBe(false);
    });
  });

  it('refuses a phase-closure proof with mismatched round identity', async () => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      write(root, 'record/proofs/compliance/closures/PC-0001.json', {
        ...closure(),
        round_id: 'R-0006',
      });

      expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
        'ROUND_ARCHIVE_PHASE_CLOSURE_MISMATCH',
      );
      expect(closeStateExists(root)).toBe(false);
    });
  });

  it('refuses a phase ledger that does not contain the closure id', async () => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      write(root, 'record/derived/indexes/rounds.md', 'PC-0002\n');

      expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
        'ROUND_ARCHIVE_PHASE_LEDGER_MISSING',
      );
      expect(closeStateExists(root)).toBe(false);
    });
  });
});
