import { describe, expect, it } from 'vitest';
import type { SensorReading } from '@devai-nyx/sensors';
import { assessScorecard, computeScorecard, type Scorecard } from '../../src/loop/scorecard.js';
const NOW = '2026-09-08T12:00:00.000Z';
function reading(
  status: SensorReading['status'],
  change: Partial<SensorReading> = {},
): SensorReading {
  return {
    schemaVersion: '1.0.0',
    id: 'SR-' + 'a'.repeat(16),
    sensor: { kind: 'type_check', name: 'type-check' },
    timestamp: NOW,
    status,
    deterministic: true,
    tier: 'L1',
    command: 'fixture',
    command_hash: 'a'.repeat(64),
    ...change,
  };
}
function card(readings: SensorReading[]): Scorecard {
  const coords = computeScorecard({ timestamp: NOW, integrationHead: 'a'.repeat(40) }).cells;
  return computeScorecard({
    timestamp: NOW,
    integrationHead: 'a'.repeat(40),
    readings,
    naCells: new Set(
      coords
        .filter((c) => c.substrate !== 'F2' || c.property !== 'T8')
        .map((c) => `${c.substrate}:${c.property}`),
    ),
  });
}
function narrative(scorecard: Scorecard, readings: SensorReading[]) {
  const before = JSON.stringify({ scorecard, readings });
  const result = assessScorecard(scorecard, NOW, 1, readings);
  expect(JSON.stringify({ scorecard, readings })).toBe(before);
  return result.narrative;
}
function failure(detail: string) {
  return `Overall: RED. 0/45 cells passing. 1 cell(s) failing. Per-cell signals:\n  - F2×T8 FAIL: ${detail}`;
}

describe('assessment explains the exact supplied evidence and its gaps', () => {
  it.each(['fail', 'error', 'killed'] as const)(
    'retains %s first finding and ignores later findings and stderr',
    (status) => {
      const r = reading(status, {
        findings: [
          { severity: 'error', code: 'FIRST', message: 'Fix this', file: 'src/ação.ts', line: 7 },
          { severity: 'error', code: 'SECOND', message: 'Do not substitute' },
        ],
        err_head: 'Do not substitute stderr',
      });
      expect(narrative(card([r]), [r])).toBe(
        failure('type_check → FIRST: Fix this (src/ação.ts:7)'),
      );
    },
  );
  it.each([159, 160, 161])(
    'bounds a finding message of length %s while preserving its file location',
    (length) => {
      const message = 'x'.repeat(length);
      const r = reading('fail', {
        findings: [{ severity: 'error', code: 'BOUND', message, file: 'src/a.ts' }],
      });
      expect(narrative(card([r]), [r])).toBe(
        failure(
          `type_check → BOUND: ${length <= 160 ? message : 'x'.repeat(159) + '…'} (src/a.ts)`,
        ),
      );
    },
  );
  it.each([160, 161])('bounds stderr of length %s when findings are absent', (length) => {
    const r = reading('error', { err_head: 'y'.repeat(length) });
    expect(narrative(card([r]), [r])).toBe(
      failure(`type_check → ${length <= 160 ? 'y'.repeat(length) : 'y'.repeat(159) + '…'}`),
    );
  });
  it('does not invent a file for a finding that has none', () => {
    const r = reading('fail', {
      findings: [{ severity: 'error', code: 'NO_PATH', message: 'Exact message' }],
    });
    expect(narrative(card([r]), [r])).toBe(failure('type_check → NO_PATH: Exact message'));
  });
  it.each([0, 17, undefined])(
    'reports exit identity %s when both findings and stderr are unavailable',
    (exit_code) => {
      const r = reading('fail', { exit_code, err_head: '', findings: [] });
      expect(narrative(card([r]), [r])).toBe(
        failure(`type_check → exit=${String(exit_code ?? '?')} (no findings)`),
      );
    },
  );
  it('names an unresolved referenced reading rather than silently omitting the gap', () => {
    const r = reading('fail');
    expect(narrative(card([r]), [])).toBe(failure(`SR ${r.id} not loaded`));
  });
  it('does not quote passing evidence as a failure explanation', () => {
    const r = reading('fail');
    const passing = { ...r, status: 'pass' as const, err_head: 'not a failure' };
    expect(narrative(card([r]), [passing])).toBe(failure('(no failure detail available)'));
  });
  it('distinguishes absent references from referenced readings with no failure detail', () => {
    const c = card([reading('fail')]);
    c.cells = c.cells.map((cell) =>
      cell.verdict === 'FAIL' ? { ...cell, sensor_readings: undefined } : cell,
    );
    expect(narrative(c, [])).toBe(failure('(no SR refs; cell verdict came from elsewhere)'));
  });
  it('sorts and deduplicates only warning/info codes from review evidence', () => {
    const r = reading('review', {
      findings: [
        { severity: 'warning', code: 'Z_CODE', message: 'z' },
        { severity: 'info', code: 'A_CODE', message: 'a' },
        { severity: 'warning', code: 'Z_CODE', message: 'duplicate' },
        { severity: 'error', code: 'ERROR_NOT_REVIEW', message: 'different class' },
      ],
    });
    expect(narrative(card([r]), [r])).toBe(
      'Overall: YELLOW. 0/45 cells passing. 1 cell(s) in review. Per-cell signals:\n  - F2×T8 REVIEW: A_CODE, Z_CODE',
    );
  });
  it('describes a review with no cited eligible findings explicitly', () => {
    const r = reading('review');
    expect(narrative(card([r]), [r])).toContain('F2×T8 REVIEW: (no review findings cited)');
  });
  it('deduplicates known kinds and identifies unresolved references in an UNKNOWN cell', () => {
    const r = reading('unknown');
    const c = card([r]);
    c.cells = c.cells.map((cell) =>
      cell.substrate === 'F2' && cell.property === 'T8'
        ? { ...cell, sensor_readings: [r.id, 'SR-' + 'b'.repeat(16), r.id] }
        : cell,
    );
    expect(narrative(c, [r])).toContain('kind=type_check, <unknown>)');
  });
  it.each([22, 23])(
    'offers coverage advice only above half of the 45 cells (%s UNKNOWN)',
    (unknown) => {
      const c = computeScorecard({ timestamp: NOW, integrationHead: 'a'.repeat(40) });
      let count = 0;
      c.cells = c.cells.map((cell) =>
        cell.verdict === 'UNKNOWN' && count++ < unknown ? cell : { ...cell, verdict: 'N/A' },
      );
      const result = narrative(c, []);
      expect(result.startsWith(`Overall: ${unknown === 23 ? 'YELLOW' : 'GREEN'}.`)).toBe(true);
      expect(result.includes('Your scorecard is heavily UNKNOWN.')).toBe(unknown === 23);
    },
  );
  it('binds the assessment to the exact scorecard and UTC identity without inventing backlog actions', () => {
    const c = card([reading('pass')]);
    const result = assessScorecard(c, '2026-01-02T00:03:04.987+03:00', 7);
    expect(result).toEqual({
      schemaVersion: '1.0.0',
      id: 'AS-20260101T210304-007',
      generated_at: '2026-01-02T00:03:04.987+03:00',
      scorecard_id: c.id,
      previous_assessment_id: null,
      narrative: 'Overall: GREEN. 1/45 cells passing.',
      deltas: [],
      backlog_actions: { additions: [], completions: [], deprioritizations: [] },
      recommended_priorities: [],
    });
  });
});
