import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: spec freshness (F1 × T9). Phase 26.D (closes
 * D-77 sub-batch 26.D). For each invariant in
 * `law/invariants/*.json`, compares the invariant
 * file's mtime against the most-recent mtime of any file matched by
 * its `scope.code_areas[]`. An invariant whose mtime is more than
 * `thresholdDays` (default 90) older than its code is flagged as
 * stale.
 *
 * Status semantics:
 *   - PASS: no stale invariants.
 *   - REVIEW: ≥ 1 stale invariant (staleness is a discipline signal,
 *     not a hard fail; the invariant may still be correct but the
 *     mtime delta suggests it hasn't been re-examined since the code
 *     it claims to govern was last touched).
 *
 * Glob handling: `scope.code_areas[]` entries are treated as paths.
 * A trailing `/**` is stripped to yield a directory; the directory
 * is walked recursively for max mtime. A path without trailing
 * `/**` is statted directly. Non-existent paths are silently
 * skipped (an invariant pointing at deleted code is a separate
 * concern handled by adherence checks).
 */

export interface SpecFreshnessOptions {
  readonly repoRoot: string;
  /** Default: `law/invariants` */
  readonly invariantsDir?: string;
  /** Staleness threshold in days. Default 90. */
  readonly thresholdDays?: number;
  /** Override "now" for deterministic testing. Default: current time. */
  readonly now?: Date;
}

const DAY_MS = 86_400_000;

function absDir(repoRoot: string, dir: string): string {
  return isAbsolute(dir) ? dir : resolve(repoRoot, dir);
}

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** Walk a directory recursively and return the max mtime in milliseconds. */
function maxMtimeMs(dir: string): number {
  let max = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(cur, entry);
      const st = safeStat(full);
      if (st === null) continue;
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
        stack.push(full);
      } else if (st.isFile()) {
        const m = Number(st.mtimeMs);
        if (m > max) max = m;
      }
    }
  }
  return max;
}

function resolveCodeAreaMtimeMs(repoRoot: string, area: string): number {
  // Strip trailing `/**` (and `/*`); treat as the parent dir.
  let path = area.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
  if (path === '') path = repoRoot;
  const abs = isAbsolute(path) ? path : resolve(repoRoot, path);
  const st = safeStat(abs);
  if (st === null) return 0;
  if (st.isDirectory()) return maxMtimeMs(abs);
  return Number(st.mtimeMs);
}

export interface SpecFreshnessReport {
  readonly invariant_id: string;
  readonly file: string;
  readonly invariant_mtime_ms: number;
  readonly max_code_mtime_ms: number;
  readonly stale_days: number;
  readonly stale: boolean;
}

interface InvariantRecord {
  readonly id?: string;
  readonly scope?: { code_areas?: readonly string[] };
}

export function senseSpecFreshness(opts: SpecFreshnessOptions): {
  reading: SensorReading;
  reports: readonly SpecFreshnessReport[];
} {
  const invariantsDir = absDir(opts.repoRoot, opts.invariantsDir ?? 'law/invariants');
  const thresholdDays = opts.thresholdDays ?? 90;
  const _now = (opts.now ?? new Date()).getTime();

  const reports: SpecFreshnessReport[] = [];
  let entries: string[];
  try {
    entries = readdirSync(invariantsDir);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = join(invariantsDir, entry);
    let parsed: InvariantRecord | null = null;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as InvariantRecord;
    } catch {
      continue;
    }
    if (parsed === null) continue;
    const id = parsed.id ?? entry.replace(/\.json$/, '');
    const codeAreas = parsed.scope?.code_areas ?? [];
    if (codeAreas.length === 0) continue;

    const invMtime = Number(safeStat(file)?.mtimeMs ?? 0);
    let maxCode = 0;
    for (const area of codeAreas) {
      const m = resolveCodeAreaMtimeMs(opts.repoRoot, area);
      if (m > maxCode) maxCode = m;
    }
    if (maxCode === 0) continue;

    const deltaMs = maxCode - invMtime;
    const staleDays = Math.max(0, Math.floor(deltaMs / DAY_MS));
    const stale = staleDays > thresholdDays;
    reports.push({
      invariant_id: id,
      file,
      invariant_mtime_ms: invMtime,
      max_code_mtime_ms: maxCode,
      stale_days: staleDays,
      stale,
    });
  }

  const staleCount = reports.filter((r) => r.stale).length;
  const status: SensorStatus = staleCount > 0 ? 'review' : 'pass';
  const findings: SensorFinding[] = reports
    .filter((r) => r.stale)
    .map((r) => ({
      severity: 'warning' as const,
      code: 'SPEC_FRESHNESS_STALE',
      message: `Invariant ${r.invariant_id} is ${String(r.stale_days)} day(s) older than its code (threshold ${String(thresholdDays)}).`,
      file: r.file,
    }));

  const reading = buildSensorReading({
    sensorName: 'spec-freshness',
    sensorKind: 'spec_freshness',
    command: ['devai', 'sense-spec-freshness'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now.toISOString() }),
    findings,
    metrics: {
      invariants_scanned: reports.length,
      stale_count: staleCount,
      threshold_days: thresholdDays,
    },
  });
  return { reading, reports };
}
