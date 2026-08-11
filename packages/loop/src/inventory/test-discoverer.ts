import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { walkFiles } from './walker.js';

export type TestSuite = 'unit' | 'api' | 'int' | 'e2e' | 'sec' | 'perf' | 'journey' | 'db';

export interface TestRecord {
  readonly path: string;
  readonly suite: TestSuite;
  readonly invariants: readonly string[];
}

export interface DiscoverTestsOptions {
  readonly repoRoot: string;
  readonly dir?: string;
  readonly ignoreDirs?: ReadonlySet<string>;
}

const INV_MARKER = /\bINV-[A-Z][A-Z0-9]{1,15}-[0-9]{3}\b/g;

/**
 * Walk the repo for `*.test.ts` / `*.spec.ts` files. Classify each by suite
 * via filename heuristic (`.integration.test.ts` → int, `.e2e.test.ts` → e2e,
 * `.regression.test.ts` → unit-equivalent, etc.). Extract invariant markers
 * by scanning each file's text for `INV-<DOMAIN>-NNN` references.
 */
export function discoverTests(opts: DiscoverTestsOptions): readonly TestRecord[] {
  const dir = opts.dir ?? opts.repoRoot;
  const files = walkFiles(dir, {
    extensions: ['.test.ts', '.spec.ts'],
    ignoreDirs: opts.ignoreDirs,
  });
  const records: TestRecord[] = [];

  for (const file of files) {
    const rel = relative(opts.repoRoot, file);
    const suite = classifySuite(rel);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const matches = text.match(INV_MARKER) ?? [];
    const invariants = [...new Set(matches)].sort();
    records.push({ path: rel, suite, invariants });
  }

  return records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function classifySuite(path: string): TestSuite {
  if (/\.e2e\.(test|spec)\.ts$/.test(path)) return 'e2e';
  if (/\.integration\.(test|spec)\.ts$/.test(path)) return 'int';
  if (/\.api\.(test|spec)\.ts$/.test(path)) return 'api';
  if (/\.sec\.(test|spec)\.ts$/.test(path)) return 'sec';
  if (/\.perf\.(test|spec)\.ts$/.test(path)) return 'perf';
  if (/\.journey\.(test|spec)\.ts$/.test(path)) return 'journey';
  if (/\.db\.(test|spec)\.ts$/.test(path)) return 'db';
  // Default: anything else is treated as unit (including .regression.test.ts;
  // regression tests are unit-shaped by convention).
  return 'unit';
}
