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
export function walkTs(dir: string, ignoreDirs?: ReadonlySet<string>): string[] {
  return walkFiles(dir, {
    ...(ignoreDirs !== undefined && { ignoreDirs }),
    extensions: ['ts'],
    skipDeclarations: true,
  });
}

/**
 * Walk TS + TSX + JSX + JS sources. Used by the React routes adapter
 * which has to handle mixed-extension React projects.
 */
export function walkTsxJsx(dir: string, ignoreDirs?: ReadonlySet<string>): string[] {
  return walkFiles(dir, {
    ...(ignoreDirs !== undefined && { ignoreDirs }),
    extensions: ['tsx', 'ts', 'jsx', 'js'],
    skipDeclarations: true,
  });
}

/**
 * Parse a TS/TSX source file via the typescript compiler. Returns
 * null on read or parse failure (callers skip such files).
 *
 * Script kind defaults to TSX so JSX in `.tsx` and `.jsx` files
 * parses. Pure `.ts` content still parses fine under TSX.
 */
export function parseSource(file: string): ts.SourceFile | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const kind =
    file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  try {
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /*setParents*/ false, kind);
  } catch {
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
