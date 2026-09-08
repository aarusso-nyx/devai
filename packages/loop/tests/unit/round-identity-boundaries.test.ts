// Invariants: INV-DEVAI-001, INV-DEVAI-015
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  closeGovernedRound,
  declareGovernedRound,
  governedRoundStatus,
  scaffoldGovernedRound,
} from '../../src/round-lifecycle/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function write(root: string, path: string, value: unknown): string {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  return target;
}
function record() {
  return {
    schemaVersion: '1.0.0',
    id: 'R-0005',
    title: 'Identity-bound round',
    type: 'round-record',
    status: 'closed',
    date: '2026-07-24',
    authority: 'Architect',
    kind: 'round',
    goal: 'Verify exact closure identity',
    declared_by: 'DII-1',
    closed_by: 'DII-2',
    phase_closure: 'PC-0001',
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
function closure() {
  return {
    schemaVersion: '1.0.0',
    id: 'PC-0001',
    round_id: 'R-0005',
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
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-identity-'));
  roots.push(root);
  scaffoldGovernedRound({ repoRoot: root, round: 5 });
  const value = record();
  expect(validators.recordMeta(value)).toBe(true);
  declareGovernedRound({ repoRoot: root, round: 5, recordPath: write(root, 'record.json', value) });
  const proof = closure();
  expect(validators.phaseClosure(proof)).toBe(true);
  write(root, 'record/proofs/compliance/closures/PC-0001.json', proof);
  write(
    root,
    'law/register/DECISIONS.md',
    '### DII-1 — Declare fixture\n\n### DII-2 — Close fixture\n',
  );
  write(root, 'record/derived/indexes/rounds.md', 'PC-0001\n');
  return root;
}

describe('round identity boundaries', () => {
  it('refuses status when the valid record belongs to another round', async () => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      const path = join(root, 'work/rounds/R-0005/record.md');
      const changed = readFileSync(path, 'utf8').replace('id: "R-0005"', 'id: "R-0006"');
      writeFileSync(path, changed);
      expect(() => governedRoundStatus({ repoRoot: root, round: 5 })).toThrow(
        'ROUND_RECORD_ID_MISMATCH',
      );
      expect(readFileSync(path, 'utf8')).toBe(changed);
    });
  });

  it.each([
    ['id', 'PC-0002'],
    ['round_id', 'R-0006'],
    ['declaring_decision', 'DII-3'],
    ['closing_decision', 'DII-4'],
    ['merged_as', 'c'.repeat(40)],
  ])(
    'refuses a schema-valid closure with mismatched %s without recording completion',
    async (field, value) => {
      await withAuthorityHostTestScope(() => {
        const root = fixture();
        const proof = { ...closure(), [field]: value };
        expect(validators.phaseClosure(proof)).toBe(true);
        const path = write(root, 'record/proofs/compliance/closures/PC-0001.json', proof);
        const before = readFileSync(path);
        expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
          'ROUND_ARCHIVE_PHASE_CLOSURE_MISMATCH',
        );
        expect(existsSync(join(root, 'work/rounds/R-0005/close-state.jsonl'))).toBe(false);
        expect(readFileSync(path)).toEqual(before);
      });
    },
  );

  it('records exact closure bindings once and preserves the evidence and working papers', async () => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      const paths = [
        'work/rounds/R-0005/record.md',
        'work/rounds/R-0005/plan.md',
        'work/rounds/R-0005/prompts/00-orchestrator.md',
        'record/proofs/compliance/closures/PC-0001.json',
      ];
      const before = paths.map((path) => readFileSync(join(root, path)));
      const first = closeGovernedRound({ repoRoot: root, round: 5 });
      expect(first).toEqual({
        ok: true,
        id: 'R-0005',
        path: 'work/rounds/R-0005',
        close_state: 'work/rounds/R-0005/close-state.jsonl',
      });
      const bytes = readFileSync(join(root, first.close_state), 'utf8');
      expect(bytes).toBe(
        JSON.stringify({
          schemaVersion: '1.0.0',
          round_id: 'R-0005',
          status: 'closed',
          closing_decision: 'DII-2',
          phase_closure: 'PC-0001',
          merged_as: 'b'.repeat(40),
        }) + '\n',
      );
      expect(closeGovernedRound({ repoRoot: root, round: 5 })).toEqual(first);
      expect(readFileSync(join(root, first.close_state), 'utf8')).toBe(bytes);
      expect(paths.map((path) => readFileSync(join(root, path)))).toEqual(before);
    });
  });

  it.each(['fail', 'skipped', 'missing'])(
    'refuses a %s required gate without creating close state',
    async (status) => {
      await withAuthorityHostTestScope(() => {
        const root = fixture();
        const proof = {
          ...closure(),
          gates: status === 'missing' ? { other: { status: 'pass' } } : { unit: { status } },
        };
        expect(validators.phaseClosure(proof)).toBe(true);
        write(root, 'record/proofs/compliance/closures/PC-0001.json', proof);
        expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
          'ROUND_ARCHIVE_GATE_NOT_GREEN:unit',
        );
        expect(existsSync(join(root, 'work/rounds/R-0005/close-state.jsonl'))).toBe(false);
      });
    },
  );

  it('checks every validation criterion even when an earlier one passes', async () => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      const proof = closure();
      proof.validation_criteria.push({
        criterion: 'second independent criterion',
        verdict: 'fail',
        evidence: 'rejected fixture',
      });
      expect(validators.phaseClosure(proof)).toBe(true);
      write(root, 'record/proofs/compliance/closures/PC-0001.json', proof);
      expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
        'ROUND_ARCHIVE_VALIDATION_NOT_GREEN',
      );
      expect(existsSync(join(root, 'work/rounds/R-0005/close-state.jsonl'))).toBe(false);
    });
  });

  it.each(['plan.md', 'prompts/00-orchestrator.md'])(
    'requires the declared %s working artifact',
    async (artifact) => {
      await withAuthorityHostTestScope(() => {
        const root = fixture();
        rmSync(join(root, 'work/rounds/R-0005', artifact));
        expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
          `ROUND_ARCHIVE_REQUIRED_ARTIFACT_MISSING:${artifact}`,
        );
        expect(existsSync(join(root, 'work/rounds/R-0005/close-state.jsonl'))).toBe(false);
      });
    },
  );

  it.each(['DII-1', 'DII-2'])('requires the exact %s decision before closure', async (missing) => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      const present = missing === 'DII-1' ? 'DII-2' : 'DII-1';
      write(root, 'law/register/DECISIONS.md', `### ${present} — Existing decision\n`);
      expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
        `ROUND_ARCHIVE_DECISION_MISSING:${missing}`,
      );
      expect(existsSync(join(root, 'work/rounds/R-0005/close-state.jsonl'))).toBe(false);
    });
  });

  it('preserves a conflicting existing close state byte for byte', async () => {
    await withAuthorityHostTestScope(() => {
      const root = fixture();
      const bytes = '{"round_id":"R-0006","status":"closed"}\n';
      const path = write(root, 'work/rounds/R-0005/close-state.jsonl', bytes);
      expect(() => closeGovernedRound({ repoRoot: root, round: 5 })).toThrow(
        'ROUND_CLOSE_STATE_CONFLICT',
      );
      expect(readFileSync(path, 'utf8')).toBe(bytes);
    });
  });
});
