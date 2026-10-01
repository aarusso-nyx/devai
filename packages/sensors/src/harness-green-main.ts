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
 * Inventory sensor: harness green-main (F5 × T9). Phase 26.K (closes
 * D-77 sub-batch 26.K). Samples the declared CI population (ADR-SCR-0010)
 * through `gh run list --workflow <file> --event <event> ...` and maps the
 * success rate to PASS / REVIEW / FAIL; below the declared minimum sample
 * it reads UNKNOWN.
 *
 * Status semantics (defaults):
 *   - PASS: success_pct ≥ 95.
 *   - REVIEW: 80 ≤ success_pct < 95.
 *   - FAIL: success_pct < 80.
 *   - UNKNOWN (status='unknown'): `gh` binary not on PATH, or auth
 *     missing — the sensor cleanly no-ops with an explicit reason
 *     code rather than asserting a verdict it can't justify. This
 *     is the only sensor in Phase 26 allowed to emit `unknown`.
 *
 * Adopters override thresholds via `--threshold-pass` / `--threshold-
 * review` or the pack-config key
 * `extractor_params.harness_green_main.threshold_pct`.
 */

export interface HarnessGreenMainOptions extends HarnessPopulationOptions {
  readonly thresholds?: { readonly pass: number; readonly review: number };
  /**
   * Phase 32.D (closes D-A-34): ISO-date string. Applied after the population filter: the
   * effective window becomes the in-population runs created at or after `since`.
   */
  readonly since?: string;
  /**
   * Phase 32.D (closes D-A-34): minimum runs the post-`since` window must contain before the
   * sensor emits a real verdict. Default 5.
   */
  readonly minSampleSize?: number;
}

const DEFAULT_THRESHOLDS = { pass: 95, review: 80 } as const;
const DEFAULT_MIN_SAMPLE_SIZE = 5;

export function senseHarnessGreenMain(opts: HarnessGreenMainOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const minSampleSize = opts.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
  const since = opts.since;
  const common = {
    sensorName: 'harness-green-main',
    sensorKind: 'harness_green_main',
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
          code: 'HARNESS_GREEN_MAIN_GH_UNAVAILABLE',
          message: `Skipped: ${sample.reason}`,
        },
      ],
      metrics: { run_count: 0, success_pct: 0 },
    });
  }
  const command = ['gh', ...sample.args];
  const populationRuns = sample.runs;
  const populationSize = populationRuns.length;

  if (populationSize < sample.minimum) {
    return buildSensorReading({
      ...common,
      command,
      status: 'unknown',
      findings: [
        insufficientSampleFinding(
          'HARNESS_GREEN_MAIN_INSUFFICIENT_SAMPLE',
          populationSize,
          sample.minimum,
          sample.describe,
          'run(s)',
        ),
        sample.unverifiedFinding,
      ],
      metrics: { run_count: populationSize, sample_size: populationSize, ...sample.metrics },
    });
  }

  // Phase 32.D: the since filter runs after the population filter.
  const filteredRuns =
    since === undefined
      ? populationRuns
      : populationRuns.filter(
          (r) => r.createdAt !== undefined && Date.parse(r.createdAt) >= Date.parse(since),
        );
  const total = filteredRuns.length;

  if (total === 0) {
    return buildSensorReading({
      ...common,
      command,
      status: 'review',
      findings: [
        {
          severity: 'warning',
          code: 'HARNESS_GREEN_MAIN_NO_RUNS',
          message: `No CI runs of the population since ${since ?? ''} (${sample.describe}).`,
        },
        sample.unverifiedFinding,
      ],
      metrics: {
        run_count: 0,
        success_pct: 0,
        sample_size: populationSize,
        ...(since !== undefined && { since_filter_applied: 1 }),
        ...sample.metrics,
      },
    });
  }

  // Phase 32.D: insufficient-sample guard.
  if (since !== undefined && total < minSampleSize) {
    return buildSensorReading({
      ...common,
      command,
      status: 'unknown',
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_GREEN_MAIN_INSUFFICIENT_SAMPLE_POST_FILTER',
          message: `Only ${String(total)} run(s) since ${since}; below min_sample_size ${String(minSampleSize)}. Verdict suppressed.`,
        },
        sample.unverifiedFinding,
      ],
      metrics: {
        run_count: total,
        success_pct: 0,
        min_sample_size: minSampleSize,
        since_filter_applied: 1,
        sample_size: populationSize,
        ...sample.metrics,
      },
    });
  }

  const successCount = filteredRuns.filter((r) => r.conclusion === 'success').length;
  const successPct = (successCount / total) * 100;
  let status: SensorStatus;
  const findings: SensorFinding[] = [];
  if (successPct >= thresholds.pass) {
    status = 'pass';
  } else if (successPct >= thresholds.review) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'HARNESS_GREEN_MAIN_PARTIAL',
      message: `Success rate ${successPct.toFixed(1)}% (over ${String(total)} runs, ${sample.describe}) is below pass threshold ${String(thresholds.pass)}%.`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'HARNESS_GREEN_MAIN_BELOW_THRESHOLD',
      message: `Success rate ${successPct.toFixed(1)}% (over ${String(total)} runs, ${sample.describe}) is below review threshold ${String(thresholds.review)}%.`,
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
      success_count: successCount,
      success_pct: Number(successPct.toFixed(2)),
      threshold_pass: thresholds.pass,
      threshold_review: thresholds.review,
      sample_size: populationSize,
      ...(since !== undefined && {
        since_filter_applied: 1,
        min_sample_size: minSampleSize,
      }),
      ...sample.metrics,
    },
  });
}
