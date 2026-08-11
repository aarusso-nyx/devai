import { describe, expect, it } from 'vitest';
import { redact, type RedactionPolicy } from '../../src/redact.js';

const policy: RedactionPolicy = {
  patterns: [/sk-[a-z0-9]+/g],
  fields: ['password', 'token'],
};

describe('redact', () => {
  it('redacts matched field values regardless of contents', () => {
    const result = redact({ user: 'alice', password: 'p@ssw0rd' }, policy) as Record<
      string,
      unknown
    >;
    expect(result.user).toBe('alice');
    expect(result.password).toBe('[REDACTED]');
  });

  it('redacts pattern matches inside strings', () => {
    const result = redact('key=sk-abc123 and sk-xyz789', policy);
    expect(result).toBe('key=[REDACTED] and [REDACTED]');
  });

  it('walks nested objects', () => {
    const result = redact({ outer: { token: 'secret', label: 'use sk-deadbeef' } }, policy) as {
      outer: { token: unknown; label: unknown };
    };
    expect(result.outer.token).toBe('[REDACTED]');
    expect(result.outer.label).toBe('use [REDACTED]');
  });

  it('walks arrays', () => {
    const result = redact([{ password: 'a' }, 'plain', 'sk-zzz'], policy);
    expect(result).toEqual([{ password: '[REDACTED]' }, 'plain', '[REDACTED]']);
  });

  it('passes non-redactable primitives through', () => {
    expect(redact(42, policy)).toBe(42);
    expect(redact(true, policy)).toBe(true);
    expect(redact(null, policy)).toBe(null);
    expect(redact(undefined, policy)).toBe(undefined);
  });

  it('does not mutate input', () => {
    const input = { password: 'x' };
    redact(input, policy);
    expect(input.password).toBe('x');
  });
});
// Invariants: INV-DEVAI-001
