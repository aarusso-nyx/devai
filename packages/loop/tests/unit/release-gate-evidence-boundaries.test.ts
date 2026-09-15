import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runReleaseGate, releaseContentHash, type ReleaseRecord } from '../../src/release/index.js';
const roots: string[] = [];
const NOW = '2026-09-08T12:00:00.000Z';
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), 'devai-release-gate-evidence-'));
  roots.push(path);
  return path;
}
function write(base: string, rel: string, content: string) {
  const path = join(base, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('release gate retains exact independent evidence and precedence', () => {
  it.each([
    ['pass', 'pass', undefined],
    ['green', 'pass', undefined],
    ['fail', 'block', 'scorecard decision: fail'],
    ['red', 'block', 'scorecard decision: red'],
    ['review', 'review', 'scorecard requires review: review'],
    ['amber', 'review', 'scorecard requires review: amber'],
    ['yellow', 'review', 'scorecard requires review: yellow'],
    ['unknown', 'inconclusive', undefined],
    ['', 'inconclusive', undefined],
  ] as const)(
    'binds explicit %s over conflicting fallback state',
    async (decision, verdict, reason) => {
      const base = root();
      const scorecard = write(
        base,
        'scorecard.json',
        JSON.stringify({
          gate_decision: decision,
          overall_state: decision === 'pass' || decision === 'green' ? 'red' : 'green',
        }),
      );
      await withAuthorityHostTestScope(() => {
        const record = runReleaseGate({
          repoRoot: base,
          scorecardRef: scorecard,
          artifactRef: 'artifact:reviewed',
          environment: 'staging',
          auditChainHead: 'a'.repeat(64),
          now: NOW,
        });
        expect(record).toEqual({
          schemaVersion: '1.0.0',
          id: 'REL-0001',
          kind: 'gate',
          decided_at: NOW,
          artifact_ref: 'artifact:reviewed',
          environment: 'staging',
          verdict,
          ...(reason === undefined ? {} : { reasons: [reason] }),
          inputs: { scorecard_ref: scorecard, audit_chain_head: 'a'.repeat(64) },
          checks: [
            { name: 'scorecard.decision', verdict, detail: `decision=${decision}` },
            { name: 'invariants.present', verdict: 'skipped' },
            { name: 'sensors.fresh', verdict: 'skipped' },
          ],
        });
        expect(
          JSON.parse(readFileSync(join(base, '.devai/state/releases/REL-0001.json'), 'utf8')),
        ).toEqual(record);
      });
    },
  );
  it('reports unavailable scorecard, invariant and sensor evidence together', async () => {
    const base = root();
    await withAuthorityHostTestScope(() => {
      const scorecard = join(base, 'missing-scorecard');
      const invariants = join(base, 'missing-invariants');
      const sensors = join(base, 'missing-sensors');
      const record = runReleaseGate({
        repoRoot: base,
        scorecardRef: scorecard,
        invariantsDir: invariants,
        sensorReadingsDir: sensors,
        now: NOW,
      });
      expect(record.verdict).toBe('block');
      expect(record.reasons).toEqual([
        'scorecard not found',
        'invariants directory missing',
        'no sensor readings',
      ]);
      expect(record.inputs).toEqual({
        scorecard_ref: scorecard,
        invariants_dir: invariants,
        sensor_readings_dir: sensors,
      });
      expect(record.checks).toEqual([
        {
          name: 'scorecard.readable',
          verdict: 'inconclusive',
          detail: `scorecard not found at ${scorecard}`,
        },
        {
          name: 'invariants.present',
          verdict: 'block',
          detail: `invariants dir not found at ${invariants}`,
        },
        { name: 'sensors.fresh', verdict: 'review', detail: 'no sensor-readings dir found' },
      ]);
    });
  });
  it('cannot count a directory named like an invariant as an invariant file', async () => {
    const base = root();
    const invariants = join(base, 'invariants');
    mkdirSync(join(invariants, 'INV-fake.json'), { recursive: true });
    await withAuthorityHostTestScope(() => {
      const record = runReleaseGate({ repoRoot: base, invariantsDir: invariants, now: NOW });
      expect(record.verdict).toBe('block');
      expect(record.checks?.[1]).toEqual({
        name: 'invariants.present',
        verdict: 'block',
        detail: 'no INV-*.json files',
      });
    });
  });
  it('counts actual top-level invariant files and nested sensor JSON files without following links', async () => {
    const base = root();
    const invariants = join(base, 'invariants');
    const sensors = join(base, 'readings');
    write(base, 'invariants/INV-1.json', '{}');
    write(base, 'invariants/INV-2.json', '{}');
    write(base, 'invariants/ignored.json', '{}');
    write(base, 'invariants/nested/INV-3.json', '{}');
    symlinkSync(join(invariants, 'INV-1.json'), join(invariants, 'INV-linked.json'));
    write(base, 'readings/SR-1.json', '{}');
    write(base, 'readings/nested/SR-2.json', '{}');
    write(base, 'readings/ignored.json.bak', '{}');
    symlinkSync(join(sensors, 'SR-1.json'), join(sensors, 'linked.json'));
    await withAuthorityHostTestScope(() => {
      const record = runReleaseGate({
        repoRoot: base,
        invariantsDir: invariants,
        sensorReadingsDir: sensors,
        now: NOW,
      });
      expect(record.verdict).toBe('pass');
      expect(record.checks).toEqual([
        { name: 'scorecard.decision', verdict: 'skipped', detail: 'no --scorecard provided' },
        { name: 'invariants.present', verdict: 'pass', detail: '2 INV file(s)' },
        { name: 'sensors.fresh', verdict: 'pass', detail: '2 reading(s)' },
      ]);
      expect(record).not.toHaveProperty('reasons');
    });
  });
  it('does not erase an inconclusive scorecard with passing inventory evidence', async () => {
    const base = root();
    const scorecard = write(base, 'scorecard.json', '{}');
    write(base, 'invariants/INV-1.json', '{}');
    write(base, 'readings/SR-1.json', '{}');
    await withAuthorityHostTestScope(() => {
      expect(
        runReleaseGate({
          repoRoot: base,
          scorecardRef: scorecard,
          invariantsDir: join(base, 'invariants'),
          sensorReadingsDir: join(base, 'readings'),
          now: NOW,
        }).verdict,
      ).toBe('inconclusive');
    });
  });
  it('retains review precedence and explicit reasons when a scorecard cannot be parsed', async () => {
    const base = root();
    const scorecard = write(base, 'scorecard.json', '{');
    const readings = join(base, 'readings');
    mkdirSync(readings);
    await withAuthorityHostTestScope(() => {
      const record = runReleaseGate({
        repoRoot: base,
        scorecardRef: scorecard,
        sensorReadingsDir: readings,
        now: NOW,
      });
      expect(record.verdict).toBe('review');
      expect(record.reasons).toEqual(['scorecard parse error', 'no sensor readings emitted']);
      expect(record.checks?.map(({ name, verdict }) => ({ name, verdict }))).toEqual([
        { name: 'scorecard.parse', verdict: 'inconclusive' },
        { name: 'invariants.present', verdict: 'skipped' },
        { name: 'sensors.fresh', verdict: 'review' },
      ]);
      expect(record.checks?.[0]?.detail).toMatch(/JSON/);
    });
  });
  it('hashes canonical content independently of insertion order while binding altered evidence', async () => {
    const base = root();
    await withAuthorityHostTestScope(() => {
      const record = runReleaseGate({ repoRoot: base, now: NOW });
      const reordered = Object.fromEntries(
        Object.entries(record).reverse(),
      ) as unknown as ReleaseRecord;
      expect(releaseContentHash(reordered)).toBe(releaseContentHash(record));
      expect(releaseContentHash({ ...record, artifact_ref: 'different-artifact' })).not.toBe(
        releaseContentHash(record),
      );
      expect(
        releaseContentHash({ ...record, inputs: { scorecard_ref: 'different-evidence' } }),
      ).not.toBe(releaseContentHash(record));
    });
  });
});
