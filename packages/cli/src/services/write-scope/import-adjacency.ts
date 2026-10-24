/**
 * Import adjacency for the Engineer focused-regression verb (ADR-GOV-0026): the repository
 * files a test file imports, through a relative import or a workspace package import. There is
 * no import graph of the repository; one test file is read, its module specifiers are scanned
 * with the TypeScript pre-processor (so comments and strings never count), and each specifier
 * is resolved against the head tree. scripts/check-commit-range.mjs mirrors this resolution for
 * the commits of a pull-request range.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from '@devai-nyx/authority';
import { join, posix } from 'node:path';
import ts from 'typescript';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** Export conditions read in order; `development` names the source in this workspace. */
const ENTRY_CONDITIONS = ['development', 'import', 'default', 'types', 'require'];
/** A path segment Node refuses in a wildcard export match: empty, `.`, `..` or `node_modules`. */
const INVALID_SEGMENTS = new Set(['', '.', '..', 'node_modules']);

interface Workspace {
  readonly name: string;
  readonly directory: string;
  readonly manifest: { readonly exports?: unknown; readonly main?: unknown };
}

/** The module specifiers a source imports, re-exports, requires or loads dynamically. */
export function importSpecifiers(text: string): readonly string[] {
  return ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => fileName);
}

/** The files a resolved target may name: itself, its TypeScript source, an extension, an index. */
export function candidateFiles(target: string): readonly string[] {
  const candidates = [target];
  const emitted = /\.([mc]?)js(x?)$/u.exec(target);
  if (emitted !== null) {
    candidates.push(
      `${target.slice(0, -emitted[0].length)}.${emitted[1] ?? ''}ts${emitted[2] ?? ''}`,
    );
  }
  if (target.endsWith('.d.ts')) candidates.push(`${target.slice(0, -'.d.ts'.length)}.ts`);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${target}${extension}`);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${target}/index${extension}`);
  return candidates;
}

/** The `packages/*` manifests of a head tree that name a package. */
export function workspacePackages(root: string): readonly Workspace[] {
  const packages = join(root, 'packages');
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true }).flatMap((entry) => {
    const path = join(packages, entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(path)) return [];
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as Workspace['manifest'] & {
        readonly name?: unknown;
      };
      return typeof manifest.name === 'string'
        ? [{ name: manifest.name, directory: `packages/${entry.name}`, manifest }]
        : [];
    } catch {
      return [];
    }
  });
}

/**
 * The `exports` entry for a subpath and the text a wildcard key matched, as Node resolves package
 * exports: an exact key first, then the single-`*` key with the longest prefix, then the longest
 * key. A match holding an empty, `.`, `..` or `node_modules` segment resolves to nothing.
 */
function subpathEntry(
  exported: Record<string, unknown>,
  subpath: string,
): { readonly entry: unknown; readonly match: string | undefined } {
  if (Object.hasOwn(exported, subpath) && !subpath.includes('*')) {
    return { entry: exported[subpath], match: undefined };
  }
  let best: { key: string; prefix: string; match: string } | undefined;
  for (const key of Object.keys(exported)) {
    const star = key.indexOf('*');
    if (star === -1 || star !== key.lastIndexOf('*')) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.length < key.length ||
      !subpath.startsWith(prefix) ||
      !subpath.endsWith(suffix) ||
      (best !== undefined &&
        (prefix.length < best.prefix.length ||
          (prefix.length === best.prefix.length && key.length <= best.key.length)))
    ) {
      continue;
    }
    best = { key, prefix, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  if (
    best === undefined ||
    best.match.split(/[/\\]/u).some((segment) => INVALID_SEGMENTS.has(segment.toLowerCase()))
  ) {
    return { entry: undefined, match: undefined };
  }
  return { entry: exported[best.key], match: best.match };
}

/** The entry targets a workspace package exports for a subpath (`.` or `./name`). */
function exportTargets(manifest: Workspace['manifest'], subpath: string): readonly string[] {
  const exported = manifest.exports;
  if (exported === undefined || exported === null) {
    if (subpath !== '.') return [subpath];
    return [typeof manifest.main === 'string' ? manifest.main : 'index.js'];
  }
  const conditional =
    typeof exported === 'object' &&
    !Array.isArray(exported) &&
    !Object.keys(exported).some((key) => key.startsWith('.'));
  const { entry, match } =
    typeof exported === 'string' || conditional
      ? { entry: subpath === '.' ? exported : undefined, match: undefined }
      : subpathEntry(exported as Record<string, unknown>, subpath);
  let targets: readonly string[];
  if (typeof entry === 'string') targets = [entry];
  else if (entry === null || typeof entry !== 'object') targets = [];
  else {
    const conditions = entry as Record<string, unknown>;
    targets = ENTRY_CONDITIONS.flatMap((condition) => {
      const target = conditions[condition];
      return typeof target === 'string' ? [target] : [];
    });
  }
  return match === undefined ? targets : targets.map((target) => target.replaceAll('*', match));
}

/**
 * The repository files one specifier of `from` resolves to: a relative specifier against the
 * importing file, a workspace specifier through the exports of the `packages/*` manifest that
 * names it (a wildcard key such as `./dist/*` included), where an emitted `dist/` target stands
 * for its `src/` source. Any other bare specifier, and a relative one leaving the repository,
 * resolves to nothing.
 */
export function resolveImport(
  specifier: string,
  from: string,
  exists: (path: string) => boolean,
  workspaces: readonly Workspace[],
): readonly string[] {
  const present = (targets: readonly string[]): string[] =>
    targets.flatMap((target) => candidateFiles(target).filter(exists).slice(0, 1));
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const target = posix.normalize(posix.join(posix.dirname(from), specifier));
    return target.startsWith('../') ? [] : present([target]);
  }
  const workspace = workspaces
    .filter(({ name }) => specifier === name || specifier.startsWith(`${name}/`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (workspace === undefined) return [];
  const subpath = specifier === workspace.name ? '.' : `.${specifier.slice(workspace.name.length)}`;
  return present(
    exportTargets(workspace.manifest, subpath).flatMap((entry) => {
      const target = posix.normalize(posix.join(workspace.directory, entry));
      const emitted = `${workspace.directory}/dist/`;
      return target.startsWith(emitted)
        ? [target, `${workspace.directory}/src/${target.slice(emitted.length)}`]
        : [target];
    }),
  );
}

/** Every repository file the test file at `path` in the head tree `root` imports. */
export function importedRepositoryFiles(
  root: string,
  path: string,
  text: string,
  workspaces: readonly Workspace[] = workspacePackages(root),
): ReadonlySet<string> {
  const exists = (candidate: string): boolean => {
    try {
      return lstatSync(join(root, candidate)).isFile();
    } catch {
      return false;
    }
  };
  return new Set(
    importSpecifiers(text).flatMap((specifier) =>
      resolveImport(specifier, path, exists, workspaces),
    ),
  );
}
