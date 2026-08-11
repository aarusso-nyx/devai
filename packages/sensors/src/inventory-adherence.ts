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
}

const DEFAULT_MAX_ORPHANS = 50;

export function senseInventoryAdherence(opts: InventoryAdherenceOptions): SensorReading {
  const maxOrphans = opts.maxOrphans ?? DEFAULT_MAX_ORPHANS;
  const { counts } = opts.report;
  let status: SensorStatus;
  const findings: SensorFinding[] = [];

  if (counts.orphan === 0) {
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
