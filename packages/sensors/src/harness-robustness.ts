import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import { invokeGhJson } from './harness/gh-api.js';

/**
 * F5 harness robustness sensor (28.H; F5×T8). Per design note at
 * docs/theory/architecture/sensors/harness_robustness.md.
 */

export interface HarnessRobustnessOptions {
  readonly repoRoot: string;
  readonly branch?: string;
  readonly limit?: number;
  readonly thresholds?: { readonly pass: number; readonly review: number };
  readonly now?: string;
}

const DEFAULT_THRESHOLDS = { pass: 5, review: 15 } as const;

interface GhRun {
  readonly conclusion?: string;
  readonly attempt?: number;
}

export function senseHarnessRobustness(opts: HarnessRobustnessOptions): SensorReading {
  const branch = opts.branch ?? 'main';
  const limit = opts.limit ?? 100;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  const args = [
    'run',
    'list',
    '--branch',
    branch,
    '--json',
    'conclusion,attempt',
    '--limit',
    String(limit),
  ];
  const result = invokeGhJson<GhRun[]>({ cwd: opts.repoRoot, args });
  if (!result.ok) {
    return buildSensorReading({
      sensorName: 'harness-robustness',
      sensorKind: 'harness_robustness',
      command: ['gh', ...args],
      status: 'unknown',
      deterministic: false,
      tier: 'L2',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_ROBUSTNESS_GH_UNAVAILABLE',
          message: `Skipped: ${result.reason}`,
        },
      ],
      metrics: { run_count: 0 },
    });
  }

  const total = result.data.length;
  if (total === 0) {
    return buildSensorReading({
      sensorName: 'harness-robustness',
      sensorKind: 'harness_robustness',
      command: ['gh', ...args],
      status: 'review',
      deterministic: false,
      tier: 'L2',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'warning',
          code: 'HARNESS_ROBUSTNESS_NO_RUNS',
          message: `No CI runs found on branch ${branch}.`,
        },
      ],
      metrics: { run_count: 0, flaky_runs: 0, flakiness_pct: 0 },
    });
  }

  let flaky = 0;
  for (const run of result.data) {
    if (run.conclusion === 'success' && typeof run.attempt === 'number' && run.attempt > 1)
      flaky += 1;
  }
  const pct = (flaky / total) * 100;

  const findings: SensorFinding[] = [];
  let status: SensorStatus;
  if (pct < thresholds.pass) {
    status = 'pass';
  } else if (pct < thresholds.review) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'HARNESS_ROBUSTNESS_FLAKY',
      message: `Flakiness rate ${pct.toFixed(1)}% (above pass ${String(thresholds.pass)}%).`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'HARNESS_ROBUSTNESS_DEGRADED',
      message: `Flakiness rate ${pct.toFixed(1)}% (above review ${String(thresholds.review)}%).`,
    });
  }

  return buildSensorReading({
    sensorName: 'harness-robustness',
    sensorKind: 'harness_robustness',
    command: ['gh', ...args],
    status,
    deterministic: false,
    tier: 'L2',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      run_count: total,
      flaky_runs: flaky,
      flakiness_pct: Number(pct.toFixed(2)),
      threshold_pass: thresholds.pass,
      threshold_review: thresholds.review,
    },
  });
}
