import { existsSync, readFileSync } from '@devai-nyx/authority';
import { resolve } from 'node:path';

const DEFAULT_THRESHOLDS = '.devai/config/thresholds.json';
const DEFAULT_BASELINE = '.devai/state/mutation/baseline.json';
const DEFAULT_CURRENT = '.devai/state/mutation/current.json';

export interface MutationReportCheckOptions {
  readonly baseline?: string;
  readonly current?: string;
  readonly thresholds?: string;
  readonly repoRoot?: string;
}

interface MutationReport {
  readonly mutation_score?: number;
  readonly survived?: number;
  readonly metrics?: {
    readonly mutationScore?: number;
    readonly survived?: number;
  };
}

interface Thresholds {
  readonly mutation?: {
    readonly score_min?: number;
    readonly survived_max?: number;
  };
}

function readReport(path: string): MutationReport {
  return JSON.parse(readFileSync(path, 'utf8')) as MutationReport;
}

function scoreOf(report: MutationReport): number | undefined {
  return typeof report.mutation_score === 'number'
    ? report.mutation_score
    : report.metrics?.mutationScore;
}

function survivedOf(report: MutationReport): number | undefined {
  return typeof report.survived === 'number' ? report.survived : report.metrics?.survived;
}

function readThresholds(path: string): Thresholds | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Thresholds) : undefined;
}

export interface MutationFinding {
  readonly kind: 'below_threshold' | 'regression_score' | 'regression_survived';
  readonly message: string;
}

export interface MutationReportCheck {
  readonly ok: boolean;
  readonly current: { readonly mutation_score: number | null; readonly survived: number | null };
  readonly baseline: {
    readonly mutation_score: number | null;
    readonly survived: number | null;
  } | null;
  readonly thresholds: Thresholds['mutation'] | null;
  readonly findings: readonly MutationFinding[];
}

/** Compare a current mutation report with configured thresholds and an optional baseline. */
export function checkMutationReport(options: MutationReportCheckOptions): MutationReportCheck {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const currentPath = resolve(repoRoot, options.current ?? DEFAULT_CURRENT);
  if (!existsSync(currentPath)) throw new Error(`--current report not found at ${currentPath}`);

  const current = readReport(currentPath);
  const curScore = scoreOf(current);
  const curSurvived = survivedOf(current);
  const baselinePath = resolve(repoRoot, options.baseline ?? DEFAULT_BASELINE);
  const baseline = existsSync(baselinePath) ? readReport(baselinePath) : undefined;
  const baseScore = baseline === undefined ? undefined : scoreOf(baseline);
  const baseSurvived = baseline === undefined ? undefined : survivedOf(baseline);
  const thresholds = readThresholds(resolve(repoRoot, options.thresholds ?? DEFAULT_THRESHOLDS));

  const findings: MutationFinding[] = [];
  const minScore = thresholds?.mutation?.score_min;
  if (typeof minScore === 'number' && typeof curScore === 'number' && curScore < minScore) {
    findings.push({
      kind: 'below_threshold',
      message: `mutation score ${curScore.toFixed(1)}% < threshold ${String(minScore)}%`,
    });
  }
  const maxSurvived = thresholds?.mutation?.survived_max;
  if (
    typeof maxSurvived === 'number' &&
    typeof curSurvived === 'number' &&
    curSurvived > maxSurvived
  ) {
    findings.push({
      kind: 'below_threshold',
      message: `survived mutants ${String(curSurvived)} > ceiling ${String(maxSurvived)}`,
    });
  }
  if (typeof baseScore === 'number' && typeof curScore === 'number' && curScore < baseScore) {
    findings.push({
      kind: 'regression_score',
      message: `mutation score regressed: ${curScore.toFixed(1)}% < baseline ${baseScore.toFixed(1)}%`,
    });
  }
  if (
    typeof baseSurvived === 'number' &&
    typeof curSurvived === 'number' &&
    curSurvived > baseSurvived
  ) {
    findings.push({
      kind: 'regression_survived',
      message: `survived mutants regressed: ${String(curSurvived)} > baseline ${String(baseSurvived)}`,
    });
  }

  return {
    ok: findings.length === 0,
    current: { mutation_score: curScore ?? null, survived: curSurvived ?? null },
    baseline:
      baseline === undefined
        ? null
        : { mutation_score: baseScore ?? null, survived: baseSurvived ?? null },
    thresholds: thresholds?.mutation ?? null,
    findings,
  };
}
