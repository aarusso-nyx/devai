import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import { countPatternMatches } from './test-pattern-walker.js';

/**
 * Inventory sensor: test robustness coverage (F3 × T8). Phase 27.L.
 * Per design note at docs/theory/architecture/sensors/test_robustness_coverage.md.
 */

export interface TestRobustnessCoverageOptions {
  readonly repoRoot: string;
  readonly testGlobs?: readonly string[];
  readonly extraPatterns?: readonly string[];
  readonly thresholds?: { readonly pass: number; readonly review: number };
  readonly now?: string;
}

const DEFAULT_PATTERNS = [
  'throws',
  'reject',
  'toThrow',
  'toReject',
  'error',
  'fail',
  'fault',
  'chaos',
  'retry',
  'timeout',
  'exception',
  'NotFound',
  'Forbidden',
  'Unauthorized',
  'BadRequest',
];
const DEFAULT_THRESHOLDS = { pass: 10, review: 5 } as const;

export function senseTestRobustnessCoverage(opts: TestRobustnessCoverageOptions): SensorReading {
  const patterns = [...DEFAULT_PATTERNS, ...(opts.extraPatterns ?? [])];
  const re = new RegExp(`\\b(${patterns.join('|')})\\b`, 'i');
  const result = countPatternMatches(opts.repoRoot, re, opts.testGlobs);
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const pct = result.total === 0 ? 0 : (result.matched / result.total) * 100;

  const findings: SensorFinding[] = [];
  let status: SensorStatus;
  if (result.total === 0) {
    status = 'review';
    findings.push({
      severity: 'info',
      code: 'TEST_ROBUSTNESS_NO_TESTS',
      message: 'No test files found.',
    });
  } else if (pct >= thresholds.pass) {
    status = 'pass';
  } else if (pct >= thresholds.review) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'TEST_ROBUSTNESS_LOW_COVERAGE',
      message: `${pct.toFixed(1)}% error-path tests (below pass ${String(thresholds.pass)}%).`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'TEST_ROBUSTNESS_BELOW_THRESHOLD',
      message: `${pct.toFixed(1)}% error-path tests (below review ${String(thresholds.review)}%).`,
    });
  }

  return buildSensorReading({
    sensorName: 'test-robustness-coverage',
    sensorKind: 'test_robustness_coverage',
    command: ['devai', 'sense-test-robustness-coverage'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      test_files: result.total,
      robust_tests: result.matched,
      robust_pct: Number(pct.toFixed(2)),
      threshold_pass: thresholds.pass,
      threshold_review: thresholds.review,
    },
  });
}
