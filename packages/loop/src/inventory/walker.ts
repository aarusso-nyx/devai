import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.vitest-cache',
  '.devai',
  'generated',
  'examples',
  // R13 W05: docs/site/ is the canonical Docusaurus scaffold location per
  // ADR-DOCS-GOVERNANCE Decision 5. Its TypeScript files (docusaurus.config.ts,
  // sidebars.ts, src/pages/*) are scaffold/config, not framework surfaces, and
  // wouldn't be claimed by any invariant.code_areas. Bare-name match because
  // the inventory walker traverses by directory name and the rest of
  // DEFAULT_IGNORE (e.g. examples, generated) uses the same convention.
  'site',
]);

export interface WalkOptions {
  readonly extensions?: readonly string[];
  /**
   * When supplied, this set REPLACES the walker's DEFAULT_IGNORE entirely.
   * Callers (typically the CLI's `buildIgnoreDirs` helper) compose the
   * effective set from DEFAULT_IGNORE + `--ignore-dir` (add) -
   * `--include-ignored` (remove), so the walker doesn't union here.
   * When omitted, DEFAULT_IGNORE is used as-is.
   */
  readonly ignoreDirs?: ReadonlySet<string>;
}

interface InventoryReadSnapshot {
  readonly walks: Map<string, readonly string[]>;
  readonly sources: Map<string, string>;
  readonly values: Map<string, unknown>;
}

const inventoryReadSnapshot = new AsyncLocalStorage<InventoryReadSnapshot>();

/**
 * Share filesystem discovery and source bytes only for one inventory invocation.
 * The store is discarded when the operation settles, so no later invocation can
 * substitute cached repository state.
 */
export function withInventoryReadSnapshot<T>(operation: () => T): T {
  if (inventoryReadSnapshot.getStore() !== undefined) return operation();
  return inventoryReadSnapshot.run(
    { walks: new Map(), sources: new Map(), values: new Map() },
    operation,
  );
}

/** Reuse a derived value only inside the active inventory invocation. */
export function inventorySnapshotValue<T>(key: string, load: () => T): T {
  const snapshot = inventoryReadSnapshot.getStore();
  if (snapshot === undefined) return load();
  if (snapshot.values.has(key)) return snapshot.values.get(key) as T;
  const value = load();
  snapshot.values.set(key, value);
  return value;
}

/** Read source bytes through the active invocation snapshot, if one exists. */
export function readInventorySource(path: string): string {
  const snapshot = inventoryReadSnapshot.getStore();
  if (snapshot === undefined) return readFileSync(path, 'utf8');
  const cached = snapshot.sources.get(path);
  if (cached !== undefined) return cached;
  const source = readFileSync(path, 'utf8');
  snapshot.sources.set(path, source);
  return source;
}

/**
 * Recursively walk a directory, returning paths to files matching the given
 * extensions. Sorted output for determinism. Skips a default ignore list
 * (node_modules, dist, coverage, .devai, examples, etc.) unless `ignoreDirs`
 * is supplied, in which case `ignoreDirs` is used verbatim.
 *
 * Symlinks are skipped (lstat-based) to avoid double-counting via symlinked
 * paths such as `packages/schemas/src/schemas → docs/schemas`.
 */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const ignore = opts.ignoreDirs ?? DEFAULT_IGNORE;
  const exts = opts.extensions;
  const snapshot = inventoryReadSnapshot.getStore();
  const key = `${root}\0${[...(exts ?? [])].sort().join('\0')}\0${[...ignore].sort().join('\0')}`;
  const cached = snapshot?.walks.get(key);
  if (cached !== undefined) return [...cached];
  const results: string[] = [];
  walk(root, ignore, exts, results);
  results.sort();
  snapshot?.walks.set(key, results);
  return [...results];
}

/** Exposed so CLI callers can compose the effective ignore set without duplicating the default list. */
export const WALKER_DEFAULT_IGNORE: ReadonlySet<string> = DEFAULT_IGNORE;

function walk(
  dir: string,
  ignore: ReadonlySet<string>,
  exts: readonly string[] | undefined,
  out: string[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (ignore.has(name)) continue;
    const full = join(dir, name);
    let s;
    try {
      // lstat (not stat) so symlinks are reported as symlinks; we skip them
      // to avoid double-counting (e.g. `packages/schemas/src/schemas` symlinks
      // to `docs/schemas`).
      s = lstatSync(full);
    } catch {
      continue;
    }
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) {
      walk(full, ignore, exts, out);
    } else if (s.isFile()) {
      if (exts === undefined || exts.some((e) => name.endsWith(e))) {
        out.push(full);
      }
    }
  }
}

export function relativizeAll(paths: readonly string[], repoRoot: string): string[] {
  return paths.map((p) => relative(repoRoot, p)).sort();
}
