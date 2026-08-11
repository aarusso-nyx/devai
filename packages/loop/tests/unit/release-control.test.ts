// Invariants: INV-DEVAI-016, INV-DEVAI-018
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getReleaseDir,
  listReleases,
  releaseContentHash,
  runPostdeployVerify,
  runPostdeployVerifyFromCharter,
  runReleaseGate,
  runRuntimeDrift,
  runRuntimeDriftFromCharter,
} from '../../src/release/index.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const roots: string[] = [];
const NOW = '2026-07-25T00:00:00.000Z';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-release-control-'));
  roots.push(path);
  return path;
}

function put(base: string, relativePath: string, body: string): string {
  const path = join(base, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

describe('release control records', () => {
  it('evaluates scorecard, invariant, and sensor evidence without optimistic defaults', async () => {
    const repo = root();
    await withAuthorityHostTestScope(() => {
      const absent = runReleaseGate({ repoRoot: repo, now: NOW });
      expect(absent).toMatchObject({
        id: 'REL-0001',
        kind: 'gate',
        verdict: 'inconclusive',
      });
      expect(absent.checks?.map((check) => check.verdict)).toEqual([
        'skipped',
        'skipped',
        'skipped',
      ]);

      const missing = runReleaseGate({
        repoRoot: repo,
        scorecardRef: join(repo, 'missing-scorecard.json'),
        invariantsDir: join(repo, 'missing-invariants'),
        sensorReadingsDir: join(repo, 'missing-readings'),
        now: NOW,
      });
      expect(missing.verdict).toBe('block');
      expect(missing.reasons).toEqual([
        'scorecard not found',
        'invariants directory missing',
        'no sensor readings',
      ]);

      const malformedScorecard = put(repo, 'scorecards/malformed.json', '{');
      const emptyInvariants = join(repo, 'law/invariants');
      const emptyReadings = join(repo, 'readings');
      mkdirSync(emptyInvariants, { recursive: true });
      mkdirSync(emptyReadings, { recursive: true });
      const malformed = runReleaseGate({
        repoRoot: repo,
        scorecardRef: malformedScorecard,
        invariantsDir: emptyInvariants,
        sensorReadingsDir: emptyReadings,
        now: NOW,
      });
      expect(malformed.verdict).toBe('block');
      expect(malformed.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'scorecard.parse', verdict: 'inconclusive' }),
          expect.objectContaining({ name: 'invariants.present', verdict: 'block' }),
          expect.objectContaining({ name: 'sensors.fresh', verdict: 'review' }),
        ]),
      );

      put(repo, 'law/invariants/INV-DEMO-001.json', '{}');
      put(repo, 'readings/nested/SR-0001.json', '{}');
      for (const [decision, expected] of [
        ['green', 'pass'],
        ['red', 'block'],
        ['yellow', 'review'],
        ['unknown', 'inconclusive'],
      ] as const) {
        const scorecard = put(
          repo,
          `scorecards/${decision}.json`,
          JSON.stringify({ overall_state: decision }),
        );
        const record = runReleaseGate({
          repoRoot: repo,
          scorecardRef: scorecard,
          invariantsDir: emptyInvariants,
          sensorReadingsDir: emptyReadings,
          artifactRef: 'artifact:fixture',
          environment: 'staging',
          auditChainHead: 'd'.repeat(64),
          now: NOW,
        });
        expect(record.checks?.find((check) => check.name === 'scorecard.decision')?.verdict).toBe(
          expected,
        );
        expect(record.inputs.audit_chain_head).toBe('d'.repeat(64));
      }
    });

    const persisted = JSON.parse(
      readFileSync(join(getReleaseDir(repo), 'REL-0007.json'), 'utf8'),
    ) as { verdict: string };
    expect(persisted.verdict).toBe('inconclusive');
  });

  it('persists exact postdeploy and runtime-drift outcomes', async () => {
    const repo = root();
    await withAuthorityHostTestScope(() => {
      const matching = runPostdeployVerify({
        repoRoot: repo,
        artifactRef: 'artifact:one',
        artifactChainHead: 'a'.repeat(64),
        auditChainHead: 'a'.repeat(64),
        environment: 'prod',
        now: NOW,
      });
      expect(matching).toMatchObject({ verdict: 'pass', rollback_recommended: false });

      const mismatch = runPostdeployVerify({
        repoRoot: repo,
        artifactRef: 'artifact:two',
        artifactChainHead: 'a'.repeat(64),
        auditChainHead: 'b'.repeat(64),
        now: NOW,
      });
      expect(mismatch).toMatchObject({
        verdict: 'block',
        reasons: ['audit-chain head mismatch'],
        rollback_recommended: true,
      });
      expect(mismatch.checks?.[0]?.detail).toContain('observed=bbbbbbbbbbbb');

      const charterPass = runPostdeployVerifyFromCharter({
        repoRoot: repo,
        artifactRef: 'artifact:three',
        artifactChainHead: 'c'.repeat(64),
        charterPath: 'charters/runtime.json',
        probeAggregate: {
          summary_verdict: 'pass',
          pass: 2,
          fail: 0,
          error: 0,
          review: 0,
          skipped: 0,
          findings: [],
        },
        now: NOW,
      });
      expect(charterPass).toMatchObject({ verdict: 'pass', rollback_recommended: false });

      const charterFail = runPostdeployVerifyFromCharter({
        repoRoot: repo,
        artifactRef: 'artifact:four',
        charterPath: 'charters/runtime.json',
        probeAggregate: {
          summary_verdict: 'error',
          pass: 0,
          fail: 1,
          error: 1,
          review: 0,
          skipped: 0,
          findings: [{ code: 'HEAD_MISMATCH', message: 'runtime head differs' }],
        },
        now: NOW,
      });
      expect(charterFail).toMatchObject({
        verdict: 'block',
        reasons: ['runtime head differs'],
        rollback_recommended: true,
      });

      const charterFailWithoutFinding = runPostdeployVerifyFromCharter({
        repoRoot: repo,
        artifactRef: 'artifact:five',
        charterPath: 'charters/empty.json',
        probeAggregate: {
          summary_verdict: 'fail',
          pass: 0,
          fail: 1,
          error: 0,
          review: 0,
          skipped: 0,
          findings: [],
        },
        now: NOW,
      });
      expect(charterFailWithoutFinding.reasons?.[0]).toContain('charters/empty.json');

      expect(runRuntimeDrift({ repoRoot: repo, observations: [], now: NOW })).toMatchObject({
        verdict: 'pass',
        rollback_recommended: false,
      });
      expect(
        runRuntimeDrift({
          repoRoot: repo,
          observations: [{ surface: 'env.API_URL', delta: 'expected A; observed B' }],
          artifactRef: 'artifact:six',
          environment: 'preview',
          now: NOW,
        }),
      ).toMatchObject({
        verdict: 'review',
        reasons: ['1 runtime drift observation(s)'],
        rollback_recommended: true,
      });

      const detected = runRuntimeDriftFromCharter({
        repoRoot: repo,
        charterPath: 'charters/drift.json',
        outcomes: [
          { pid: 'P1', name: 'healthy', verdict: 'pass', failed_expectations: [] },
          { pid: 'P2', name: 'not-run', verdict: 'skipped', failed_expectations: [] },
          {
            pid: 'P3',
            name: 'database',
            verdict: 'fail',
            failed_expectations: ['row count', 'schema hash'],
          },
          { pid: 'P4', name: 'cache', verdict: 'error', failed_expectations: [] },
        ],
        now: NOW,
      });
      expect(detected.drift_observations).toEqual([
        { surface: 'database', delta: 'row count; schema hash' },
        { surface: 'cache', delta: 'probe verdict=error' },
      ]);
      expect(detected.verdict).toBe('review');
    });

    const records = listReleases(repo);
    expect(records).toHaveLength(8);
    expect(records.map((record) => record.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `REL-${String(index + 1).padStart(4, '0')}`),
    );
    const first = records[0];
    if (first === undefined) throw new Error('fixture requires a release record');
    expect(releaseContentHash(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(releaseContentHash(first)).toBe(releaseContentHash(first));
  });

  it('lists release state fail-closed when absent, unreadable, or partially malformed', () => {
    const absent = root();
    expect(listReleases(absent)).toEqual([]);

    const unreadable = root();
    put(unreadable, '.devai/state/releases', 'not a directory');
    expect(listReleases(unreadable)).toEqual([]);

    const partial = root();
    put(partial, '.devai/state/releases/REL-0002.json', '{');
    put(
      partial,
      '.devai/state/releases/REL-0001.json',
      JSON.stringify({ id: 'REL-0001', verdict: 'pass' }),
    );
    put(partial, '.devai/state/releases/ignored.json', '{}');
    expect(listReleases(partial)).toEqual([{ id: 'REL-0001', verdict: 'pass' }]);
  });
});
