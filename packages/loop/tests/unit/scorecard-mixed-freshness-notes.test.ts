import { getValidator } from '@devai-nyx/schemas';
import type { SensorReading } from '@devai-nyx/sensors';
import { describe, expect, it } from 'vitest';
import { computeScorecard } from '../../src/loop/scorecard.js';

const generatedAt = '2026-09-08T12:00:00.000Z';
const staleTimestamp = '2026-09-08T10:00:00.000Z';
const freshTimestamp = '2026-09-08T11:30:00.000Z';
const validateReading = getValidator('sensor-reading.schema.json');

function reading(
  kind: 'inventory_api' | 'inventory_routes',
  idSuffix: string,
  timestamp: string,
): SensorReading {
  const value: SensorReading = {
    schemaVersion: '1.0.0',
    id: `SR-${idSuffix.repeat(16)}`,
    sensor: { name: kind, kind },
    timestamp,
    status: 'fail',
    deterministic: true,
    command: 'fixture',
    command_hash: '0'.repeat(64),
    tier: 'L0',
  };
  expect(validateReading(value), JSON.stringify(validateReading.errors)).toBe(true);
  return value;
}

describe('scorecard mixed freshness notes', () => {
  it('preserves stale and fresh failure notes and both reading references on one cell', () => {
    const stale = reading('inventory_api', 'a', staleTimestamp);
    const fresh = reading('inventory_routes', 'b', freshTimestamp);
    const scorecard = computeScorecard({
      timestamp: generatedAt,
      integrationHead: 'a'.repeat(40),
      readings: [stale, fresh],
      staleFailAfterMs: 60 * 60 * 1000,
    });
    const cell = scorecard.cells.find(
      (candidate) => candidate.substrate === 'F4' && candidate.property === 'T1',
    );

    expect(cell).toMatchObject({
      verdict: 'FAIL',
      sensor_readings: [stale.id, fresh.id],
      notes:
        `REVIEW-stale: latest inventory_api failure at ${staleTimestamp}; ` +
        `latest inventory_routes failure at ${freshTimestamp}`,
    });
  });

  it('preserves the same note contract when the API failure is fresh and routes failure is stale', () => {
    const fresh = reading('inventory_api', 'c', freshTimestamp);
    const stale = reading('inventory_routes', 'd', staleTimestamp);
    const scorecard = computeScorecard({
      timestamp: generatedAt,
      integrationHead: 'a'.repeat(40),
      readings: [fresh, stale],
      staleFailAfterMs: 60 * 60 * 1000,
    });
    const cell = scorecard.cells.find(
      (candidate) => candidate.substrate === 'F4' && candidate.property === 'T1',
    );

    expect(cell).toMatchObject({
      verdict: 'FAIL',
      sensor_readings: [fresh.id, stale.id],
      notes:
        `latest inventory_api failure at ${freshTimestamp}; ` +
        `REVIEW-stale: latest inventory_routes failure at ${staleTimestamp}`,
    });
  });

  it('does not attach failure notes to a passing reading', () => {
    const passing = reading('inventory_api', 'e', freshTimestamp);
    const scorecard = computeScorecard({
      timestamp: generatedAt,
      integrationHead: 'a'.repeat(40),
      readings: [{ ...passing, status: 'pass' }],
      staleFailAfterMs: 60 * 60 * 1000,
    });
    const cell = scorecard.cells.find(
      (candidate) => candidate.substrate === 'F4' && candidate.property === 'T1',
    );

    expect(cell).toBeDefined();
    expect(cell).toMatchObject({ verdict: 'PASS', sensor_readings: [passing.id] });
    expect(cell).not.toHaveProperty('notes');
  });
});
