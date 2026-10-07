import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAuditObservation } from '../../src/post-merge-auditor/index.js';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';
import { disableGitAutoMaintenance } from './git-fixture-maintenance.js';

const roots: string[] = [];
const NAMES = ['inventory', 'scorecard', 'backlog', 'assessment', 'status'] as const;
const RECORD_DIRECTORY = 'record/proofs/compliance/scorecards';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'DEVAI Test',
      GIT_AUTHOR_EMAIL: 'devai-test@example.invalid',
      GIT_COMMITTER_NAME: 'DEVAI Test',
      GIT_COMMITTER_EMAIL: 'devai-test@example.invalid',
    },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-audit-previous-'));
  roots.push(root);
  git(root, ['init', '-b', 'main']);
  disableGitAutoMaintenance(root);
  writeFileSync(join(root, 'README.md'), '# Fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'test: initial']);
  return root;
}

function bundlePath(root: string, at: string, name: string): string {
  return join(root, '.devai/state/audit-observations', at, `${name}.json`);
}

function readBundle(root: string, at: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(bundlePath(root, at, name), 'utf8')) as Record<string, unknown>;
}

/** The chain record `audit observe` appends, with the digests the caller names. */
function chainRecord(at: string, digests: Record<string, string>): Record<string, unknown> {
  return {
    action: 'audit.observe',
    status: 'completed',
    artifacts: NAMES.map((name) => ({
      path: `.devai/state/audit-observations/${at}/${name}.json`,
      sha256: digests[name],
      kind: 'audit',
    })),
    notes: [`exact_sha=${at}`, 'readiness_promoting=false'],
  };
}

function writeChain(root: string, records: readonly Record<string, unknown>[]): void {
  mkdirSync(join(root, 'record/proofs'), { recursive: true });
  writeFileSync(
    join(root, 'record/proofs/chain.json'),
    `${JSON.stringify({ records }, null, 2)}\n`,
  );
}

/** Digests of an observed bundle's files, as the chain records them. */
function bundleDigests(root: string, at: string): Record<string, string> {
  return Object.fromEntries(
    NAMES.map((name) => [name, sha256(readFileSync(bundlePath(root, at, name)))]),
  );
}

async function observe(root: string, at: string, previous?: string) {
  return withAuthorityHostTestScope(() =>
    runAuditObservation({ repoRoot: root, at, ...(previous === undefined ? {} : { previous }) }),
  );
}

/**
 * Observe the first commit, then record a backlog copy for it in which F5:T3 reads
 * FAIL (the SC-20261006T141503-001 shape), a scorecard copy, and the chain record
 * whose digests name those copies and the state bundle's status.json. Commit them.
 */
async function observedPredecessor(root: string): Promise<{ first: string; second: string }> {
  const first = git(root, ['rev-parse', 'HEAD']);
  await observe(root, first);
  const backlog = readBundle(root, first, 'backlog');
  const observations = (backlog['observations'] as { cell: string; verdict: string }[]).map(
    (observation) =>
      observation.cell === 'F5:T3' ? { ...observation, verdict: 'FAIL' } : observation,
  );
  const recordedBacklog = `${JSON.stringify({ ...backlog, observations }, null, 2)}\n`;
  const recordedScorecard = readFileSync(bundlePath(root, first, 'scorecard'));
  mkdirSync(join(root, RECORD_DIRECTORY), { recursive: true });
  writeFileSync(join(root, RECORD_DIRECTORY, 'SC-TEST-001.backlog.json'), recordedBacklog);
  writeFileSync(join(root, RECORD_DIRECTORY, 'SC-TEST-001.json'), recordedScorecard);
  writeChain(root, [
    chainRecord(first, {
      ...bundleDigests(root, first),
      backlog: sha256(recordedBacklog),
      scorecard: sha256(recordedScorecard),
    }),
  ]);
  git(root, ['add', 'record']);
  git(root, ['commit', '-m', 'plan(scorecard): record the first observation']);
  return { first, second: git(root, ['rev-parse', 'HEAD']) };
}

describe('audit observe links the previous observation (#335)', () => {
  it('links nothing on a first-ever observation', async () => {
    const root = fixture();
    const at = git(root, ['rev-parse', 'HEAD']);

    await observe(root, at);

    const backlog = readBundle(root, at, 'backlog');
    expect(backlog['previous_merge_sha']).toBeNull();
    expect(backlog['deltas']).toEqual({ additions: [], completions: [] });
    expect(readBundle(root, at, 'status')['previous_observation_digest_sha256']).toBeNull();
  });

  it('links the nearest observed ancestor in the chain and records its completions', async () => {
    const root = fixture();
    const { first, second } = await observedPredecessor(root);

    await observe(root, second);

    const backlog = readBundle(root, second, 'backlog');
    expect(backlog['previous_merge_sha']).toBe(first);
    const deltas = backlog['deltas'] as { completions: { cell: string; verdict: string }[] };
    expect(deltas.completions).toContainEqual({ cell: 'F5:T3', verdict: 'FAIL' });
    expect(readBundle(root, second, 'status')['previous_observation_digest_sha256']).toBe(
      readBundle(root, first, 'status')['observation_digest_sha256'],
    );
  });

  it('accepts a recorded scorecard id, keeps the link on replay, and refuses unknown names', async () => {
    const root = fixture();
    const { first, second } = await observedPredecessor(root);
    // The predecessor's state bundle is gone: only the recorded copies remain.
    rmSync(join(root, '.devai/state/audit-observations', first), { recursive: true, force: true });

    const linked = await observe(root, second, 'SC-TEST-001');
    const replayed = await observe(root, second);

    expect(replayed).toEqual({ ...linked, status: 'replayed' });
    const backlog = readBundle(root, second, 'backlog');
    expect(backlog['previous_merge_sha']).toBe(first);
    expect((backlog['deltas'] as { completions: unknown[] }).completions).toContainEqual({
      cell: 'F5:T3',
      verdict: 'FAIL',
    });
    expect(readBundle(root, second, 'status')['previous_observation_digest_sha256']).toBeNull();

    rmSync(join(root, '.devai/state/audit-observations', second), { recursive: true, force: true });
    await expect(observe(root, second, 'SC-UNKNOWN-001')).rejects.toThrow(
      'AUDIT_OBSERVE_PREVIOUS_UNKNOWN',
    );
    await expect(observe(root, second, 'not-a-name')).rejects.toThrow(
      'AUDIT_OBSERVE_PREVIOUS_INVALID',
    );
    await expect(observe(root, second, second)).rejects.toThrow('AUDIT_OBSERVE_PREVIOUS_UNKNOWN');
  });

  it('stays byte-deterministic when a later observation of an intermediate commit is chained', async () => {
    const root = fixture();
    const { first, second } = await observedPredecessor(root);
    await observe(root, second);
    const before = Object.fromEntries(
      NAMES.map((name) => [name, readFileSync(bundlePath(root, second, name), 'utf8')]),
    );

    // A newer chain record of the observed commit itself is not a predecessor, and the
    // replay keeps the link its bundle already records.
    const chain = JSON.parse(readFileSync(join(root, 'record/proofs/chain.json'), 'utf8')) as {
      records: Record<string, unknown>[];
    };
    writeChain(root, [...chain.records, chainRecord(second, bundleDigests(root, second))]);
    const replayed = await observe(root, second);

    expect(replayed.status).toBe('replayed');
    for (const name of NAMES) {
      expect(readFileSync(bundlePath(root, second, name), 'utf8')).toBe(before[name]);
    }
    expect(readBundle(root, second, 'backlog')['previous_merge_sha']).toBe(first);
  });
});
