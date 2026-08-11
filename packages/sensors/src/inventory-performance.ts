import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * F4 inventory performance sensor (Phase 29.F; F4×T7).
 *
 * Reads every persisted SR under `record/proofs/sensor-readings/
 * inventory_*<asterisk>/` and aggregates `duration_ms` per kind plus an
 * overall p95. The last UNKNOWN-without-sensor cell from D-77's
 * carry-forward register (substrate-expansion trilogy residual).
 *
 * Per design note at docs/theory/architecture/sensors/inventory_performance.md.
 */

export interface InventoryPerformanceOptions {
  readonly repoRoot: string;
  readonly readingsDir?: string;
  readonly thresholds?: { readonly pass: number; readonly review: number };
  readonly now?: string;
}

const DEFAULT_READINGS_DIR = 'record/proofs/sensor-readings';
const DEFAULT_THRESHOLDS = { pass: 2000, review: 5000 } as const;

function abs(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? 0;
}

interface PersistedSR {
  readonly sensor?: { readonly kind?: string };
  readonly duration_ms?: number;
}

export function senseInventoryPerformance(opts: InventoryPerformanceOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const readingsDir = abs(opts.repoRoot, opts.readingsDir ?? DEFAULT_READINGS_DIR);

  const st = safeStat(readingsDir);
  if (st === null || !st.isDirectory()) {
    return buildSensorReading({
      sensorName: 'inventory-performance',
      sensorKind: 'inventory_performance',
      command: ['devai', 'sense-inventory-performance'],
      status: 'review',
      deterministic: true,
      tier: 'L0',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'INVENTORY_PERFORMANCE_NO_READINGS',
          message: `No sensor-readings directory at ${readingsDir}.`,
        },
      ],
      metrics: { kinds_observed: 0, total_observations: 0 },
    });
  }

  // Per kind subdir: only inventory_* directories.
  let subdirs: string[];
  try {
    subdirs = readdirSync(readingsDir).filter((d) => d.startsWith('inventory_'));
  } catch {
    subdirs = [];
  }

  const perKind: Map<string, number[]> = new Map();
  for (const sub of subdirs) {
    const dir = join(readingsDir, sub);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, e), 'utf8')) as PersistedSR;
        if (typeof parsed.duration_ms !== 'number') continue;
        const kind = parsed.sensor?.kind ?? sub;
        const list = perKind.get(kind) ?? [];
        list.push(parsed.duration_ms);
        perKind.set(kind, list);
      } catch {
        // skip
      }
    }
  }

  const allDurations: number[] = [];
  for (const list of perKind.values()) for (const d of list) allDurations.push(d);
  allDurations.sort((a, b) => a - b);

  if (allDurations.length === 0) {
    return buildSensorReading({
      sensorName: 'inventory-performance',
      sensorKind: 'inventory_performance',
      command: ['devai', 'sense-inventory-performance'],
      status: 'review',
      deterministic: true,
      tier: 'L0',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'INVENTORY_PERFORMANCE_NO_READINGS',
          message: 'No persisted inventory_* SensorReadings with duration_ms found.',
        },
      ],
      metrics: { kinds_observed: 0, total_observations: 0 },
    });
  }

  const overallP95 = percentile(allDurations, 0.95);
  const overallMean = Math.round(allDurations.reduce((acc, n) => acc + n, 0) / allDurations.length);

  const findings: SensorFinding[] = [];
  let status: SensorStatus;
  if (overallP95 < thresholds.pass) {
    status = 'pass';
  } else if (overallP95 < thresholds.review) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'INVENTORY_PERFORMANCE_SLOW',
      message: `Inventory p95 ${String(overallP95)}ms above pass threshold ${String(thresholds.pass)}ms.`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'INVENTORY_PERFORMANCE_TOO_SLOW',
      message: `Inventory p95 ${String(overallP95)}ms above review threshold ${String(thresholds.review)}ms.`,
    });
  }

  // Surface per-kind p95 to aid triage. Stable order via sorted keys.
  const perKindMetrics: Record<string, number> = {};
  for (const kind of [...perKind.keys()].sort()) {
    const list = [...(perKind.get(kind) ?? [])].sort((a, b) => a - b);
    perKindMetrics[`${kind}_count`] = list.length;
    perKindMetrics[`${kind}_p95_ms`] = percentile(list, 0.95);
  }

  return buildSensorReading({
    sensorName: 'inventory-performance',
    sensorKind: 'inventory_performance',
    command: ['devai', 'sense-inventory-performance'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      kinds_observed: perKind.size,
      total_observations: allDurations.length,
      overall_p95_ms: overallP95,
      overall_mean_ms: overallMean,
      threshold_pass: thresholds.pass,
      threshold_review: thresholds.review,
      ...perKindMetrics,
    },
  });
}
