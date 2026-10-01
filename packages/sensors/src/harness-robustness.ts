import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import {
  insufficientSampleFinding,
  samplePopulation,
  type HarnessPopulationOptions,
} from './harness/gh-api.js';

/**
 * F5 harness robustness sensor (28.H; F5×T8). Per design note at
 * docs/theory/architecture/sensors/harness_robustness.md.
 */

export interface HarnessRobustnessOptions extends HarnessPopulationOptions {
  readonly thresholds?: { readonly pass: number; readonly review: number };
}

const DEFAULT_THRESHOLDS = { pass: 5, review: 15 } as const;

export function senseHarnessRobustness(opts: HarnessRobustnessOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const common = {
    sensorName: 'harness-robustness',
    sensorKind: 'harness_robustness',
    deterministic: false,
    tier: 'L2',
    ...(opts.now !== undefined && { timestamp: opts.now }),
  } as const;

  const sample = samplePopulation(opts);
  if (!sample.ok) {
    return buildSensorReading({
      ...common,
      command: ['gh', ...sample.args],
      status: 'unknown',
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_ROBUSTNESS_GH_UNAVAILABLE',
          message: `Skipped: ${sample.reason}`,
        },
      ],
      metrics: { run_count: 0 },
    });
  }
  const command = ['gh', ...sample.args];

  const total = sample.runs.length;
  if (total < sample.minimum) {
    return buildSensorReading({
      ...common,
      command,
      status: 'unknown',
      findings: [
        insufficientSampleFinding(
          'HARNESS_ROBUSTNESS_INSUFFICIENT_SAMPLE',
          total,
          sample.minimum,
          sample.describe,
          'run(s)',
        ),
        sample.unverifiedFinding,
      ],
      metrics: { run_count: total, sample_size: total, ...sample.metrics },
    });
  }

  let flaky = 0;
  for (const run of sample.runs) {
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
  findings.push(sample.unverifiedFinding);

  return buildSensorReading({
    ...common,
    command,
    status,
    findings,
    metrics: {
      run_count: total,
      flaky_runs: flaky,
      flakiness_pct: Number(pct.toFixed(2)),
      threshold_pass: thresholds.pass,
      threshold_review: thresholds.review,
      sample_size: total,
      ...sample.metrics,
    },
  });
}
