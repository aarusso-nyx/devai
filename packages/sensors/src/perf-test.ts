import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './run-command.js';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: perf-test (F2 × T7). Phase 30.H (closes S-2).
 *
 * Wraps an adopter-declared perf-suite script invoked via
 * `pnpm <script_name>` (default `test:perf`). When the script does
 * not exist in the adopter's package.json, the sensor emits
 * `status: unknown + reason: no-perf-script` (per D-85 and the
 * standard graceful-degradation contract INV-DEVAI-012) — UNKNOWN
 * rather than FAIL, since the cell genuinely cannot be measured.
 *
 * The perf script is expected to emit a JSON line on stdout matching
 * `{p50_ms, p95_ms, throughput_rps}` (subset acceptable). The sensor
 * grades each metric against pack-configurable thresholds and
 * downgrades to REVIEW when the script exits 0 but any metric is
 * outside threshold; FAIL only when the script itself fails.
 */

export interface PerfTestThresholds {
  readonly pass_p50_ms?: number;
  readonly review_p50_ms?: number;
  readonly pass_p95_ms?: number;
  readonly review_p95_ms?: number;
  readonly pass_throughput_rps?: number;
  readonly review_throughput_rps?: number;
}

export interface PerfTestOptions {
  readonly repoRoot: string;
  readonly scriptName?: string;
  readonly thresholds?: PerfTestThresholds;
  readonly timeoutMs?: number;
  readonly now?: string;
}

interface ParsedMetrics {
  readonly p50_ms?: number;
  readonly p95_ms?: number;
  readonly throughput_rps?: number;
}

function readScripts(repoRoot: string): Record<string, string> | null {
  try {
    const raw = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return null;
  }
}

/** Scan stdout for a JSON line carrying perf metrics. Tolerant of leading log noise. */
function parseMetrics(stdout: string): ParsedMetrics {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0 || !line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const result: ParsedMetrics = {};
      if (typeof parsed['p50_ms'] === 'number')
        (result as { p50_ms?: number }).p50_ms = parsed['p50_ms'] as number;
      if (typeof parsed['p95_ms'] === 'number')
        (result as { p95_ms?: number }).p95_ms = parsed['p95_ms'] as number;
      if (typeof parsed['throughput_rps'] === 'number')
        (result as { throughput_rps?: number }).throughput_rps = parsed['throughput_rps'] as number;
      if (
        result.p50_ms !== undefined ||
        result.p95_ms !== undefined ||
        result.throughput_rps !== undefined
      ) {
        return result;
      }
    } catch {
      // skip non-JSON lines
    }
  }
  return {};
}

export function sensePerfTest(opts: PerfTestOptions): SensorReading {
  const scriptName = opts.scriptName ?? 'test:perf';
  const command = ['pnpm', scriptName];
  const scripts = readScripts(opts.repoRoot);

  if (scripts === null) {
    return buildSensorReading({
      sensorName: 'perf-test',
      sensorKind: 'perf_test',
      command,
      status: 'unknown',
      deterministic: false,
      tier: 'L1',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'PERF_TEST_NO_PACKAGE_JSON',
          message: `Cannot read package.json under ${opts.repoRoot}.`,
        },
      ],
      metrics: { script_name: scriptName },
    });
  }

  if (scripts[scriptName] === undefined) {
    return buildSensorReading({
      sensorName: 'perf-test',
      sensorKind: 'perf_test',
      command,
      status: 'unknown',
      deterministic: false,
      tier: 'L1',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'PERF_TEST_NO_PERF_SCRIPT',
          message: `No '${scriptName}' script in package.json — cell unmeasurable.`,
        },
      ],
      metrics: { script_name: scriptName, script_present: false },
    });
  }

  const r = runCommand(command, { cwd: opts.repoRoot, timeoutMs: opts.timeoutMs ?? 600_000 });

  // Script-level failure dominates: FAIL irrespective of metrics.
  if (r.exit_code !== 0) {
    return buildSensorReading({
      sensorName: 'perf-test',
      sensorKind: 'perf_test',
      command,
      status: 'fail',
      deterministic: false,
      tier: 'L1',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      exit_code: r.exit_code,
      duration_ms: r.duration_ms,
      out_head: r.stdout,
      err_head: r.stderr,
      killed: r.killed,
      findings: [
        {
          severity: 'error',
          code: 'PERF_TEST_SCRIPT_FAILED',
          message: `${scriptName} exited ${String(r.exit_code)}: ${r.stderr.split('\n')[0] ?? ''}`,
        },
      ],
      metrics: { script_name: scriptName, exit_code: r.exit_code, duration_ms: r.duration_ms },
    });
  }

  const metrics = parseMetrics(r.stdout);
  const thresholds = opts.thresholds ?? {};
  const findings: SensorFinding[] = [];
  let status: SensorStatus = 'pass';

  const checkUpperBound = (
    name: string,
    value: number | undefined,
    passMax: number | undefined,
    reviewMax: number | undefined,
  ): void => {
    if (value === undefined) return;
    if (reviewMax !== undefined && value > reviewMax) {
      status = 'fail';
      findings.push({
        severity: 'error',
        code: 'PERF_TEST_METRIC_OVER_REVIEW',
        message: `${name}=${String(value)} exceeds REVIEW threshold ${String(reviewMax)}.`,
      });
    } else if (passMax !== undefined && value > passMax) {
      if (status === 'pass') status = 'review';
      findings.push({
        severity: 'warning',
        code: 'PERF_TEST_METRIC_OVER_PASS',
        message: `${name}=${String(value)} exceeds PASS threshold ${String(passMax)}.`,
      });
    }
  };

  const checkLowerBound = (
    name: string,
    value: number | undefined,
    passMin: number | undefined,
    reviewMin: number | undefined,
  ): void => {
    if (value === undefined) return;
    if (reviewMin !== undefined && value < reviewMin) {
      status = 'fail';
      findings.push({
        severity: 'error',
        code: 'PERF_TEST_METRIC_UNDER_REVIEW',
        message: `${name}=${String(value)} below REVIEW threshold ${String(reviewMin)}.`,
      });
    } else if (passMin !== undefined && value < passMin) {
      if (status === 'pass') status = 'review';
      findings.push({
        severity: 'warning',
        code: 'PERF_TEST_METRIC_UNDER_PASS',
        message: `${name}=${String(value)} below PASS threshold ${String(passMin)}.`,
      });
    }
  };

  checkUpperBound('p50_ms', metrics.p50_ms, thresholds.pass_p50_ms, thresholds.review_p50_ms);
  checkUpperBound('p95_ms', metrics.p95_ms, thresholds.pass_p95_ms, thresholds.review_p95_ms);
  checkLowerBound(
    'throughput_rps',
    metrics.throughput_rps,
    thresholds.pass_throughput_rps,
    thresholds.review_throughput_rps,
  );

  if (
    metrics.p50_ms === undefined &&
    metrics.p95_ms === undefined &&
    metrics.throughput_rps === undefined
  ) {
    findings.push({
      severity: 'info',
      code: 'PERF_TEST_NO_METRICS_PARSED',
      message: `${scriptName} exited 0 but emitted no parseable JSON metrics line.`,
    });
  }

  const outMetrics: Record<string, number | string | boolean> = {
    script_name: scriptName,
    exit_code: r.exit_code,
    duration_ms: r.duration_ms,
  };
  if (metrics.p50_ms !== undefined) outMetrics['p50_ms'] = metrics.p50_ms;
  if (metrics.p95_ms !== undefined) outMetrics['p95_ms'] = metrics.p95_ms;
  if (metrics.throughput_rps !== undefined) outMetrics['throughput_rps'] = metrics.throughput_rps;

  return buildSensorReading({
    sensorName: 'perf-test',
    sensorKind: 'perf_test',
    command,
    status,
    deterministic: false,
    tier: 'L1',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    exit_code: r.exit_code,
    duration_ms: r.duration_ms,
    out_head: r.stdout,
    err_head: r.stderr,
    killed: r.killed,
    findings,
    metrics: outMetrics,
  });
}
