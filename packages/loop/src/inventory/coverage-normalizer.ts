import { existsSync, readFileSync, statSync } from 'node:fs';

export interface CoverageSummary {
  readonly statements_total: number;
  readonly statements_covered: number;
  readonly branches_total: number;
  readonly branches_covered: number;
  readonly functions_total: number;
  readonly functions_covered: number;
  readonly lines_total: number;
  readonly lines_covered: number;
  readonly files_count: number;
}

export interface CoverageNormalizationResult {
  readonly source_path: string | null;
  readonly summary: CoverageSummary | null;
  readonly missing: boolean;
}

export interface NormalizeCoverageOptions {
  /** Path to coverage-final.json (Jest/Vitest format). */
  readonly coveragePath: string;
}

/**
 * Normalize a `coverage-final.json` (the Istanbul / Jest / Vitest output
 * format) into a flat summary. If the file is missing, returns
 * `{ missing: true }` so callers can surface that explicitly without
 * erroring when a repository does not run coverage by default.
 */
export function normalizeCoverage(opts: NormalizeCoverageOptions): CoverageNormalizationResult {
  if (!existsSync(opts.coveragePath)) {
    return { source_path: opts.coveragePath, summary: null, missing: true };
  }
  const stat = statSync(opts.coveragePath);
  if (!stat.isFile()) {
    return { source_path: opts.coveragePath, summary: null, missing: true };
  }

  const text = readFileSync(opts.coveragePath, 'utf8');
  const parsed = JSON.parse(text) as Record<string, FileCoverage>;

  let statementsTotal = 0;
  let statementsCovered = 0;
  let branchesTotal = 0;
  let branchesCovered = 0;
  let functionsTotal = 0;
  let functionsCovered = 0;
  let linesTotal = 0;
  let linesCovered = 0;
  let filesCount = 0;

  for (const fc of Object.values(parsed)) {
    filesCount++;
    if (fc.s !== undefined) {
      for (const hit of Object.values(fc.s)) {
        statementsTotal++;
        if (hit > 0) statementsCovered++;
      }
    }
    if (fc.b !== undefined) {
      for (const branchHits of Object.values(fc.b)) {
        for (const hit of branchHits) {
          branchesTotal++;
          if (hit > 0) branchesCovered++;
        }
      }
    }
    if (fc.f !== undefined) {
      for (const hit of Object.values(fc.f)) {
        functionsTotal++;
        if (hit > 0) functionsCovered++;
      }
    }
    if (fc.l !== undefined) {
      for (const hit of Object.values(fc.l)) {
        linesTotal++;
        if (hit > 0) linesCovered++;
      }
    } else if (fc.s !== undefined) {
      // Some emitters use only `s` (statement) coverage; reuse it as a
      // lines approximation so the SensorReading is non-empty.
      linesTotal = statementsTotal;
      linesCovered = statementsCovered;
    }
  }

  return {
    source_path: opts.coveragePath,
    missing: false,
    summary: {
      statements_total: statementsTotal,
      statements_covered: statementsCovered,
      branches_total: branchesTotal,
      branches_covered: branchesCovered,
      functions_total: functionsTotal,
      functions_covered: functionsCovered,
      lines_total: linesTotal,
      lines_covered: linesCovered,
      files_count: filesCount,
    },
  };
}

interface FileCoverage {
  s?: Record<string, number>;
  b?: Record<string, number[]>;
  f?: Record<string, number>;
  l?: Record<string, number>;
}
