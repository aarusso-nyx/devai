import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import { invokeGhJson } from './harness/gh-api.js';

/**
 * F5 harness performance sensor (28.G; F5×T7). Per design note at
 * docs/theory/architecture/sensors/harness_performance.md.
 */

export interface HarnessPerformanceOptions {
  readonly repoRoot: string;
  readonly branch?: string;
  readonly limit?: number;
  readonly thresholds?: {
    readonly passMedianMs: number;
    readonly passP95Ms: number;
    readonly reviewMedianMs: number;
    readonly reviewP95Ms: number;
  };
  readonly now?: string;
}

const DEFAULT_THRESHOLDS = {
  passMedianMs: 600_000,
  passP95Ms: 1_800_000,
  reviewMedianMs: 1_200_000,
  reviewP95Ms: 3_600_000,
} as const;

interface GhRun {
  readonly conclusion?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? 0;
}

export function senseHarnessPerformance(opts: HarnessPerformanceOptions): SensorReading {
  const branch = opts.branch ?? 'main';
  const limit = opts.limit ?? 50;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  const args = [
    'run',
    'list',
    '--branch',
    branch,
    '--json',
    'conclusion,createdAt,updatedAt',
    '--limit',
    String(limit),
  ];
  const result = invokeGhJson<GhRun[]>({ cwd: opts.repoRoot, args });
  if (!result.ok) {
    return buildSensorReading({
      sensorName: 'harness-performance',
      sensorKind: 'harness_performance',
      command: ['gh', ...args],
      status: 'unknown',
      deterministic: false,
      tier: 'L2',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_PERFORMANCE_GH_UNAVAILABLE',
          message: `Skipped: ${result.reason}`,
        },
      ],
      metrics: { run_count: 0 },
    });
  }

  const durations: number[] = [];
  let total = 0;
  for (const run of result.data) {
    total += 1;
    if (run.conclusion !== 'success') continue;
    if (run.createdAt === undefined || run.updatedAt === undefined) continue;
    const start = Date.parse(run.createdAt);
    const end = Date.parse(run.updatedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) durations.push(end - start);
  }

  if (durations.length === 0) {
    return buildSensorReading({
      sensorName: 'harness-performance',
      sensorKind: 'harness_performance',
      command: ['gh', ...args],
      status: 'review',
      deterministic: false,
      tier: 'L2',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'warning',
          code: 'HARNESS_PERFORMANCE_NO_SUCCESS_RUNS',
          message: `No successful runs found on branch ${branch} (last ${String(total)} entries).`,
        },
      ],
      metrics: { run_count: total, success_count: 0 },
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

  return buildSensorReading({
    sensorName: 'harness-performance',
    sensorKind: 'harness_performance',
    command: ['gh', ...args],
    status,
    deterministic: false,
    tier: 'L2',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      run_count: total,
      success_count: durations.length,
      median_ms: median,
      p95_ms: p95,
      pass_median_ms: thresholds.passMedianMs,
      pass_p95_ms: thresholds.passP95Ms,
    },
  });
}
