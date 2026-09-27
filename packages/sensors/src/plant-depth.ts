import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: plant depth (F2 × T2). Phase 27.F.
 * Per design note at docs/theory/architecture/sensors/plant_depth.md.
 */

export interface PlantDepthOptions {
  readonly repoRoot: string;
  readonly sourceGlobs?: readonly string[];
  /**
   * Repository-relative file globs left out of the measured plant (ADR-SCR-0005),
   * such as a generated view derived from a law policy. `*` matches within one
   * path segment and a `**` segment matches any number of segments. Default: none.
   */
  readonly excludeGlobs?: readonly string[];
  readonly thresholds?: { readonly pass: number; readonly review: number };
  readonly now?: string;
}

const DEFAULT_GLOBS = ['packages/*/src/**'] as const;
const DEFAULT_THRESHOLDS = { pass: 500, review: 1000 } as const;

function abs(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function walkSources(dir: string, sink: string[]): void {
  const st = safeStat(dir);
  if (st === null) return;
  if (st.isFile()) {
    if (/\.(ts|tsx)$/i.test(dir) && !/\.d\.ts$/.test(dir)) sink.push(dir);
    return;
  }
  if (!st.isDirectory()) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === 'build') continue;
    walkSources(join(dir, e), sink);
  }
}

function expandWildcardOneLevel(repoRoot: string, glob: string, sink: string[]): void {
  // Strip trailing /** or /*
  const prefix = glob.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
  if (!prefix.includes('*')) {
    walkSources(abs(repoRoot, prefix), sink);
    return;
  }
  const parts = prefix.split('/');
  const wildIdx = parts.findIndex((p) => p.includes('*'));
  if (wildIdx < 0) {
    walkSources(abs(repoRoot, prefix), sink);
    return;
  }
  const before = parts.slice(0, wildIdx).join('/');
  const after = parts.slice(wildIdx + 1).join('/');
  const segmentPattern = new RegExp(
    `^${(parts[wildIdx] ?? '')
      .split('*')
      .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  let entries: string[];
  try {
    entries = readdirSync(abs(repoRoot, before));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!segmentPattern.test(entry)) continue;
    const next = [before, entry, after].filter((s) => s !== '').join('/');
    walkSources(abs(repoRoot, next), sink);
  }
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile one exclusion glob to a matcher over repository-relative POSIX paths. */
function compileExcludeGlob(glob: string): RegExp {
  const segments = glob.replace(/\/+$/, '').split('/');
  let pattern = '';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      pattern += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    pattern += segment.split('*').map(escapeRegExp).join('[^/]*');
    if (!last) pattern += '/';
  });
  return new RegExp(`^${pattern}$`);
}

function repositoryRelative(repoRoot: string, file: string): string {
  return relative(resolve(repoRoot), file).split(sep).join('/');
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank method: P-th percentile = sorted[ceil(p * n) - 1].
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  const idx = Math.min(sorted.length - 1, rank - 1);
  return sorted[idx] ?? 0;
}

export function sensePlantDepth(opts: PlantDepthOptions): SensorReading {
  const globs = opts.sourceGlobs ?? DEFAULT_GLOBS;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  const files: string[] = [];
  for (const g of globs) expandWildcardOneLevel(opts.repoRoot, g, files);
  const excluded = (opts.excludeGlobs ?? []).map(compileExcludeGlob);
  const measured = [...new Set(files)].filter((f) => {
    const path = repositoryRelative(opts.repoRoot, f);
    return !excluded.some((matcher) => matcher.test(path));
  });

  const lineCounts: number[] = [];
  let linesTotal = 0;
  for (const f of measured) {
    try {
      const content = readFileSync(f, 'utf8');
      const lines = content.split('\n').length;
      lineCounts.push(lines);
      linesTotal += lines;
    } catch {
      // skip
    }
  }
  const sorted = [...lineCounts].sort((a, b) => a - b);
  const linesMax = sorted.length > 0 ? (sorted[sorted.length - 1] ?? 0) : 0;
  const linesMean = sorted.length > 0 ? Math.round(linesTotal / sorted.length) : 0;
  const linesP95 = percentile(sorted, 0.95);

  let status: SensorStatus;
  const findings: SensorFinding[] = [];
  if (sorted.length === 0) {
    status = 'review';
    findings.push({
      severity: 'info',
      code: 'PLANT_DEPTH_NO_SOURCES',
      message: `No source files matched globs: ${globs.join(', ')}`,
    });
  } else if (linesP95 < thresholds.pass) {
    status = 'pass';
  } else if (linesP95 < thresholds.review) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'PLANT_DEPTH_FILES_GROWING',
      message: `95th-percentile file size ${String(linesP95)} LOC exceeds PASS threshold ${String(thresholds.pass)}.`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'PLANT_DEPTH_FILES_BLOATED',
      message: `95th-percentile file size ${String(linesP95)} LOC exceeds REVIEW threshold ${String(thresholds.review)}.`,
    });
  }

  return buildSensorReading({
    sensorName: 'plant-depth',
    sensorKind: 'plant_depth',
    command: ['devai', 'sense-plant-depth'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      files_count: sorted.length,
      lines_total: linesTotal,
      lines_max: linesMax,
      lines_mean: linesMean,
      lines_p95: linesP95,
      threshold_pass: thresholds.pass,
      threshold_review: thresholds.review,
    },
  });
}
