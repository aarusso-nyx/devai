import { describe, expect, it } from 'vitest';
import { detectRelabeledSensors } from '../../src/loop/sensor-integrity.js';
import type { SensorReading } from '@devai-nyx/sensors';
import './triage-cases.js';

/**
 * Minimal fixture builder — `detectRelabeledSensors` reads only
 * `id`, `sensor.kind`, and `command_hash`, so the fixture stays
 * loose rather than fighting `SensorKind`'s closed union (schema
 * conformance for real sensor kinds is covered by sensor-reading
 * schema tests elsewhere, not the point of this unit).
 */
function reading(opts: { id: string; kind: string; hash?: string }): SensorReading {
  return {
    schemaVersion: '1.0.0',
    id: opts.id,
    sensor: { name: `sensor-${opts.kind}`, kind: opts.kind },
    timestamp: '2026-07-12T00:00:00.000Z',
    status: 'pass',
    deterministic: true,
    command: 'npm run governance:check',
    ...(opts.hash !== undefined && { command_hash: opts.hash }),
  } as unknown as SensorReading;
}

describe('detectRelabeledSensors', () => {
  it('returns no groups when readings have no command_hash', () => {
    const readings = [reading({ id: 'a', kind: 'lint' }), reading({ id: 'b', kind: 'typecheck' })];
    expect(detectRelabeledSensors(readings)).toEqual([]);
  });

  it('returns no groups when the same command_hash is used by a single sensor kind (repeated runs)', () => {
    const readings = [
      reading({ id: 'a', kind: 'lint', hash: 'x'.repeat(64) }),
      reading({ id: 'b', kind: 'lint', hash: 'x'.repeat(64) }),
    ];
    expect(detectRelabeledSensors(readings)).toEqual([]);
  });

  it('flags a command_hash shared across distinct sensor kinds', () => {
    const readings = [
      reading({ id: 'a', kind: 'sgp-contracts', hash: 'x'.repeat(64) }),
      reading({ id: 'b', kind: 'sgp-spec-security', hash: 'x'.repeat(64) }),
      reading({ id: 'c', kind: 'lint', hash: 'y'.repeat(64) }),
    ];
    const groups = detectRelabeledSensors(readings);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.command_hash).toBe('x'.repeat(64));
    expect(groups[0]?.kinds).toEqual(['sgp-contracts', 'sgp-spec-security']);
    expect(groups[0]?.reading_ids).toEqual(['a', 'b']);
  });

  it('sorts groups deterministically by command_hash', () => {
    const readings = [
      reading({ id: 'a', kind: 'k1', hash: 'b'.repeat(64) }),
      reading({ id: 'b', kind: 'k2', hash: 'b'.repeat(64) }),
      reading({ id: 'c', kind: 'k3', hash: 'a'.repeat(64) }),
      reading({ id: 'd', kind: 'k4', hash: 'a'.repeat(64) }),
    ];
    const groups = detectRelabeledSensors(readings);
    expect(groups.map((g) => g.command_hash)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });

  it('dedupes repeated (kind, id) pairs within a group', () => {
    const readings = [
      reading({ id: 'a', kind: 'k1', hash: 'z'.repeat(64) }),
      reading({ id: 'a', kind: 'k1', hash: 'z'.repeat(64) }),
      reading({ id: 'b', kind: 'k2', hash: 'z'.repeat(64) }),
    ];
    const groups = detectRelabeledSensors(readings);
    expect(groups[0]?.kinds).toEqual(['k1', 'k2']);
    expect(groups[0]?.reading_ids).toEqual(['a', 'b']);
  });
});
// Invariants: INV-DEVAI-002, INV-DEVAI-007, INV-DEVAI-012
