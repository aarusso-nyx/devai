import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { executableTestPopulation } from './test-file-population.js';
import { classifyTestMocks } from './test-mock-classification.js';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: test idiomaticity (F3 × T5). Phase 27.I.
 * Per design note at docs/theory/architecture/sensors/test_idiomaticity.md.
 */

export interface TestIdiomaticityOptions {
  readonly repoRoot: string;
  readonly testGlobs?: readonly string[];
  readonly thresholds?: { readonly review: number; readonly fail: number };
  readonly now?: string;
}

const DEFAULT_THRESHOLDS = { review: 0.5, fail: 0.8 } as const;
const INTEGRATION_RE =
  /(?:^|\/)(?:integration|e2e|wiring)(?:\/|$)|\.(?:integration|e2e|wiring-spec)(?:\.(?:test|spec))?\.[cm]?[jt]sx?$/iu;

export function senseTestIdiomaticity(opts: TestIdiomaticityOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  const population = executableTestPopulation(opts.repoRoot, opts.testGlobs);
  const files = population.paths;
  const errors = [...population.errors];

  let mockHeavyFiles = 0;
  let mocksInIntegration = 0;
  let totalMocks = 0;
  let totalFixtures = 0;
  let totalSnapshots = 0;
  const findings: SensorFinding[] = [];
  let observers = 0;
  let faultInjections = 0;
  let externalPorts = 0;

  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, 'utf8');
    } catch (error) {
      errors.push(`Cannot read executable test ${f}: ${String(error)}`);
      continue;
    }
    const classified = classifyTestMocks(opts.repoRoot, f, content);
    const { mocks, fixtures, snapshots } = classified;
    observers += classified.observers;
    faultInjections += classified.faultInjections;
    externalPorts += classified.externalPorts;
    totalMocks += mocks;
    totalFixtures += fixtures;
    totalSnapshots += snapshots;
    if (mocks >= 2) mockHeavyFiles += 1;
    const rel = relative(resolve(opts.repoRoot), f).replace(/\\/gu, '/');
    if (mocks > 0 && INTEGRATION_RE.test(rel)) {
      mocksInIntegration += 1;
      findings.push({
        severity: 'warning',
        code: 'TEST_IDIOMATICITY_MOCK_IN_INTEGRATION',
        message:
          classified.unresolved > 0
            ? `Integration/e2e file has unresolved mock ownership: ${rel}`
            : `Integration/e2e file substitutes owned behavior or an unproved local double: ${rel}`,
        file: rel,
      });
    }
  }

  const total = files.length;
  const mockHeavyRatio = total === 0 ? 0 : mockHeavyFiles / total;
  let status: SensorStatus;
  if (total === 0) {
    status = 'review';
    findings.push({
      severity: 'info',
      code: 'TEST_IDIOMATICITY_NO_TESTS',
      message: 'No test files found.',
    });
  } else if (mockHeavyRatio >= thresholds.fail) {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'TEST_IDIOMATICITY_MOCK_DOMINANT',
      message: `${(mockHeavyRatio * 100).toFixed(1)}% of test files are mock-heavy (≥ ${String(thresholds.fail * 100)}%).`,
    });
  } else if (mockHeavyRatio >= thresholds.review || mocksInIntegration > 0) {
    status = 'review';
    if (mockHeavyRatio >= thresholds.review) {
      findings.push({
        severity: 'warning',
        code: 'TEST_IDIOMATICITY_MOCK_HEAVY',
        message: `${(mockHeavyRatio * 100).toFixed(1)}% of test files are mock-heavy.`,
      });
    }
  } else {
    status = 'pass';
  }

  if (errors.length > 0) {
    status = 'error';
    findings.push(
      ...errors.map((message) => ({
        severity: 'critical' as const,
        code: 'TEST_EXECUTABLE_POPULATION_INCOMPLETE',
        message,
      })),
    );
  }

  return buildSensorReading({
    sensorName: 'test-idiomaticity',
    sensorKind: 'test_idiomaticity',
    command: ['devai', 'sense-test-idiomaticity'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      test_files: total,
      mock_calls: totalMocks,
      call_through_observers: observers,
      observed_fault_injections: faultInjections,
      external_port_substitutions: externalPorts,
      fixture_calls: totalFixtures,
      snapshot_calls: totalSnapshots,
      mock_heavy_files: mockHeavyFiles,
      mock_heavy_ratio: Number(mockHeavyRatio.toFixed(3)),
      mocks_in_integration_files: mocksInIntegration,
    },
  });
}
