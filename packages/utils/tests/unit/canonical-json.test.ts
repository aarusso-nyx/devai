import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../../src/canonical-json/index.js';

describe('canonicalJson', () => {
  it('sorts top-level keys lexicographically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('recursively sorts nested object keys', () => {
    const out = canonicalJson({ b: { y: 1, x: 2 }, a: 3 });
    expect(out).toBe('{"a":3,"b":{"x":2,"y":1}}');
  });

  it('preserves array order (arrays are semantically ordered)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles deeply nested mixed structures', () => {
    const input = {
      z: [
        { b: 2, a: 1 },
        { d: 4, c: 3 },
      ],
      a: { nested: { y: 1, x: 2 } },
    };
    const out = canonicalJson(input);
    // Outer keys sorted: a, z. Inner objects in array also sorted.
    expect(out).toBe('{"a":{"nested":{"x":2,"y":1}},"z":[{"a":1,"b":2},{"c":3,"d":4}]}');
  });

  it('passes through primitives', () => {
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
  });
});

describe('canonicalSha256', () => {
  it('produces a deterministic 64-char hex string', () => {
    const h = canonicalSha256({ a: 1, b: 2 });
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is stable under key-insertion-order changes (v2.0)', () => {
    const a = { x: 1, y: { p: 1, q: 2 } };
    const b = { y: { q: 2, p: 1 }, x: 1 };
    expect(canonicalSha256(a)).toBe(canonicalSha256(b));
  });

});
// Invariants: INV-DEVAI-001
