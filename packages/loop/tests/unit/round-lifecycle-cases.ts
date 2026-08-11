import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RoundLifecycleError,
  closeGovernedRound,
  declareGovernedRound,
  governedRoundStatus,
  normalizeRoundId,
  scaffoldDecisionRecord,
  scaffoldGovernedRound,
} from '../../src/round-lifecycle/index.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-round-lifecycle-'));
  roots.push(path);
  return path;
}

function write(repo: string, rel: string, value: unknown): string {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

function record(id: string): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id,
    title: `${id} fixture`,
    type: 'round-record',
    status: 'draft',
    date: '2026-07-24',
    authority: 'Architect',
    kind: 'round',
    goal: 'Exercise lifecycle behavior',
    declared_by: 'D-1',
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

describe('round lifecycle normalization', () => {
  it.each([
    [1, 'R-0001'],
    ['1', 'R-0001'],
    ['R-42', 'R-0042'],
    [' 9999 ', 'R-9999'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeRoundId(input)).toBe(expected);
  });

  it.each(['', '0', -1, 'R-00000', 'R-x', '1.5'])('rejects invalid id %s', (input) => {
    expect(() => normalizeRoundId(input)).toThrowError(
      expect.objectContaining<Partial<RoundLifecycleError>>({ code: 'ROUND_ID_INVALID' }),
    );
  });
});

describe('round lifecycle filesystem behavior', () => {
  it('scaffolds once and fails closed without an authority host scope', async () => {
    const repo = root();
    expect(() => scaffoldGovernedRound({ repoRoot: repo, round: 1 })).toThrow(
      'AUTHORITY_FINAL_BOUNDARY_REQUIRED',
    );
    await withAuthorityHostTestScope(() => {
      const result = scaffoldGovernedRound({ repoRoot: repo, round: 1 });
      expect(result).toMatchObject({
        ok: true,
        id: 'R-0001',
        path: 'work/rounds/R-0001',
      });
      expect(result.files).toEqual([
        'work/rounds/R-0001/plan.md',
        'work/rounds/R-0001/prompts/00-orchestrator.md',
      ]);
      expect(() => scaffoldGovernedRound({ repoRoot: repo, round: 1 })).toThrow(
        'ROUND_ALREADY_EXISTS',
      );
    });
  });

  it('validates declaration input and renders the accepted current record shape', async () => {
    const repo = root();
    await withAuthorityHostTestScope(() => {
      expect(() =>
        declareGovernedRound({ repoRoot: repo, round: 2, recordPath: 'missing' }),
      ).toThrow('ROUND_SCAFFOLD_MISSING');
      scaffoldGovernedRound({ repoRoot: repo, round: 2 });
      expect(() =>
        declareGovernedRound({
          repoRoot: repo,
          round: 2,
          recordPath: write(repo, 'bad.json', '{bad'),
        }),
      ).toThrow('ROUND_RECORD_INPUT_INVALID');
      expect(() =>
        declareGovernedRound({
          repoRoot: repo,
          round: 2,
          recordPath: write(repo, 'invalid.json', { id: 'R-0002' }),
        }),
      ).toThrow('ROUND_RECORD_SCHEMA_INVALID');
      expect(() =>
        declareGovernedRound({
          repoRoot: repo,
          round: 2,
          recordPath: write(repo, 'mismatch.json', record('R-0003')),
        }),
      ).toThrow('ROUND_RECORD_ID_MISMATCH');

      const declared = declareGovernedRound({
        repoRoot: repo,
        round: 2,
        recordPath: write(repo, 'record.json', record('R-0002')),
      });
      expect(declared).toMatchObject({
        ok: true,
        id: 'R-0002',
        path: 'work/rounds/R-0002/record.md',
      });
      expect(governedRoundStatus({ repoRoot: repo, round: 2 })).toMatchObject({
        ok: true,
        id: 'R-0002',
        location: 'active',
        record: { title: 'R-0002 fixture', type: 'round-record', authority: 'Architect' },
      });
    });
  });

  it('KR-R5-020 round-trips a declaration and closes it idempotently via DII register entries', async () => {
    const repo = root();
    await withAuthorityHostTestScope(() => {
      scaffoldGovernedRound({ repoRoot: repo, round: 5 });
      const closed = {
        ...record('R-0005'),
        declared_by: 'DII-1',
        status: 'closed',
        closed_by: 'DII-2',
        phase_closure: 'PC-0001',
        merged_as: 'b'.repeat(40),
      };
      declareGovernedRound({
        repoRoot: repo,
        round: 5,
        recordPath: write(repo, 'record.json', closed),
      });
      write(
        repo,
        'law/register/DECISIONS.md',
        '### DII-1 — Declare fixture\n\n### DII-2 — Close fixture\n',
      );
      write(repo, 'record/proofs/compliance/closures/PC-0001.json', {
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
      });
      write(repo, 'record/derived/indexes/rounds.md', 'PC-0001\n');

      expect(closeGovernedRound({ repoRoot: repo, round: 5 })).toMatchObject({
        ok: true,
        id: 'R-0005',
        path: 'work/rounds/R-0005',
      });
      expect(closeGovernedRound({ repoRoot: repo, round: 5 })).toMatchObject({ ok: true });
      expect(governedRoundStatus({ repoRoot: repo, round: 5 })).toMatchObject({
        location: 'closed',
      });
    });
  });

  it('rejects unsupported record serialization and absent close prerequisites', async () => {
    const repo = root();
    await withAuthorityHostTestScope(() => {
      scaffoldGovernedRound({ repoRoot: repo, round: 3 });
      const unsupported = record('R-0003');
      const firstWave = (unsupported['waves'] as Array<Record<string, unknown>>)[0];
      if (firstWave === undefined) throw new Error('fixture requires a wave');
      firstWave['roles'] = [{}];
      expect(() =>
        declareGovernedRound({
          repoRoot: repo,
          round: 3,
          recordPath: write(repo, 'unsupported.json', unsupported),
        }),
      ).toThrow('ROUND_RECORD_SERIALIZATION_UNSUPPORTED');

      expect(() => closeGovernedRound({ repoRoot: repo, round: 4 })).toThrow(
        'ROUND_ARCHIVE_SOURCE_MISSING',
      );
      expect(() => closeGovernedRound({ repoRoot: repo, round: 3 })).toThrow(
        'ROUND_ARCHIVE_RECORD_MISSING',
      );
    });
  });

  it('increments decision ids and supplies deterministic defaults', async () => {
    const repo = root();
    write(repo, 'law/register/D-2.md', 'existing');
    write(repo, 'law/register/D-9.md', 'existing');
    await withAuthorityHostTestScope(() => {
      expect(
        scaffoldDecisionRecord({
          repoRoot: repo,
          title: '  ',
          round: 'R-0007',
          now: '2026-07-24T12:00:00.000Z',
        }),
      ).toEqual({ ok: true, id: 'D-10', path: 'law/register/D-10.md' });
      expect(readFileSync(join(repo, 'law/register/D-10.md'), 'utf8')).toContain(
        'superseded_by: null',
      );
      expect(
        scaffoldDecisionRecord({
          repoRoot: repo,
          title: 'Explicit decision',
          now: '2026-07-25T12:00:00.000Z',
        }),
      ).toEqual({ ok: true, id: 'D-11', path: 'law/register/D-11.md' });
    });
  });

  it('reports a missing record when no in-place declaration exists', () => {
    expect(() => governedRoundStatus({ repoRoot: root(), round: 99 })).toThrow(
      'ROUND_RECORD_NOT_FOUND',
    );
  });
});
