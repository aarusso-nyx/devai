import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { closePhase, computeLedger, readClosures } from '../../src/closure/index.js';

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

describe('closure records', () => {
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
