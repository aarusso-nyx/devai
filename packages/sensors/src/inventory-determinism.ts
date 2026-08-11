import { createHash } from 'node:crypto';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: inventory determinism (F4 × T8). Phase 26.I
 * (closes D-77 sub-batch 26.I). Verifies that `inv-regen` produces
 * byte-identical output across two consecutive invocations against
 * the same repository state.
 *
 * Status semantics:
 *   - PASS: SHA-256(canonicalized output A) == SHA-256(canonicalized
 *     output B). The inventory walker is deterministic.
 *   - FAIL: hashes differ. Non-determinism is a hard problem (Set
 *     iteration order, Date.now() pollution, environment-dependent
 *     walker behaviour); surface explicitly.
 *
 * The CLI verb at `commands/sense/inventory-determinism.ts` runs
 * `regenerateInventory` twice with the same pinned timestamp +
 * integrationHead, JSON-canonicalizes both, and passes the two
 * canonical strings into the sensor. The sensor itself is pure with
 * respect to those strings (hashes + compares).
 */

export interface InventoryDeterminismOptions {
  readonly canonicalA: string;
  readonly canonicalB: string;
  readonly now?: string;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function senseInventoryDeterminism(opts: InventoryDeterminismOptions): SensorReading {
  const hashA = sha256(opts.canonicalA);
  const hashB = sha256(opts.canonicalB);
  const equal = hashA === hashB;
  const status: SensorStatus = equal ? 'pass' : 'fail';
  const findings: SensorFinding[] = equal
    ? []
    : [
        {
          severity: 'error',
          code: 'INVENTORY_DETERMINISM_HASH_MISMATCH',
          message: `inv-regen produced divergent output across two consecutive invocations: ${hashA.slice(0, 16)}… ≠ ${hashB.slice(0, 16)}…`,
        },
      ];
  return buildSensorReading({
    sensorName: 'inventory-determinism',
    sensorKind: 'inventory_determinism',
    command: ['devai', 'sense-inventory-determinism'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      hash_a: hashA,
      hash_b: hashB,
      bytes_a: opts.canonicalA.length,
      bytes_b: opts.canonicalB.length,
      equal: equal ? 1 : 0,
    },
  });
}
