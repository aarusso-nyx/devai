import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import {
  actionEvidence,
  applySurfaceDeclaration,
  measureActionLinkage,
  surfacePresent,
  unlinkedActionFindings,
  type DeclaredSurfaces,
  type PlantSurface,
  type SurfaceEvidence,
} from './declared-surfaces.js';

/**
 * Inventory sensor: plant coverage (F2 × T1). Phase 26.E (closes
 * D-77 sub-batch 26.E). Joins the api-map.json + routes-inventory.json
 * bodies emitted by the existing inventory_api / inventory_routes
 * sensors, and asserts that each endpoint's `controller.file` and
 * each route's `component.file` path is present on disk.
 *
 * Status semantics:
 *   - PASS: every endpoint/route has a present file reference.
 *   - REVIEW: ≥ 1 endpoint or route refers to a file that doesn't
 *     exist (likely a stale inventory; re-run the inventory sensors
 *     to refresh).
 *   - FAIL: both api-map and routes-inventory bodies missing (no
 *     inventory to verify against — adopters should run sense-api +
 *     sense-routes first), unless http is declared absent.
 *
 * ADR-SCR-0003: bound to the http and actions surfaces. With actions
 * present, every registered action in law/policy/action-registry.json
 * is checked for a use-case link (`refs.actionRefs`); an unlinked
 * action reads REVIEW. Skipped when both surfaces are declared absent.
 *
 * This sensor catches stale inventories more than it catches missing
 * code: in a healthy repo the inventory was generated against the
 * same checkout and every controller.file exists. After a refactor
 * that renames or removes files, the inventory diverges; this
 * sensor surfaces that divergence at F2×T1.
 */

export interface PlantCoverageOptions {
  readonly repoRoot: string;
  /** Default: `record/proofs/sensors/inventory_api/api-map.json`. */
  readonly apiMapPath?: string;
  /** Default: `record/proofs/sensors/inventory_routes/routes-inventory.json`. */
  readonly routesInventoryPath?: string;
  readonly now?: string;
  /**
   * Declared plant surfaces (ADR-SCR-0003). Omitted: every surface is presumed present.
   */
  readonly surfaces?: DeclaredSurfaces;
}

function abs(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

function loadJsonSafe<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

interface ApiMap {
  readonly endpoints?: ReadonlyArray<{
    readonly method?: string;
    readonly path?: string;
    readonly controller?: { readonly file?: string };
  }>;
}
interface RoutesInventory {
  readonly routes?: ReadonlyArray<{
    readonly path?: string;
    readonly component?: { readonly file?: string };
  }>;
}

/** Surfaces this sensor is bound to (ADR-SCR-0003). */
const BOUND_SURFACES: readonly PlantSurface[] = ['http', 'actions'];

export function sensePlantCoverage(opts: PlantCoverageOptions): SensorReading {
  const apiPath = abs(
    opts.repoRoot,
    opts.apiMapPath ?? 'record/proofs/sensors/inventory_api/api-map.json',
  );
  const routesPath = abs(
    opts.repoRoot,
    opts.routesInventoryPath ?? 'record/proofs/sensors/inventory_routes/routes-inventory.json',
  );
  const apiMap = loadJsonSafe<ApiMap>(apiPath);
  const routes = loadJsonSafe<RoutesInventory>(routesPath);
  const httpPresent = surfacePresent(opts.surfaces, 'http');
  const actionsPresent = surfacePresent(opts.surfaces, 'actions');

  const findings: SensorFinding[] = [];
  let endpointCount = 0;
  let routeCount = 0;
  let missing = 0;
  // With http declared absent the HTTP inventory is not demanded.
  const noInventory = httpPresent && apiMap === null && routes === null;

  if (noInventory) {
    findings.push({
      severity: 'error',
      code: 'PLANT_COVERAGE_NO_INVENTORY',
      message: `Neither api-map nor routes-inventory found. Run sense-api + sense-routes first.`,
    });
  }

  for (const ep of httpPresent ? (apiMap?.endpoints ?? []) : []) {
    endpointCount += 1;
    const file = ep.controller?.file;
    if (typeof file !== 'string' || file.length === 0) continue;
    const absFile = abs(opts.repoRoot, file);
    if (!existsSync(absFile)) {
      missing += 1;
      findings.push({
        severity: 'warning',
        code: 'PLANT_COVERAGE_MISSING_CONTROLLER_FILE',
        message: `Endpoint ${ep.method ?? '?'} ${ep.path ?? '?'} references non-existent file: ${file}`,
        file,
      });
    }
  }
  for (const rt of httpPresent ? (routes?.routes ?? []) : []) {
    routeCount += 1;
    const file = rt.component?.file;
    if (typeof file !== 'string' || file.length === 0) continue;
    const absFile = abs(opts.repoRoot, file);
    if (!existsSync(absFile)) {
      missing += 1;
      findings.push({
        severity: 'warning',
        code: 'PLANT_COVERAGE_MISSING_COMPONENT_FILE',
        message: `Route ${rt.path ?? '?'} references non-existent file: ${file}`,
        file,
      });
    }
  }

  // ADR-SCR-0003 IA-004: registered actions measured against their specification links.
  const linkage = actionsPresent ? measureActionLinkage(opts.repoRoot) : null;
  if (linkage !== null) {
    findings.push(...unlinkedActionFindings(linkage, 'PLANT_COVERAGE_UNLINKED_ACTION'));
  }

  const status: SensorStatus = noInventory
    ? 'fail'
    : missing === 0 && (linkage?.unlinkedIds.length ?? 0) === 0
      ? 'pass'
      : 'review';
  const reading = buildSensorReading({
    sensorName: 'plant-coverage',
    sensorKind: 'plant_coverage',
    command: ['devai', 'sense-plant-coverage'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      endpoint_count: endpointCount,
      route_count: routeCount,
      missing_files: missing,
      ...(linkage !== null && linkage.metrics),
    },
  });

  const evidence: SurfaceEvidence[] = [];
  if (!httpPresent) {
    evidence.push({
      surface: 'http',
      items: [
        ...(apiMap?.endpoints ?? []).map((ep) => `${ep.method ?? '?'} ${ep.path ?? '?'}`),
        ...(routes?.routes ?? []).map((rt) => rt.path ?? '?'),
      ],
    });
  }
  if (!actionsPresent) evidence.push(actionEvidence(opts.repoRoot));
  return applySurfaceDeclaration(reading, opts.surfaces, BOUND_SURFACES, evidence);
}
