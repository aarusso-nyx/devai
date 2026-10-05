import {
  applySurfaceDeclaration,
  type DeclaredSurfaces,
  type PlantSurface,
} from './declared-surfaces.js';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: inventory adherence (F4 × T4). Phase 26.H (closes
 * D-77 sub-batch 26.H). Wraps a `computeReverseAdherence` report
 * (the existing helper at `the shared inventory helper`) and translates
 * orphan counts into a PASS / REVIEW / FAIL verdict.
 *
 * Status semantics:
 *   - UNKNOWN: total_count == 0 (no surface was observed, so nothing is
 *     measured; ADR-SCR-0012 IA-006).
 *   - PASS: orphan_count == 0 (every plant surface is claimed by
 *     some invariant's `code_areas[]`).
 *   - REVIEW: 0 < orphan_count ≤ max_orphans (the threshold; default
 *     50; pack-config override
 *     `extractor_params.inventory_adherence.max_orphans`).
 *   - FAIL: orphan_count > max_orphans.
 *
 * The sensor takes the report as input (pure pattern, mirrors 26.C
 * and 26.F); the CLI verb loads inventory + trace and calls
 * `computeReverseAdherence` first.
 */

export interface InventoryAdherenceOptions {
  readonly report: {
    readonly counts: { readonly total: number; readonly claimed: number; readonly orphan: number };
    readonly orphans?: ReadonlyArray<{
      readonly kind?: string;
      readonly id?: string;
      readonly file?: string;
    }>;
  };
  /** Max orphan count tolerated as REVIEW. Default 50. */
  readonly maxOrphans?: number;
  readonly now?: string;
  /**
   * Declared plant surfaces (ADR-SCR-0003, ADR-SCR-0008). Omitted: every surface is
   * presumed present. The reading is `skipped` only when every surface the sensor
   * measures is declared absent.
   */
  readonly surfaces?: DeclaredSurfaces;
}

/** Bound to every plant surface: adherence is measured unless all are declared absent. */
const BOUND_SURFACES: readonly PlantSurface[] = ['http', 'database', 'rbac', 'actions'];

const DEFAULT_MAX_ORPHANS = 50;

export function senseInventoryAdherence(opts: InventoryAdherenceOptions): SensorReading {
  return applySurfaceDeclaration(
    measureInventoryAdherence(opts),
    opts.surfaces,
    BOUND_SURFACES,
    [],
  );
}

function measureInventoryAdherence(opts: InventoryAdherenceOptions): SensorReading {
  const maxOrphans = opts.maxOrphans ?? DEFAULT_MAX_ORPHANS;
  const { counts } = opts.report;
  let status: SensorStatus;
  const findings: SensorFinding[] = [];

  if (counts.total === 0) {
    // ADR-SCR-0012 IA-006: an inventory with no surface is a diagnostic, never an empty PASS.
    status = 'unknown';
    findings.push({
      severity: 'warning',
      code: 'INVENTORY_ADHERENCE_NO_SURFACES',
      message:
        'The inventory holds no module, route, component, or dependency surface to measure. Regenerate it from source with sense run inventory_regeneration.',
    });
  } else if (counts.orphan === 0) {
    status = 'pass';
  } else if (counts.orphan <= maxOrphans) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'INVENTORY_ADHERENCE_PARTIAL',
      message: `${String(counts.orphan)} plant surfaces are unclaimed by any invariant.code_areas[] (threshold ${String(maxOrphans)}).`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'INVENTORY_ADHERENCE_BELOW_THRESHOLD',
      message: `${String(counts.orphan)} orphans exceed max_orphans=${String(maxOrphans)}.`,
    });
  }

  // Surface up to the first 10 orphans as additional info-level
  // findings so adopters can spot which surfaces specifically.
  const surfaceLimit = 10;
  for (const o of (opts.report.orphans ?? []).slice(0, surfaceLimit)) {
    findings.push({
      severity: 'info',
      code: 'INVENTORY_ADHERENCE_ORPHAN',
      message: `Unclaimed ${o.kind ?? '?'}: ${o.id ?? '?'}`,
      ...(o.file !== undefined && { file: o.file }),
    });
  }

  return buildSensorReading({
    sensorName: 'inventory-adherence',
    sensorKind: 'inventory_adherence',
    command: ['devai', 'sense-inventory-adherence'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      total_count: counts.total,
      claimed_count: counts.claimed,
      orphan_count: counts.orphan,
      max_orphans: maxOrphans,
    },
  });
}
