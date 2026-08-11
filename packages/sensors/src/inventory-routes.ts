import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { validators } from '@devai-nyx/schemas';
import { buildSensorReading, type SensorReading, type SensorStatus } from './sensor-reading.js';
import { DEFAULT_IGNORE_DIRS, parseSource, walkTsxJsx } from './inventory-walker.js';

/**
 * Resolve configured scan directories to unique existing absolute paths.
 * An empty list scans `repoRoot`.
 */
function uniqueExistingDirs(raw: readonly string[], repoRoot: string): string[] {
  if (raw.length === 0) return [repoRoot];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of raw) {
    const abs = isAbsolute(d) ? d : resolve(repoRoot, d);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!existsSync(abs)) continue;
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(abs);
  }
  if (out.length === 0) {
    // All declared dirs were absent — surface as empty walk against
    // the repo root so the caller sees ROUTES_INVENTORY_EMPTY rather
    // than a spurious "directory missing" error.
    return [repoRoot];
  }
  return out;
}

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

interface RawRoute {
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
function extractAngularRoutesFromFile(
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

function makeId(framework: RoutesFramework, fileRel: string, path: string, line: number): string {
  const h = createHash('sha256')
    .update(`${fileRel}::${path}::${String(line)}`)
    .digest('hex')
    .slice(0, 12);
  return `${framework}:${h}`;
}

function extractRoutesFromFile(file: string, repoRoot: string, sf: ts.SourceFile): RawRoute[] {
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

function sortRoutes(routes: readonly RoutesInventoryRoute[]): RoutesInventoryRoute[] {
  return [...routes].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function senseInventoryRoutes(opts: InventoryRoutesOptions): InventoryRoutesResult {
  const t0 = Date.now();
  const ignoreDirs = opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const scanDirs = uniqueExistingDirs(opts.scanDirs ?? [], opts.repoRoot);
  const generatedAt = opts.now ?? new Date().toISOString();
  const framework: RoutesFramework = opts.framework ?? 'react';

  const findings: Array<{
    readonly severity: 'info' | 'warning' | 'error' | 'critical';
    readonly code: string;
    readonly message: string;
  }> = [];

  let routes: RoutesInventoryRoute[] = [];
  let status: SensorStatus = 'pass';

  try {
    const collected: RawRoute[] = [];
    for (const scanDir of scanDirs) {
      const files = walkTsxJsx(scanDir, ignoreDirs);
      for (const file of files) {
        const sf = parseSource(file);
        if (sf === null) continue;
        const extracted =
          framework === 'angular'
            ? extractAngularRoutesFromFile(file, opts.repoRoot, sf)
            : extractRoutesFromFile(file, opts.repoRoot, sf);
        collected.push(...extracted);
      }
    }
    routes = collected.map((r) => {
      const id = makeId(framework, r.evidence.path, r.path, r.evidence.startLine);
      const route: RoutesInventoryRoute = {
        id,
        path: r.path,
        ...(r.parentId !== undefined && { parentId: r.parentId }),
        ...(r.element !== null && {
          component: { file: r.evidence.path, name: r.element },
        }),
        evidence: [r.evidence],
      };
      return route;
    });
    // Phase 20.E: dedupe by id when multiple scan dirs overlap.
    const byId = new Map<string, RoutesInventoryRoute>();
    for (const r of routes) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }
    routes = sortRoutes(Array.from(byId.values()));
  } catch (err) {
    status = 'error';
    findings.push({
      severity: 'critical',
      code: 'ROUTES_INVENTORY_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (status === 'pass' && routes.length === 0) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'ROUTES_INVENTORY_EMPTY',
      message:
        framework === 'angular'
          ? 'No Angular routes (Routes arrays, provideRouter([...]) or RouterModule.forRoot/forChild) discovered under scan path.'
          : 'No React routes (<Route .../> or createBrowserRouter([...])) discovered under scan path.',
    });
  }

  const body: RoutesInventoryBody = {
    schemaVersion: '1.0.0',
    generatedAt,
    framework,
    routes,
  };

  if (status === 'pass') {
    const ok = validators.routesInventory(body);
    if (!ok) {
      status = 'error';
      findings.push({
        severity: 'critical',
        code: 'ROUTES_INVENTORY_SCHEMA_INVALID',
        message: `body fails routes-inventory.schema.json: ${JSON.stringify(validators.routesInventory.errors)}`,
      });
    }
  }

  let bodyPath: string | null = null;
  if ((status === 'pass' || status === 'review') && opts.persistBody !== false) {
    bodyPath =
      opts.bodyPath ??
      join(opts.repoRoot, `record/proofs/sensors/inventory_routes/routes-${framework}.json`);
    try {
      mkdirSync(dirname(bodyPath), { recursive: true });
      writeFileSync(bodyPath, JSON.stringify(body, null, 2) + '\n');
    } catch (err) {
      status = 'error';
      bodyPath = null;
      findings.push({
        severity: 'critical',
        code: 'ROUTES_INVENTORY_WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const routesHash = createHash('sha256')
    .update(JSON.stringify(routes.map((r) => [r.path, r.id, r.component?.name ?? ''])))
    .digest('hex');

  const reading = buildSensorReading({
    sensorName: 'inventory:routes',
    sensorKind: 'inventory_routes',
    sensorVersion: '1.0.0',
    command: ['devai', 'sense', 'routes', '--repo-root', opts.repoRoot],
    status,
    deterministic: true,
    tier: 'L0',
    duration_ms: Date.now() - t0,
    timestamp: generatedAt,
    ...(findings.length > 0 && { findings }),
    metrics: {
      route_count: routes.length,
      route_file_count: new Set(routes.flatMap((r) => r.evidence.map((e) => e.path))).size,
      routes_hash: routesHash,
    },
    ...(bodyPath !== null && { evidence_path: bodyPath }),
  });

  return { reading, body, bodyPath };
}
