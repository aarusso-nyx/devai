import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: spec alignment (F1 × T4). Phase 27.B.
 *
 * Forward scan: every invariant's `scope.code_areas[]` glob resolves
 * to ≥ 1 file on disk. Invariants whose entries match zero files are
 * "broken-forward" (stale-spec hard-fail).
 *
 * Reverse scan: every source file (default `packages/*<asterisk>/src/<asterisk><asterisk>`)
 * matches ≥ 1 invariant's `scope.code_areas[]`. Files matching zero
 * globs are "unclaimed-reverse" (discipline signal).
 *
 * Status semantics:
 *   - PASS: every invariant forward-matches AND reverse-claim ≥ 80%.
 *   - REVIEW: every invariant forward-matches but reverse < 80%.
 *   - FAIL: ≥ 1 invariant matches zero files (stale claim).
 */

export interface SpecAlignmentOptions {
  readonly repoRoot: string;
  readonly invariantsDir?: string;
  readonly sourceGlobs?: readonly string[];
  readonly reverseThresholdPct?: number;
  readonly now?: string;
}

const DEFAULT_INVARIANTS_DIR = 'law/invariants';
const DEFAULT_SOURCE_GLOBS = ['packages/*/src/**'] as const;
const DEFAULT_REVERSE_THRESHOLD = 80;

function absDir(repoRoot: string, dir: string): string {
  return isAbsolute(dir) ? dir : resolve(repoRoot, dir);
}

function listJsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Convert a glob (only `*` and `**` supported) to a RegExp anchored against repo-relative posix paths. */
function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c !== undefined && /[.+?^${}()|[\]\\]/.test(c)) {
      re += '\\' + c;
    } else {
      re += c ?? '';
    }
  }
  re += '$';
  return new RegExp(re);
}

function isLiteralPath(glob: string): boolean {
  return !glob.includes('*');
}

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** Count files under a directory tree (excluding common build/junk dirs). */
function listFilesRecursive(absRoot: string, repoRoot: string, sink: string[]): void {
  const st = safeStat(absRoot);
  if (st === null) return;
  if (st.isFile()) {
    const rel = absRoot
      .replace(repoRoot + sep, '')
      .split(sep)
      .join('/');
    sink.push(rel);
    return;
  }
  if (!st.isDirectory()) return;
  let entries: string[];
  try {
    entries = readdirSync(absRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build')
      continue;
    listFilesRecursive(join(absRoot, entry), repoRoot, sink);
  }
}

interface InvariantRecord {
  readonly id?: string;
  readonly scope?: { code_areas?: readonly string[] };
}

export function senseSpecAlignment(rawOpts: SpecAlignmentOptions): SensorReading {
  // Phase 30 lane D (DEVAI self-application): resolve repoRoot to an
  // absolute path. The listFilesRecursive path-stripping logic
  // (`absRoot.replace(repoRoot + sep, '')`) only works when repoRoot
  // is absolute; with the CLI default of '.', stripping fails and
  // file paths stay absolute, breaking the regex match.
  const opts: SpecAlignmentOptions = { ...rawOpts, repoRoot: resolve(rawOpts.repoRoot) };
  const invariantsDir = absDir(opts.repoRoot, opts.invariantsDir ?? DEFAULT_INVARIANTS_DIR);
  const sourceGlobs = opts.sourceGlobs ?? DEFAULT_SOURCE_GLOBS;
  const reverseThreshold = opts.reverseThresholdPct ?? DEFAULT_REVERSE_THRESHOLD;

  // Load invariants and compute the union of all code-area globs.
  const allGlobs: string[] = [];
  const perInvariantGlobs: Array<{ id: string; file: string; globs: readonly string[] }> = [];
  for (const file of listJsonFiles(invariantsDir)) {
    let parsed: InvariantRecord | null = null;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as InvariantRecord;
    } catch {
      continue;
    }
    const id = parsed.id ?? file.split('/').slice(-1).join('');
    const globs = parsed.scope?.code_areas ?? [];
    perInvariantGlobs.push({ id, file, globs });
    for (const g of globs) allGlobs.push(g);
  }

  // Forward scan.
  const findings: SensorFinding[] = [];
  let invariantsBrokenForward = 0;
  for (const { id, file, globs } of perInvariantGlobs) {
    let matched = 0;
    for (const g of globs) {
      if (isLiteralPath(g)) {
        if (safeStat(absDir(opts.repoRoot, g)) !== null) matched += 1;
        continue;
      }
      // Globbed; expand by walking the stripped-prefix directory.
      const prefix = g.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
      const abs = absDir(opts.repoRoot, prefix);
      const sink: string[] = [];
      listFilesRecursive(abs, opts.repoRoot, sink);
      const re = globToRegExp(g);
      if (sink.some((s) => re.test(s))) matched += 1;
    }
    if (globs.length > 0 && matched === 0) {
      invariantsBrokenForward += 1;
      findings.push({
        severity: 'error',
        code: 'SPEC_ALIGNMENT_INVARIANT_HAS_NO_MATCHING_FILES',
        message: `Invariant ${id} has zero matching files for any of its scope.code_areas[].`,
        file,
      });
    }
  }

  // Reverse scan.
  const sourceFiles: string[] = [];
  for (const g of sourceGlobs) {
    const prefix = g.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
    if (prefix.includes('*')) {
      // Wildcard in prefix (e.g. packages/*/src) — expand one level.
      const parts = prefix.split('/');
      const wildIdx = parts.findIndex((p) => p.includes('*'));
      if (wildIdx < 0) continue;
      const before = parts.slice(0, wildIdx).join('/');
      const after = parts.slice(wildIdx + 1).join('/');
      const wildAbs = absDir(opts.repoRoot, before);
      const wildPattern = parts[wildIdx] ?? '*';
      const wildRe = globToRegExp(wildPattern);
      let entries: string[];
      try {
        entries = readdirSync(wildAbs);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!wildRe.test(entry)) continue;
        const sub = absDir(opts.repoRoot, [before, entry, after].filter((s) => s !== '').join('/'));
        listFilesRecursive(sub, opts.repoRoot, sourceFiles);
      }
    } else {
      listFilesRecursive(absDir(opts.repoRoot, prefix), opts.repoRoot, sourceFiles);
    }
  }

  const allRes = allGlobs.map((g) => globToRegExp(g));
  let claimed = 0;
  for (const f of sourceFiles) {
    if (allRes.some((re) => re.test(f))) claimed += 1;
  }
  const reversePct = sourceFiles.length === 0 ? 100 : (claimed / sourceFiles.length) * 100;

  let status: SensorStatus;
  if (invariantsBrokenForward > 0) {
    status = 'fail';
  } else if (reversePct < reverseThreshold) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'SPEC_ALIGNMENT_REVERSE_BELOW_THRESHOLD',
      message: `Reverse-claim ratio ${reversePct.toFixed(1)}% is below threshold ${String(reverseThreshold)}% (${String(claimed)} / ${String(sourceFiles.length)} source files claimed).`,
    });
  } else {
    status = 'pass';
  }

  return buildSensorReading({
    sensorName: 'spec-alignment',
    sensorKind: 'spec_alignment',
    command: ['devai', 'sense-spec-alignment'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      invariants_scanned: perInvariantGlobs.length,
      invariants_broken_forward: invariantsBrokenForward,
      source_files_scanned: sourceFiles.length,
      source_files_claimed: claimed,
      reverse_pct: Number(reversePct.toFixed(2)),
      reverse_threshold_pct: reverseThreshold,
    },
  });
}
