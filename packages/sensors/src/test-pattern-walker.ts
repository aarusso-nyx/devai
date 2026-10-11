import { readFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { executableTestPopulation } from './test-file-population.js';

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
  readonly errors?: readonly string[];
}

export function countPatternMatches(
  repoRoot: string,
  pattern: RegExp,
  testGlobs?: readonly string[],
): TestPatternCounts {
  const population = executableTestPopulation(repoRoot, testGlobs);
  const files = population.paths;
  const errors = [...population.errors];
  const matched: string[] = [];
  const matches = (value: string): boolean => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  };
  for (const f of files) {
    // Only match against the path *relative to repoRoot* so the tmpdir
    // prefix or other surrounding context doesn't falsely match. Fall back to
    // basename when the file isn't actually inside repoRoot.
    const candidate = relative(resolve(repoRoot), f);
    const rel =
      candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)
        ? basename(f)
        : candidate.split(sep).join('/');
    if (matches(rel)) {
      matched.push(f);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(f, 'utf8');
    } catch (error) {
      errors.push(`Cannot read executable test ${f}: ${String(error)}`);
      continue;
    }
    if (matches(content)) matched.push(f);
  }
  return {
    total: files.length,
    matched: matched.length,
    matchedFiles: matched,
    ...(errors.length === 0 ? {} : { errors }),
  };
}
