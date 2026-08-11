import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Shared helper for Phase 27.J/K/L pattern-matching test sensors.
 * Walks test files under configurable globs; for each, checks the
 * filename and content against a regex; returns total + matched
 * counts.
 */

export interface TestPatternCounts {
  readonly total: number;
  readonly matched: number;
  readonly matchedFiles: readonly string[];
}

const DEFAULT_TEST_GLOBS = ['packages/*/test', 'packages/*/src'];

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

function walk(dir: string, sink: string[]): void {
  const st = safeStat(dir);
  if (st === null) return;
  if (st.isFile()) {
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(dir)) sink.push(dir);
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
    walk(join(dir, e), sink);
  }
}

function expandRoots(repoRoot: string, globs: readonly string[]): string[] {
  const out: string[] = [];
  for (const g of globs) {
    const normalised = g.replace(/\/\*\*$/, '/*');
    if (!normalised.includes('*')) {
      out.push(abs(repoRoot, normalised));
      continue;
    }
    const parts = normalised.split('/');
    const wildIdx = parts.findIndex((p) => p.includes('*'));
    if (wildIdx < 0) continue;
    const before = parts.slice(0, wildIdx).join('/');
    const after = parts.slice(wildIdx + 1).join('/');
    let entries: string[];
    try {
      entries = readdirSync(abs(repoRoot, before));
    } catch {
      continue;
    }
    for (const entry of entries) {
      out.push(abs(repoRoot, [before, entry, after].filter((s) => s !== '').join('/')));
    }
  }
  return out;
}

export function countPatternMatches(
  repoRoot: string,
  pattern: RegExp,
  testGlobs?: readonly string[],
): TestPatternCounts {
  const roots = expandRoots(repoRoot, testGlobs ?? DEFAULT_TEST_GLOBS);
  const files: string[] = [];
  for (const r of roots) walk(r, files);
  const matched: string[] = [];
  for (const f of files) {
    // Only match against the path *relative to repoRoot* so the tmpdir
    // prefix or other surrounding context doesn't falsely match. Fall back to
    // basename when the file isn't actually inside repoRoot.
    const rel = f.startsWith(repoRoot + '/')
      ? f.slice(repoRoot.length + 1)
      : (f.split('/').pop() ?? f);
    if (pattern.test(rel)) {
      matched.push(f);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (pattern.test(content)) matched.push(f);
  }
  return { total: files.length, matched: matched.length, matchedFiles: matched };
}
