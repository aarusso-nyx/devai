import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import { countPatternMatches } from './test-pattern-walker.js';

/**
 * Inventory sensor: test security coverage (F3 × T6). Phase 27.J.
 * Per design note at docs/theory/architecture/sensors/test_security_coverage.md.
 */

export interface TestSecurityCoverageOptions {
  readonly repoRoot: string;
  readonly testGlobs?: readonly string[];
  readonly extraPatterns?: readonly string[];
  readonly thresholds?: { readonly pass: number; readonly review: number };
  readonly now?: string;
}

const DEFAULT_PATTERNS = [
  'auth',
  'rbac',
  'permission',
  'tenant.*isolation',
  'injection',
  'xss',
  'csrf',
  'cve',
  'sql.injection',
];
const DEFAULT_THRESHOLDS = { pass: 5, review: 2 } as const;

export function senseTestSecurityCoverage(opts: TestSecurityCoverageOptions): SensorReading {
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
      code: 'TEST_SECURITY_NO_TESTS',
      message: 'No test files found.',
    });
  } else if (pct >= thresholds.pass) {
    status = 'pass';
  } else if (pct >= thresholds.review) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'TEST_SECURITY_LOW_COVERAGE',
      message: `Only ${pct.toFixed(1)}% of test files match security patterns (below pass ${String(thresholds.pass)}%).`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'TEST_SECURITY_BELOW_THRESHOLD',
      message: `${pct.toFixed(1)}% security tests (below review ${String(thresholds.review)}%).`,
    });
  }

  return buildSensorReading({
    sensorName: 'test-security-coverage',
    sensorKind: 'test_security_coverage',
    command: ['devai', 'sense-test-security-coverage'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      test_files: result.total,
      security_tests: result.matched,
      security_pct: Number(pct.toFixed(2)),
      threshold_pass: thresholds.pass,
      threshold_review: thresholds.review,
    },
  });
}
