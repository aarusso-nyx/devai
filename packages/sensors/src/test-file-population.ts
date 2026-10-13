import { realpathSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { isExecutableTestFile } from '@devai-nyx/utils';
export { executableTestKind, isExecutableTestFile } from '@devai-nyx/utils';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from 'node:path';

export const DEFAULT_TEST_GLOBS = [
  'packages/*/test',
  'packages/*/tests',
  'packages/*/src',
  'test',
  'tests',
] as const;

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build']);

export interface RepositoryPathPopulation {
  readonly paths: readonly string[];
  readonly errors: readonly string[];
  /** Declared display roots mapped to their once-resolved traversal scopes. */
  readonly physicalRoots?: ReadonlyMap<string, string>;
}

/**
 * Expand every glob segment using Node's glob grammar. Walk only regular entries,
 * never symlink targets; repeated/overlapping declarations have one population.
 * Explicit absolute external roots retain their separately scoped direct-read API.
 */
export function expandRepositoryPaths(
  repoRoot: string,
  patterns: readonly string[],
  options: { readonly optional?: boolean; readonly contained?: boolean } = {},
): RepositoryPathPopulation {
  const root = resolve(repoRoot);
  const selected = new Map<string, string>();
  const errors = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.length === 0) {
      errors.add('Empty executable population pattern.');
      continue;
    }
    let absolutePattern = resolve(root, pattern);
    const inside = relative(root, absolutePattern);
    if (
      options.contained === true &&
      (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    ) {
      errors.add(`Executable population escapes the candidate root: ${pattern}`);
      continue;
    }
    const parts = absolutePattern.split(sep);
    const wildcard = parts.findIndex((part) => /[*?[\]{}]/u.test(part));
    let base = wildcard < 0 ? absolutePattern : parts.slice(0, wildcard).join(sep) || sep;
    const displayBase = base;
    const external = inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);
    if (external) {
      try {
        const physicalBase =
          wildcard < 0 && !statSync(base).isDirectory()
            ? resolve(realpathSync(dirname(base)), basename(base))
            : realpathSync(base);
        absolutePattern = resolve(physicalBase, relative(base, absolutePattern));
        base = physicalBase;
      } catch {
        // Missing/unreadable declared roots retain the ordinary refusal below.
      }
    }
    let matches = 0;
    const inspect = (path: string): void => {
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (!options.optional || path !== base)
          errors.add(`Cannot inspect executable population ${path}: ${String(error)}`);
        return;
      }
      if (stat.isSymbolicLink()) {
        errors.add(`Executable population contains a symbolic link: ${path}`);
        return;
      }
      if (matchesGlob(path, absolutePattern)) {
        const display = external ? resolve(displayBase, relative(base, path)) : path;
        if (!selected.has(display)) selected.set(display, path);
        matches += 1;
        if (stat.isDirectory()) return;
      }
      if (!stat.isDirectory()) return;
      let entries: string[];
      try {
        entries = readdirSync(path).sort();
      } catch (error) {
        errors.add(`Cannot list executable population ${path}: ${String(error)}`);
        return;
      }
      for (const entry of entries) {
        if (
          IGNORED_DIRECTORIES.has(entry) ||
          (entry === 'worktrees' && path.endsWith(`${sep}.devai`))
        )
          continue;
        inspect(join(path, entry));
      }
    };
    // Candidate prefixes remain link-free within the candidate. An explicit external
    // root is canonicalized once above; descendants remain inside its physical scope.
    let ancestor = base;
    let safe = true;
    const boundary =
      inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? root : base;
    while (ancestor !== dirname(ancestor)) {
      try {
        if (lstatSync(ancestor).isSymbolicLink()) {
          errors.add(`Executable population prefix contains a symbolic link: ${ancestor}`);
          safe = false;
          break;
        }
      } catch {
        // Missing prefixes are reported by inspect, not silently substituted.
      }
      if (ancestor === boundary) break;
      ancestor = dirname(ancestor);
    }
    if (safe) inspect(base);
    if (matches === 0 && options.optional !== true)
      errors.add(`Executable population pattern matched no entries: ${pattern}`);
  }
  const identities = new Set<string>();
  const unique = new Map<string, string>();
  for (const [display, physical] of selected) {
    const identity = realpathSync(physical);
    if (identities.has(identity)) continue;
    identities.add(identity);
    unique.set(display, physical);
  }
  return {
    paths: [...unique.keys()].filter(
      (path) =>
        ![...unique].some(
          ([parent, physical]) =>
            parent !== path && unique.get(path)?.startsWith(`${physical}${sep}`),
        ),
    ),
    physicalRoots: unique,
    errors: [...errors].sort(),
  };
}

/** Enumerate all regular files below selected directory roots, without following links. */
export function regularFilePopulation(
  roots: readonly string[],
  physicalRoots?: ReadonlyMap<string, string>,
): RepositoryPathPopulation {
  const files = new Map<string, string>();
  const errors = new Set<string>();
  const walk = (path: string, display: string): void => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        errors.add(`Executable population contains a symbolic link: ${path}`);
      } else if (stat.isFile()) {
        const identity = realpathSync(path);
        if (!files.has(identity)) files.set(identity, display);
      } else if (stat.isDirectory()) {
        for (const entry of readdirSync(path).sort()) {
          if (
            IGNORED_DIRECTORIES.has(entry) ||
            (entry === 'worktrees' && path.endsWith(`${sep}.devai`))
          )
            continue;
          walk(join(path, entry), join(display, entry));
        }
      } else errors.add(`Executable population contains a non-regular entry: ${path}`);
    } catch (error) {
      errors.add(`Cannot read executable population ${path}: ${String(error)}`);
    }
  };
  for (const root of roots) walk(physicalRoots?.get(root) ?? root, root);
  return { paths: [...files.values()], errors: [...errors].sort() };
}

export function executableTestPopulation(
  repoRoot: string,
  patterns?: readonly string[],
): RepositoryPathPopulation {
  const roots = expandRepositoryPaths(repoRoot, patterns ?? DEFAULT_TEST_GLOBS, {
    optional: patterns === undefined,
  });
  const files = regularFilePopulation(roots.paths, roots.physicalRoots);
  return {
    paths: files.paths.filter(isExecutableTestFile),
    errors: [...new Set([...roots.errors, ...files.errors])].sort(),
  };
}
