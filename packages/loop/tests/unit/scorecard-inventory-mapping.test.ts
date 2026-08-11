import { describe, expect, it } from 'vitest';
import { computeScorecard } from '../../src/loop/scorecard.js';
import type { SensorReading } from '@devai-nyx/sensors';

/**
 * Phase 22.D (closes D-A-14): scorecard cell-classifier refinement
 * for L0 inventory SRs.
 *
 * Pre-Phase-21.E: `mapSensorToCell` had no entry for the seven L0
 * inventory kinds — readings were ignored, every F4 cell read
 * UNKNOWN even when inventory was healthy.
 *
 * Phase 21.E added per-kind semantic mappings:
 *   inventory_api/routes/data-model/coverage → F4×T2 (Depth)
 *   inventory_data_handling/rbac           → F4×T6 (Security/Privacy)
 *   inventory_dep_graph                    → F4×T3 (Coherence)
 *
 * Phase 22.D adds F4×T1 (Coverage) as the canonical "presence"
 * anchor every inventory kind contributes to ALONGSIDE its
 * semantic cell. This means a single sense-api PASS populates
 * both F4×T1 and F4×T2. Worst-wins merge across kinds gives a
 * coherent F4×T1 read on inventory completeness.
 */

function buildReading(
  kind: SensorReading['sensor']['kind'],
  status: SensorReading['status'],
  id: string,
): SensorReading {
  return {
    schemaVersion: '1.0.0',
    id,
    sensor: { name: `inventory:${kind}`, kind },
    timestamp: '2026-05-16T12:00:00.000Z',
    status,
    deterministic: true,
    command: 'fixture',
    command_hash: '0'.repeat(64),
    tier: 'L0',
  };
}

describe('scorecard maps L0 inventory SRs to F4 cells (Phase 22.D, closes D-A-14)', () => {
  const SEVEN_INVENTORY_KINDS = [
    'inventory_api',
    'inventory_routes',
    'inventory_data_model',
    'inventory_data_handling',
    'inventory_rbac',
    'inventory_dep_graph',
    'inventory_coverage',
  ] as const;

  it('every inventory kind contributes to F4×T1 (presence anchor)', () => {
    const readings = SEVEN_INVENTORY_KINDS.map((k, i) => buildReading(k, 'pass', `SR-${i}-${k}`));
    const sc = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings,
    });
    const f4t1 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T1');
    expect(f4t1).toBeDefined();
    expect(f4t1?.verdict).toBe('PASS');
    // F4×T1 should reference one SR per inventory kind (seven total).
    expect((f4t1?.sensor_readings ?? []).length).toBe(SEVEN_INVENTORY_KINDS.length);
  });

  it('per-kind semantic cells get the same readings (Phase 21.E preserved)', () => {
    const readings = SEVEN_INVENTORY_KINDS.map((k, i) => buildReading(k, 'pass', `SR-${i}-${k}`));
    const sc = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings,
    });
    // F4×T2 (Depth) — 4 inventory kinds map here
    // (api/routes/data-model/coverage).
    const f4t2 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T2');
    expect(f4t2?.verdict).toBe('PASS');
    expect((f4t2?.sensor_readings ?? []).length).toBe(4);
    // F4×T6 (Security and Privacy) — 2 inventory kinds
    // (data-handling/rbac).
    const f4t6 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T6');
    expect(f4t6?.verdict).toBe('PASS');
    expect((f4t6?.sensor_readings ?? []).length).toBe(2);
    // F4×T3 (Coherence) — 1 inventory kind (dep-graph).
    const f4t3 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T3');
    expect(f4t3?.verdict).toBe('PASS');
    expect((f4t3?.sensor_readings ?? []).length).toBe(1);
  });

  it('a single inventory kind populates BOTH F4×T1 AND its semantic cell', () => {
    const sc = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings: [buildReading('inventory_api', 'pass', 'SR-only-api')],
    });
    const f4t1 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T1');
    const f4t2 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T2');
    expect(f4t1?.verdict).toBe('PASS');
    expect(f4t1?.sensor_readings).toContain('SR-only-api');
    expect(f4t2?.verdict).toBe('PASS');
    expect(f4t2?.sensor_readings).toContain('SR-only-api');
  });

  it('worst-wins on F4×T1: any FAIL across the seven kinds makes F4×T1 FAIL', () => {
    const readings = SEVEN_INVENTORY_KINDS.map((k, i) => {
      const status: SensorReading['status'] = k === 'inventory_rbac' ? 'fail' : 'pass';
      return buildReading(k, status, `SR-${i}-${k}`);
    });
    const sc = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings,
    });
    const f4t1 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T1');
    expect(f4t1?.verdict).toBe('FAIL');
    // Even with the FAIL, F4×T1 still references every reading
    // (it's the presence anchor — every inventory SR contributes).
    expect((f4t1?.sensor_readings ?? []).length).toBe(SEVEN_INVENTORY_KINDS.length);
    // Substrate aggregate for F4 is FAIL (the worst across cells).
    expect(sc.substrate_aggregates.F4?.verdict).toBe('FAIL');
  });

  it('REVIEW status maps to REVIEW verdict in both cells', () => {
    const sc = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings: [buildReading('inventory_routes', 'review', 'SR-rev-routes')],
    });
    const f4t1 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T1');
    const f4t2 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T2');
    expect(f4t1?.verdict).toBe('REVIEW');
    expect(f4t2?.verdict).toBe('REVIEW');
  });

  it('non-inventory sensor kinds map to one cell only (no F4×T1 contribution)', () => {
    const sc = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings: [buildReading('lint', 'pass', 'SR-lint')],
    });
    // lint → F2×T5 only; F4×T1 stays UNKNOWN.
    const f2t5 = sc.cells.find((c) => c.substrate === 'F2' && c.property === 'T5');
    expect(f2t5?.verdict).toBe('PASS');
    const f4t1 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T1');
    expect(f4t1?.verdict).toBe('UNKNOWN');
  });

  it('experimental readings remain auditable but cannot promote a supported cell', () => {
    const experimental = {
      ...buildReading('inventory_api', 'pass', 'SR-experimental-api'),
      lifecycle: 'experimental' as const,
    };
    const sc = computeScorecard({
      timestamp: '2026-05-16T12:00:00.000Z',
      integrationHead: '0'.repeat(39) + 'f',
      readings: [experimental],
    });
    const f4t1 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T1');
    const f4t2 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T2');
    expect(f4t1?.verdict).toBe('UNKNOWN');
    expect(f4t2?.verdict).toBe('UNKNOWN');
    expect(f4t1?.sensor_readings ?? []).not.toContain('SR-experimental-api');
  });
});
// Invariants: INV-INVENTORY-001
