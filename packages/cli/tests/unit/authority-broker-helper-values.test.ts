// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { describe, expect, it } from 'vitest';
import {
  actionContractRegistry,
  authorityPolicySemantics,
  expectSuccess,
  flagValue,
  isRecord,
  validatePolicySchema,
} from '../../src/authority/broker.js';
import { canonicalRegistry } from '../../src/define-command.js';

describe('authority broker helper values', () => {
  it.each([
    [{}, true],
    [{ value: 1 }, true],
    [null, false],
    [[], false],
    ['object', false],
    [1, false],
  ] as const)('classifies record value %j as %s', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });

  it('reads only the value following an exact flag', () => {
    expect(flagValue(['--target', 'repo', '--write'], '--target')).toBe('repo');
    expect(flagValue(['--write', '--target'], '--target')).toBeUndefined();
    expect(flagValue(['--target', 'repo'], '--missing')).toBeUndefined();
  });

  it('unwraps only successful results with an owned value', () => {
    expect(expectSuccess<string>({ ok: true, value: 'accepted' })).toBe('accepted');
    expect(() => expectSuccess({ ok: false, code: 'DENIED', value: 'ignored' })).toThrow('DENIED');
    expect(() => expectSuccess({ ok: true })).toThrow('UNKNOWN');
    expect(() => expectSuccess(null)).toThrow('UNKNOWN');
  });

  it('materializes canonical and internal action contracts by exact name', () => {
    const entries = canonicalRegistry();
    const registry = actionContractRegistry(entries);
    const first = entries[0];
    if (first === undefined) throw new Error('missing canonical action');
    expect(registry.get(first.name)).toMatchObject({
      raw: first.authority_contract,
      view: first.authority_contract,
    });
    expect(registry.get(first.name)).toHaveProperty('canonical_bytes');
    expect(registry.get('init record')).toHaveProperty('view.action_id', 'init record');
    expect(registry.get('missing action')).toBeUndefined();
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it('rejects a malformed authority policy with the exact closed result', () => {
    expect(validatePolicySchema({})).toEqual({
      ok: false,
      category: 'refused',
      code: 'AUTHORITY_POLICY_SCHEMA_INVALID',
      reasons: ['AUTHORITY_POLICY_SCHEMA_INVALID'],
    });
  });

  it('removes only materialization metadata from policy semantics', () => {
    expect(
      authorityPolicySemantics({
        schemaVersion: '1.0.0',
        materialized_at: 'time',
        materialization: { source: 'fixture' },
        retained: true,
      }),
    ).toEqual({ schemaVersion: '1.0.0', retained: true });
  });
});
