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

it.each([
  'EFFECT_UNDER_DECLARED',
  'SPAWN_EFFECT_UNDECLARED',
  'EFFECT_EDGE_UNRESOLVED',
  'EFFECT_EXTRACTOR_CATALOG_MISMATCH',
  'EFFECT_CAPABILITIES_MISSING',
  'EFFECT_CONTRACT_MISSING',
])('blocks %s with exact action attribution and aggregated diagnostics', (code) => {
  expect(() =>
    enforceEffectReport({
      findings: [
        { code, action_id: 'fixture action', message: 'first' },
        { code: 'EFFECT_OVER_DECLARED', message: 'advisory' },
        { code, message: 'second' },
      ],
    }),
  ).toThrow(new Error(`${code}:fixture action\n${code}`));
});
