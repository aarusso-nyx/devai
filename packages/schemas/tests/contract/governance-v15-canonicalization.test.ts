import { describe, expect, it } from 'vitest';
import { canonicalSha256, omitPaths, schemaExample } from '../fixtures/governance-v15.js';

type Json = Record<string, unknown>;

describe('governance receipt canonicalization fixtures', () => {
  it.each([
    ['release-plan-receipt.schema.json', 'RPL'],
    ['release-offline-verification-receipt.schema.json', 'ROV'],
  ])('reproduces the %s canonical digest and derived id', (schemaName, prefix) => {
    const receipt = schemaExample<Json>(schemaName);
    const digest = canonicalSha256(omitPaths(receipt, ['receipt_id', 'receipt_digest_sha256']));
    expect(receipt.receipt_digest_sha256).toBe(digest);
    expect(receipt.receipt_id).toBe(`${prefix}-${digest.slice(0, 16)}`);
  });

  it('reproduces publication signed-payload and whole-receipt digests', () => {
    const receipt = schemaExample<Json>('release-publication-receipt.schema.json');
    const signedPayload = canonicalSha256(
      omitPaths(receipt, [
        'receipt_id',
        'trust.signature',
        'trust.signed_payload_digest_sha256',
        'receipt_digest_sha256',
      ]),
    );
    expect((receipt.trust as Json).signed_payload_digest_sha256).toBe(signedPayload);
    expect(receipt.receipt_id).toBe(`RPU-${signedPayload.slice(0, 16)}`);
    expect(receipt.receipt_digest_sha256).toBe(
      canonicalSha256(omitPaths(receipt, ['receipt_digest_sha256'])),
    );
  });

  it('does not treat a schema-valid signature as verified without external trust input', () => {
    const receipt = schemaExample<Json>('release-publication-receipt.schema.json');
    const trust = receipt.trust as Json;
    expect(trust.signature).toEqual(expect.any(String));
    expect(receipt).not.toHaveProperty('public_key');
    expect(receipt).not.toHaveProperty('trust_store');
    expect(receipt.grants).toMatchObject({
      authority: false,
      publication_authority: false,
      lifecycle_transition: false,
      appended_as_state_record: false,
    });
  });
});
