import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';
import type { SensorReading } from '@devai-nyx/sensors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeScorecard } from '../../src/loop/scorecard.js';
import {
  filterLatestPerKind,
  loadReadingsFromDir,
  resolveScorecardInputs,
} from '../../src/scorecard/inputs.js';

let root: string;
const earlier = '2026-09-08T10:00:00.000Z';
const later = '2026-09-08T11:00:00.000Z';
const timestamp = '2026-09-08T12:00:00.000Z';
const head = 'a'.repeat(40);
const validate = getValidator('sensor-reading.schema.json');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-scorecard-input-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function reading(
  status: SensorReading['status'],
  suffix = 'a',
  time = earlier,
  kind: SensorReading['sensor']['kind'] = 'inventory_api',
): SensorReading {
  const value: SensorReading = {
    schemaVersion: '1.0.0',
    id: 'SR-' + suffix.repeat(16),
    sensor: { name: kind, kind },
    timestamp: time,
    status,
    deterministic: true,
    command: 'fixture',
    command_hash: '0'.repeat(64),
    tier: 'L0',
  };
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  return value;
}
function write(path: string, value: unknown): string {
  const dest = join(root, path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(value) + '\n');
  return dest;
}

describe('scorecard current evidence selection', () => {
  it('selects newer evidence of each kind and sorts output independently of input order', () => {
    const old = reading('pass');
    const fresh = reading('review', 'b', later);
    const other = reading('pass', 'c', earlier, 'inventory_routes');
    for (const values of [
      [old, fresh, other],
      [other, fresh, old],
      [fresh, old, other],
    ])
      expect(filterLatestPerKind(values)).toEqual([fresh, other]);
  });
  it('breaks equal timestamp ties by exact reading identity', () => {
    const low = reading('pass', 'a');
    const high = reading('review', 'b');
    expect(filterLatestPerKind([low, high])).toEqual([high]);
    expect(filterLatestPerKind([high, low])).toEqual([high]);
  });
  it.each(['fail', 'error', 'killed'] as const)(
    'retains %s against later unknown or skipped evidence in both input orders',
    (status) => {
      const failure = reading(status);
      for (const unknownStatus of ['unknown', 'skipped'] as const) {
        const unknown = reading(unknownStatus, 'b', later);
        expect(filterLatestPerKind([failure, unknown])).toEqual([failure]);
        expect(filterLatestPerKind([unknown, failure])).toEqual([failure]);
      }
    },
  );
  it.each(['pass', 'review'] as const)(
    'allows later %s evidence to replace a prior failure',
    (status) => {
      const old = reading('fail');
      const fresh = reading(status, 'b', later);
      expect(filterLatestPerKind([old, fresh])).toEqual([fresh]);
      expect(filterLatestPerKind([fresh, old])).toEqual([fresh]);
    },
  );
  it('excludes experimental evidence without modifying its bytes or production standing', () => {
    const supported = reading('fail');
    const experimental = { ...reading('pass', 'b', later), lifecycle: 'experimental' as const };
    expect(validate(experimental), JSON.stringify(validate.errors)).toBe(true);
    const values = [experimental, supported];
    const before = JSON.stringify(values);
    expect(filterLatestPerKind(values)).toEqual([supported]);
    expect(JSON.stringify(values)).toBe(before);
    expect(filterLatestPerKind([experimental])).toEqual([]);
  });
});

describe('scorecard input precedence and disk population', () => {
  it('returns the exact caller scorecard even when disk and readings differ', () => {
    const old = reading('pass');
    const fresh = reading('review', 'b', later);
    const precomputed = computeScorecard({ timestamp, integrationHead: head, readings: [old] });
    write('.devai/state/sensor-readings/disk.json', reading('fail', 'c'));
    const result = resolveScorecardInputs({
      repoRoot: root,
      inputs: { scorecard: precomputed, readings: [old, fresh] },
      timestamp,
      integrationHead: 'b'.repeat(40),
    });
    expect(result.scorecard).toBe(precomputed);
    expect(result.readings).toEqual([fresh]);
    expect(result.source).toBe('inputs');
  });
  it('accepts a caller scorecard without readings and never discovers disk evidence', () => {
    const precomputed = computeScorecard({ timestamp, integrationHead: head });
    write('.devai/state/sensor-readings/disk.json', reading('fail'));
    expect(
      resolveScorecardInputs({ repoRoot: root, inputs: { scorecard: precomputed }, timestamp }),
    ).toEqual({ scorecard: precomputed, readings: [], source: 'inputs' });
  });
  it('computes from the caller readings before consulting disk', () => {
    const provided = reading('review');
    write('.devai/state/sensor-readings/disk.json', reading('fail', 'b', later));
    const result = resolveScorecardInputs({
      repoRoot: root,
      inputs: { readings: [provided] },
      timestamp,
      integrationHead: head,
    });
    expect(result).toEqual({
      scorecard: computeScorecard({ timestamp, integrationHead: head, readings: [provided] }),
      readings: [provided],
      source: 'inputs',
    });
  });
  it.each([undefined, {}].map((inputs) => ({ inputs })))(
    'returns an empty scorecard for missing evidence with $inputs',
    ({ inputs }) => {
      const result = resolveScorecardInputs({ repoRoot: root, inputs, timestamp });
      expect(result.source).toBe('empty');
      expect(result.readings).toEqual([]);
      expect(result.scorecard.integration_head).toBe('0'.repeat(39) + 'f');
      expect(result.scorecard.generated_at).toBe(timestamp);
    },
  );
  it('falls back to disk when the caller supplies an empty readings list', () => {
    const stored = reading('review');
    write('.devai/state/sensor-readings/api/one.json', stored);
    expect(
      resolveScorecardInputs({
        repoRoot: root,
        inputs: { readings: [] },
        timestamp,
        integrationHead: head,
      }),
    ).toEqual({
      scorecard: computeScorecard({ timestamp, integrationHead: head, readings: [stored] }),
      readings: [stored],
      source: 'disk',
    });
  });
  it('honors an explicit readings directory without merging the default directory', () => {
    const selected = reading('review');
    write('chosen/reading.json', selected);
    write('.devai/state/sensor-readings/reading.json', reading('fail', 'b', later));
    expect(
      resolveScorecardInputs({
        repoRoot: root,
        inputs: { readings_dir: join(root, 'chosen') },
        timestamp,
      }).readings,
    ).toEqual([selected]);
  });
  it('loads single records and arrays at root and one directory level, preserves all source bytes, and ignores deeper or malformed files', () => {
    const old = reading('fail');
    const fresh = reading('pass', 'b', later);
    const route = reading('review', 'c', later, 'inventory_routes');
    const paths = [
      write('readings/root.json', [old]),
      write('readings/api/latest.json', fresh),
      write('readings/routes/readings.json', [route]),
    ];
    write('readings/root.txt', reading('fail', 'd', timestamp));
    write('readings/routes/ignored.txt', reading('fail', 'e', timestamp));
    write('readings/deep/more/ignored.json', reading('fail', 'f', timestamp));
    writeFileSync(join(root, 'readings/broken.json'), '{');
    writeFileSync(join(root, 'readings/routes/broken.json'), '{');
    symlinkSync(join(root, 'missing'), join(root, 'readings/broken-link'));
    const bytes = paths.map((p) => readFileSync(p));
    expect(loadReadingsFromDir(join(root, 'readings'))).toEqual([fresh, route]);
    expect(paths.map((p) => readFileSync(p))).toEqual(bytes);
  });
  it('applies the repository stale-failure policy equally to supplied and disk readings', () => {
    const failure = reading('fail');
    write('law/policy/thresholds.json', { freshness: { scorecard_failure_max_age_hours: 1 } });
    write('.devai/state/sensor-readings/reading.json', failure);
    const expected = computeScorecard({
      timestamp,
      integrationHead: head,
      readings: [failure],
      staleFailAfterMs: 3600000,
    });
    expect(
      resolveScorecardInputs({
        repoRoot: root,
        inputs: { readings: [failure] },
        timestamp,
        integrationHead: head,
      }).scorecard,
    ).toEqual(expected);
    expect(
      resolveScorecardInputs({
        repoRoot: root,
        inputs: undefined,
        timestamp,
        integrationHead: head,
      }).scorecard,
    ).toEqual(expected);
    expect(expected.cells.find((c) => c.substrate === 'F4' && c.property === 'T1')?.verdict).toBe(
      'REVIEW',
    );
  });
  it('refuses divergent canonical and materialized policy instead of computing a scorecard', () => {
    write('law/policy/thresholds.json', { freshness: { scorecard_failure_max_age_hours: 1 } });
    write('.devai/config/thresholds.json', { freshness: { scorecard_failure_max_age_hours: 2 } });
    expect(() =>
      resolveScorecardInputs({
        repoRoot: root,
        inputs: { readings: [reading('pass')] },
        timestamp,
      }),
    ).toThrow('canonical and materialized thresholds.json bytes diverge');
  });
});
