import { spawnSync } from '@devai-nyx/authority';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: harness green-main (F5 × T9). Phase 26.K (closes
 * D-77 sub-batch 26.K). Calls `gh run list --branch main --json
 * conclusion --limit 50` and maps the success rate to PASS / REVIEW
 * / FAIL.
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

export interface HarnessGreenMainOptions {
  readonly repoRoot: string;
  readonly branch?: string;
  readonly limit?: number;
  readonly thresholds?: { readonly pass: number; readonly review: number };
  /**
   * Phase 32.D (closes D-A-34): ISO-date string. When set, the
   * effective window becomes "the last `limit` runs since `since`".
   * Always applied client-side after fetching (server-side
   * `gh run list --created '>=<date>'` is also passed but client-side
   * is the deterministic ground truth — gh CLI version skew won't
   * silently change behavior).
   */
  readonly since?: string;
  /**
   * Phase 32.D (closes D-A-34): minimum runs the post-`since` window
   * must contain before the sensor emits a real verdict. Below this,
   * emits status=unknown to avoid noisy verdicts on tiny samples.
   * Default 5.
   */
  readonly minSampleSize?: number;
  readonly now?: string;
}

const DEFAULT_THRESHOLDS = { pass: 95, review: 80 } as const;
const DEFAULT_MIN_SAMPLE_SIZE = 5;

interface GhRun {
  readonly conclusion?: string;
  readonly createdAt?: string;
}

function runGh(
  args: readonly string[],
  cwd: string,
): { ok: true; runs: readonly GhRun[] } | { ok: false; reason: string } {
  const result = spawnSync('gh', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 30_000,
  });
  if (result.error !== undefined) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { ok: false, reason: 'gh-cli-unavailable' };
    return { ok: false, reason: `gh-cli-error: ${err.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').slice(0, 256);
    return { ok: false, reason: `gh-cli-nonzero-exit: ${stderr}` };
  }
  try {
    const parsed = JSON.parse(result.stdout) as GhRun[];
    return { ok: true, runs: parsed };
  } catch (e) {
    return {
      ok: false,
      reason: `gh-cli-parse-error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export function senseHarnessGreenMain(opts: HarnessGreenMainOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const branch = opts.branch ?? 'main';
  const limit = opts.limit ?? 50;
  const minSampleSize = opts.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
  const since = opts.since;

  // Phase 32.D (D-A-34): always fetch createdAt so we can client-side
  // filter on --since. Server-side `--created '>=<date>'` is also
  // passed for query-cost reduction, but client-side is the ground
  // truth (gh CLI version skew won't silently change verdicts).
  const ghArgs = [
    'run',
    'list',
    '--branch',
    branch,
    '--json',
    'conclusion,createdAt',
    '--limit',
    String(limit),
  ];
  if (since !== undefined) ghArgs.push('--created', `>=${since}`);
  const ghResult = runGh(ghArgs, opts.repoRoot);
  const command = ['gh', ...ghArgs];

  if (!ghResult.ok) {
    return buildSensorReading({
      sensorName: 'harness-green-main',
      sensorKind: 'harness_green_main',
      command,
      status: 'unknown',
      deterministic: false,
      tier: 'L2',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_GREEN_MAIN_GH_UNAVAILABLE',
          message: `Skipped: ${ghResult.reason}`,
        },
      ],
      metrics: {
        run_count: 0,
        success_pct: 0,
      },
    });
  }

  // Phase 32.D: client-side filter on createdAt >= since. Defensive
  // even when --created was accepted server-side (gh might silently
  // ignore the flag on older versions).
  const filteredRuns =
    since === undefined
      ? ghResult.runs
      : ghResult.runs.filter((r) => r.createdAt !== undefined && r.createdAt >= since);
  const total = filteredRuns.length;

  if (total === 0) {
    return buildSensorReading({
      sensorName: 'harness-green-main',
      sensorKind: 'harness_green_main',
      command,
      status: 'review',
      deterministic: false,
      tier: 'L2',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'warning',
          code: 'HARNESS_GREEN_MAIN_NO_RUNS',
          message:
            since === undefined
              ? `No CI runs found for branch ${branch} in the last ${String(limit)} entries.`
              : `No CI runs found for branch ${branch} since ${since} (within the last ${String(limit)} entries).`,
        },
      ],
      metrics: {
        run_count: 0,
        success_pct: 0,
        ...(since !== undefined && { since_filter_applied: 1 }),
      },
    });
  }

  // Phase 32.D: insufficient-sample guard.
  if (since !== undefined && total < minSampleSize) {
    return buildSensorReading({
      sensorName: 'harness-green-main',
      sensorKind: 'harness_green_main',
      command,
      status: 'unknown',
      deterministic: false,
      tier: 'L2',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_GREEN_MAIN_INSUFFICIENT_SAMPLE_POST_FILTER',
          message: `Only ${String(total)} run(s) since ${since}; below min_sample_size ${String(minSampleSize)}. Verdict suppressed.`,
        },
      ],
      metrics: {
        run_count: total,
        success_pct: 0,
        min_sample_size: minSampleSize,
        since_filter_applied: 1,
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
      message: `Main branch success rate ${successPct.toFixed(1)}% (over last ${String(total)} runs) is below pass threshold ${String(thresholds.pass)}%.`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'HARNESS_GREEN_MAIN_BELOW_THRESHOLD',
      message: `Main branch success rate ${successPct.toFixed(1)}% (over last ${String(total)} runs) is below review threshold ${String(thresholds.review)}%.`,
    });
  }

  return buildSensorReading({
    sensorName: 'harness-green-main',
    sensorKind: 'harness_green_main',
    command,
    status,
    deterministic: false,
    tier: 'L2',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      run_count: total,
      success_count: successCount,
      success_pct: Number(successPct.toFixed(2)),
      threshold_pass: thresholds.pass,
      threshold_review: thresholds.review,
      ...(since !== undefined && {
        since_filter_applied: 1,
        min_sample_size: minSampleSize,
      }),
    },
  });
}
