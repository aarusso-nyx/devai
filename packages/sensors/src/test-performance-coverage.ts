import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import { countPatternMatches } from './test-pattern-walker.js';

/**
 * Inventory sensor: test performance coverage (F3 × T7). Phase 27.K.
 * Per design note at docs/theory/architecture/sensors/test_performance_coverage.md.
 */

export interface TestPerformanceCoverageOptions {
  readonly repoRoot: string;
  readonly testGlobs?: readonly string[];
  readonly extraPatterns?: readonly string[];
  readonly now?: string;
}

const DEFAULT_PATTERNS = [
  'bench',
  'perf',
  'load',
  'throughput',
  'latency',
  'p95',
  'p99',
  'tps',
  'rps',
  'qps',
];

export function senseTestPerformanceCoverage(opts: TestPerformanceCoverageOptions): SensorReading {
  const patterns = [...DEFAULT_PATTERNS, ...(opts.extraPatterns ?? [])];
  const re = new RegExp(`\\b(${patterns.join('|')})\\b`, 'i');
  const result = countPatternMatches(opts.repoRoot, re, opts.testGlobs);
  const pct = result.total === 0 ? 0 : (result.matched / result.total) * 100;

  const findings: SensorFinding[] = [];
  let status: SensorStatus;
  if (result.total === 0) {
    status = 'review';
    findings.push({
      severity: 'info',
      code: 'TEST_PERFORMANCE_NO_TESTS',
      message: 'No test files found.',
    });
  } else if (result.matched >= 1 && pct >= 1) {
    status = 'pass';
  } else if (result.matched >= 1) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'TEST_PERFORMANCE_LOW_COVERAGE',
      message: `${String(result.matched)} perf tests across ${String(result.total)} total — below 1% threshold.`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'TEST_PERFORMANCE_NO_PERF_TESTS',
      message: 'No test files matched perf patterns.',
    });
  }

  return buildSensorReading({
    sensorName: 'test-performance-coverage',
    sensorKind: 'test_performance_coverage',
    command: ['devai', 'sense-test-performance-coverage'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      test_files: result.total,
      perf_tests: result.matched,
      perf_pct: Number(pct.toFixed(2)),
    },
  });
}
