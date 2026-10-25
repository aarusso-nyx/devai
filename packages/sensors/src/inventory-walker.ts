import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Shared filesystem walker + TS source parser for inventory sensors
 * (Phase 17.C). Re-used by inventory-dep-graph, inventory-api,
 * inventory-routes, and (eventually) the other inventory_* sensors.
 *
 * Plain `typescript` only — no ts-morph, no @babel/parser. The TS
 * compiler parses .tsx via ScriptKind.TSX, which covers both NestJS
 * (.ts) and React (.tsx) needs without adding deps.
 */

/** Immutable admitted source namespace; observation only, never mutation authority. */
export interface InventorySourceReader {
  readFile(absolutePath: string): string;
  listDirectory(
    absolutePath: string,
  ): readonly { readonly name: string; readonly kind: 'file' | 'directory' }[];
  exists(absolutePath: string): boolean;
  isDirectory(absolutePath: string): boolean;
}

export const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'generated',
  '.git',
  'coverage',
  '.devai',
  '.vitest-cache',
  'build',
]);

export interface WalkOptions {
  readonly sourceReader?: InventorySourceReader;
  readonly ignoreDirs?: ReadonlySet<string>;
  /** Extensions to include (without dot). Defaults to ['ts']. */
  readonly extensions?: readonly string[];
  /** Skip .d.ts files (default: true). */
  readonly skipDeclarations?: boolean;
}

/**
 * Recursive directory walk. Returns absolute file paths in arbitrary
 * order. Errors reading sub-directories are silently skipped (e.g.
 * permission denied on a sibling project).
 */
export function walkFiles(dir: string, opts: WalkOptions = {}): string[] {
  const ignoreDirs = opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const extensions = opts.extensions ?? ['ts'];
  const skipDeclarations = opts.skipDeclarations ?? true;
  const out: string[] = [];

  function recurse(current: string): void {
    if (opts.sourceReader !== undefined) {
      for (const entry of opts.sourceReader.listDirectory(current)) {
        const { name, kind } = entry;
        if (
          !name ||
          name === '.' ||
          name === '..' ||
          /[\\/]/u.test(name) ||
          !['file', 'directory'].includes(kind)
        )
          throw new Error('INVENTORY_SOURCE_DIRECTORY_INVALID');
        if (ignoreDirs.has(name)) continue;
        const full = join(current, name);
        if (kind === 'directory') recurse(full);
        else if (
          (!skipDeclarations || !name.endsWith('.d.ts')) &&
          extensions.some((ext) => name.endsWith('.' + ext))
        )
          out.push(full);
      }
      return;
    }
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (ignoreDirs.has(name)) continue;
      const full = join(current, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        recurse(full);
      } else if (s.isFile()) {
        if (skipDeclarations && name.endsWith('.d.ts')) continue;
        for (const ext of extensions) {
          if (name.endsWith('.' + ext)) {
            out.push(full);
            break;
          }
        }
      }
    }
  }

  recurse(dir);
  return out;
}

/**
 * Walk TS sources (default: only `.ts`, skipping `.d.ts`).
 * Use {extensions: ['ts','tsx']} for JSX-bearing sources.
 */
export function walkTs(
  dir: string,
  ignoreDirs?: ReadonlySet<string>,
  sourceReader?: InventorySourceReader,
): string[] {
  return walkFiles(dir, {
    ...(ignoreDirs !== undefined && { ignoreDirs }),
    extensions: ['ts'],
    skipDeclarations: true,
    ...(sourceReader === undefined ? {} : { sourceReader }),
  });
}

/**
 * Walk TS + TSX + JSX + JS sources. Used by the React routes adapter
 * which has to handle mixed-extension React projects.
 */
export function walkTsxJsx(
  dir: string,
  ignoreDirs?: ReadonlySet<string>,
  sourceReader?: InventorySourceReader,
): string[] {
  return walkFiles(dir, {
    ...(ignoreDirs !== undefined && { ignoreDirs }),
    extensions: ['tsx', 'ts', 'jsx', 'js'],
    skipDeclarations: true,
    ...(sourceReader === undefined ? {} : { sourceReader }),
  });
}

/**
 * Parse a TS/TSX source file via the typescript compiler. Returns
 * null on read or parse failure (callers skip such files).
 *
 * Preserve TypeScript parsing for `.ts`; React projects may carry JSX
 * in either `.jsx` or plain `.js` files, both discovered by the route walker.
 */
export function parseSource(
  file: string,
  sourceReader?: InventorySourceReader,
): ts.SourceFile | null {
  let text: string;
  try {
    text = sourceReader === undefined ? readFileSync(file, 'utf8') : sourceReader.readFile(file);
  } catch (error) {
    if (sourceReader !== undefined) throw error;
    return null;
  }
  const kind = file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : file.endsWith('.jsx') || file.endsWith('.js')
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS;
  try {
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /*setParents*/ false, kind);
  } catch (error) {
    if (sourceReader !== undefined) throw error;
    return null;
  }
}

/** True if a node has a `@<name>(...)` call-expression decorator. */
export function findDecoratorByName(
  decorators: readonly ts.Decorator[] | undefined,
  name: string,
): ts.Decorator | undefined {
  if (decorators === undefined) return undefined;
  for (const d of decorators) {
    if (decoratorName(d) === name) return d;
  }
  return undefined;
}

/** Get the name of a `@<name>(...)` or `@<name>` decorator, or null. */
export function decoratorName(d: ts.Decorator): string | null {
  const expr = d.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.expression.text;
  }
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  return null;
}

/** Read the first string-literal argument of a decorator's call expression, or null. */
export function decoratorFirstStringArg(d: ts.Decorator): string | null {
  const expr = d.expression;
  if (!ts.isCallExpression(expr) || expr.arguments.length === 0) return null;
  const arg = expr.arguments[0];
  if (arg !== undefined && ts.isStringLiteral(arg)) return arg.text;
  if (arg !== undefined && ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return null;
}

/**
 * Read all argument identifiers / string-literal values of a decorator's
 * call expression. Used for guards like @UseGuards(JwtGuard, RoleGuard).
 */
export function decoratorArgIdentifiers(d: ts.Decorator): string[] {
  const expr = d.expression;
  if (!ts.isCallExpression(expr)) return [];
  const out: string[] = [];
  for (const arg of expr.arguments) {
    if (ts.isIdentifier(arg)) out.push(arg.text);
    else if (ts.isStringLiteral(arg)) out.push(arg.text);
  }
  return out;
}
