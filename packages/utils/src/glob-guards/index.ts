import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { minimatch } from 'minimatch';

/**
 * A declarative registry of glob patterns an adopter depends on — a CI
 * trigger path, generator input, or validation target — plus a check that
 * each pattern still matches real files.
 *
 * Found via two real bugs: stynx's devai-gates.yml referenced
 * `docs/architecture/invariants/*.json` after the directory had been
 * renamed within the documentation tree, so its "validate
 * invariants against the schema" step had been silently validating
 * zero files (guarded by `[ -f "$f" ] || continue`) on every PR while
 * still reporting green; pec's `generate-test-obligations.mjs`
 * scanned for `INV-*.md` only, silently dropping invariants already
 * migrated to devai's canonical `.json` schema format. Both are the
 * same failure class: a glob that was correct once, then the tree
 * moved on, and nothing re-checked whether it still matched anything.
 */

const HARD_EXCLUDE = new Set(['.git', 'node_modules']);

export interface GlobGuard {
  readonly id: string;
  readonly description?: string;
  readonly pattern: string;
  readonly min_matches?: number;
  readonly source?: string;
}

export interface GlobGuardResult {
  readonly id: string;
  readonly pattern: string;
  readonly min_matches: number;
  readonly match_count: number;
  readonly ok: boolean;
  readonly sample_matches: readonly string[];
}

export function loadGlobGuards(registryPath: string): GlobGuard[] {
  if (!existsSync(registryPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as { guards?: GlobGuard[] };
    return parsed.guards ?? [];
  } catch {
    return [];
  }
}

const GLOB_META = /[*?[\]{}]/;

/** The longest path prefix of `pattern` before any glob metacharacter. */
function globBaseDir(pattern: string): string {
  const segments = pattern.split('/');
  const base: string[] = [];
  for (const seg of segments) {
    if (GLOB_META.test(seg)) break;
    base.push(seg);
  }
  return base.length > 0 ? base.join('/') : '.';
}

function walkAll(dir: string, root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (HARD_EXCLUDE.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkAll(full, root, out);
    } else if (entry.isFile()) {
      out.push(relative(root, full).split(sep).join('/'));
    }
  }
}

/**
 * Evaluate a single guard's pattern against the real tree rooted at
 * `repoRoot`. Literal (glob-metacharacter-free) patterns are checked
 * by direct existence rather than a directory walk, since walking a
 * file path as if it were a directory would always report zero
 * matches.
 */
export function evaluateGlobGuard(repoRoot: string, guard: GlobGuard): GlobGuardResult {
  const minMatches = guard.min_matches ?? 1;
  let matches: string[];
  if (!GLOB_META.test(guard.pattern)) {
    matches = existsSync(join(repoRoot, guard.pattern)) ? [guard.pattern] : [];
  } else {
    const baseDir = join(repoRoot, globBaseDir(guard.pattern));
    const files: string[] = [];
    if (existsSync(baseDir)) {
      walkAll(baseDir, repoRoot, files);
    }
    matches = files.filter((f) => minimatch(f, guard.pattern, { dot: true }));
  }
  return {
    id: guard.id,
    pattern: guard.pattern,
    min_matches: minMatches,
    match_count: matches.length,
    ok: matches.length >= minMatches,
    sample_matches: matches.slice(0, 5),
  };
}

export function evaluateGlobGuards(repoRoot: string, registryPath: string): GlobGuardResult[] {
  return loadGlobGuards(registryPath).map((g) => evaluateGlobGuard(repoRoot, g));
}
