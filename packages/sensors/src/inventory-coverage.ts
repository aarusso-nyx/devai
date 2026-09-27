import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import {
  actionEvidence,
  allBoundSurfacesAbsent,
  applySurfaceDeclaration,
  measureActionLinkage,
  surfacePresent,
  unlinkedActionFindings,
  type PlantSurface,
  type SurfaceEvidence,
} from './declared-surfaces.js';
import { buildSensorReading, type SensorStatus } from './sensor-reading.js';
import {
  type InventoryCoverageOptions,
  type InventoryCoverageResult,
  resolveRoutesPath,
  type ApiMapShape,
  type RoutesInventoryShape,
  endpointId,
  countInferredMatches,
  loadUseCasesFromDir,
  synthesizeLinks,
} from './inventory-coverage-inputs.js';
export type {
  InventoryCoverageOptions,
  InventoryCoverageResult,
} from './inventory-coverage-inputs.js';

function measureInventoryCoverage(opts: InventoryCoverageOptions): InventoryCoverageResult {
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
  const httpPresent = surfacePresent(opts.surfaces, 'http');

  if (!httpPresent) {
    // ADR-SCR-0003: http declared absent; no HTTP inventory is demanded.
  } else if (!existsSync(apiMapPath)) {
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

  if (!httpPresent) {
    // As above: the routes body is not demanded either.
  } else if (routesResolution.kind === 'ambiguous') {
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

  // ADR-SCR-0003 IA-004: registered actions measured against their specification links,
  // the way unmapped routes and endpoints read review above.
  const linkage = surfacePresent(opts.surfaces, 'actions')
    ? measureActionLinkage(opts.repoRoot, useCasesDir)
    : null;
  if (linkage !== null && linkage.unlinkedIds.length > 0) {
    if (status === 'pass') status = 'review';
    findings.push(...unlinkedActionFindings(linkage, 'COVERAGE_UNLINKED_ACTION'));
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
      ...(linkage !== null && linkage.metrics),
    },
    ...(bodyPath !== null && { evidence_path: bodyPath }),
  });

  return { reading, body, bodyPath };
}

/** Surfaces this sensor is bound to (ADR-SCR-0003). */
const BOUND_SURFACES: readonly PlantSurface[] = ['http', 'actions'];

/** Endpoints and routes an existing HTTP inventory body holds. */
function httpEvidence(opts: InventoryCoverageOptions): SurfaceEvidence {
  const items: string[] = [];
  const apiMapPath =
    opts.apiMapPath ?? join(opts.repoRoot, 'record/proofs/sensors/inventory_api/api-map.json');
  try {
    const apiMap = JSON.parse(readFileSync(apiMapPath, 'utf8')) as Partial<ApiMapShape>;
    for (const endpoint of apiMap.endpoints ?? []) items.push(endpointId(endpoint));
  } catch {
    // No readable api-map: no endpoint evidence.
  }
  const routes = resolveRoutesPath(opts.repoRoot, opts.routesPath, opts.framework);
  if (routes.kind === 'resolved') {
    try {
      const inventory = JSON.parse(
        readFileSync(routes.path, 'utf8'),
      ) as Partial<RoutesInventoryShape>;
      for (const route of inventory.routes ?? []) items.push(route.path);
    } catch {
      // No readable routes body: no route evidence.
    }
  }
  return { surface: 'http', items };
}

export function senseInventoryCoverage(opts: InventoryCoverageOptions): InventoryCoverageResult {
  // Declared-absent surfaces are still checked for evidence; the matrix body of a
  // skipped reading is never materialized.
  const absent = allBoundSurfacesAbsent(opts.surfaces, BOUND_SURFACES);
  const result = measureInventoryCoverage(absent ? { ...opts, persistBody: false } : opts);
  const evidence: SurfaceEvidence[] = [];
  if (!surfacePresent(opts.surfaces, 'http')) evidence.push(httpEvidence(opts));
  if (!surfacePresent(opts.surfaces, 'actions')) evidence.push(actionEvidence(opts.repoRoot));
  const reading = applySurfaceDeclaration(result.reading, opts.surfaces, BOUND_SURFACES, evidence);
  return { ...result, reading };
}
