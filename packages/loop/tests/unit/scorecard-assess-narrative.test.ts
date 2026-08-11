import { describe, expect, it } from 'vitest';
import './round-lifecycle-cases.js';
import { assessScorecard, computeScorecard } from '../../src/loop/scorecard.js';
import type { SensorReading } from '@devai-nyx/sensors';

/**
 * Assessment narrative coverage.
 * gains an actionable-advice paragraph when the scorecard is
 * heavily UNKNOWN (more than half of cells).
 *
 * Pre-22.F, the narrative diagnosed correctly ("X/45 cells
 * passing, Y cell(s) unknown (sensor coverage gap)") but offered
 * no path forward — adopters reading it had no obvious next
 * action. Post-22.F, when >50% of cells are UNKNOWN, the
 * narrative appends a paragraph citing the L1+ correctness
 * sensors most likely missing + cross-linking to the
 * `docs/adopters/first-introspection.md#correctness-sensors`
 * section documenting the `devai sense-* --emit-reading`
 * wrapper pattern.
 */

function buildReading(
  kind: SensorReading['sensor']['kind'],
  status: SensorReading['status'],
  id: string,
): SensorReading {
  return {
    schemaVersion: '1.0.0',
    id,
    sensor: { name: `inventory:${kind}`, kind },
    timestamp: '2026-05-16T12:00:00.000Z',
    status,
    deterministic: true,
    command: 'fixture',
    command_hash: '0'.repeat(64),
    tier: 'L0',
  };
}

describe('assessScorecard appends actionable advice when scorecard is heavily UNKNOWN (Phase 22.F, closes D-A-16)', () => {
  it('appends the advice paragraph when >50% of cells are UNKNOWN', () => {
    // Empty readings → every cell is UNKNOWN (modulo degenerate
    // cells which are N/A). That's the worst-case "adopter
    // hasn't wrapped any sensors yet" shape.
    const scorecard = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings: [],
    });
    const assessment = assessScorecard(scorecard, '2026-05-16T12:00:00.000Z');
    expect(assessment.narrative).toMatch(/cell\(s\) unknown/);
    expect(assessment.narrative).toMatch(/heavily UNKNOWN/);
    expect(assessment.narrative).toContain('sense-lint');
    expect(assessment.narrative).toContain('sense-test');
    expect(assessment.narrative).toContain('sense-build');
    expect(assessment.narrative).toContain('sense-type-check');
    expect(assessment.narrative).toContain('--emit-reading');
    expect(assessment.narrative).toContain(
      'docs/adopters/first-introspection.md#correctness-sensors',
    );
  });

  it('does NOT append the advice paragraph against a synthetic mostly-populated scorecard', () => {
    // The 5×9 - 1 (N/A) = 44 actionable cells is bigger than what
    // any current sensor set can populate (mapSensorToCell targets
    // ~13 distinct cells when every defined sensor is exercised).
    // For the unit test, hand-craft a 5×9 scorecard whose UNKNOWN
    // cell count is below the half-cells threshold by constructing
    // a Scorecard literal directly. This bypasses computeScorecard
    // but exercises assessScorecard's narrative logic faithfully.
    const cells = [];
    for (let i = 0; i < 30; i++) {
      cells.push({
        substrate: 'F2' as const,
        property: 'T1' as const,
        verdict: 'PASS' as const,
        deterministic: true,
      });
    }
    for (let i = 0; i < 14; i++) {
      cells.push({
        substrate: 'F2' as const,
        property: 'T1' as const,
        verdict: 'UNKNOWN' as const,
        deterministic: true,
      });
    }
    // 30 PASS + 14 UNKNOWN = 44 cells; unknown * 2 = 28 < 44.
    const synthetic = {
      schemaVersion: '1.0.0' as const,
      id: 'SC-20260516T120000-001',
      generated_at: '2026-05-16T12:00:00.000Z',
      integration_head: '0'.repeat(39) + 'f',
      thresholds_used: { source: 'defaults' },
      cells,
      substrate_aggregates: {},
      invariant_rollups: [],
      overall: { verdict: 'PASS' as const },
    };
    const assessment = assessScorecard(synthetic, '2026-05-16T12:00:00.000Z');
    expect(assessment.narrative).not.toMatch(/heavily UNKNOWN/);
    expect(assessment.narrative).not.toContain('--emit-reading');
  });

  it('appends the advice when unknown count crosses the half-cells threshold', () => {
    // Just one inventory reading → most cells stay UNKNOWN.
    const scorecard = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings: [buildReading('inventory_api', 'pass', 'SR-only-api')],
    });
    const assessment = assessScorecard(scorecard, '2026-05-16T12:00:00.000Z');
    expect(assessment.narrative).toMatch(/heavily UNKNOWN/);
  });

  it('honours the pre-22.F narrative structure (status + cell counts) before the advice', () => {
    const scorecard = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings: [],
    });
    const assessment = assessScorecard(scorecard, '2026-05-16T12:00:00.000Z');
    // Status line + pass-count + unknown-count come first
    // (pre-22.F structure), then the new advice paragraph after.
    const lines = assessment.narrative.split(' ');
    expect(lines[0]).toBe('Overall:');
    expect(assessment.narrative).toMatch(/\d+\/\d+ cells passing/);
    expect(assessment.narrative.indexOf('cell(s) unknown')).toBeLessThan(
      assessment.narrative.indexOf('heavily UNKNOWN'),
    );
  });
});

/**
 * Phase 23.I (closes D-A-16): per-cell-class actionable narrative.
 * `assessScorecard` accepts an optional `readings` array and uses it
 * to enrich the narrative with FAIL details (quoting findings) +
 * REVIEW reasons (listing finding codes) + UNKNOWN-with-SR-but-
 * classifier-rejected hints. Pre-23.I, the narrative was a single
 * text block diagnosing only the bulk UNKNOWN case.
 */
describe('assessScorecard per-cell-class narrative (Phase 23.I, closes D-A-16)', () => {
  function buildReadingWithFindings(
    kind: SensorReading['sensor']['kind'],
    status: SensorReading['status'],
    id: string,
    findings: SensorReading['findings'] = undefined,
    err_head?: string,
  ): SensorReading {
    const r: SensorReading = {
      schemaVersion: '1.0.0',
      id,
      sensor: { name: `sense-${kind}`, kind },
      timestamp: '2026-05-16T12:00:00.000Z',
      status,
      deterministic: true,
      command: 'fixture',
      command_hash: '0'.repeat(64),
      tier: 'L1',
    };
    if (findings !== undefined) r.findings = [...findings];
    if (err_head !== undefined) r.err_head = err_head;
    return r;
  }

  it('FAIL cell quotes the first finding verbatim (with file:line when present)', () => {
    const failing = buildReadingWithFindings('type_check', 'fail', 'SR-tc-fail', [
      {
        severity: 'error',
        code: 'TS2304',
        message: "Cannot find name 'describe'.",
        file: 'packages/auth/test/auth.spec.ts',
        line: 7,
      },
    ]);
    const scorecard = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings: [failing],
    });
    const assessment = assessScorecard(scorecard, '2026-05-16T12:00:00.000Z', 1, [failing]);
    expect(assessment.narrative).toContain('Per-cell signals:');
    expect(assessment.narrative).toMatch(/F2×T8 FAIL: type_check → TS2304:/);
    expect(assessment.narrative).toContain("Cannot find name 'describe'.");
    expect(assessment.narrative).toContain('packages/auth/test/auth.spec.ts:7');
  });

  it('FAIL cell falls back to err_head when no findings are present', () => {
    const failing = buildReadingWithFindings(
      'build',
      'fail',
      'SR-build-fail',
      [],
      'build aborted: missing entry point apps/api/src/main.ts',
    );
    const scorecard = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings: [failing],
    });
    const assessment = assessScorecard(scorecard, '2026-05-16T12:00:00.000Z', 1, [failing]);
    expect(assessment.narrative).toContain('build aborted: missing entry point');
  });

  it('REVIEW cell lists unique review finding codes', () => {
    const review = buildReadingWithFindings('inventory_coverage', 'review', 'SR-cov-review', [
      { severity: 'warning', code: 'COVERAGE_PARTIAL_USE_CASE_LINKING', message: '...' },
      { severity: 'warning', code: 'COVERAGE_PARTIAL_USE_CASE_LINKING', message: '...' },
      { severity: 'warning', code: 'COVERAGE_NO_USE_CASES', message: '...' },
    ]);
    const scorecard = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings: [review],
    });
    const assessment = assessScorecard(scorecard, '2026-05-16T12:00:00.000Z', 1, [review]);
    expect(assessment.narrative).toMatch(/F4×T1 REVIEW:.*COVERAGE_/);
    expect(assessment.narrative).toContain('COVERAGE_NO_USE_CASES');
    expect(assessment.narrative).toContain('COVERAGE_PARTIAL_USE_CASE_LINKING');
  });

  it('UNKNOWN cell with SR ref flags classifier mismatch (kind named)', () => {
    // Stage a reading with status=unknown — classifier returns
    // UNKNOWN even though the SR is present.
    const unknownSR = buildReadingWithFindings('type_check', 'unknown', 'SR-tc-unknown');
    const scorecard = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings: [unknownSR],
    });
    const assessment = assessScorecard(scorecard, '2026-05-16T12:00:00.000Z', 1, [unknownSR]);
    expect(assessment.narrative).toMatch(/F2×T8 UNKNOWN.*SR exists.*kind=type_check/);
  });

  it('omits per-cell signals block entirely when readings is empty (pre-23.I shape)', () => {
    const scorecard = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings: [],
    });
    const assessment = assessScorecard(scorecard, '2026-05-16T12:00:00.000Z');
    expect(assessment.narrative).not.toContain('Per-cell signals:');
  });
});
// Invariants: INV-DEVAI-006, INV-DEVAI-011
