import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';
import { canonicalSha256, omitPaths, schemaExample } from '../fixtures/governance-v15.js';

type Json = Record<string, unknown>;

describe('exact effect authorization ledger contracts', () => {
  const validateEvent = getValidator('effect-authorization-event.schema.json');
  const validateLedger = getValidator('effect-authorization-ledger.schema.json');

  it('binds the grant id, payload digest, and ledger head to canonical event bytes', () => {
    const event = schemaExample<Json>('effect-authorization-event.schema.json');
    const payloadDigest = canonicalSha256(omitPaths(event, ['event_id', 'payload_digest_sha256']));
    expect(event.payload_digest_sha256).toBe(payloadDigest);
    expect(event.event_id).toBe(`EA-${payloadDigest.slice(0, 16)}`);

    const eventDigest = canonicalSha256(event);
    const ledger = schemaExample<Json>('effect-authorization-ledger.schema.json');
    expect(ledger.head).toMatchObject({
      sequence: 1,
      event_id: event.event_id,
      event_digest_sha256: eventDigest,
    });
    expect(validateEvent(event)).toBe(true);
    expect(validateLedger(ledger)).toBe(true);
  });

  it('rejects wildcard scope, bearer transfer, delegation, wrong role, and reusable grants', () => {
    const grant = schemaExample<Json>('effect-authorization-event.schema.json');
    const resource = grant.resource as Json;
    for (const invalid of [
      { ...grant, action_id: 'release *' },
      { ...grant, resource: { ...resource, exact_identifier: '@aarusso-nyx/*' } },
      { ...grant, bearer_transferable: true },
      { ...grant, delegable: true },
      { ...grant, one_time: false },
      { ...grant, uses_permitted: 2 },
      { ...grant, grantor: { kind: 'machine', role: 'owner', declaration_source: 'cli-flag' } },
    ]) {
      expect(validateEvent(invalid)).toBe(false);
    }
  });

  it('rejects terminal events without a grant reference or consumed state binding', () => {
    const grant = schemaExample<Json>('effect-authorization-event.schema.json');
    for (const invalid of [
      { ...grant, kind: 'consumed', grant_event_id: null },
      { ...grant, kind: 'consumed', grant_event_id: grant.event_id },
      { ...grant, kind: 'revoked', grant_event_id: grant.event_id },
    ]) {
      expect(validateEvent(invalid)).toBe(false);
    }
  });

  it('declares schema validation insufficient for replay, chain, identity, and expiry checks', () => {
    const ledger = schemaExample<Json>('effect-authorization-ledger.schema.json');
    const verifier = ledger.semantic_verifier as {
      schema_validation_alone_establishes_authorization: boolean;
      errors: string[];
    };
    expect(verifier.schema_validation_alone_establishes_authorization).toBe(false);
    expect(verifier.errors).toEqual(
      expect.arrayContaining([
        'eal-grant-consumed-more-than-once',
        'eal-grant-identity-mismatch',
        'eal-consume-outside-live-window',
        'eal-previous-digest-mismatch',
        'eal-head-not-final-entry',
      ]),
    );
  });
});
