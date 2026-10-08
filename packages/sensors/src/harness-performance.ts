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
 * F5 harness performance sensor (28.G; F5×T7). Per design note at
 * docs/theory/architecture/sensors/harness_performance.md.
 */

export interface HarnessPerformanceOptions extends HarnessPopulationOptions {
  readonly thresholds?: {
    readonly passMedianMs: number;
    readonly passP95Ms: number;
    readonly reviewMedianMs: number;
    readonly reviewP95Ms: number;
  };
}

const DEFAULT_THRESHOLDS = {
  passMedianMs: 900_000,
  passP95Ms: 1_800_000,
  reviewMedianMs: 1_200_000,
  reviewP95Ms: 3_600_000,
} as const;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? 0;
}

export function senseHarnessPerformance(opts: HarnessPerformanceOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const common = {
    sensorName: 'harness-performance',
    sensorKind: 'harness_performance',
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
          code: 'HARNESS_PERFORMANCE_GH_UNAVAILABLE',
          message: `Skipped: ${sample.reason}`,
        },
      ],
      metrics: { run_count: 0 },
    });
  }
  const command = ['gh', ...sample.args];

  const durations: number[] = [];
  for (const run of sample.runs) {
    if (run.conclusion !== 'success') continue;
    if (run.createdAt === undefined || run.updatedAt === undefined) continue;
    const start = Date.parse(run.createdAt);
    const end = Date.parse(run.updatedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) durations.push(end - start);
  }
  const total = sample.runs.length;

  // The minimum counts the successful runs whose durations are measured.
  if (durations.length < sample.minimum) {
    return buildSensorReading({
      ...common,
      command,
      status: 'unknown',
      findings: [
        insufficientSampleFinding(
          'HARNESS_PERFORMANCE_INSUFFICIENT_SAMPLE',
          durations.length,
          sample.minimum,
          sample.describe,
          'successful run(s)',
        ),
        sample.unverifiedFinding,
      ],
      metrics: {
        run_count: total,
        success_count: durations.length,
        sample_size: durations.length,
        ...sample.metrics,
      },
    });
  }

  durations.sort((a, b) => a - b);
  const median = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);

  let status: SensorStatus;
  const findings: SensorFinding[] = [];
  if (median < thresholds.passMedianMs && p95 < thresholds.passP95Ms) {
    status = 'pass';
  } else if (median < thresholds.reviewMedianMs && p95 < thresholds.reviewP95Ms) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'HARNESS_PERFORMANCE_SLOW',
      message: `median ${String(Math.round(median / 1000))}s, p95 ${String(Math.round(p95 / 1000))}s — above pass thresholds.`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'HARNESS_PERFORMANCE_TOO_SLOW',
      message: `median ${String(Math.round(median / 1000))}s, p95 ${String(Math.round(p95 / 1000))}s — above review thresholds.`,
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
      success_count: durations.length,
      sample_size: durations.length,
      median_ms: median,
      p95_ms: p95,
      pass_median_ms: thresholds.passMedianMs,
      pass_p95_ms: thresholds.passP95Ms,
      ...sample.metrics,
    },
  });
}
