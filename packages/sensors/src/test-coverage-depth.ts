import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runCommand } from './run-command.js';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: test coverage depth (F3 × T2). Translates a normalized
 * coverage summary into a PASS/REVIEW/FAIL verdict using configurable
 * thresholds. The sensor is pure with respect to its summary input.
 *
 * Status semantics (defaults):
 *   - PASS: lines_pct ≥ 80.
 *   - REVIEW: 50 ≤ lines_pct < 80.
 *   - FAIL: lines_pct < 50.
 *   - UNKNOWN-ish: coverage report missing → status='review' with a
 *     finding code, so adopters see "coverage not collected" rather
 *     than a falsely-passing zero.
 *
 * Adopters override thresholds via the pack-config key
 * `extractor_params.test_coverage.thresholds: {pass:80, review:50}`
 * (CLI passes through; the sensor stays pure).
 */

export interface TestCoverageDepthOptions {
  /**
   * Caller-supplied summary. `null` indicates the coverage file was
   * missing (the sensor surfaces this as REVIEW with an explicit
   * finding code).
   */
  readonly summary: { readonly lines_total: number; readonly lines_covered: number } | null;
  readonly thresholds?: { readonly pass: number; readonly review: number };
  readonly now?: string;
  readonly coveragePath?: string;
}

const DEFAULT_THRESHOLDS = { pass: 80, review: 50 } as const;

/** Set on the coverage producer's environment so a nested sensor never starts another (#242). */
export const COVERAGE_PRODUCER_MARKER = 'DEVAI_COVERAGE_PRODUCER_ACTIVE';

export function senseTestCoverageDepth(opts: TestCoverageDepthOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  let status: SensorStatus;
  const findings: SensorFinding[] = [];
  let linesPct = 0;
  let linesTotal = 0;
  let linesCovered = 0;

  if (opts.summary === null) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'TEST_COVERAGE_REPORT_MISSING',
      message:
        opts.coveragePath !== undefined
          ? `Coverage report not found at ${opts.coveragePath}. Run \`pnpm test:coverage\` first.`
          : 'Coverage report not found. Run `pnpm test:coverage` first.',
    });
  } else {
    linesTotal = opts.summary.lines_total;
    linesCovered = opts.summary.lines_covered;
    linesPct = linesTotal === 0 ? 0 : (linesCovered / linesTotal) * 100;
    if (linesPct >= thresholds.pass) {
      status = 'pass';
    } else if (linesPct >= thresholds.review) {
      status = 'review';
      findings.push({
        severity: 'warning',
        code: 'TEST_COVERAGE_PARTIAL',
        message: `Lines coverage ${linesPct.toFixed(1)}% is between review (${String(thresholds.review)}%) and pass (${String(thresholds.pass)}%) thresholds.`,
      });
    } else {
      status = 'fail';
      findings.push({
        severity: 'error',
        code: 'TEST_COVERAGE_BELOW_THRESHOLD',
        message: `Lines coverage ${linesPct.toFixed(1)}% is below review threshold (${String(thresholds.review)}%).`,
      });
    }
  }

  return buildSensorReading({
    sensorName: 'test-coverage-depth',
    sensorKind: 'test_coverage_depth',
    command: ['devai', 'sense-test-coverage-depth'],
    status,
    deterministic: true,
    tier: 'L2',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      lines_total: linesTotal,
      lines_covered: linesCovered,
      lines_pct: Number(linesPct.toFixed(2)),
      threshold_pass: thresholds.pass,
      threshold_review: thresholds.review,
    },
  });
}

/**
 * The governed producer of the `local` coverage population (ADR-SCR-0007): exactly the
 * shape the broker admits under `sense run`, never a bare package script.
 */
export const LOCAL_COVERAGE_PRODUCER_ARGV: readonly string[] = [
  'pnpm',
  'vitest',
  'run',
  '--config',
  'tests/config/local.coverage.config.ts',
];

export interface MeasureTestCoverageDepthOptions {
  readonly repoRoot: string;
  /** Repository-relative (or absolute) path of the Istanbul per-file report. */
  readonly coveragePath: string;
  /** The declared population the report must carry in its `population.json` sidecar. */
  readonly population: string;
  /** The declared excluded suites; the sidecar must list the same set, in any order. */
  readonly exclusions: readonly string[];
  readonly thresholds?: { readonly pass: number; readonly review: number };
  readonly now?: string;
}

const STDERR_HEAD_LIMIT = 512;
const FAILED_FILES_LIMIT = 10;
// eslint-disable-next-line no-control-regex -- ANSI escape sequences are control characters.
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/gu;
const FAILED_TEST_FILE_PATTERN = /^\s*FAIL\s+(?:\|[^|]*\|\s+)?(\S+\.(?:test|spec)\.[cm]?[jt]s)\b/u;
const FAILED_SUMMARY_FILE_PATTERN =
  /^\s*[\u276F>]\s+(\S+\.(?:test|spec)\.[cm]?[jt]s)\s+\(\d+ tests?\b.*\b\d+ failed\b/u;

/**
 * The test files a failed vitest run names, in first-seen order. The producer prints expected
 * diagnostics from passing tests too, so its stderr head alone can name the wrong cause
 * (#236); the failing files come from vitest's own FAIL and failed-summary lines.
 */
export function failedTestFiles(output: string): readonly string[] {
  const found = new Set<string>();
  for (const line of output.replace(ANSI_PATTERN, '').split('\n')) {
    const match = FAILED_TEST_FILE_PATTERN.exec(line) ?? FAILED_SUMMARY_FILE_PATTERN.exec(line);
    if (match?.[1] !== undefined) found.add(match[1]);
  }
  return [...found];
}

interface ProducerRun {
  readonly exit_code: number;
  readonly stderr: string;
  readonly duration_ms: number;
}

/**
 * Measure test coverage depth over a declared population (ADR-SCR-0007). When the report
 * is absent it runs the governed local producer, then reads the report and its population
 * sidecar. Every outcome is a measured verdict: a producer that exits non-zero reads FAIL
 * with its exit code and stderr head, a report still missing after a zero exit reads FAIL
 * with COVERAGE_REPORT_MISSING, and a report over another population or exclusion set is
 * rejected with the mismatch named. A missing file never reads `error`.
 */
export function measureTestCoverageDepth(opts: MeasureTestCoverageDepthOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const reportPath = isAbsolute(opts.coveragePath)
    ? opts.coveragePath
    : resolve(opts.repoRoot, opts.coveragePath);
  const sidecarPath = join(dirname(reportPath), 'population.json');
  const population = opts.population;

  const reading = (
    status: SensorStatus,
    findings: readonly SensorFinding[],
    summary: { readonly lines_total: number; readonly lines_covered: number } | null,
    producer?: ProducerRun,
  ): SensorReading => {
    const linesTotal = summary?.lines_total ?? 0;
    const linesCovered = summary?.lines_covered ?? 0;
    const linesPct = linesTotal === 0 ? 0 : (linesCovered / linesTotal) * 100;
    return buildSensorReading({
      sensorName: 'test-coverage-depth',
      sensorKind: 'test_coverage_depth',
      command: ['devai', 'sense-test-coverage-depth'],
      status,
      deterministic: true,
      tier: 'L2',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      ...(producer !== undefined && {
        exit_code: producer.exit_code,
        duration_ms: producer.duration_ms,
        ...(producer.stderr.length > 0 && { err_head: producer.stderr }),
      }),
      findings,
      metrics: {
        population,
        lines_total: linesTotal,
        lines_covered: linesCovered,
        lines_pct: Number(linesPct.toFixed(2)),
        threshold_pass: thresholds.pass,
        threshold_review: thresholds.review,
      },
    });
  };

  let producer: ProducerRun | undefined;
  if (!isFile(reportPath)) {
    // #242: the producer runs the local suite, which may itself run this sensor. The producer
    // carries a marker, and a sensor inside it never starts a nested producer, whatever the
    // authority scope admits.
    if (process.env[COVERAGE_PRODUCER_MARKER] === '1') {
      return reading(
        'unknown',
        [
          {
            severity: 'warning',
            code: 'COVERAGE_PRODUCER_RECURSION',
            message: `The ${population} coverage producer was not started: this sensor already runs inside a coverage producer (${COVERAGE_PRODUCER_MARKER}=1).`,
          },
        ],
        null,
      );
    }
    let result: ReturnType<typeof runCommand>;
    try {
      result = runCommand(LOCAL_COVERAGE_PRODUCER_ARGV, {
        cwd: opts.repoRoot,
        env: { [COVERAGE_PRODUCER_MARKER]: '1' },
      });
    } catch (error) {
      // The host refused to start the producer (an authority scope that does not admit
      // it). A refusal measures nothing about the code, so the reading is an `unknown`
      // diagnostic naming the refusal, never a verdict and never an `error` reading.
      const reason = error instanceof Error ? error.message : String(error);
      return reading(
        'unknown',
        [
          {
            severity: 'warning',
            code: 'COVERAGE_PRODUCER_REFUSED',
            message: `The ${population} coverage producer \`${LOCAL_COVERAGE_PRODUCER_ARGV.join(' ')}\` was not started: ${reason}`,
          },
        ],
        null,
      );
    }
    producer = {
      exit_code: result.exit_code,
      stderr: result.stderr,
      duration_ms: result.duration_ms,
    };
    if (result.exit_code !== 0) {
      const head = result.stderr.trim().slice(0, STDERR_HEAD_LIMIT);
      const failed = failedTestFiles(`${result.stdout}\n${result.stderr}`);
      const named =
        failed.length > 0
          ? ` Failing test files: ${failed.slice(0, FAILED_FILES_LIMIT).join(', ')}${failed.length > FAILED_FILES_LIMIT ? `, and ${String(failed.length - FAILED_FILES_LIMIT)} more` : ''}.`
          : '';
      return reading(
        'fail',
        [
          {
            severity: 'error',
            code: 'COVERAGE_PRODUCER_FAILED',
            message: `The ${population} coverage producer \`${LOCAL_COVERAGE_PRODUCER_ARGV.join(' ')}\` exited with code ${String(result.exit_code)}.${named}${head.length > 0 ? ` stderr head: ${head}` : ''}`,
          },
        ],
        null,
        producer,
      );
    }
    if (!isFile(reportPath)) {
      return reading(
        'fail',
        [
          {
            severity: 'error',
            code: 'COVERAGE_REPORT_MISSING',
            message: `The ${population} coverage producer exited 0 but wrote no report at ${opts.coveragePath}.`,
          },
        ],
        null,
        producer,
      );
    }
  }

  const sidecar = readSidecar(sidecarPath);
  if (sidecar === undefined) {
    return reading(
      'fail',
      [
        {
          severity: 'error',
          code: 'COVERAGE_POPULATION_SIDECAR_MISSING',
          message: `The coverage report at ${opts.coveragePath} has no readable population.json sidecar, so it cannot be read as the ${population} population.`,
        },
      ],
      null,
      producer,
    );
  }
  const mismatches: string[] = [];
  if (sidecar.population !== population) {
    mismatches.push(
      `population ${JSON.stringify(sidecar.population)} is not the declared population ${JSON.stringify(population)}`,
    );
  }
  const recorded = new Set(sidecar.exclusions);
  const declared = new Set(opts.exclusions);
  const omitted = [...declared].filter((entry) => !recorded.has(entry));
  const added = [...recorded].filter((entry) => !declared.has(entry));
  if (omitted.length > 0) {
    mismatches.push(`exclusions omit the declared ${omitted.join(', ')}`);
  }
  if (added.length > 0) {
    mismatches.push(`exclusions add the undeclared ${added.join(', ')}`);
  }
  if (mismatches.length > 0) {
    return reading(
      'fail',
      [
        {
          severity: 'error',
          code: 'COVERAGE_POPULATION_MISMATCH',
          message: `The coverage report at ${opts.coveragePath} is not the declared ${population} population: ${mismatches.join('; ')}.`,
        },
      ],
      null,
      producer,
    );
  }

  const summary = summarizeLines(reportPath);
  if (summary === undefined) {
    return reading(
      'fail',
      [
        {
          severity: 'error',
          code: 'COVERAGE_REPORT_UNREADABLE',
          message: `The ${population} coverage report at ${opts.coveragePath} is not an Istanbul per-file JSON report.`,
        },
      ],
      null,
      producer,
    );
  }

  const linesPct =
    summary.lines_total === 0 ? 0 : (summary.lines_covered / summary.lines_total) * 100;
  const findings: SensorFinding[] = [];
  let status: SensorStatus;
  if (linesPct >= thresholds.pass) {
    status = 'pass';
  } else if (linesPct >= thresholds.review) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'TEST_COVERAGE_PARTIAL',
      message: `Lines coverage ${linesPct.toFixed(1)}% over the ${population} population is between review (${String(thresholds.review)}%) and pass (${String(thresholds.pass)}%) thresholds.`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'TEST_COVERAGE_BELOW_THRESHOLD',
      message: `Lines coverage ${linesPct.toFixed(1)}% over the ${population} population is below review threshold (${String(thresholds.review)}%).`,
    });
  }
  return reading(status, findings, summary, producer);
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function readSidecar(
  path: string,
): { readonly population: string; readonly exclusions: readonly string[] } | undefined {
  if (!isFile(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const { population, exclusions } = parsed as { population?: unknown; exclusions?: unknown };
  if (typeof population !== 'string' || !Array.isArray(exclusions)) return undefined;
  if (!exclusions.every((entry): entry is string => typeof entry === 'string')) return undefined;
  return { population, exclusions };
}

/** Line totals from an Istanbul per-file report (`l`, else `s` as the approximation). */
function summarizeLines(
  path: string,
): { readonly lines_total: number; readonly lines_covered: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  let linesTotal = 0;
  let linesCovered = 0;
  for (const entry of Object.values(parsed as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') return undefined;
    const file = entry as { l?: Record<string, number>; s?: Record<string, number> };
    const hits = file.l ?? file.s ?? {};
    for (const hit of Object.values(hits)) {
      linesTotal += 1;
      if (hit > 0) linesCovered += 1;
    }
  }
  return { lines_total: linesTotal, lines_covered: linesCovered };
}
