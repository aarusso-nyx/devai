import { describe, expect, it } from 'vitest';
import {
  computeScorecard,
  filterLatestPerKind,
  loadScorecardFailureMaxAgeMs,
} from '../../packages/loop/src/index.js';
import type { SensorReading } from '../../packages/sensors/src/index.js';

function reading(id: string, timestamp: string, status: SensorReading['status']): SensorReading {
  return {
    schemaVersion: '1.0.0',
    id,
    sensor: { name: 'eslint', kind: 'lint' },
    timestamp,
    status,
    deterministic: true,
    command: 'pnpm lint',
    command_hash: '0'.repeat(64),
  };
}

function lintCell(readings: SensorReading[], staleFailAfterMs?: number) {
  const scorecard = computeScorecard({
    timestamp: '2026-07-23T12:00:00.000Z',
    integrationHead: 'a'.repeat(40),
    readings,
    ...(staleFailAfterMs !== undefined && { staleFailAfterMs }),
  });
  return scorecard.cells.find((cell) => cell.substrate === 'F2' && cell.property === 'T5');
}

describe('DII-103 same-kind sensor standing', () => {
  it('keeps FAIL when a newer UNKNOWN reading arrives', () => {
    const fail = reading('SR-fail', '2026-07-23T10:00:00.000Z', 'fail');
    const unknown = reading('SR-unknown', '2026-07-23T11:00:00.000Z', 'unknown');
    expect(filterLatestPerKind([fail, unknown])).toEqual([fail]);
    expect(lintCell([fail, unknown])?.verdict).toBe('FAIL');
  });

  it('allows newer same-kind PASS evidence to supersede FAIL', () => {
    const fail = reading('SR-fail', '2026-07-23T10:00:00.000Z', 'fail');
    const pass = reading('SR-pass', '2026-07-23T11:00:00.000Z', 'pass');
    expect(filterLatestPerKind([fail, pass])).toEqual([pass]);
    expect(lintCell([fail, pass])?.verdict).toBe('PASS');
  });

  it('turns a stale latest FAIL into REVIEW-stale without dropping its evidence', () => {
    const policyMs = loadScorecardFailureMaxAgeMs(new URL('../..', import.meta.url).pathname);
    expect(policyMs).toBe(168 * 60 * 60 * 1000);
    const veryOld = reading('SR-fail', '2026-07-01T10:00:00.000Z', 'fail');
    const cell = lintCell([veryOld], policyMs);
    expect(cell?.verdict).toBe('REVIEW');
    expect(cell?.sensor_readings).toEqual(['SR-fail']);
    expect(cell?.notes).toContain('REVIEW-stale');
  });
});
// Invariants: INV-DEVAI-002, INV-DEVAI-012
