import { describe, expect, it } from 'vitest';
import {
  CONSENT,
  NOW,
  actionDocument,
  canonicalSha256,
  createIssuer,
  declarationDependencies,
  evidenceBindings,
  evidenceDocument,
  expectFailure,
  expectSuccess,
  runtimeApi,
} from './authority-runtime-testkit.js';

// Invariants: INV-AUTH-003, INV-AUTH-004

function viewOf(document: unknown): Record<string, unknown> {
  return (document as { view: Record<string, unknown> }).view;
}

function validatorFor(document: unknown): (value: unknown) => unknown {
  return (value: unknown) => ({
    ok: true,
    value: { ...(document as object), raw: value },
  });
}

describe('R19 audit-only authority evidence', () => {
  it('returns schema-valid current evidence as audit-only data without capability material', async () => {
    const api = await runtimeApi();
    const document = evidenceDocument();
    const raw = viewOf(document);
    const result = api.validateAuthorityEvidence(raw, {
      current: evidenceBindings(),
      canonicalSha256,
      validateSchema: validatorFor(document),
    });
    const value = expectSuccess<{
      evidence: { raw: unknown; canonical_bytes: Uint8Array; view: Record<string, unknown> };
      audit_only: true;
    }>(result);
    expect(value.audit_only).toBe(true);
    expect(value.evidence.raw).toBe(raw);
    expect(value.evidence.canonical_bytes).toBeInstanceOf(Uint8Array);
    expect(value.evidence.view).toMatchObject({
      timestamp: NOW,
      repository_id: 'example-repository',
      issuer_audit: {
        issuer_id: 'test-authority-issuer',
        capability_material_present: false,
        replayable: false,
      },
    });
    expect(value).not.toHaveProperty('receipt');
    expect(value).not.toHaveProperty('capability');
    expect(value).not.toHaveProperty('binding');
  });

  it('preserves discriminated direct and session declaration provenance', async () => {
    const api = await runtimeApi();
    for (const principal of [
      { kind: 'human', role: 'engineer', declaration_source: 'cli-flag' },
      {
        kind: 'human',
        role: 'engineer',
        declaration_source: 'session-state',
        session_id: 'AUTH-SESSION-abcdefghijklmnop',
      },
    ]) {
      const document = evidenceDocument({ principal });
      const result = api.validateAuthorityEvidence(viewOf(document), {
        current: evidenceBindings(),
        canonicalSha256,
        validateSchema: validatorFor(document),
      });
      const value = expectSuccess<{ evidence: { view: { principal: unknown } } }>(result);
      expect(value.evidence.view.principal).toEqual(principal);
    }
  });

  it('accepts shadow observation only when readiness remains authority-ineligible', async () => {
    const api = await runtimeApi();
    const ineligible = evidenceDocument({
      enforcement_mode: 'shadow',
      readiness: {
        authority_eligible: false,
        production_ready: false,
        reason: 'Shadow observation cannot promote readiness.',
      },
    });
    expectSuccess(
      api.validateAuthorityEvidence(viewOf(ineligible), {
        current: evidenceBindings(),
        canonicalSha256,
        validateSchema: validatorFor(ineligible),
      }),
    );

    const falselyEligible = evidenceDocument({
      enforcement_mode: 'shadow',
      readiness: {
        authority_eligible: true,
        production_ready: false,
        reason: 'Invalid promotion attempt.',
      },
    });
    expectFailure(
      api.validateAuthorityEvidence(viewOf(falselyEligible), {
        current: evidenceBindings(),
        canonicalSha256,
        validateSchema: validatorFor(falselyEligible),
      }),
      'refused',
      'AUTHORITY_EVIDENCE_READINESS_INVALID',
    );
  });

  it('keeps validator refusal and validator outage as distinct tagged outcomes', async () => {
    const api = await runtimeApi();
    const invalid = api.validateAuthorityEvidence(
      {},
      {
        current: evidenceBindings(),
        canonicalSha256,
        validateSchema: () => ({
          ok: false,
          category: 'refused',
          code: 'AUTHORITY_EVIDENCE_SCHEMA_INVALID',
          reasons: ['fixture invalid'],
        }),
      },
    );
    expectFailure(invalid, 'refused', 'AUTHORITY_EVIDENCE_SCHEMA_INVALID');
    const unavailable = api.validateAuthorityEvidence(
      {},
      {
        current: evidenceBindings(),
        canonicalSha256,
        validateSchema: () => ({
          ok: false,
          category: 'dependency-error',
          code: 'AUTHORITY_EVIDENCE_VALIDATOR_UNAVAILABLE',
          reasons: ['fixture unavailable'],
        }),
      },
    );
    expectFailure(unavailable, 'dependency-error', 'AUTHORITY_EVIDENCE_VALIDATOR_UNAVAILABLE');
  });

  it.each([
    ['record timestamp', evidenceDocument({ timestamp: '2026-07-15T12:00:01.000Z' })],
    [
      'issuer timestamp',
      evidenceDocument({
        issuer_audit: {
          issuer_id: 'test-authority-issuer',
          issuer_version: '1.0.0',
          issued_at: '2026-07-15T12:00:01.000Z',
          capability_material_present: false,
          replayable: false,
        },
      }),
    ],
  ])('refuses a future %s', async (_name, document) => {
    const api = await runtimeApi();
    const result = api.validateAuthorityEvidence(viewOf(document), {
      current: evidenceBindings(),
      canonicalSha256,
      validateSchema: validatorFor(document),
    });
    expectFailure(result, 'refused', 'AUTHORITY_EVIDENCE_TIMESTAMP_INVALID');
  });

  it.each([
    ['repository', evidenceBindings({ repository_id: 'other-repository' })],
    ['package', evidenceBindings({ package: { name: '@aarusso-nyx/devai', version: '0.5.0' } })],
    [
      'constitution',
      evidenceBindings({
        constitution: { version: '0.5.0', digest_sha256: 'f'.repeat(64) },
      }),
    ],
    [
      'policy',
      evidenceBindings({
        policy: {
          ...(evidenceBindings() as { policy: Record<string, unknown> }).policy,
          resolved_digest_sha256: 'f'.repeat(64),
        },
      }),
    ],
  ])('refuses a current %s binding mismatch', async (_name, current) => {
    const api = await runtimeApi();
    const document = evidenceDocument();
    const result = api.validateAuthorityEvidence(viewOf(document), {
      current,
      canonicalSha256,
      validateSchema: validatorFor(document),
    });
    expectFailure(result, 'refused', 'AUTHORITY_EVIDENCE_BINDING_MISMATCH');
  });

  it('refuses evidence issued by a different issuer identity', async () => {
    const api = await runtimeApi();
    const document = evidenceDocument();
    const result = api.validateAuthorityEvidence(viewOf(document), {
      current: evidenceBindings({
        issuer: { issuer_id: 'foreign-issuer', issuer_version: '1.0.0' },
      }),
      canonicalSha256,
      validateSchema: validatorFor(document),
    });
    expectFailure(result, 'refused', 'AUTHORITY_EVIDENCE_ISSUER_INVALID');
  });

  it('cannot reuse valid evidence as a declaration capability', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api);
    const evidence = evidenceDocument();
    const result = api.deriveMachineAuthorityContext(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-1',
        declaration_receipt: evidence,
        consent: CONSENT,
      },
      {
        actionContracts: (
          declarationDependencies(
            issuer,
            actionDocument('local-write', {
              kind: 'derived-machine',
              actor: 'binding',
              transition: 'bind',
              initiator: { allowed_roles: ['architect'], preserve_in_context: true },
            }),
          ) as { actionContracts: unknown }
        ).actionContracts,
        verifiedOrigin: { kind: 'direct-cli', invocation_id: 'invocation-1' },
        trusted_adapter_id: 'binding-authority',
        receiptStore: issuer,
        canonicalSha256,
      },
    );
    expectFailure(result, 'refused', 'AUTHORITY_DECLARATION_RECEIPT_UNKNOWN');
  });
});
