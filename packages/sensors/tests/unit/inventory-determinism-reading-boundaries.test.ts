import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { senseInventoryDeterminism } from '../../src/inventory-determinism.js';

const NOW = '2026-09-08T12:00:00.000Z';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('inventory determinism reading boundaries', () => {
  it('reports equal canonical output as a deterministic pass with exact hashes and sizes', () => {
    const canonical = '{"routes":["/accounts"],"endpoints":[]}';
    const reading = senseInventoryDeterminism({
      canonicalA: canonical,
      canonicalB: canonical,
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'pass',
      sensor: { name: 'inventory-determinism', kind: 'inventory_determinism' },
      command: 'devai sense-inventory-determinism',
      deterministic: true,
      tier: 'L0',
      timestamp: NOW,
      findings: [],
      metrics: {
        hash_a: hash(canonical),
        hash_b: hash(canonical),
        bytes_a: canonical.length,
        bytes_b: canonical.length,
        equal: 1,
      },
    });
  });

  it('reports unequal canonical output as a deterministic failure with exact mismatch evidence', () => {
    const first = '{"routes":[],"endpoints":[]}';
    const second = '{"routes":["/accounts"],"endpoints":[]}';
    const hashA = hash(first);
    const hashB = hash(second);
    const reading = senseInventoryDeterminism({ canonicalA: first, canonicalB: second, now: NOW });

    expect(reading).toMatchObject({
      status: 'fail',
      command: 'devai sense-inventory-determinism',
      deterministic: true,
      timestamp: NOW,
      metrics: {
        hash_a: hashA,
        hash_b: hashB,
        bytes_a: first.length,
        bytes_b: second.length,
        equal: 0,
      },
    });
    expect(reading.findings).toEqual([
      {
        severity: 'error',
        code: 'INVENTORY_DETERMINISM_HASH_MISMATCH',
        message: `inv-regen produced divergent output across two consecutive invocations: ${hashA.slice(0, 16)}… ≠ ${hashB.slice(0, 16)}…`,
      },
    ]);
  });
});
