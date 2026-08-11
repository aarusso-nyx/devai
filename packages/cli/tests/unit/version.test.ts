import { describe, expect, it } from 'vitest';
import { resolveCliProvenance, resolveCliVersion } from '../../src/version.js';

describe('resolveCliVersion', () => {
  it('returns a semver-shaped string', () => {
    expect(resolveCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('resolveCliProvenance', () => {
  it('reports the supported package consumption mode', () => {
    const provenance = resolveCliProvenance();
    expect(provenance.source).toBe('npm-package');
    expect(provenance.resolvedPath.length).toBeGreaterThan(0);
  });

  it('is cached across calls (same object identity is not required, but the value is stable)', () => {
    const first = resolveCliProvenance();
    const second = resolveCliProvenance();
    expect(second).toEqual(first);
  });
});
// Invariants: INV-DEVAI-001
