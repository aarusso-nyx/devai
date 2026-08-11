import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: test coverage depth (F3 × T2). Translates a normalized
 * coverage summary into a PASS/REVIEW/FAIL verdict using configurable
 * thresholds. The sensor is pure with respect to its summary input.
 *
 * Status semantics (defaults):
 *   - PASS: lines_pct ≥ 80.
 *   - REVIEW: 50 ≤ lines_pct < 80.
 *   - FAIL: lines_pct < 50.
 *   - UNKNOWN-ish: coverage report missing → status='review' with a
 *     finding code, so adopters see "coverage not collected" rather
 *     than a falsely-passing zero.
 *
 * Adopters override thresholds via the pack-config key
 * `extractor_params.test_coverage.thresholds: {pass:80, review:50}`
 * (CLI passes through; the sensor stays pure).
 */

export interface TestCoverageDepthOptions {
  /**
   * Caller-supplied summary. `null` indicates the coverage file was
   * missing (the sensor surfaces this as REVIEW with an explicit
   * finding code).
   */
  readonly summary: { readonly lines_total: number; readonly lines_covered: number } | null;
  readonly thresholds?: { readonly pass: number; readonly review: number };
  readonly now?: string;
  readonly coveragePath?: string;
}

const DEFAULT_THRESHOLDS = { pass: 80, review: 50 } as const;

export function senseTestCoverageDepth(opts: TestCoverageDepthOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  let status: SensorStatus;
  const findings: SensorFinding[] = [];
  let linesPct = 0;
  let linesTotal = 0;
  let linesCovered = 0;

  if (opts.summary === null) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'TEST_COVERAGE_REPORT_MISSING',
      message:
        opts.coveragePath !== undefined
          ? `Coverage report not found at ${opts.coveragePath}. Run \`pnpm test:coverage\` first.`
          : 'Coverage report not found. Run `pnpm test:coverage` first.',
    });
  } else {
    linesTotal = opts.summary.lines_total;
    linesCovered = opts.summary.lines_covered;
    linesPct = linesTotal === 0 ? 0 : (linesCovered / linesTotal) * 100;
    if (linesPct >= thresholds.pass) {
      status = 'pass';
    } else if (linesPct >= thresholds.review) {
      status = 'review';
      findings.push({
        severity: 'warning',
        code: 'TEST_COVERAGE_PARTIAL',
        message: `Lines coverage ${linesPct.toFixed(1)}% is between review (${String(thresholds.review)}%) and pass (${String(thresholds.pass)}%) thresholds.`,
      });
    } else {
      status = 'fail';
      findings.push({
        severity: 'error',
        code: 'TEST_COVERAGE_BELOW_THRESHOLD',
        message: `Lines coverage ${linesPct.toFixed(1)}% is below review threshold (${String(thresholds.review)}%).`,
      });
    }
  }

  return buildSensorReading({
    sensorName: 'test-coverage-depth',
    sensorKind: 'test_coverage_depth',
    command: ['devai', 'sense-test-coverage-depth'],
    status,
    deterministic: true,
    tier: 'L2',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      lines_total: linesTotal,
      lines_covered: linesCovered,
      lines_pct: Number(linesPct.toFixed(2)),
      threshold_pass: thresholds.pass,
      threshold_review: thresholds.review,
    },
  });
}
