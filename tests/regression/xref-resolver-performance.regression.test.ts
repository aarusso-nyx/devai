import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  resolveAll,
  type XrefCheck,
} from '../../packages/spec/src/spec/xref-resolver.js';

// Absorbed Phase-2 validation criterion:
//   "Cross-reference resolver handles a graph of 100+ invariants with
//    200+ references in under 100ms."
//
// Implementation is O(1) per lookup via Set; this guards against an
// accidental O(n²) regression (e.g., switching to Array.includes).
describe('xref-resolver performance', () => {
  it('resolves 200 references over 100 invariants in well under 100ms', () => {
    const invariantIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      invariantIds.push(`INV-PERF-${String(i + 1).padStart(3, '0')}`);
    }
    const catalog = buildCatalog(invariantIds);

    const checks: XrefCheck[] = [];
    for (let i = 0; i < 200; i++) {
      checks.push({
        source_file: `JNY-${String(i % 50).padStart(3, '0')}.json`,
        source_id: `JNY-${String(i % 50).padStart(3, '0')}`,
        field: `related_invariants[${String(i % 4)}]`,
        target_id: `INV-PERF-${String((i % 100) + 1).padStart(3, '0')}`,
        target_kind: 'invariant',
      });
    }

    const start = performance.now();
    const errors = resolveAll(catalog, checks);
    const elapsed = performance.now() - start;

    expect(errors).toEqual([]);
    expect(elapsed).toBeLessThan(100);
  });

  it('handles 10x scale (1000 invariants, 2000 refs) in well under 100ms', () => {
    const invariantIds: string[] = [];
    for (let i = 0; i < 1000; i++) {
      invariantIds.push(`INV-PERF-${String(i + 1).padStart(4, '0')}`);
    }
    const catalog = buildCatalog(invariantIds);

    const checks: XrefCheck[] = [];
    for (let i = 0; i < 2000; i++) {
      checks.push({
        source_file: `JNY-${String(i % 500).padStart(3, '0')}.json`,
        source_id: `JNY-${String(i % 500).padStart(3, '0')}`,
        field: `related_invariants[${String(i % 4)}]`,
        target_id: `INV-PERF-${String((i % 1000) + 1).padStart(4, '0')}`,
        target_kind: 'invariant',
      });
    }

    const start = performance.now();
    const errors = resolveAll(catalog, checks);
    const elapsed = performance.now() - start;

    expect(errors).toEqual([]);
    expect(elapsed).toBeLessThan(100);
  });
});
// Invariants: INV-DEVAI-001
