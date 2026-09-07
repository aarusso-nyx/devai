import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  closePhase,
  computeLedger,
  readClosures,
  type PhaseClosureDraft,
  type PhaseClosureRecord,
} from '../../src/closure/index.js';

const roots: string[] = [];

function repository(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), 'devai-closure-'));
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
      'test: initialize closure fixture',
    ],
    { cwd: root },
  );
  return {
    root,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gateDraft(head: string): PhaseClosureDraft {
  return {
    round_id: 'gate-acknowledgement',
    declaring_decision: 'D-1',
    closing_decision: 'D-2',
    batches: [{ id: 'B1', roles: ['Machine'], commit: head, headline: 'Measured candidate' }],
    gates: { coverage: { status: 'fail' } },
    source_repo_deleted: false,
    validation_criteria: [{ criterion: 'coverage', verdict: 'fail' }],
    merged_as: head,
    release_disposition: 'missing',
    closed_at: '2026-08-10T00:00:00.000Z',
  };
}

describe('closure failure acknowledgement', () => {
  it.each(['precoverage', 'coverage-extra', 'coverage_extra', 'coverage2', 'unrelated'])(
    'refuses partial or absent gate identity %s',
    async (criterion) => {
      const { root, head } = repository();
      await expect(
        withAuthorityHostTestScope(() =>
          closePhase(root, {
            ...gateDraft(head),
            validation_criteria: [{ criterion, verdict: 'fail' }],
          }),
        ),
      ).rejects.toThrow('naming each gate: coverage');
      expect(await withAuthorityHostTestScope(() => readClosures(root))).toEqual([]);
    },
  );

  it.each(['pass', 'n/a'] as const)(
    'does not accept %s as acknowledgement of failure',
    async (verdict) => {
      const { root, head } = repository();
      await expect(
        withAuthorityHostTestScope(() =>
          closePhase(root, {
            ...gateDraft(head),
            validation_criteria: [{ criterion: 'coverage', verdict }],
          }),
        ),
      ).rejects.toThrow('naming each gate: coverage');
    },
  );

  it('requires each failed gate while ignoring passed and skipped gates', async () => {
    const { root, head } = repository();
    const draft: PhaseClosureDraft = {
      ...gateDraft(head),
      gates: {
        coverage: { status: 'fail' },
        mutation: { status: 'fail' },
        build: { status: 'pass' },
        optional: { status: 'skipped' },
      },
    };
    await expect(withAuthorityHostTestScope(() => closePhase(root, draft))).rejects.toThrow(
      'naming each gate: mutation',
    );
    const result = await withAuthorityHostTestScope(() =>
      closePhase(root, {
        ...draft,
        validation_criteria: [
          { criterion: 'unrelated review', verdict: 'pass' },
          { criterion: 'coverage', verdict: 'fail' },
          { criterion: 'retained report', evidence: 'mutation: below threshold', verdict: 'fail' },
        ],
      }),
    );
    expect(result.record.release_disposition).toBe('missing');
    expect(computeLedger([result.record]).rounds[0]?.gates_failed).toEqual([
      'coverage',
      'mutation',
    ]);
  });

  it.each(['test.unit', 'test[unit]', 'test+unit', 'test(unit)'])(
    'matches gate metacharacters literally: %s',
    async (gate) => {
      const { root, head } = repository();
      const result = await withAuthorityHostTestScope(() =>
        closePhase(root, {
          ...gateDraft(head),
          gates: { [gate]: { status: 'fail' } },
          validation_criteria: [
            {
              criterion: 'retained failed evidence',
              evidence: `Result: ${gate}; failed`,
              verdict: 'fail',
            },
          ],
        }),
      );
      expect(computeLedger([result.record]).rounds[0]?.gates_failed).toEqual([gate]);
    },
  );

  it('does not treat a regex-like gate as a wildcard', async () => {
    const { root, head } = repository();
    await expect(
      withAuthorityHostTestScope(() =>
        closePhase(root, {
          ...gateDraft(head),
          gates: { 'test.unit': { status: 'fail' } },
          validation_criteria: [{ criterion: 'testXunit', verdict: 'fail' }],
        }),
      ),
    ).rejects.toThrow('naming each gate: test.unit');
  });

  it.each([undefined, 'HEAD', 'a'.repeat(41), 'a'.repeat(63)])(
    'refuses Machine delivery without exact full commit %s',
    async (commit) => {
      const { root, head } = repository();
      await expect(
        withAuthorityHostTestScope(() =>
          closePhase(root, {
            ...gateDraft(head),
            batches: [
              {
                id: 'B1',
                roles: ['Machine'],
                headline: 'Measured candidate',
                ...(commit === undefined ? {} : { commit }),
              },
            ],
          }),
        ),
      ).rejects.toThrow('does not validate against phase-closure.schema.json');
      expect(await withAuthorityHostTestScope(() => readClosures(root))).toEqual([]);
    },
  );
});

describe('closure records', () => {
  it('derives roles, failed gates, and deletion streak from effective records', () => {
    const base: PhaseClosureRecord = {
      schemaVersion: '1.0.0',
      id: 'PC-0001',
      round_id: 'first',
      title: 'First round',
      closed_at: '2026-08-10T00:00:00.000Z',
      declaring_decision: 'D-1',
      closing_decision: 'D-2',
      batches: [
        { id: 'B1', roles: ['Engineer', 'Inspector'], headline: 'Implementation' },
        { id: 'B2', roles: ['Inspector'], headline: 'Review' },
      ],
      gates: {
        build: { status: 'pass' },
        coverage: { status: 'fail' },
        optional: { status: 'skipped' },
      },
      source_repo_deleted: false,
      validation_criteria: [{ criterion: 'coverage', verdict: 'fail' }],
    };
    const records: PhaseClosureRecord[] = [
      base,
      { ...base, id: 'PC-0002', round_id: 'second', source_repo_deleted: true },
      { ...base, id: 'PC-0003', round_id: 'third' },
    ];
    const ledger = computeLedger(records);
    expect(ledger).toMatchObject({
      count: 3,
      no_deletion_streak: 1,
      streak_basis: 'since records began (PC-0001)',
    });
    expect(ledger.rounds[0]).toEqual({
      id: 'PC-0001',
      round_id: 'first',
      title: 'First round',
      closed_at: base.closed_at,
      declaring_decision: 'D-1',
      closing_decision: 'D-2',
      batch_count: 2,
      roles: ['Engineer', 'Inspector'],
      gates_failed: ['coverage'],
      source_repo_deleted: false,
    });
    expect(
      computeLedger([
        ...records,
        {
          ...base,
          id: 'PC-0004',
          round_id: 'second',
          supersedes: 'PC-0002',
        },
      ]),
    ).toMatchObject({
      count: 3,
      no_deletion_streak: 3,
      rounds: [
        { id: 'PC-0001' },
        { id: 'PC-0002', superseded_by: 'PC-0004' },
        { id: 'PC-0003' },
        { id: 'PC-0004' },
      ],
    });
    expect(computeLedger(records.slice(0, 2)).no_deletion_streak).toBe(0);
  });

  it('chains repeated corrections through the latest closure without changing earlier bytes', async () => {
    const { root, head } = repository();
    const draft: PhaseClosureDraft = {
      round_id: 'repeated-correction',
      declaring_decision: 'D-1',
      closing_decision: 'D-2',
      batches: [{ id: 'B1', roles: ['Inspector'], headline: 'Reviewed closure' }],
      gates: { check: { status: 'pass' } },
      source_repo_deleted: false,
      validation_criteria: [{ criterion: 'check', verdict: 'pass' }],
      merged_as: head,
      release_disposition: 'none-needed',
      closed_at: '2026-08-10T00:00:00.000Z',
    };
    const first = await withAuthorityHostTestScope(() => closePhase(root, draft));
    const firstBytes = readFileSync(first.path);
    const second = await withAuthorityHostTestScope(() =>
      closePhase(root, {
        ...draft,
        supersedes: first.record.id,
        declaring_decision: 'D-3',
        closing_decision: 'D-4',
      }),
    );
    const secondBytes = readFileSync(second.path);
    const third = await withAuthorityHostTestScope(() =>
      closePhase(root, {
        ...draft,
        supersedes: second.record.id,
        declaring_decision: 'D-5',
        closing_decision: 'D-6',
      }),
    );
    expect(third.record.id).toBe('PC-0003');
    expect(readFileSync(first.path)).toEqual(firstBytes);
    expect(readFileSync(second.path)).toEqual(secondBytes);
    const records = await withAuthorityHostTestScope(() => readClosures(root));
    expect(computeLedger(records)).toMatchObject({
      count: 1,
      no_deletion_streak: 1,
      rounds: [
        { id: 'PC-0001', superseded_by: 'PC-0002' },
        { id: 'PC-0002', superseded_by: 'PC-0003' },
        { id: 'PC-0003' },
      ],
    });
    await expect(
      withAuthorityHostTestScope(() =>
        closePhase(root, {
          ...draft,
          supersedes: first.record.id,
          declaring_decision: 'D-7',
          closing_decision: 'D-8',
        }),
      ),
    ).rejects.toThrow("pass supersedes: 'PC-0003'");
    expect(await withAuthorityHostTestScope(() => readClosures(root))).toHaveLength(3);
  });

  it('appends corrections and computes the effective no-deletion ledger', async () => {
    const { root, head } = repository();
    const first = await withAuthorityHostTestScope(() =>
      closePhase(root, {
        round_id: 'rc-validation',
        declaring_decision: 'DII-1',
        closing_decision: 'DII-2',
        batches: [{ id: 'RC-A', roles: ['Engineer'], commit: head, headline: 'RC candidate' }],
        gates: { coverage: { status: 'pass', detail: '70/60/70/70' } },
        source_repo_deleted: false,
        validation_criteria: [{ criterion: 'coverage', verdict: 'pass' }],
        closed_at: '2026-08-10T00:00:00.000Z',
        merged_as: head,
        release_disposition: 'none-needed',
      }),
    );
    expect(first.record.id).toBe('PC-0001');

    const correction = await withAuthorityHostTestScope(() =>
      closePhase(root, {
        round_id: 'rc-validation',
        declaring_decision: 'DII-3',
        closing_decision: 'DII-4',
        supersedes: first.record.id,
        batches: [{ id: 'RC-B', roles: ['Inspector'], headline: 'Corrected evidence' }],
        gates: { coverage: { status: 'pass' } },
        source_repo_deleted: false,
        validation_criteria: [{ criterion: 'coverage', verdict: 'pass' }],
        closed_at: '2026-08-10T00:01:00.000Z',
        merged_as: head,
        release_disposition: 'none-needed',
      }),
    );
    expect(correction.record.id).toBe('PC-0002');

    const records = await withAuthorityHostTestScope(() => readClosures(root));
    expect(records).toHaveLength(2);
    expect(computeLedger(records)).toMatchObject({
      count: 1,
      no_deletion_streak: 1,
      rounds: [{ id: 'PC-0001', superseded_by: 'PC-0002' }, { id: 'PC-0002' }],
    });
    await expect(
      withAuthorityHostTestScope(() =>
        closePhase(root, {
          round_id: 'rc-validation',
          declaring_decision: 'DII-5',
          closing_decision: 'DII-6',
          batches: [{ id: 'RC-C', roles: ['Auditor'], headline: 'Unlinked replacement' }],
          gates: { coverage: { status: 'pass' } },
          source_repo_deleted: false,
          validation_criteria: [{ criterion: 'coverage', verdict: 'pass' }],
          merged_as: head,
          release_disposition: 'none-needed',
        }),
      ),
    ).rejects.toThrow("round_id 'rc-validation' already closed");
    expect(computeLedger([])).toMatchObject({
      count: 0,
      no_deletion_streak: 0,
      streak_basis: 'no closure records yet',
      rounds: [],
    });
  });

  it('fails closed for caller identities, unacknowledged gates, and corrupt records', async () => {
    const { root, head } = repository();
    expect(await withAuthorityHostTestScope(() => readClosures(root))).toEqual([]);

    const base = {
      round_id: 'invalid-close',
      declaring_decision: 'DII-10',
      closing_decision: 'DII-11',
      batches: [{ id: 'RC-X', roles: ['Engineer'] as const, headline: 'Candidate' }],
      gates: { coverage: { status: 'pass' as const } },
      source_repo_deleted: false,
      validation_criteria: [{ criterion: 'coverage', verdict: 'pass' as const }],
      closed_at: '2026-08-10T00:02:00.000Z',
      merged_as: head,
      release_disposition: 'none-needed' as const,
    };
    await expect(
      withAuthorityHostTestScope(() => closePhase(root, { ...base, id: 'PC-9999' } as never)),
    ).rejects.toThrow('caller-supplied id is forbidden');
    await expect(
      withAuthorityHostTestScope(() =>
        closePhase(root, {
          ...base,
          gates: { coverage: { status: 'fail' } },
          validation_criteria: [{ criterion: 'release', verdict: 'fail' }],
        }),
      ),
    ).rejects.toThrow('failed gates require explicit failing validation criteria');
    await expect(
      withAuthorityHostTestScope(() => closePhase(root, { ...base, round_id: '' })),
    ).rejects.toThrow('draft does not validate against phase-closure.schema.json');
    await expect(
      withAuthorityHostTestScope(() =>
        closePhase(root, {
          ...base,
          batches: [
            { id: 'RC-X', roles: ['Engineer'], commit: '0'.repeat(40), headline: 'Candidate' },
          ],
        }),
      ),
    ).rejects.toThrow('does not resolve to a Git commit');
    await expect(
      withAuthorityHostTestScope(() => closePhase(root, { ...base, closing_decision: 'D-11' })),
    ).rejects.toThrow('use different namespaces');
    await expect(
      withAuthorityHostTestScope(() => closePhase(root, { ...base, closing_decision: 'DII-10' })),
    ).rejects.toThrow('must strictly follow declaring decision');
    await expect(
      withAuthorityHostTestScope(() => closePhase(root, { ...base, merged_as: undefined })),
    ).rejects.toThrow('merged_as is required');
    await expect(
      withAuthorityHostTestScope(() =>
        closePhase(root, { ...base, release_disposition: undefined }),
      ),
    ).rejects.toThrow('release_disposition is required');
    await expect(
      withAuthorityHostTestScope(() => closePhase(root, { ...base, supersedes: 'PC-9999' })),
    ).rejects.toThrow('supersedes PC-9999 does not exist');

    const closures = join(root, 'record/proofs/compliance/closures');
    mkdirSync(closures, { recursive: true });
    const path = join(closures, 'PC-0001.json');
    writeFileSync(path, '{');
    await expect(withAuthorityHostTestScope(() => readClosures(root))).rejects.toThrow(
      'is malformed',
    );
    writeFileSync(path, JSON.stringify({ schemaVersion: '1.0.0', id: 'PC-0002' }));
    await expect(withAuthorityHostTestScope(() => readClosures(root))).rejects.toThrow(
      "declares mismatched id 'PC-0002'",
    );
    writeFileSync(path, JSON.stringify({ schemaVersion: '1.0.0', id: 'PC-0001' }));
    await expect(withAuthorityHostTestScope(() => readClosures(root))).rejects.toThrow(
      'does not validate against phase-closure.schema.json',
    );
  });
});
