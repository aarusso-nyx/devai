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

/** Expand from the literal prefix, then apply the same pattern used for claims. */
function matchingFiles(repoRoot: string, glob: string): string[] {
  const wildcard = glob.indexOf('*');
  const prefix = wildcard < 0 ? glob : glob.slice(0, glob.lastIndexOf('/', wildcard) + 1);
  const files: string[] = [];
  listFilesRecursive(absDir(repoRoot, prefix), repoRoot, files);
  if (wildcard < 0) return files;
  const pattern = globToRegExp(glob);
  return files.filter((file) => pattern.test(file));
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
  const perInvariantGlobs: Array<{
    id: string;
    file: string;
    globs: readonly string[];
    invalid: boolean;
  }> = [];
  for (const file of listJsonFiles(invariantsDir)) {
    let parsed: InvariantRecord | null = null;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as InvariantRecord;
    } catch {
      continue;
    }
    const id = parsed?.id ?? file.split('/').slice(-1).join('');
    const declared = parsed?.scope?.code_areas;
    const invalid =
      declared !== undefined &&
      (!Array.isArray(declared) || declared.some((g) => typeof g !== 'string'));
    const globs: readonly string[] = invalid ? [] : (declared ?? []);
    perInvariantGlobs.push({ id, file, globs, invalid });
    for (const g of globs) allGlobs.push(g);
  }

  // Forward scan.
  const findings: SensorFinding[] = [];
  let invariantsBrokenForward = 0;
  for (const { id, file, globs, invalid } of perInvariantGlobs) {
    const matched = globs.some((glob) =>
      glob.includes('*')
        ? matchingFiles(opts.repoRoot, glob).length > 0
        : safeStat(absDir(opts.repoRoot, glob))?.isFile() === true,
    );
    if (invalid || (globs.length > 0 && !matched)) {
      invariantsBrokenForward += 1;
      findings.push({
        severity: 'error',
        code: invalid
          ? 'SPEC_ALIGNMENT_INVALID_CODE_AREAS'
          : 'SPEC_ALIGNMENT_INVARIANT_HAS_NO_MATCHING_FILES',
        message: invalid
          ? `Invariant ${id} scope.code_areas must be an array of strings.`
          : `Invariant ${id} has zero matching files for any of its scope.code_areas[].`,
        file,
      });
    }
  }

  // Reverse scan.
  const sourceFiles = [
    ...new Set(sourceGlobs.flatMap((glob) => matchingFiles(opts.repoRoot, glob))),
  ].filter((file) => /\.(ts|tsx|js)$/.test(file));

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
