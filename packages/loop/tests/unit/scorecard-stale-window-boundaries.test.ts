import { getValidator } from '@devai-nyx/schemas';
import type { SensorReading } from '@devai-nyx/sensors';
import { describe, expect, it } from 'vitest';
import { computeScorecard } from '../../src/loop/scorecard.js';

const validateReading = getValidator('sensor-reading.schema.json');
const readingTimestamp = '2026-09-08T12:00:00.000Z';

function reading(status: SensorReading['status'], suffix: string): SensorReading {
  const value: SensorReading = {
    schemaVersion: '1.0.0',
    id: `SR-${suffix.repeat(16)}`,
    sensor: { name: 'inventory_api', kind: 'inventory_api' },
    timestamp: readingTimestamp,
    status,
    deterministic: true,
    command: 'fixture',
    command_hash: '0'.repeat(64),
    tier: 'L0',
  };
  expect(validateReading(value), JSON.stringify(validateReading.errors)).toBe(true);
  return value;
}

function cell(readings: readonly SensorReading[], timestamp: string, staleFailAfterMs: number) {
  return computeScorecard({
    timestamp,
    integrationHead: 'a'.repeat(40),
    readings,
    staleFailAfterMs,
  }).cells.find((candidate) => candidate.substrate === 'F4' && candidate.property === 'T1');
}

describe('scorecard stale-failure windows', () => {
  it('downgrades an old failure at a zero millisecond window', () => {
    const result = cell([reading('fail', 'a')], '2026-09-08T12:00:00.001Z', 0);

    expect(result).toMatchObject({
      verdict: 'REVIEW',
      notes: `REVIEW-stale: latest inventory_api failure at ${readingTimestamp}`,
    });
  });

  it('disables stale downgrading for a negative window', () => {
    const result = cell([reading('fail', 'b')], '2026-09-08T12:00:00.001Z', -1);

    expect(result).toMatchObject({ verdict: 'FAIL' });
    expect(result?.notes).toBe(`latest inventory_api failure at ${readingTimestamp}`);
    expect(result?.notes).not.toContain('REVIEW-stale');
  });

  it('does not classify an old non-failure reading as stale failure evidence', () => {
    const result = cell([reading('pass', 'c')], '2026-09-08T12:00:00.001Z', 0);

    expect(result).toMatchObject({ verdict: 'PASS', sensor_readings: ['SR-' + 'c'.repeat(16)] });
    expect(result).not.toHaveProperty('notes');
  });
});
