import { describe, expect, it } from 'vitest';
import {
  createIssuer,
  expectFailure,
  expectSuccess,
  runtimeApi,
} from './authority-runtime-testkit.js';

// Invariants: INV-AUTH-003

describe('R19 authority decision issuer construction and lifecycle', () => {
  it.each([0, 30_001, 1.5, Number.NaN])(
    'throws only for invalid trusted receipt TTL dependency %s',
    async (receiptTtl) => {
      const api = await runtimeApi();
      expect(() => createIssuer(api, { receipt_ttl_ms: receiptTtl })).toThrow(/ttl|1.*30000/i);
    },
  );

  it('constructs the sole receipt-store identity without accepting another store', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api);
    expect(issuer.issuer_id).toBe('test-authority-issuer');
    expect(issuer.issuer_version).toBe('1.0.0');
    expect(issuer).not.toHaveProperty('receiptStore');
    expect(issuer).not.toHaveProperty('register');
    expect(issuer).not.toHaveProperty('lookup');
    expect(issuer).not.toHaveProperty('bless');
    expect(issuer).not.toHaveProperty('verifyDecision');
  });

  it('disposes once and then returns the stable closed-issuer refusal from every operation', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api);
    expectSuccess<{ disposed: true }>(issuer.dispose());
    expectFailure(issuer.dispose(), 'refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    expectFailure(issuer.issueAllow({}), 'refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    expectFailure(issuer.issueDenial({}), 'refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    expectFailure(issuer.consume({}), 'refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
  });

  it('does not expose an API that accepts and blesses a caller-supplied Decision', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api);
    const names = new Set([
      ...Object.keys(issuer),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(issuer) as object),
    ]);
    for (const required of ['issueAllow', 'issueDenial', 'consume', 'dispose']) {
      expect(names.has(required)).toBe(true);
    }
    for (const forbidden of ['bless', 'verifyDecision', 'register', 'lookup']) {
      expect(names.has(forbidden)).toBe(false);
    }
  });
});
