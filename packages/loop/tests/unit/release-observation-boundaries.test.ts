import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  getReleaseDir,
  runPostdeployVerify,
  runPostdeployVerifyFromCharter,
  runRuntimeDriftFromCharter,
  type ProbeAggregate,
  type DriftProbeOutcome,
} from '../../src/release/index.js';
let root: string;
const now = '2026-09-08T12:00:00.000Z';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-release-observation-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
function aggregate(summary_verdict: ProbeAggregate['summary_verdict']): ProbeAggregate {
  return {
    summary_verdict,
    pass: summary_verdict === 'pass' ? 2 : 0,
    fail: summary_verdict === 'fail' ? 1 : 0,
    error: summary_verdict === 'error' ? 1 : 0,
    review: summary_verdict === 'review' ? 1 : 0,
    skipped: summary_verdict === 'skipped' ? 1 : 0,
    findings: [],
  };
}

describe('release observation records retain exact supplied evidence', () => {
  it.each([true, false])(
    'records the complete audit-head comparison with match=%s',
    async (matches) => {
      await withAuthorityHostTestScope(() => {
        const artifact = 'a'.repeat(64);
        const observed = matches ? artifact : 'b'.repeat(64);
        const record = runPostdeployVerify({
          repoRoot: root,
          artifactRef: 'artifact:fixture',
          artifactChainHead: artifact,
          auditChainHead: observed,
          environment: 'prod',
          now,
        });
        expect(record).toEqual({
          schemaVersion: '1.0.0',
          id: 'REL-0001',
          kind: 'postdeploy-verify',
          decided_at: now,
          artifact_ref: 'artifact:fixture',
          environment: 'prod',
          verdict: matches ? 'pass' : 'block',
          ...(matches ? {} : { reasons: ['audit-chain head mismatch'] }),
          inputs: { audit_chain_head: observed, artifact_chain_head: artifact },
          checks: [
            {
              name: 'audit-chain.head-match',
              verdict: matches ? 'pass' : 'block',
              detail: matches
                ? 'observed head matches artifact head'
                : 'observed=bbbbbbbbbbbb… vs artifact=aaaaaaaaaaaa…',
            },
          ],
          rollback_recommended: !matches,
        });
        expect(readFileSync(join(getReleaseDir(root), 'REL-0001.json'), 'utf8')).toBe(
          JSON.stringify(record, null, 2) + '\n',
        );
      });
    },
  );
  it.each(['pass', 'fail', 'review', 'skipped', 'killed', 'error', 'unknown'] as const)(
    'maps charter aggregate %s to the exact stored result',
    async (status) => {
      await withAuthorityHostTestScope(() => {
        const probes = aggregate(status);
        const pass = status === 'pass';
        const record = runPostdeployVerifyFromCharter({
          repoRoot: root,
          artifactRef: 'artifact:fixture',
          artifactChainHead: 'c'.repeat(64),
          charterPath: 'charters/runtime.json',
          probeAggregate: probes,
          environment: 'staging',
          now,
        });
        expect(record).toEqual({
          schemaVersion: '1.0.0',
          id: 'REL-0001',
          kind: 'postdeploy-verify',
          decided_at: now,
          artifact_ref: 'artifact:fixture',
          environment: 'staging',
          verdict: pass ? 'pass' : 'block',
          ...(pass
            ? {}
            : { reasons: ['runtime-attestation charter charters/runtime.json did not pass'] }),
          inputs: { artifact_chain_head: 'c'.repeat(64) },
          checks: [
            {
              name: 'runtime-attestation.probes',
              verdict: pass ? 'pass' : 'block',
              detail: pass
                ? '2 probe(s) passed'
                : `${probes.fail + probes.error} probe(s) failed/errored; charter=charters/runtime.json`,
            },
          ],
          rollback_recommended: !pass,
        });
      });
    },
  );
  it('bounds retained charter finding messages at five while preserving their order and the original aggregate', async () => {
    await withAuthorityHostTestScope(() => {
      const probes = {
        ...aggregate('fail'),
        findings: Array.from({ length: 7 }, (_, i) => ({
          code: `F-${i}`,
          message: `Failure ${i}`,
        })),
      };
      const before = JSON.stringify(probes);
      const result = runPostdeployVerifyFromCharter({
        repoRoot: root,
        artifactRef: 'artifact:fixture',
        charterPath: 'charters/runtime.json',
        probeAggregate: probes,
        now,
      });
      expect(result.reasons).toEqual([
        'Failure 0',
        'Failure 1',
        'Failure 2',
        'Failure 3',
        'Failure 4',
      ]);
      expect(result.inputs).toEqual({});
      expect(result).not.toHaveProperty('environment');
      expect(JSON.stringify(probes)).toBe(before);
    });
  });
  it.each(['pass', 'skipped', 'review', 'fail', 'error'] as const)(
    'records charter drift outcome %s without inventing observations',
    async (status) => {
      await withAuthorityHostTestScope(() => {
        const retained = status !== 'pass' && status !== 'skipped';
        const result = runRuntimeDriftFromCharter({
          repoRoot: root,
          charterPath: 'charters/drift.json',
          artifactRef: 'artifact:fixture',
          environment: 'preview',
          outcomes: [{ pid: 'P1', name: 'database', verdict: status, failed_expectations: [] }],
          now,
        });
        expect(result).toEqual({
          schemaVersion: '1.0.0',
          id: 'REL-0001',
          kind: 'runtime-drift',
          decided_at: now,
          artifact_ref: 'artifact:fixture',
          environment: 'preview',
          verdict: retained ? 'review' : 'pass',
          ...(retained
            ? { reasons: ['1 runtime drift observation(s) from charter charters/drift.json'] }
            : {}),
          inputs: {},
          drift_observations: retained
            ? [{ surface: 'database', delta: `probe verdict=${status}` }]
            : [],
          rollback_recommended: retained,
        });
      });
    },
  );
  it('preserves probe order, joined failed expectations, and source outcomes', async () => {
    await withAuthorityHostTestScope(() => {
      const outcomes: DriftProbeOutcome[] = [
        { pid: 'P2', name: 'cache', verdict: 'review', failed_expectations: ['TTL', 'namespace'] },
        { pid: 'P1', name: 'database', verdict: 'fail', failed_expectations: ['schema hash'] },
      ];
      const before = JSON.stringify(outcomes);
      const result = runRuntimeDriftFromCharter({
        repoRoot: root,
        charterPath: 'charters/drift.json',
        outcomes,
        now,
      });
      expect(result.drift_observations).toEqual([
        { surface: 'cache', delta: 'TTL; namespace' },
        { surface: 'database', delta: 'schema hash' },
      ]);
      expect(result.reasons).toEqual([
        '2 runtime drift observation(s) from charter charters/drift.json',
      ]);
      expect(result).not.toHaveProperty('artifact_ref');
      expect(result).not.toHaveProperty('environment');
      expect(JSON.stringify(outcomes)).toBe(before);
    });
  });
  it('uses the clock only when the decision timestamp is omitted', async () => {
    await withAuthorityHostTestScope(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-08T13:00:00.000Z'));
      const options = {
        repoRoot: root,
        artifactRef: 'artifact:fixture',
        artifactChainHead: 'a'.repeat(64),
        auditChainHead: 'a'.repeat(64),
      };
      expect(runPostdeployVerify(options).decided_at).toBe('2026-09-08T13:00:00.000Z');
      expect(runPostdeployVerify({ ...options, now }).decided_at).toBe(now);
    });
  });
});
