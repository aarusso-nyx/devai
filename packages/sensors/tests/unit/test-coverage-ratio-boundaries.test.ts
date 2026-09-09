import { describe, expect, it } from 'vitest';
import { senseTestCoverageDepth } from '../../src/test-coverage-depth.js';

const NOW = '2026-09-08T12:00:00.000Z';

describe('test coverage ratio boundaries', () => {
  it('reports missing coverage with the default and explicit path messages', () => {
    const missing = senseTestCoverageDepth({ summary: null, now: NOW });
    expect(missing).toMatchObject({
      status: 'review',
      timestamp: NOW,
      metrics: { lines_total: 0, lines_covered: 0, lines_pct: 0 },
      findings: [
        expect.objectContaining({
          code: 'TEST_COVERAGE_REPORT_MISSING',
          message: 'Coverage report not found. Run `pnpm test:coverage` first.',
        }),
      ],
    });

    const explicit = senseTestCoverageDepth({
      summary: null,
      coveragePath: 'coverage/summary.json',
      now: NOW,
    });
    expect(explicit.findings).toEqual([
      {
        severity: 'warning',
        code: 'TEST_COVERAGE_REPORT_MISSING',
        message:
          'Coverage report not found at coverage/summary.json. Run `pnpm test:coverage` first.',
      },
    ]);
  });

  it('treats a zero-line report as zero coverage and below threshold', () => {
    const reading = senseTestCoverageDepth({
      summary: { lines_total: 0, lines_covered: 0 },
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'fail',
      metrics: { lines_total: 0, lines_covered: 0, lines_pct: 0 },
      findings: [
        {
          severity: 'error',
          code: 'TEST_COVERAGE_BELOW_THRESHOLD',
          message: 'Lines coverage 0.0% is below review threshold (50%).',
        },
      ],
    });
  });

  it('preserves a nontrivial fractional percentage and review finding', () => {
    const reading = senseTestCoverageDepth({
      summary: { lines_total: 3, lines_covered: 2 },
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'review',
      metrics: { lines_total: 3, lines_covered: 2, lines_pct: 66.67 },
      findings: [
        {
          severity: 'warning',
          code: 'TEST_COVERAGE_PARTIAL',
          message: 'Lines coverage 66.7% is between review (50%) and pass (80%) thresholds.',
        },
      ],
    });
  });

  it('passes at exact threshold equality and keeps threshold metrics', () => {
    const reading = senseTestCoverageDepth({
      summary: { lines_total: 5, lines_covered: 4 },
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'pass',
      timestamp: NOW,
      findings: [],
      metrics: {
        lines_total: 5,
        lines_covered: 4,
        lines_pct: 80,
        threshold_pass: 80,
        threshold_review: 50,
      },
    });
  });
});
