import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { validators } from '@devai-nyx/schemas';
import {
  allBoundSurfacesAbsent,
  applySurfaceDeclaration,
  type PlantSurface,
} from './declared-surfaces.js';
import { buildSensorReading, type SensorStatus } from './sensor-reading.js';
import { DEFAULT_IGNORE_DIRS, parseSource, walkTsxJsx } from './inventory-walker.js';
import {
  type RoutesInventoryRoute,
  type InventoryRoutesOptions,
  type InventoryRoutesResult,
  type RoutesFramework,
  type RawRoute,
  extractAngularRoutesFromFile,
  extractRoutesFromFile,
  makeId,
  type RoutesInventoryBody,
} from './inventory-routes-extract.js';
export type {
  RoutesInventoryEvidence,
  RoutesInventoryComponentRef,
  RoutesInventoryRoute,
  RoutesFramework,
  RoutesInventoryBody,
  InventoryRoutesOptions,
  InventoryRoutesResult,
} from './inventory-routes-extract.js';

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

function sortRoutes(routes: readonly RoutesInventoryRoute[]): RoutesInventoryRoute[] {
  return [...routes].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function measureInventoryRoutes(opts: InventoryRoutesOptions): InventoryRoutesResult {
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

/** Surfaces this sensor is bound to (ADR-SCR-0003). */
const BOUND_SURFACES: readonly PlantSurface[] = ['http'];

export function senseInventoryRoutes(opts: InventoryRoutesOptions): InventoryRoutesResult {
  // A declared-absent surface is still scanned, so a contradiction is caught; its
  // body is never materialized.
  const absent = allBoundSurfacesAbsent(opts.surfaces, BOUND_SURFACES);
  const result = measureInventoryRoutes(absent ? { ...opts, persistBody: false } : opts);
  const reading = applySurfaceDeclaration(result.reading, opts.surfaces, BOUND_SURFACES, [
    { surface: 'http', items: result.body.routes.map((r) => r.path) },
  ]);
  return { ...result, reading };
}
