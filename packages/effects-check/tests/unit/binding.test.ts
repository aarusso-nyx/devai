import { describe, expect, it } from 'vitest';
import {
  enforceEffectReport,
  parseActionEffectsSource,
  validateDeclaredCapabilityConsistency,
} from '../../src/index.js';

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

it('does not interpret an unrelated object as the action-effect declaration', () => {
  expect(
    parseActionEffectsSource(`
    const OTHER = { unrelated: 'remote-write' };
    const ACTION_EFFECTS = { doctor: 'read' } as const;
    const AFTER = { later: 'local-write' };
  `),
  ).toEqual({ doctor: 'read' });
});

it.each([
  "({ doctor: 'read' })",
  "({ doctor: 'read' } as const)",
  "({ doctor: 'read' } satisfies Record<string, string>)",
  "(<Record<string, string>>{ doctor: 'read' })",
])('extracts a wrapped action declaration: %s', (expression) => {
  expect(parseActionEffectsSource(`const ACTION_EFFECTS = ${expression};`)).toEqual({
    doctor: 'read',
  });
});

it('ignores computed, shorthand, method and non-literal effect declarations', () => {
  expect(
    parseActionEffectsSource(`
    const action = 'computed', shorthand = 'read';
    const ACTION_EFFECTS = {
      [action]: 'remote-write', shorthand, method() { return 'read'; },
      dynamic: selectEffect(), 'docs publish': ('remote-write' as const),
    };
  `),
  ).toEqual({ 'docs publish': 'remote-write' });
});

it('rejects an extra contract even when every catalog action is present', () => {
  expect(() =>
    validateDeclaredCapabilityConsistency({
      catalog: ['doctor'],
      contracts: [
        { action_id: 'doctor', effect: 'read', capabilities: [] },
        { action_id: 'unexpected', effect: 'remote-write', capabilities: ['net:publish'] },
      ],
    }),
  ).toThrow(new Error('EFFECT_CONTRACT_CATALOG_MISMATCH'));
});

it('rejects a missing contract with the exact affected action', () => {
  expect(() =>
    validateDeclaredCapabilityConsistency({ catalog: ['doctor'], contracts: [] }),
  ).toThrow(new Error('doctor: EFFECT_CONTRACT_MISSING'));
});

it('accepts a complete read-only catalog with explicitly empty capabilities', () => {
  expect(() =>
    validateDeclaredCapabilityConsistency({
      catalog: ['doctor'],
      contracts: [{ action_id: 'doctor', effect: 'read', capabilities: [] }],
    }),
  ).not.toThrow();
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
