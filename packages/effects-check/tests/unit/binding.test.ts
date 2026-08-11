import { describe, expect, it } from 'vitest';
import { enforceEffectReport } from '../../src/index.js';

// Invariants: INV-DEVAI-020

describe('binding effect report', () => {
  it('fails under-declaration', () => {
    expect(() =>
      enforceEffectReport({
        findings: [{ code: 'EFFECT_UNDER_DECLARED', action_id: 'fixture', message: 'missing' }],
      }),
    ).toThrow(/EFFECT_UNDER_DECLARED:fixture/u);
  });

  it('fails unresolved and unregistered reaches', () => {
    expect(() =>
      enforceEffectReport({
        findings: [
          { code: 'EFFECT_EDGE_UNRESOLVED', message: 'edge' },
          { code: 'SPAWN_EFFECT_UNDECLARED', message: 'spawn' },
        ],
      }),
    ).toThrow(/EFFECT_EDGE_UNRESOLVED[\s\S]*SPAWN_EFFECT_UNDECLARED/u);
  });

  it('keeps over-declaration advisory', () => {
    expect(() =>
      enforceEffectReport({
        findings: [{ code: 'EFFECT_OVER_DECLARED', message: 'conservative' }],
      }),
    ).not.toThrow();
  });
});
