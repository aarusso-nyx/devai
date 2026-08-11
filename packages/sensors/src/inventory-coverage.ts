import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { buildSensorReading, type SensorReading, type SensorStatus } from './sensor-reading.js';

/**
 * Inventory sensor: coverage matrix (REDOX-CoverageMatrix, Phase 17.C4).
 *
 * Meta-sensor. Consumes api-map (from sense api) + routes-inventory
 * (from sense routes) bodies and assembles a coverage-matrix body
 * conforming to coverage-matrix.schema.json (Phase 17.B):
 *
 *   - routes[]:    flat list of route IDs from routes-inventory
 *   - endpoints[]: flat list of endpoint IDs from api-map (constructed
 *                  as "METHOD path" when the api-map endpoint has no
 *                  explicit id)
 *   - useCases[]:  empty in 17.C4 (LLM-assisted use-case inference is
 *                  deferred to a documentation recipe or a later
 *                  sub-batch); seeded as []
 *   - links[]:     empty for the same reason — a Triad requires a
 *                  use-case to bind to. Path-shaped matches between
 *                  routes and endpoints are surfaced in metrics
 *                  (inferred_path_match_count) but NOT as triads.
 *   - unmapped:    every route and every endpoint, since links[] is
 *                  empty. This is the honest signal: the brownfield
 *                  adoption has surface inventoried but no use-case
 *                  ↔ surface mapping yet.
 *
 * INV-INVENTORY-001 (Phase 17.D, "every route/endpoint covered by ≥1
 * use-case", severity gate) hard-fails on a non-empty unmapped set.
 * The Architect closes that gap by authoring use-cases (manual or via
 * 17.F SKILL writers) and re-running this sensor.
 *
 * Per Constitution Article 17 (sensor adapter uniformity); per D-57.
 */

interface ApiMapEndpointShape {
  readonly id?: string;
  readonly method: string;
  readonly path: string;
}

interface RoutesInventoryShape {
  readonly framework: string;
  readonly routes: ReadonlyArray<{ readonly id: string; readonly path: string }>;
}

interface ApiMapShape {
  readonly endpoints: readonly ApiMapEndpointShape[];
}

export interface InventoryCoverageOptions {
  readonly repoRoot: string;
  readonly apiMapPath?: string;
  readonly routesPath?: string;
  readonly bodyPath?: string;
  /** False for pure observation callers that must not materialize canonical state. */
  readonly persistBody?: boolean;
  readonly now?: string;
  /**
   * Framework selector for the routes body. When `routesPath` is absent,
   * the sensor resolves `routes-${framework}.json` exactly.
   */
  readonly framework?: string;
  /**
   * Directory under repoRoot to walk
   * for use-case files (default `product/use-cases`). Each
   * `*.json` file under this directory is parsed as a UseCases
   * record (per `use-cases.schema.json`) and its steps' `refs`
   * are projected into the coverage matrix's `links[]` triads
   * (one triad per route × endpoint combination per step).
   *
   * Adopters without authored use-cases: no behaviour change.
   * The walker silently skips a missing directory and the
   * matrix `links[]` stays empty (REVIEW status, current pre-22.H
   * semantics preserved).
   */
  readonly useCasesDir?: string;
}

interface UseCasesStep {
  readonly action: string;
  readonly refs?: {
    readonly routeIds?: readonly string[];
    readonly endpointIds?: readonly string[];
  };
}

interface UseCasesCase {
  readonly id?: string;
  readonly title?: string;
  readonly mainFlow?: readonly UseCasesStep[];
  readonly alternateFlows?: ReadonlyArray<{
    readonly steps?: readonly UseCasesStep[];
  }>;
}

interface UseCasesShape {
  readonly cases?: readonly UseCasesCase[];
}

export interface InventoryCoverageResult {
  readonly reading: SensorReading;
  readonly body: unknown;
  readonly bodyPath: string | null;
}

function endpointId(e: ApiMapEndpointShape): string {
  return e.id ?? `${e.method} ${e.path}`;
}

/**
 * Path-pattern match: convert `/foo/:id` and `/foo/{id}` into a
 * regex matching `/foo/<any>`. Used to detect when a frontend
 * route is talking to a specific backend endpoint, even without
 * use-case-level traceability.
 */
function pathPattern(p: string): RegExp {
  const escaped = p
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_][\w]*)/g, '[^/]+')
    .replace(/\\\{([A-Za-z_][\w]*)\\\}/g, '[^/]+');
  return new RegExp('^' + escaped + '$');
}

/**
 * Walk a use-cases directory and
 * return the parsed records. Files that fail JSON parsing or
 * use-cases-schema validation are skipped with a finding (not
 * a hard fail — an adopter's authoring may be in progress).
 *
 * Returns the loaded cases plus per-file diagnostics for the
 * caller to surface in the SensorReading's findings.
 */
interface LoadedUseCases {
  readonly cases: readonly UseCasesCase[];
  readonly fileCount: number;
  readonly findings: ReadonlyArray<{
    readonly severity: 'info' | 'warning' | 'error';
    readonly code: string;
    readonly message: string;
  }>;
}

function loadUseCasesFromDir(absDir: string): LoadedUseCases {
  const findings: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }> =
    [];
  const cases: UseCasesCase[] = [];
  let fileCount = 0;
  if (!existsSync(absDir)) {
    return { cases, fileCount: 0, findings };
  }
  try {
    if (!statSync(absDir).isDirectory()) {
      return { cases, fileCount: 0, findings };
    }
  } catch {
    return { cases, fileCount: 0, findings };
  }
  let entries: readonly string[];
  try {
    entries = readdirSync(absDir)
      .filter((n) => n.endsWith('.json'))
      .sort();
  } catch (err) {
    findings.push({
      severity: 'error',
      code: 'COVERAGE_USE_CASES_DIR_UNREADABLE',
      message: `could not read use-cases dir ${absDir}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { cases, fileCount: 0, findings };
  }
  for (const filename of entries) {
    const filePath = join(absDir, filename);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      findings.push({
        severity: 'warning',
        code: 'COVERAGE_USE_CASES_PARSE_FAILED',
        message: `failed to parse ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (!validators.useCases(parsed)) {
      findings.push({
        severity: 'warning',
        code: 'COVERAGE_USE_CASES_SCHEMA_INVALID',
        message: `${filename} fails use-cases.schema.json: ${JSON.stringify(validators.useCases.errors)}`,
      });
      continue;
    }
    fileCount += 1;
    const body = parsed as UseCasesShape;
    for (const c of body.cases ?? []) {
      cases.push(c);
    }
  }
  return { cases, fileCount, findings };
}

type SynthesizedLink = {
  routeId: string | null;
  endpointId: string | null;
  useCaseId: string;
  linkKind: 'paired' | 'route-only' | 'endpoint-only';
  inferred?: boolean;
};

/**
 * From a
 * list of UseCases, synthesize `coverage-matrix.links[]` triads.
 * Walks every step in `mainFlow` + `alternateFlows.steps`. Three
 * cardinalities are emitted, each tagged with `linkKind`:
 *
 *   - `paired`        — step has both `refs.routeIds` and
 *                       `refs.endpointIds`; emit one triad per
 *                       (route, endpoint) cross-product.
 *   - `route-only`    — step has only `refs.routeIds` (e.g. UI
 *                       navigation step with no API call); emit one
 *                       triad per route with `endpointId: null`.
 *   - `endpoint-only` — step has only `refs.endpointIds` (e.g.
 *                       background job, system-to-system call); emit
 *                       one triad per endpoint with `routeId: null`.
 *
 * Pre-23.C, this synthesizer required BOTH axes on a step and
 * silently dropped single-axis refs. Stynx's `INV-COVERAGE-001`
 * surfaced as a historically recorded set of unmapped routes and
 * endpoints. Many of those step refs only declared endpoints and were
 * silently ignored. Post-23.C, single-axis steps produce links and
 * the violation count drops proportionally. The measured historical
 * prior counts are not part of the runtime result.
 *
 * De-duplication: the same (linkKind, routeId, endpointId, useCaseId)
 * 4-tuple may appear in multiple steps; the synthesizer emits each
 * unique tuple at most once. The first occurrence wins; order across
 * the input use-case files is stable (the loader walks dir entries
 * sorted).
 *
 * Defensive: refs to unknown route/endpoint ids (typos in authored
 * use-cases) are silently dropped before emission.
 */
function synthesizeLinks(
  cases: readonly UseCasesCase[],
  validRouteIds: ReadonlySet<string>,
  validEndpointIds: ReadonlySet<string>,
): readonly SynthesizedLink[] {
  const seen = new Set<string>();
  const out: SynthesizedLink[] = [];
  for (const c of cases) {
    const useCaseId = c.id;
    if (useCaseId === undefined || useCaseId.length === 0) continue;
    const steps: UseCasesStep[] = [...(c.mainFlow ?? [])];
    for (const alt of c.alternateFlows ?? []) {
      steps.push(...(alt.steps ?? []));
    }
    for (const step of steps) {
      const rawRouteIds = step.refs?.routeIds ?? [];
      const rawEndpointIds = step.refs?.endpointIds ?? [];
      const routeIds = rawRouteIds.filter((id) => validRouteIds.has(id));
      const endpointIds = rawEndpointIds.filter((id) => validEndpointIds.has(id));
      if (routeIds.length > 0 && endpointIds.length > 0) {
        for (const routeId of routeIds) {
          for (const endpointId of endpointIds) {
            const key = `paired|${routeId}|${endpointId}|${useCaseId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ routeId, endpointId, useCaseId, linkKind: 'paired' });
          }
        }
      } else if (routeIds.length > 0) {
        for (const routeId of routeIds) {
          const key = `route-only|${routeId}||${useCaseId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ routeId, endpointId: null, useCaseId, linkKind: 'route-only' });
        }
      } else if (endpointIds.length > 0) {
        for (const endpointId of endpointIds) {
          const key = `endpoint-only||${endpointId}|${useCaseId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ routeId: null, endpointId, useCaseId, linkKind: 'endpoint-only' });
        }
      }
      // steps with neither axis set: skipped (the step is not a
      // claim against the inventoried surface).
    }
  }
  return out;
}

function countInferredMatches(
  routes: RoutesInventoryShape['routes'],
  endpoints: readonly ApiMapEndpointShape[],
): number {
  // For each route, see if any endpoint path-shape-matches. This is
  // not a traceability triad (no use-case anchor), but it surfaces a
  // structural signal: "this route probably calls this endpoint."
  let n = 0;
  const endpointPatterns = endpoints.map((e) => ({ pattern: pathPattern(e.path), endpoint: e }));
  for (const r of routes) {
    for (const ep of endpointPatterns) {
      if (ep.pattern.test(r.path)) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

type RoutesPathResolution =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'missing'; readonly directory: string }
  | {
      readonly kind: 'ambiguous';
      readonly directory: string;
      readonly candidates: readonly string[];
    };

/** Resolve exactly one current routes-inventory body without guessing a framework. */
function resolveRoutesPath(
  repoRoot: string,
  explicit: string | undefined,
  framework: string | undefined,
): RoutesPathResolution {
  if (explicit !== undefined) return { kind: 'resolved', path: explicit };
  const dir = join(repoRoot, 'record/proofs/sensors/inventory_routes');
  if (framework !== undefined) {
    return { kind: 'resolved', path: join(dir, `routes-${framework}.json`) };
  }
  if (existsSync(dir)) {
    try {
      const candidates = readdirSync(dir)
        .filter((name) => /^routes-[^.]+\.json$/.test(name))
        .sort();
      if (candidates.length === 1) {
        return { kind: 'resolved', path: join(dir, candidates[0] as string) };
      }
      if (candidates.length > 1) {
        return { kind: 'ambiguous', directory: dir, candidates };
      }
    } catch {
      return { kind: 'missing', directory: dir };
    }
  }
  return { kind: 'missing', directory: dir };
}

export function senseInventoryCoverage(opts: InventoryCoverageOptions): InventoryCoverageResult {
  const t0 = Date.now();
  const generatedAt = opts.now ?? new Date().toISOString();
  const apiMapPath =
    opts.apiMapPath ?? join(opts.repoRoot, 'record/proofs/sensors/inventory_api/api-map.json');
  const routesResolution = resolveRoutesPath(opts.repoRoot, opts.routesPath, opts.framework);

  const findings: Array<{
    readonly severity: 'info' | 'warning' | 'error' | 'critical';
    readonly code: string;
    readonly message: string;
  }> = [];

  let status: SensorStatus = 'pass';
  let apiMap: ApiMapShape | null = null;
  let routesInventory: RoutesInventoryShape | null = null;

  if (!existsSync(apiMapPath)) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'COVERAGE_REQUIRES_API_MAP',
      message: `api-map body not found at ${apiMapPath}. Run 'devai sense run inventory_api' first.`,
    });
  } else {
    try {
      apiMap = JSON.parse(readFileSync(apiMapPath, 'utf8')) as ApiMapShape;
    } catch (err) {
      status = 'error';
      findings.push({
        severity: 'critical',
        code: 'COVERAGE_API_MAP_INVALID',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (routesResolution.kind === 'ambiguous') {
    if (status === 'pass') status = 'review';
    findings.push({
      severity: 'warning',
      code: 'COVERAGE_ROUTES_AMBIGUOUS',
      message: `Multiple routes-inventory bodies found under ${routesResolution.directory}: ${routesResolution.candidates.join(', ')}. Select one with routesPath or framework after running 'devai sense run inventory_routes'.`,
    });
  } else if (routesResolution.kind === 'missing') {
    if (status === 'pass') status = 'review';
    findings.push({
      severity: 'warning',
      code: 'COVERAGE_REQUIRES_ROUTES',
      message: `No routes-inventory body found under ${routesResolution.directory}. Run 'devai sense run inventory_routes' first.`,
    });
  } else {
    const routesPath = routesResolution.path;
    if (!existsSync(routesPath)) {
      if (status === 'pass') status = 'review';
      findings.push({
        severity: 'warning',
        code: 'COVERAGE_REQUIRES_ROUTES',
        message: `routes-inventory body not found at ${routesPath}. Run 'devai sense run inventory_routes' first.`,
      });
    } else {
      try {
        routesInventory = JSON.parse(readFileSync(routesPath, 'utf8')) as RoutesInventoryShape;
      } catch (err) {
        status = 'error';
        findings.push({
          severity: 'critical',
          code: 'COVERAGE_ROUTES_INVALID',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const routeIds = (routesInventory?.routes ?? []).map((r) => r.id);
  const endpointIds = (apiMap?.endpoints ?? []).map((e) => endpointId(e));
  const inferredPathMatchCount =
    apiMap !== null && routesInventory !== null
      ? countInferredMatches(routesInventory.routes, apiMap.endpoints)
      : 0;

  // Walk `product/use-cases/`.
  // (or pack-configured dir) for authored use-cases and
  // synthesize triads into the matrix's links[].
  const useCasesDir = opts.useCasesDir ?? join(opts.repoRoot, 'product/use-cases');
  const loadedUseCases = loadUseCasesFromDir(useCasesDir);
  for (const f of loadedUseCases.findings) findings.push(f);
  const validRouteIds = new Set(routeIds);
  const validEndpointIds = new Set(endpointIds);
  const links = synthesizeLinks(loadedUseCases.cases, validRouteIds, validEndpointIds);
  const useCases = loadedUseCases.cases
    .filter((c) => c.id !== undefined && c.id.length > 0)
    .map((c) => ({
      id: c.id as string,
      ...(c.title !== undefined && { title: c.title }),
    }));

  // Compute unmapped: routes + endpoints not referenced by any
  // link. Phase 23.C: links may carry null on the absent axis
  // (route-only / endpoint-only); filter those out before checking.
  const linkedRouteIds = new Set(
    links.map((l) => l.routeId).filter((id): id is string => id !== null),
  );
  const linkedEndpointIds = new Set(
    links.map((l) => l.endpointId).filter((id): id is string => id !== null),
  );
  const unmappedRoutes = routeIds.filter((id) => !linkedRouteIds.has(id));
  const unmappedEndpoints = endpointIds.filter((id) => !linkedEndpointIds.has(id));

  const body = {
    schemaVersion: '1.0.0' as const,
    generatedAt,
    routes: routeIds,
    endpoints: endpointIds,
    useCases,
    links,
    unmapped: {
      routes: unmappedRoutes,
      endpoints: unmappedEndpoints,
    },
    stats: {
      routeCount: routeIds.length,
      endpointCount: endpointIds.length,
      useCaseCount: useCases.length,
      linkCount: links.length,
    },
  };

  if (status === 'pass') {
    const ok = validators.coverageMatrix(body);
    if (!ok) {
      status = 'error';
      findings.push({
        severity: 'critical',
        code: 'COVERAGE_SCHEMA_INVALID',
        message: `body fails coverage-matrix.schema.json: ${JSON.stringify(validators.coverageMatrix.errors)}`,
      });
    }
  }

  // Phase 22.H (D-A-18): the outcome is "pass" when use-cases are
  // authored AND every route + endpoint is linked. "review" when
  // some surfaces remain unmapped (either no use-cases at all, or
  // partial use-case coverage). The pre-22.H behaviour was to
  // always REVIEW when surfaces existed; post-22.H, fully-mapped
  // coverage PASSes.
  if (status === 'pass' && (routeIds.length > 0 || endpointIds.length > 0)) {
    if (useCases.length === 0) {
      status = 'review';
      findings.push({
        severity: 'warning',
        code: 'COVERAGE_NO_USE_CASES',
        message: `Coverage matrix assembled with ${String(routeIds.length)} routes and ${String(endpointIds.length)} endpoints, but no use-cases authored under ${useCasesDir}. Author use-cases manually or through a bounded documentation recipe to populate triads.`,
      });
    } else if (unmappedRoutes.length > 0 || unmappedEndpoints.length > 0) {
      status = 'review';
      findings.push({
        severity: 'info',
        code: 'COVERAGE_PARTIAL_USE_CASE_LINKING',
        message: `${String(useCases.length)} use-case(s) populate ${String(links.length)} link(s); ${String(unmappedRoutes.length)} route(s) and ${String(unmappedEndpoints.length)} endpoint(s) remain unmapped. Extend use-case refs.routeIds + refs.endpointIds to close.`,
      });
    }
  }

  let bodyPath: string | null = null;
  if ((status === 'pass' || status === 'review') && opts.persistBody !== false) {
    bodyPath =
      opts.bodyPath ??
      join(opts.repoRoot, 'record/proofs/sensors/inventory_coverage/coverage-matrix.json');
    try {
      mkdirSync(dirname(bodyPath), { recursive: true });
      writeFileSync(bodyPath, JSON.stringify(body, null, 2) + '\n');
    } catch (err) {
      status = 'error';
      bodyPath = null;
      findings.push({
        severity: 'critical',
        code: 'COVERAGE_WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase 33.B (closes D-A-35): hash the full matrix surface, not
  // just routes + endpoints. Pre-33.B, the SR `coverage_hash` only
  // witnessed sorted routes + endpoints — two runs with identical
  // surface inventories but different authored use-cases produced
  // the same hash, hiding link / unmapped drift from downstream
  // readers. Post-33.B, hash inputs include use-case ids, links,
  // and unmapped ids alongside the surface arrays. Each axis is
  // deep-copied before sort (the sort would otherwise mutate the
  // body's arrays in place, since `body` reuses these refs).
  const sortedLinks = [...links]
    .map((l) => ({
      linkKind: l.linkKind,
      routeId: l.routeId,
      endpointId: l.endpointId,
      useCaseId: l.useCaseId,
    }))
    .sort((a, b) => {
      const keyA = `${a.linkKind}|${a.routeId ?? ''}|${a.endpointId ?? ''}|${a.useCaseId}`;
      const keyB = `${b.linkKind}|${b.routeId ?? ''}|${b.endpointId ?? ''}|${b.useCaseId}`;
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });
  const coverageHash = createHash('sha256')
    .update(
      JSON.stringify({
        routes: [...routeIds].sort(),
        endpoints: [...endpointIds].sort(),
        useCases: useCases.map((u) => u.id).sort(),
        links: sortedLinks,
        unmappedRoutes: [...unmappedRoutes].sort(),
        unmappedEndpoints: [...unmappedEndpoints].sort(),
      }),
    )
    .digest('hex');

  const reading = buildSensorReading({
    sensorName: 'inventory:coverage',
    sensorKind: 'inventory_coverage',
    sensorVersion: '1.0.0',
    command: ['devai', 'sense', 'coverage', '--repo-root', opts.repoRoot],
    status,
    deterministic: true,
    tier: 'L0',
    duration_ms: Date.now() - t0,
    timestamp: generatedAt,
    ...(findings.length > 0 && { findings }),
    // Phase 33.B (closes D-A-35): mirror the just-built matrix body.
    // Pre-33.B these four counts were hard-coded to 0 / 0 /
    // routeIds.length / endpointIds.length, drifting from the body
    // as soon as any use-cases were authored. Downstream consumers
    // that read SR metrics rather than the body saw stale coverage.
    metrics: {
      route_count: routeIds.length,
      endpoint_count: endpointIds.length,
      use_case_count: useCases.length,
      link_count: links.length,
      unmapped_route_count: unmappedRoutes.length,
      unmapped_endpoint_count: unmappedEndpoints.length,
      inferred_path_match_count: inferredPathMatchCount,
      coverage_hash: coverageHash,
    },
    ...(bodyPath !== null && { evidence_path: bodyPath }),
  });

  return { reading, body, bodyPath };
}
