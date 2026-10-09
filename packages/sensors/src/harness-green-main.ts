import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import {
  insufficientSampleFinding,
  sampleFinalHeads,
  samplePopulation,
  type HarnessPopulationOptions,
  type PopulationFinding,
  type PopulationMetrics,
} from './harness/gh-api.js';

/** One sampled outcome: a run, or a pull request judged by its final-head run. */
interface Outcome {
  readonly conclusion?: string;
  readonly createdAt?: string;
}

type Population =
  | {
      readonly ok: false;
      readonly code: string;
      readonly reason: string;
      readonly args: readonly string[];
    }
  | {
      readonly ok: true;
      readonly args: readonly string[];
      readonly runs: readonly Outcome[];
      readonly minimum: number;
      readonly metrics: PopulationMetrics;
      /** HARNESS_POPULATION_UNVERIFIED when a declared filter could not be applied (#370). */
      readonly unverifiedFindings: readonly PopulationFinding[];
      readonly describe: string;
      /** The noun one outcome is counted as in messages. */
      readonly unit: 'run' | 'pull request';
      readonly extraFindings: readonly SensorFinding[];
      readonly extraMetrics: PopulationMetrics;
    };

/**
 * The declared population (ADR-SCR-0014). `run`, the default, counts every run exactly as
 * before. `pull-request-final-head` counts each pull request once, by the latest completed,
 * non-cancelled run on its final head: an open pull request without one is pending and not
 * counted, and a closed or merged one without one counts as not green. Its pull request list
 * failing is UNKNOWN, never a fallback to the per-run reading.
 */
function population(opts: HarnessGreenMainOptions): Population {
  if (opts.outcomeUnit !== 'pull-request-final-head') {
    const sample = samplePopulation(opts);
    if (!sample.ok)
      return {
        ok: false,
        code: 'HARNESS_GREEN_MAIN_GH_UNAVAILABLE',
        reason: sample.reason,
        args: sample.args,
      };
    return {
      ...sample,
      unverifiedFindings: [sample.unverifiedFinding],
      unit: 'run',
      extraFindings: [],
      extraMetrics: {},
    };
  }
  const sample = sampleFinalHeads(opts);
  if (!sample.ok) {
    return {
      ok: false,
      code:
        sample.source === 'pr-list'
          ? 'HARNESS_GREEN_MAIN_PR_LIST_UNAVAILABLE'
          : 'HARNESS_GREEN_MAIN_GH_UNAVAILABLE',
      reason: sample.reason,
      args: sample.args,
    };
  }
  const ungated = sample.finals.filter((final) => final.run === undefined);
  return {
    ok: true,
    args: sample.args,
    runs: sample.finals.map((final) => ({
      conclusion: final.run?.conclusion ?? 'no-final-head-run',
      createdAt: final.run?.createdAt,
    })),
    minimum: sample.minimum,
    metrics: sample.metrics,
    unverifiedFindings: sample.unverifiedFinding === undefined ? [] : [sample.unverifiedFinding],
    describe: sample.describe,
    unit: 'pull request',
    extraFindings:
      ungated.length === 0
        ? []
        : [
            {
              severity: 'warning',
              code: 'HARNESS_GREEN_MAIN_FINAL_HEAD_UNGATED',
              message: `${String(ungated.length)} closed or merged pull request(s) have no completed gate run on their final head in the window and count as not green: ${ungated.map((final) => `#${String(final.number)}`).join(', ')}.`,
            },
          ],
    extraMetrics: { final_head_ungated: ungated.length },
  };
}

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

  const sample = population(opts);
  if (!sample.ok) {
    return buildSensorReading({
      ...common,
      command: ['gh', ...sample.args],
      status: 'unknown',
      findings: [
        {
          severity: 'info',
          code: sample.code,
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
          `${sample.unit}(s)`,
        ),
        ...sample.unverifiedFindings,
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
        ...sample.unverifiedFindings,
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
        ...sample.unverifiedFindings,
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
      message: `Success rate ${successPct.toFixed(1)}% (over ${String(total)} ${sample.unit}s, ${sample.describe}) is below pass threshold ${String(thresholds.pass)}%.`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'HARNESS_GREEN_MAIN_BELOW_THRESHOLD',
      message: `Success rate ${successPct.toFixed(1)}% (over ${String(total)} ${sample.unit}s, ${sample.describe}) is below review threshold ${String(thresholds.review)}%.`,
    });
  }
  findings.push(...sample.extraFindings, ...sample.unverifiedFindings);

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
      ...sample.extraMetrics,
    },
  });
}
