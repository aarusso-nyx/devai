import { describe, expect, it } from 'vitest';
import { getValidator } from '@devai-nyx/schemas';
import type { SensorReading } from '@devai-nyx/sensors';
import { computeScorecard, summarizeCells, type CellVerdict } from '../../src/loop/scorecard.js';

const timestamp = '2026-09-08T12:00:00.000Z';
const validateReading = getValidator('sensor-reading.schema.json');
function reading(
  kind: 'inventory_api' | 'inventory_routes',
  status: SensorReading['status'],
  suffix: string,
): SensorReading {
  const value: SensorReading = {
    schemaVersion: '1.0.0',
    id: `SR-${suffix.repeat(16)}`,
    sensor: { name: kind, kind },
    timestamp,
    status,
    deterministic: true,
    command: 'fixture',
    command_hash: '0'.repeat(64),
    tier: 'L0',
  };
  expect(validateReading(value), JSON.stringify(validateReading.errors)).toBe(true);
  return value;
}
function score(
  readings: SensorReading[],
  options: Partial<Parameters<typeof computeScorecard>[0]> = {},
) {
  return computeScorecard({ timestamp, integrationHead: 'a'.repeat(40), readings, ...options });
}
const pairs: ReadonlyArray<
  readonly [SensorReading['status'], SensorReading['status'], CellVerdict]
> = [
  ['unknown', 'pass', 'UNKNOWN'],
  ['skipped', 'pass', 'UNKNOWN'],
  ['pass', 'pass', 'PASS'],
  ['pass', 'review', 'REVIEW'],
  ['unknown', 'review', 'REVIEW'],
  ['skipped', 'review', 'REVIEW'],
  ['review', 'fail', 'FAIL'],
  ['pass', 'fail', 'FAIL'],
  ['unknown', 'error', 'FAIL'],
  ['skipped', 'killed', 'FAIL'],
  ['error', 'pass', 'FAIL'],
  ['killed', 'review', 'FAIL'],
  ['unknown', 'skipped', 'UNKNOWN'],
  ['fail', 'error', 'FAIL'],
];

describe('scorecard merges independent sensor evidence conservatively', () => {
  it.each(pairs)(
    '%s and %s retain %s regardless of which sensor reports it',
    (left, right, expected) => {
      for (const [api, routes] of [
        [left, right],
        [right, left],
      ] as const) {
        const readings = [
          reading('inventory_api', api, 'a'),
          reading('inventory_routes', routes, 'b'),
        ];
        for (const ordered of [readings, [...readings].reverse()]) {
          const result = score(ordered);
          for (const property of ['T1', 'T2']) {
            const cell = result.cells.find((c) => c.substrate === 'F4' && c.property === property);
            expect(cell?.verdict).toBe(expected);
            expect(cell?.sensor_readings).toEqual(['SR-' + 'a'.repeat(16), 'SR-' + 'b'.repeat(16)]);
          }
          expect(result.substrate_aggregates.F4?.verdict).toBe(
            expected === 'PASS' ? 'UNKNOWN' : expected,
          );
        }
      }
    },
  );

  it('lets the first passing reading populate an initially unobserved cell', () => {
    const result = score([reading('inventory_api', 'pass', 'a')]);
    expect(result.cells.find((c) => c.substrate === 'F4' && c.property === 'T1')?.verdict).toBe(
      'PASS',
    );
    expect(summarizeCells(result.cells)).toEqual({
      total: 45,
      pass: 2,
      fail: 0,
      review: 0,
      unknown: 42,
      na: 1,
    });
  });

  it('preserves non-determinism from either contributor', () => {
    for (const kind of ['inventory_api', 'inventory_routes'] as const) {
      const values = [
        reading('inventory_api', 'pass', 'a'),
        reading('inventory_routes', 'pass', 'b'),
      ].map((r) => ({ ...r, deterministic: r.sensor.kind !== kind }));
      const result = score(values);
      const cells = result.cells.filter(
        (c) => c.substrate === 'F4' && ['T1', 'T2'].includes(c.property),
      );
      expect(cells.map((c) => c.deterministic)).toEqual([false, false]);
      expect(values.filter((r) => !r.deterministic)).toHaveLength(1);
    }
  });

  it('keeps an explicitly non-applicable cell outside contributing readings and failures', () => {
    const result = score([reading('inventory_api', 'fail', 'a')], { naCells: new Set(['F4:T1']) });
    expect(result.cells.find((c) => c.substrate === 'F4' && c.property === 'T1')).toEqual({
      substrate: 'F4',
      property: 'T1',
      verdict: 'N/A',
      deterministic: true,
    });
    expect(result.cells.find((c) => c.substrate === 'F4' && c.property === 'T2')?.verdict).toBe(
      'FAIL',
    );
    expect(result.overall.verdict).toBe('FAIL');
  });

  it.each(['fail', 'error', 'killed'] as const)(
    'keeps %s fresh at the exact age boundary and downgrades only after it',
    (status) => {
      const r = reading('inventory_api', status, 'a');
      const atBoundary = score([r], {
        timestamp: '2026-09-08T12:00:01.000Z',
        staleFailAfterMs: 1000,
      });
      const afterBoundary = score([r], {
        timestamp: '2026-09-08T12:00:01.001Z',
        staleFailAfterMs: 1000,
      });
      const at = atBoundary.cells.find((c) => c.substrate === 'F4' && c.property === 'T1');
      const after = afterBoundary.cells.find((c) => c.substrate === 'F4' && c.property === 'T1');
      expect(at?.verdict).toBe('FAIL');
      expect(at?.notes).not.toContain('REVIEW-stale');
      expect(after?.verdict).toBe('REVIEW');
      expect(after?.notes).toContain(`REVIEW-stale: latest inventory_api failure at ${timestamp}`);
    },
  );

  it('does not downgrade failures when no freshness policy is supplied', () => {
    const r = reading('inventory_api', 'fail', 'a');
    const result = score([r], { timestamp: '2026-10-08T12:00:00.000Z' });
    expect(result.cells.find((c) => c.substrate === 'F4' && c.property === 'T1')?.verdict).toBe(
      'FAIL',
    );
  });
});
