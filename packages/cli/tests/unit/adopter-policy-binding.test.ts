import { describe, expect, it } from 'vitest';
import { parseAdopterPolicyBinding } from '../../src/services/adopter-policy-binding.js';

const DIGEST = 'a'.repeat(64);

function historicalBinding() {
  return {
    schemaVersion: '1.0.0',
    policy_id: 'devai-adopter-policy',
    policy_version: '1.4.5',
    source_path: 'law/policy/devai-adoption.json',
    source_digest_sha256: DIGEST,
    materialized: {
      '.devai/config/project.json': DIGEST,
      '.devai/config/thresholds.json': 'b'.repeat(64),
    },
  } as const;
}

describe('adopter policy binding parser', () => {
  it('preserves a valid historical v1 binding without selecting or reading files', () => {
    const binding = historicalBinding();

    expect(parseAdopterPolicyBinding(JSON.stringify(binding))).toEqual({ binding });
  });

  it.each([
    ['malformed JSON', '{', 'BINDING_MALFORMED'],
    ['a non-object JSON value', '[]', 'BINDING_MALFORMED'],
    [
      'an unsupported schema version',
      JSON.stringify({ ...historicalBinding(), schemaVersion: '2.0.0' }),
      'BINDING_VERSION_UNSUPPORTED',
    ],
    [
      'a malformed source digest',
      JSON.stringify({ ...historicalBinding(), source_digest_sha256: 'not-a-sha256' }),
      'BINDING_MALFORMED',
    ],
    [
      'a non-map materialized value',
      JSON.stringify({ ...historicalBinding(), materialized: [] }),
      'BINDING_MALFORMED',
    ],
    [
      'a malformed materialized digest',
      JSON.stringify({
        ...historicalBinding(),
        materialized: { '.devai/config/project.json': 'not-a-sha256' },
      }),
      'BINDING_MALFORMED',
    ],
  ])('%s is refused as %s', (_label, bytes, reason) => {
    expect(parseAdopterPolicyBinding(bytes)).toEqual({ reason });
  });

  it('refuses extra or missing root keys under the closed v1 receipt keyset', () => {
    const binding = historicalBinding();
    const missing = { ...binding } as { source_path?: string } & Omit<
      typeof binding,
      'source_path'
    >;
    delete missing.source_path;

    expect(parseAdopterPolicyBinding(JSON.stringify({ ...binding, extra: true }))).toEqual({
      reason: 'BINDING_MALFORMED',
    });
    expect(parseAdopterPolicyBinding(JSON.stringify(missing))).toEqual({
      reason: 'BINDING_MALFORMED',
    });
  });
});
