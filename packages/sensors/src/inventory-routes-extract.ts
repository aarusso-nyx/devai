import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import ts from 'typescript';
import type { DeclaredSurfaces } from './declared-surfaces.js';
import type { SensorReading } from './sensor-reading.js';

/**
 * Inventory sensor: frontend routes (REDOX-Routes, Phase 17.C2; extended
 * in Phase 20.D for Angular).
 *
 * React adapter (Phase 17.C2). Walks .tsx/.jsx/.ts/.js sources and
 * extracts react-router-style routes from two forms:
 *
 *   1. JSX `<Route path="..." element={<X />} />` (react-router-dom v6+).
 *   2. Object-literal arrays passed to `createBrowserRouter([...])` /
 *      `createRoutesFromElements([...])`. Children arrays are walked
 *      recursively so nested routes inherit a parentId.
 *
 * Angular adapter (Phase 20.D, closes D-A-2). Walks .ts sources for:
 *
 *   1. `Routes` typed arrays exported from `app.routes.ts`-style files.
 *   2. `provideRouter([...])` calls.
 *   3. `RouterModule.forRoot([...])` / `RouterModule.forChild([...])`.
 *   4. Standalone-component `loadComponent: () => import('...').then(m => m.X)`
 *      and `component: X` shorthand. Both `path` and lazy `children`
 *      arrays are walked.
 *
 * Output conforms to `routes-inventory.schema.json` (Phase 17.B). The
 * `framework` field is configurable via the `framework` option (which
 * is itself pack-tuneable via `extractor_params.inventory_routes.framework`).
 * Body file path defaults to `routes-{framework}.json` so an adopter
 * whose stack changes doesn't accidentally compare yesterday's React
 * body to today's Angular body.
 *
 * Per Constitution Article 17 (sensor adapter uniformity); per D-57
 * (brownfield) + D-63 (Phase 20.D framework selector).
 */

export interface RoutesInventoryEvidence {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface RoutesInventoryComponentRef {
  readonly name?: string;
  readonly file: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface RoutesInventoryRoute {
  readonly id: string;
  readonly path: string;
  readonly parentId?: string;
  readonly children?: readonly string[];
  readonly component?: RoutesInventoryComponentRef;
  readonly evidence: readonly RoutesInventoryEvidence[];
}

export type RoutesFramework = 'react' | 'angular';

export interface RoutesInventoryBody {
  readonly schemaVersion: '1.0.0';
  readonly generatedAt: string;
  readonly framework: RoutesFramework;
  readonly routes: readonly RoutesInventoryRoute[];
}

export interface InventoryRoutesOptions {
  readonly repoRoot: string;
  /**
   * Declared plant surfaces (ADR-SCR-0003). Omitted: every surface is presumed present.
   */
  readonly surfaces?: DeclaredSurfaces;
  /**
   * Source directories to walk and merge. Absent directories are skipped;
   * an absent list scans `repoRoot`.
   */
  readonly scanDirs?: readonly string[];
  readonly ignoreDirs?: ReadonlySet<string>;
  readonly bodyPath?: string;
  /** False for pure observation callers that must not materialize canonical state. */
  readonly persistBody?: boolean;
  readonly now?: string;
  /**
   * Frontend framework. The current default is `react`; packs can select it
   * through `extractor_params.inventory_routes.framework`.
   */
  readonly framework?: RoutesFramework;
}

export interface InventoryRoutesResult {
  readonly reading: SensorReading;
  readonly body: RoutesInventoryBody;
  readonly bodyPath: string | null;
}

function lineFor(sf: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return { startLine: start.line + 1, endLine: end.line + 1 };
}

function jsxStringAttr(attrs: ts.JsxAttributes, name: string): string | null {
  for (const attr of attrs.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    if (!ts.isIdentifier(attr.name)) continue;
    if (attr.name.text !== name) continue;
    const init = attr.initializer;
    if (init === undefined) return '';
    if (ts.isStringLiteral(init)) return init.text;
    if (
      ts.isJsxExpression(init) &&
      init.expression !== undefined &&
      ts.isStringLiteral(init.expression)
    ) {
      return init.expression.text;
    }
  }
  return null;
}

function jsxElementNameAttr(attrs: ts.JsxAttributes): string | null {
  for (const attr of attrs.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    if (!ts.isIdentifier(attr.name)) continue;
    if (attr.name.text !== 'element') continue;
    const init = attr.initializer;
    if (init === undefined) return null;
    if (ts.isJsxExpression(init) && init.expression !== undefined) {
      return jsxComponentIdentifier(init.expression);
    }
  }
  return null;
}

function jsxComponentIdentifier(expr: ts.Expression): string | null {
  if (ts.isJsxSelfClosingElement(expr)) {
    return jsxTagName(expr.tagName);
  }
  if (ts.isJsxElement(expr)) {
    return jsxTagName(expr.openingElement.tagName);
  }
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text;
  return null;
}

function jsxTagName(node: ts.JsxTagNameExpression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  return null;
}

export interface RawRoute {
  readonly path: string;
  readonly element: string | null;
  readonly parentId: string | undefined;
  readonly evidence: RoutesInventoryEvidence;
}

function readObjectRoute(
  objExpr: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  fileRel: string,
  parentId: string | undefined,
  out: RawRoute[],
): void {
  let pathVal: string | null = null;
  let elementName: string | null = null;
  let childrenArr: ts.ArrayLiteralExpression | null = null;
  for (const prop of objExpr.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const keyName = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : '';
    if (keyName === 'path') {
      if (
        ts.isStringLiteral(prop.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(prop.initializer)
      ) {
        pathVal = prop.initializer.text;
      }
    } else if (keyName === 'element') {
      elementName = jsxComponentIdentifier(prop.initializer);
    } else if (keyName === 'children' && ts.isArrayLiteralExpression(prop.initializer)) {
      childrenArr = prop.initializer;
    }
  }
  if (pathVal === null) return;
  const lines = lineFor(sf, objExpr);
  const route: RawRoute = {
    path: pathVal,
    element: elementName,
    parentId,
    evidence: { path: fileRel, startLine: lines.startLine, endLine: lines.endLine },
  };
  out.push(route);
  const thisId = makeId('react', fileRel, pathVal, lines.startLine);
  if (childrenArr !== null) {
    for (const child of childrenArr.elements) {
      if (ts.isObjectLiteralExpression(child)) {
        readObjectRoute(child, sf, fileRel, thisId, out);
      }
    }
  }
}

// =====================================================================
// Angular adapter (Phase 20.D, closes D-A-2).
// =====================================================================

/**
 * Walk an Angular sources tree and extract routes from the four
 * canonical surfaces. Children arrays are recursed; lazy
 * `loadComponent` arrow expressions are parsed for the module path
 * + symbol name so the route record carries a meaningful
 * `component.name` even when the actual class lives in a separate
 * lazily-loaded file.
 */
export function extractAngularRoutesFromFile(
  file: string,
  repoRoot: string,
  sf: ts.SourceFile,
): RawRoute[] {
  const out: RawRoute[] = [];
  const fileRel = relative(repoRoot, file);

  function readAngularRoute(
    objExpr: ts.ObjectLiteralExpression,
    parentId: string | undefined,
  ): void {
    let pathVal: string | null = null;
    let componentName: string | null = null;
    let childrenArr: ts.ArrayLiteralExpression | null = null;
    let hasLoadChildren = false;
    for (const prop of objExpr.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const keyName = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : '';
      if (keyName === 'path') {
        if (
          ts.isStringLiteral(prop.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(prop.initializer)
        ) {
          pathVal = prop.initializer.text;
        }
      } else if (keyName === 'component') {
        if (ts.isIdentifier(prop.initializer)) {
          componentName = prop.initializer.text;
        }
      } else if (keyName === 'loadComponent') {
        // `loadComponent: () => import('./x.component').then(m => m.X)`
        componentName = extractLoadComponentName(prop.initializer) ?? componentName;
      } else if (keyName === 'loadChildren') {
        hasLoadChildren = true;
      } else if (keyName === 'children' && ts.isArrayLiteralExpression(prop.initializer)) {
        childrenArr = prop.initializer;
      } else if (keyName === 'redirectTo') {
        // Redirect entries are still routes; surface the path even
        // without a component.
      }
    }
    if (pathVal === null) return;
    const lines = lineFor(sf, objExpr);
    const thisRoute: RawRoute = {
      path: pathVal,
      element: componentName,
      parentId,
      evidence: { path: fileRel, startLine: lines.startLine, endLine: lines.endLine },
    };
    out.push(thisRoute);
    const thisId = makeId('angular', fileRel, pathVal, lines.startLine);
    if (childrenArr !== null) {
      for (const child of childrenArr.elements) {
        if (ts.isObjectLiteralExpression(child)) {
          readAngularRoute(child, thisId);
        }
      }
    }
    // hasLoadChildren paths point at lazy modules — the child routes
    // live in another file and are picked up when that file is
    // walked separately. No-op here; we keep `hasLoadChildren` named
    // to document the intent.
    void hasLoadChildren;
  }

  function walkRoutesArray(arr: ts.ArrayLiteralExpression): void {
    for (const el of arr.elements) {
      if (ts.isObjectLiteralExpression(el)) {
        readAngularRoute(el, undefined);
      }
    }
  }

  function visit(node: ts.Node): void {
    // Form 1: `export const routes: Routes = [...]` or `const r: Routes = [...]`.
    if (ts.isVariableDeclaration(node)) {
      const typeRef = node.type;
      const isRoutesType =
        typeRef !== undefined &&
        ts.isTypeReferenceNode(typeRef) &&
        ts.isIdentifier(typeRef.typeName) &&
        typeRef.typeName.text === 'Routes';
      if (
        isRoutesType &&
        node.initializer !== undefined &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        walkRoutesArray(node.initializer);
      }
    }
    // Forms 2-3: `provideRouter([...])`, `RouterModule.forRoot([...])`,
    // `RouterModule.forChild([...])`.
    if (ts.isCallExpression(node)) {
      let callee = '';
      if (ts.isIdentifier(node.expression)) {
        callee = node.expression.text;
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'RouterModule'
      ) {
        callee = `RouterModule.${node.expression.name.text}`;
      }
      if (
        callee === 'provideRouter' ||
        callee === 'RouterModule.forRoot' ||
        callee === 'RouterModule.forChild'
      ) {
        for (const arg of node.arguments) {
          if (ts.isArrayLiteralExpression(arg)) walkRoutesArray(arg);
          else if (ts.isIdentifier(arg)) {
            // provideRouter(routes) — defer to the var declaration
            // walker; nothing to extract here.
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

/**
 * Extract a component identifier from a `loadComponent` arrow:
 *   `() => import('./foo.component').then(m => m.FooComponent)`
 * Returns `FooComponent` or `null` when the pattern doesn't match.
 */
function extractLoadComponentName(expr: ts.Expression): string | null {
  if (!ts.isArrowFunction(expr)) return null;
  const body = expr.body;
  if (!ts.isCallExpression(body)) return null;
  // Walking `import('...').then(m => m.X)`: the outermost call is `.then(...)`.
  if (!ts.isPropertyAccessExpression(body.expression)) return null;
  if (body.expression.name.text !== 'then') return null;
  const thenArg = body.arguments[0];
  if (thenArg === undefined || !ts.isArrowFunction(thenArg)) return null;
  const thenBody = thenArg.body;
  if (ts.isPropertyAccessExpression(thenBody)) {
    return thenBody.name.text;
  }
  return null;
}

export function makeId(
  framework: RoutesFramework,
  fileRel: string,
  path: string,
  line: number,
): string {
  const h = createHash('sha256')
    .update(`${fileRel}::${path}::${String(line)}`)
    .digest('hex')
    .slice(0, 12);
  return `${framework}:${h}`;
}

export function extractRoutesFromFile(
  file: string,
  repoRoot: string,
  sf: ts.SourceFile,
): RawRoute[] {
  const out: RawRoute[] = [];
  const fileRel = relative(repoRoot, file);

  function visit(node: ts.Node): void {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = jsxTagName(node.tagName);
      if (tag === 'Route') {
        const path = jsxStringAttr(node.attributes, 'path');
        if (path !== null) {
          const elementName = jsxElementNameAttr(node.attributes);
          const lines = lineFor(sf, node);
          out.push({
            path,
            element: elementName,
            parentId: undefined,
            evidence: { path: fileRel, startLine: lines.startLine, endLine: lines.endLine },
          });
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : '';
      if (
        callee === 'createBrowserRouter' ||
        callee === 'createRoutesFromElements' ||
        callee === 'useRoutes'
      ) {
        for (const arg of node.arguments) {
          if (ts.isArrayLiteralExpression(arg)) {
            for (const el of arg.elements) {
              if (ts.isObjectLiteralExpression(el)) {
                readObjectRoute(el, sf, fileRel, undefined, out);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}
