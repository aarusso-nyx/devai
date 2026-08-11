import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { validators } from '@devai-nyx/schemas';
import { buildSensorReading, type SensorReading, type SensorStatus } from './sensor-reading.js';
import {
  DEFAULT_IGNORE_DIRS,
  decoratorArgIdentifiers,
  decoratorFirstStringArg,
  decoratorName,
  findDecoratorByName,
  parseSource,
  walkTs,
} from './inventory-walker.js';

/**
 * Inventory sensor: backend HTTP API (REDOX-ApiMap, Phase 17.C2).
 *
 * NestJS adapter (the only framework in 17.C2). Walks .ts sources,
 * finds classes decorated with `@Controller(<basePath>)`, and for
 * each method extracts:
 *   - HTTP-verb decorator (@Get/@Post/@Put/@Patch/@Delete/@Head/@Options)
 *     + optional path argument → full endpoint path
 *   - @UseGuards(...) → auth.guards[]
 *   - @Roles(...) (and similar) → auth.roles[]
 *   - method parameters with @Param/@Query/@Body/@Headers → params[]
 *
 * Output conforms to api-map.schema.json (Phase 17.B). Future
 * 17.C2.<n> sub-batches or stack-adapter packs (17.G) may add
 * Express, Laravel, Spring, etc. adapters.
 *
 * Per Constitution Article 17 (sensor adapter uniformity); per D-57.
 */

const HTTP_DECORATORS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
};

type ParamLoc = 'path' | 'query' | 'header' | 'cookie';

const PARAM_DECORATORS: Record<string, ParamLoc> = {
  Param: 'path',
  Query: 'query',
  Headers: 'header',
  Header: 'header',
};

export interface InventoryApiOptions {
  readonly repoRoot: string;
  /**
   * Source directories to walk and merge. Non-existent directories are
   * skipped; an absent list scans `repoRoot`.
   */
  readonly scanDirs?: readonly string[];
  readonly ignoreDirs?: ReadonlySet<string>;
  readonly bodyPath?: string;
  /** False for pure observation callers that must not materialize canonical state. */
  readonly persistBody?: boolean;
  readonly stack?: { backend: string; frontend: string; db: string };
  readonly now?: string;
  /**
   * Phase 22.B (closes D-A-12): pack-configurable list of decorator
   * names that mark an endpoint as deliberately public (no auth
   * required). When any decorator in this list is present on the
   * controller method OR on the enclosing controller class, the
   * endpoint's `auth.required` is set to `false` and `inv-suggest`
   * treats the endpoint as claimed (not an `unbound_endpoint`
   * candidate). Default: empty list (back-compat — no decorator is
   * recognized as a public-marker; same as pre-22.B behaviour).
   *
   * Plumbed from `extractor_params.inventory_api.public_marker_decorators`
   * on the matched stack-adapter pack.
   */
  readonly publicMarkerDecorators?: readonly string[];
}

/** Resolve configured scan directories to unique existing absolute paths. */
function uniqueExistingApiDirs(raw: readonly string[], repoRoot: string): string[] {
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
  if (out.length === 0) return [repoRoot];
  return out;
}

export interface ApiMapEvidence {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ApiMapParam {
  readonly name: string;
  readonly in: ParamLoc;
}

export interface ApiMapAuth {
  readonly required?: boolean;
  readonly guards?: readonly string[];
  readonly roles?: readonly string[];
}

export interface ApiMapEndpoint {
  readonly method: string;
  readonly path: string;
  readonly controller: {
    file: string;
    class?: string;
    methodName?: string;
    startLine?: number;
    endLine?: number;
  };
  readonly params?: readonly ApiMapParam[];
  readonly auth?: ApiMapAuth;
  readonly evidence: readonly ApiMapEvidence[];
}

export interface ApiMapBody {
  readonly schemaVersion: '1.0.0';
  readonly generatedAt: string;
  readonly sourceRepo?: string;
  readonly stack?: { backend: string; frontend: string; db: string };
  readonly endpoints: readonly ApiMapEndpoint[];
}

export interface InventoryApiResult {
  readonly reading: SensorReading;
  readonly body: ApiMapBody;
  readonly bodyPath: string | null;
}

function joinPath(base: string, sub: string): string {
  const cleanBase = base.startsWith('/') ? base : '/' + base;
  if (sub === '' || sub === '/') return cleanBase === '' ? '/' : cleanBase;
  const cleanSub = sub.startsWith('/') ? sub : '/' + sub;
  const merged = (cleanBase === '/' ? '' : cleanBase) + cleanSub;
  return merged === '' ? '/' : merged;
}

function getNodeLines(sf: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return { startLine: start.line + 1, endLine: end.line + 1 };
}

function extractParams(method: ts.MethodDeclaration): ApiMapParam[] {
  const out: ApiMapParam[] = [];
  for (const param of method.parameters) {
    const decorators = ts.canHaveDecorators(param) ? (ts.getDecorators(param) ?? []) : [];
    for (const d of decorators) {
      const name = decoratorName(d);
      if (name === null) continue;
      if (name === 'Body') {
        const argName =
          decoratorFirstStringArg(d) ?? (ts.isIdentifier(param.name) ? param.name.text : 'body');
        out.push({ name: argName, in: 'cookie' });
        // 'Body' isn't a Param location per redox's vocabulary; the
        // api-map schema allows 'path|query|header|cookie' only.
        // Body parameters surface in `request.payload`, not params[].
        out.pop();
        continue;
      }
      const loc = PARAM_DECORATORS[name];
      if (loc === undefined) continue;
      const argName =
        decoratorFirstStringArg(d) ?? (ts.isIdentifier(param.name) ? param.name.text : 'param');
      out.push({ name: argName, in: loc });
    }
  }
  return out;
}

function extractEndpointsFromFile(
  file: string,
  repoRoot: string,
  sf: ts.SourceFile,
  publicMarkerDecorators: ReadonlySet<string>,
): ApiMapEndpoint[] {
  const out: ApiMapEndpoint[] = [];
  const fileRel = relative(repoRoot, file);

  ts.forEachChild(sf, (node) => {
    if (!ts.isClassDeclaration(node)) return;
    const classDecorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
    // Phase 22.B (D-A-12): class-level public-marker decorator
    // (e.g. `@Public()` on the controller class) cascades into
    // every endpoint method.
    const classIsPublic =
      publicMarkerDecorators.size > 0 &&
      classDecorators.some((d) => {
        const name = decoratorName(d);
        return name !== null && publicMarkerDecorators.has(name);
      });
    const controllerDec = findDecoratorByName(classDecorators, 'Controller');
    if (controllerDec === undefined) return;
    const className = node.name?.text;
    const basePath = decoratorFirstStringArg(controllerDec) ?? '';

    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const memberDecorators = ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : [];
      let httpMethod: string | null = null;
      let subPath = '';
      for (const dec of memberDecorators) {
        const dName = decoratorName(dec);
        if (dName === null) continue;
        const mapped = HTTP_DECORATORS[dName];
        if (mapped !== undefined) {
          httpMethod = mapped;
          subPath = decoratorFirstStringArg(dec) ?? '';
          break;
        }
      }
      if (httpMethod === null) continue;

      const guards: string[] = [];
      const useGuardsDec = findDecoratorByName(memberDecorators, 'UseGuards');
      if (useGuardsDec !== undefined) guards.push(...decoratorArgIdentifiers(useGuardsDec));
      const classUseGuardsDec = findDecoratorByName(classDecorators, 'UseGuards');
      if (classUseGuardsDec !== undefined) {
        for (const g of decoratorArgIdentifiers(classUseGuardsDec)) {
          if (!guards.includes(g)) guards.push(g);
        }
      }

      const roles: string[] = [];
      const rolesDec = findDecoratorByName(memberDecorators, 'Roles');
      if (rolesDec !== undefined) roles.push(...decoratorArgIdentifiers(rolesDec));

      // Phase 22.B (D-A-12): method-level public-marker decorator
      // wins over class-level guards. The `Public()` (or pack-
      // configured equivalent) marker means the endpoint is
      // deliberately public; sense-api records auth.required=false
      // so `inv-suggest` treats it as claimed, not unbound.
      const memberIsPublic =
        publicMarkerDecorators.size > 0 &&
        memberDecorators.some((d) => {
          const name = decoratorName(d);
          return name !== null && publicMarkerDecorators.has(name);
        });
      const isPublic = memberIsPublic || classIsPublic;

      const lines = getNodeLines(sf, member);
      const params = extractParams(member);

      const auth: ApiMapAuth = {};
      if (guards.length > 0) (auth as { guards: string[] }).guards = guards;
      if (roles.length > 0) (auth as { roles: string[] }).roles = roles;
      if (isPublic) {
        (auth as { required: boolean }).required = false;
      } else if (guards.length > 0 || roles.length > 0) {
        (auth as { required: boolean }).required = true;
      }

      const endpoint: ApiMapEndpoint = {
        method: httpMethod,
        path: joinPath(basePath, subPath),
        controller: {
          file: fileRel,
          ...(className !== undefined && { class: className }),
          ...(member.name !== undefined &&
            ts.isIdentifier(member.name) && { methodName: member.name.text }),
          startLine: lines.startLine,
          endLine: lines.endLine,
        },
        ...(params.length > 0 && { params }),
        ...(Object.keys(auth).length > 0 && { auth }),
        evidence: [{ path: fileRel, startLine: lines.startLine, endLine: lines.endLine }],
      };
      out.push(endpoint);
    }
  });

  return out;
}

function sortEndpoints(endpoints: readonly ApiMapEndpoint[]): ApiMapEndpoint[] {
  return [...endpoints].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.method !== b.method) return a.method < b.method ? -1 : 1;
    const af = a.controller.file;
    const bf = b.controller.file;
    return af < bf ? -1 : af > bf ? 1 : 0;
  });
}

export function senseInventoryApi(opts: InventoryApiOptions): InventoryApiResult {
  const t0 = Date.now();
  const ignoreDirs = opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const scanDirs = uniqueExistingApiDirs(opts.scanDirs ?? [], opts.repoRoot);
  const generatedAt = opts.now ?? new Date().toISOString();

  const findings: Array<{
    readonly severity: 'info' | 'warning' | 'error' | 'critical';
    readonly code: string;
    readonly message: string;
  }> = [];

  let endpoints: ApiMapEndpoint[] = [];
  let status: SensorStatus = 'pass';

  // Phase 22.B (D-A-12): pack-configurable list of decorator names
  // that mark an endpoint as deliberately public.
  const publicMarkerDecorators = new Set<string>(opts.publicMarkerDecorators ?? []);

  try {
    for (const scanDir of scanDirs) {
      const files = walkTs(scanDir, ignoreDirs);
      const controllerFiles = files.filter((f) => f.endsWith('.controller.ts'));
      for (const file of controllerFiles) {
        const sf = parseSource(file);
        if (sf === null) continue;
        endpoints.push(
          ...extractEndpointsFromFile(file, opts.repoRoot, sf, publicMarkerDecorators),
        );
      }
    }
    // Phase 20.E: dedupe by (method, path, controller.file) when
    // multiple scan dirs overlap. The controller file path is the
    // tiebreaker so two distinct apps under different reference-*
    // roots both surface even if they expose the same route.
    const seen = new Set<string>();
    const deduped: ApiMapEndpoint[] = [];
    for (const e of endpoints) {
      const key = `${e.method}|${e.path}|${e.controller.file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(e);
    }
    endpoints = sortEndpoints(deduped);
  } catch (err) {
    status = 'error';
    findings.push({
      severity: 'critical',
      code: 'API_INVENTORY_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (status === 'pass' && endpoints.length === 0) {
    // Empty inventory is still schema-valid IF api-map.schema.json
    // accepts it, BUT it requires endpoints.minItems: 1. Treat zero
    // endpoints as `review`: the sensor ran cleanly but found nothing
    // to inventory. Useful signal: a NestJS-flagged repo with zero
    // controllers is probably a detection mismatch.
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'API_INVENTORY_EMPTY',
      message: 'No @Controller-decorated classes found under scan path.',
    });
  }

  const body: ApiMapBody = {
    schemaVersion: '1.0.0',
    generatedAt,
    ...(opts.repoRoot !== undefined && { sourceRepo: opts.repoRoot }),
    ...(opts.stack !== undefined && { stack: opts.stack }),
    endpoints,
  };

  // Schema-validate. Empty endpoints fails minItems: 1; we surface
  // status=review (already set above) but still emit the body so a
  // human can inspect what was — or wasn't — discovered. Skip the
  // schema validation in review mode.
  if (status === 'pass') {
    const ok = validators.apiMap(body);
    if (!ok) {
      status = 'error';
      findings.push({
        severity: 'critical',
        code: 'API_MAP_SCHEMA_INVALID',
        message: `body fails api-map.schema.json: ${JSON.stringify(validators.apiMap.errors)}`,
      });
    }
  }

  let bodyPath: string | null = null;
  if ((status === 'pass' || status === 'review') && opts.persistBody !== false) {
    bodyPath =
      opts.bodyPath ?? join(opts.repoRoot, 'record/proofs/sensors/inventory_api/api-map.json');
    try {
      mkdirSync(dirname(bodyPath), { recursive: true });
      writeFileSync(bodyPath, JSON.stringify(body, null, 2) + '\n');
    } catch (err) {
      status = 'error';
      bodyPath = null;
      findings.push({
        severity: 'critical',
        code: 'API_INVENTORY_WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Content-hashed metric for drift detection downstream.
  const endpointsHash = createHash('sha256')
    .update(
      JSON.stringify(
        endpoints.map((e) => [e.method, e.path, e.controller.file, e.controller.methodName ?? '']),
      ),
    )
    .digest('hex');

  const reading = buildSensorReading({
    sensorName: 'inventory:api',
    sensorKind: 'inventory_api',
    sensorVersion: '1.0.0',
    command: ['devai', 'sense', 'api', '--repo-root', opts.repoRoot],
    status,
    deterministic: true,
    tier: 'L0',
    duration_ms: Date.now() - t0,
    timestamp: generatedAt,
    ...(findings.length > 0 && { findings }),
    metrics: {
      endpoint_count: endpoints.length,
      controller_file_count: new Set(endpoints.map((e) => e.controller.file)).size,
      endpoints_hash: endpointsHash,
    },
    ...(bodyPath !== null && { evidence_path: bodyPath }),
  });

  return { reading, body, bodyPath };
}
