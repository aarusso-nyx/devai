import { validateRepositoryTarget } from '@devai-nyx/utils';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SpecValidationError, SpecValidationResult } from './types.js';

export interface ValidateTestTraceOptions {
  readonly repoRoot: string;
  readonly tracePath?: string;
  readonly invariantsDir?: string;
}

export interface TestTraceResult extends SpecValidationResult {
  readonly discovered_test_files: number;
  readonly referenced_test_files: number;
  readonly supported_test_files: number;
  readonly experimental_test_files: number;
}

type Lifecycle = 'supported' | 'experimental';

interface TraceCorpusEntry {
  readonly path: string;
  readonly invariant_ids: readonly string[];
  readonly lifecycle: Lifecycle;
}

interface TraceFile {
  readonly invariants?: ReadonlyArray<{
    readonly id: string;
    readonly tests: ReadonlyArray<{ readonly path: string }>;
  }>;
  readonly test_corpus?: readonly TraceCorpusEntry[];
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function discoverTests(repoRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && path.includes(`${sep}tests${sep}`) && path.endsWith('.test.ts')) {
        found.push(posixRelative(repoRoot, path));
      }
    }
  };
  for (const root of [join(repoRoot, 'packages'), join(repoRoot, 'tests')]) {
    if (existsSync(root)) walk(root);
  }
  return found.sort();
}

function loadInvariantLifecycles(invariantsDir: string): Map<string, Lifecycle> {
  const result = new Map<string, Lifecycle>();
  if (!existsSync(invariantsDir)) return result;
  for (const name of readdirSync(invariantsDir)
    .filter((item) => item.endsWith('.json'))
    .sort()) {
    try {
      const parsed = JSON.parse(readFileSync(join(invariantsDir, name), 'utf8')) as {
        id?: string;
        lifecycle?: Lifecycle;
      };
      if (typeof parsed.id === 'string') result.set(parsed.id, parsed.lifecycle ?? 'supported');
    } catch {
      // The ordinary invariant validator owns malformed JSON reporting.
    }
  }
  return result;
}

function markerIds(path: string): { ids: string[]; duplicates: string[] } {
  const source = readFileSync(path, 'utf8');
  const ids = [...source.matchAll(/\/\/\s*Invariants:\s*([^\n]+)/g)]
    .flatMap((match) => (match[1] ?? '').split(','))
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return { ids: [...seen].sort(), duplicates: [...duplicates].sort() };
}

export function validateTestTrace(opts: ValidateTestTraceOptions): TestTraceResult {
  const tracePath = opts.tracePath ?? join(opts.repoRoot, 'law/trace.json');
  const invariantsDir = opts.invariantsDir ?? join(opts.repoRoot, 'law/invariants');
  const errors: SpecValidationError[] = [];
  const lifecycles = loadInvariantLifecycles(invariantsDir);
  const tests = discoverTests(opts.repoRoot);
  const markers = new Map<string, { ids: string[]; lifecycle: Lifecycle | null }>();

  for (const path of tests) {
    const fullPath = join(opts.repoRoot, path);
    const parsed = markerIds(fullPath);
    if (parsed.ids.length === 0) {
      errors.push({ file: path, message: 'missing invariant marker (`// Invariants: INV-...`)' });
      markers.set(path, { ids: [], lifecycle: null });
      continue;
    }
    for (const id of parsed.duplicates) {
      errors.push({ file: path, message: `duplicate invariant reference '${id}'` });
    }
    const referencedLifecycles = new Set<Lifecycle>();
    for (const id of parsed.ids) {
      const lifecycle = lifecycles.get(id);
      if (lifecycle === undefined)
        errors.push({ file: path, message: `unknown invariant '${id}'` });
      else referencedLifecycles.add(lifecycle);
    }
    if (referencedLifecycles.size > 1) {
      errors.push({
        file: path,
        message: 'mixed invariant lifecycles cannot share readiness provenance',
      });
    }
    markers.set(path, {
      ids: parsed.ids,
      lifecycle: referencedLifecycles.size === 1 ? ([...referencedLifecycles][0] ?? null) : null,
    });
  }

  let trace: TraceFile = {};
  if (!existsSync(tracePath)) {
    errors.push({ file: tracePath, message: 'trace file missing' });
  } else {
    try {
      trace = JSON.parse(readFileSync(tracePath, 'utf8')) as TraceFile;
    } catch (error) {
      errors.push({
        file: tracePath,
        message: `trace JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const corpusByPath = new Map<string, TraceCorpusEntry>();
  for (const entry of trace.test_corpus ?? []) {
    if (corpusByPath.has(entry.path)) {
      errors.push({ file: tracePath, message: `duplicate canonical test mapping '${entry.path}'` });
      continue;
    }
    corpusByPath.set(entry.path, entry);
    if (!validateRepositoryTarget(opts.repoRoot, entry.path, 'test').ok) {
      errors.push({
        file: entry.path,
        message: 'trace path is not a contained executable test file',
      });
    }
  }
  for (const [path, marker] of markers) {
    const entry = corpusByPath.get(path);
    if (entry === undefined) {
      errors.push({ file: path, message: 'test is absent from trace.test_corpus' });
      continue;
    }
    const expected = [...entry.invariant_ids].sort();
    if (JSON.stringify(expected) !== JSON.stringify(marker.ids)) {
      errors.push({
        file: path,
        message: `canonical invariant mapping differs: marker=[${marker.ids.join(',')}] trace=[${expected.join(',')}]`,
      });
    }
    if (marker.lifecycle !== null && entry.lifecycle !== marker.lifecycle) {
      errors.push({
        file: path,
        message: `lifecycle classification differs: marker=${marker.lifecycle} trace=${entry.lifecycle}`,
      });
    }
  }
  for (const entry of trace.invariants ?? []) {
    for (const test of entry.tests) {
      if (!validateRepositoryTarget(opts.repoRoot, test.path, 'test').ok) {
        errors.push({
          file: test.path,
          message: 'trace path is not a contained executable test file',
        });
      }
    }
  }

  let supported = 0;
  let experimental = 0;
  for (const marker of markers.values()) {
    if (marker.lifecycle === 'experimental') experimental += 1;
    else if (marker.lifecycle === 'supported') supported += 1;
  }
  return {
    ok: errors.length === 0,
    errors,
    files_scanned: tests.length,
    discovered_test_files: tests.length,
    referenced_test_files: [...markers.values()].filter((entry) => entry.ids.length > 0).length,
    supported_test_files: supported,
    experimental_test_files: experimental,
  };
}
