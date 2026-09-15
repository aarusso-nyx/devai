import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendVerbEvidence: vi.fn(),
  loadChain: vi.fn(),
  execFileSync: vi.fn(),
  runAuditObservation: vi.fn(),
  trackGovernanceEvent: vi.fn(),
}));

vi.mock('#runtime-core', () => ({
  appendVerbEvidence: mocks.appendVerbEvidence,
  loadChain: mocks.loadChain,
}));
vi.mock('@devai-nyx/authority', () => ({ execFileSync: mocks.execFileSync }));
vi.mock('@devai-nyx/skills', () => ({ runAuditObservation: mocks.runAuditObservation }));
vi.mock('@devai-nyx/loop', () => ({ trackGovernanceEvent: mocks.trackGovernanceEvent }));

import { auditObserve } from '../../src/commands/audit/observe.js';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const originalExitCode = process.exitCode;

function actionFor(): (options: Record<string, unknown>) => Promise<void> {
  let action: ((options: Record<string, unknown>) => Promise<void>) | undefined;
  const chain = {
    option: vi.fn(() => chain),
    action: vi.fn((value: typeof action) => {
      action = value;
      return chain;
    }),
  };
  auditObserve.register({ command: vi.fn(() => chain) } as unknown as CAC);
  if (action === undefined) throw new Error('audit observe action missing');
  return action;
}

function registered() {
  let action: ((options: Record<string, unknown>) => Promise<void>) | undefined;
  const options: unknown[][] = [];
  const chain = {
    option: vi.fn((...args: unknown[]) => {
      options.push(args);
      return chain;
    }),
    action: vi.fn((value: typeof action) => {
      action = value;
      return chain;
    }),
  };
  const command = vi.fn(() => chain);
  auditObserve.register({ command } as unknown as CAC);
  if (action === undefined) throw new Error('audit observe action missing');
  return { action, command, options };
}

function observation(status = 'completed') {
  return {
    status,
    at: SHA,
    readiness_promoting: false,
    observation_root: `.devai/state/audit-observations/${SHA}`,
    artifacts: [
      { path: 'inventory.json', sha256: '2'.repeat(64) },
      { path: 'scorecard.json', sha256: '1'.repeat(64) },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  mocks.runAuditObservation.mockResolvedValue(observation());
  mocks.loadChain.mockReturnValue({ records: [] });
  mocks.appendVerbEvidence.mockReturnValue({ ok: true, id: 'EVIDENCE-1' });
  mocks.execFileSync.mockReturnValue(`${TREE}\n`);
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('audit observe command depth', () => {
  it('registers its exact public command contract', () => {
    expect(auditObserve).toMatchObject({
      name: 'audit observe',
      description:
        'Regenerate inventory, scorecard, assessment, and backlog for one exact commit as non-promoting Auditor evidence.',
      authority: 'mesh_controller',
    });
    const { command, options } = registered();
    expect(command).toHaveBeenCalledWith(
      'audit-observe',
      'Observe the exact current repository commit',
    );
    expect(options).toEqual([
      ['--repo-root <path>', 'Repository root (default: cwd)'],
      ['--at <full-sha>', 'Mandatory exact 40-character commit SHA'],
      [
        '--round <round_id>',
        'Optional governed round to attribute this observation to for tracking',
      ],
      ['--human', 'Human-readable output'],
    ]);
  });

  it.each([
    undefined,
    '',
    'abc',
    'A'.repeat(40),
    'a'.repeat(39),
    `x${'a'.repeat(40)}`,
    `${'a'.repeat(40)}x`,
  ])('rejects an invalid exact commit before observation (%s)', async (at) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await actionFor()({ at });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai audit observe: --at requires a full 40-character SHA\n',
    );
    expect(process.exitCode).toBe(2);
    expect(mocks.runAuditObservation).not.toHaveBeenCalled();
  });

  it('records new evidence with sorted audit artifacts and renders JSON', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await actionFor()({ at: SHA, repoRoot: '/repo' });
    expect(mocks.runAuditObservation).toHaveBeenCalledWith({ repoRoot: '/repo', at: SHA });
    expect(mocks.loadChain).toHaveBeenCalledWith('/repo/record/proofs/chain.json');
    expect(mocks.appendVerbEvidence).toHaveBeenCalledWith({
      repoRoot: '/repo',
      action: 'audit.observe',
      status: 'completed',
      artifacts: [
        { path: 'inventory.json', sha256: '2'.repeat(64), kind: 'audit' },
        { path: 'scorecard.json', sha256: '1'.repeat(64), kind: 'audit' },
      ],
      notes: [`exact_sha=${SHA}`, 'readiness_promoting=false'],
    });
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toEqual({
      ...observation(),
      evidence_ref: 'EVIDENCE-1',
    });
    expect(mocks.trackGovernanceEvent).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('reuses matching evidence and attributes an exact tree-bound round', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mocks.runAuditObservation.mockResolvedValue(observation('replayed'));
    mocks.loadChain.mockReturnValue({
      records: [
        {
          id: 'OLD',
          action: 'other',
          artifacts: [{ sha256: '2'.repeat(64) }, { sha256: '1'.repeat(64) }],
        },
        {
          id: 'WRONG-DIGEST',
          action: 'audit.observe',
          artifacts: [{ sha256: '9'.repeat(64) }],
        },
        {
          id: 'MATCH',
          action: 'audit.observe',
          artifacts: [{ sha256: '2'.repeat(64) }, { sha256: '1'.repeat(64) }],
        },
      ],
    });
    await actionFor()({ at: SHA, repoRoot: '/repo', round: 'R-1', human: true });
    expect(mocks.appendVerbEvidence).not.toHaveBeenCalled();
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--verify', `${SHA}^{tree}`],
      {
        cwd: '/repo',
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(mocks.trackGovernanceEvent).toHaveBeenCalledWith({
      repoRoot: '/repo',
      round: 'R-1',
      role: 'auditor',
      kind: 'finding_emitted',
      status: 'not_applicable',
      summary: `Auditor observed commit ${SHA} with status replayed; non-promoting.`,
      payload: observation('replayed'),
      evidenceRefs: ['MATCH'],
      commitBinding: {
        base_commit: SHA,
        base_tree: TREE,
        candidate_commit: null,
        candidate_tree: null,
      },
    });
    expect(stdout).toHaveBeenLastCalledWith(`audit observe: replayed ${SHA} (MATCH)\n`);
  });

  it.each(['short-tree', `x${TREE}`, `${TREE}x`, new Error('git unavailable')])(
    'records a null commit binding when tree lookup cannot authenticate (%s)',
    async (treeResult) => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      if (treeResult instanceof Error)
        mocks.execFileSync.mockImplementation(() => {
          throw treeResult;
        });
      else mocks.execFileSync.mockReturnValue(treeResult);
      await actionFor()({ at: SHA, round: 'R-2' });
      expect(mocks.trackGovernanceEvent).toHaveBeenCalledWith(
        expect.objectContaining({ commitBinding: null, evidenceRefs: ['EVIDENCE-1'] }),
      );
    },
  );

  it('recovers from an unreadable chain by creating evidence', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mocks.loadChain.mockImplementation(() => {
      throw new Error('chain unavailable');
    });
    await actionFor()({ at: SHA });
    expect(mocks.appendVerbEvidence).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  it('keeps missing evidence identifiers explicit in round and human output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mocks.appendVerbEvidence.mockReturnValue({ ok: true });
    await actionFor()({ at: SHA, round: 'R-3', human: true });
    expect(mocks.trackGovernanceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceRefs: [] }),
    );
    expect(stdout).toHaveBeenLastCalledWith(`audit observe: completed ${SHA} (no evidence)\n`);
  });

  it('fails closed for evidence refusal, observation errors, and opaque failures', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.appendVerbEvidence.mockReturnValue({ ok: false, error: 'ledger denied' });
    await actionFor()({ at: SHA });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai audit observe: AUDIT_OBSERVE_EVIDENCE_FAILED:ledger denied\n',
    );
    expect(process.exitCode).toBe(2);

    mocks.runAuditObservation.mockResolvedValue(observation());
    mocks.appendVerbEvidence.mockReturnValue({ ok: false });
    await actionFor()({ at: SHA });
    expect(stderr).toHaveBeenLastCalledWith(
      'devai audit observe: AUDIT_OBSERVE_EVIDENCE_FAILED:\n',
    );

    mocks.runAuditObservation.mockRejectedValue(new Error('observation failed'));
    await actionFor()({ at: SHA });
    expect(stderr).toHaveBeenLastCalledWith('devai audit observe: observation failed\n');

    mocks.runAuditObservation.mockRejectedValue('opaque failure');
    await actionFor()({ at: SHA });
    expect(stderr).toHaveBeenLastCalledWith('devai audit observe: opaque failure\n');
  });

  it('activates the complete descriptor through a fresh module instance', async () => {
    vi.resetModules();
    // @ts-expect-error the query creates a distinct ESM identity for static mutation activation
    const fresh = await import('../../src/commands/audit/observe.js?fresh-audit-observe-depth');
    expect(fresh.auditObserve).toMatchObject({
      name: 'audit observe',
      authority: 'mesh_controller',
      description:
        'Regenerate inventory, scorecard, assessment, and backlog for one exact commit as non-promoting Auditor evidence.',
    });
  });
});
