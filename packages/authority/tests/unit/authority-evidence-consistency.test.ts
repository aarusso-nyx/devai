import { describe, expect, it } from 'vitest';
import {
  canonicalSha256,
  evidenceBindings,
  evidenceDocument,
  expectFailure,
  expectSuccess,
  runtimeApi,
} from './authority-runtime-testkit.js';

function view(overrides: Record<string, unknown> = {}) {
  return (evidenceDocument(overrides) as { view: Record<string, unknown> }).view;
}
function field(name: string) {
  return view()[name] as Record<string, unknown>;
}
async function validate(overrides: Record<string, unknown>) {
  const document = evidenceDocument(overrides) as { view: unknown };
  return (await runtimeApi()).validateAuthorityEvidence(document.view, {
    current: evidenceBindings(),
    canonicalSha256,
    // Exercise semantic validation after the separately tested schema boundary.
    validateSchema: () => ({ ok: true, value: document }),
  });
}

describe('authority evidence independent consistency checks', () => {
  it('canonicalizes a mixed target population without mutating its order', async () => {
    const summary = [
      { kind: 'remote', operation: 'publish', resource_id: 'z' },
      { kind: 'fs', operation: 'update', resource_id: 'b' },
      { kind: 'fs', operation: 'update', resource_id: 'a' },
    ];
    expectSuccess(
      await validate({
        targets: {
          count: 3,
          kinds: ['fs', 'remote'],
          summary,
          target_ids_digest_sha256: canonicalSha256(['a', 'b', 'z']),
        },
      }),
    );
    expect(summary.map((entry) => entry.resource_id)).toEqual(['z', 'b', 'a']);
  });

  it.each([
    ['count', { count: 2 }],
    ['kinds', { kinds: ['remote'] }],
    ['digest', { target_ids_digest_sha256: 'f'.repeat(64) }],
  ])('rejects independently incorrect target %s', async (_name, changed) => {
    expectFailure(
      await validate({ targets: { ...field('targets'), ...changed } }),
      'refused',
      'AUTHORITY_EVIDENCE_SEMANTIC_INVALID',
    );
  });

  it.each([
    ['allow', 'refuse'],
    ['deny', 'proceed'],
    ['not-applicable', 'proceed'],
    ['not-applicable', 'refuse'],
  ])('rejects incoherent write decision %s/%s', async (evaluation, disposition) => {
    expectFailure(
      await validate({ decision: { ...field('decision'), evaluation, disposition } }),
      'refused',
      'AUTHORITY_EVIDENCE_SEMANTIC_INVALID',
    );
  });

  it('accepts a denied write as ineligible audit evidence', async () => {
    expectSuccess(
      await validate({
        decision: { ...field('decision'), evaluation: 'deny', disposition: 'refuse' },
        readiness: { ...field('readiness'), authority_eligible: false },
      }),
    );
  });

  it.each([
    ['record syntax', { timestamp: 'invalid' }],
    ['issuer syntax', { issuer_audit: { ...field('issuer_audit'), issued_at: 'invalid' } }],
    ['issuer after record', { timestamp: '2026-07-15T11:59:59.000Z' }],
  ])('rejects %s independently of future time', async (_name, changed) => {
    expectFailure(await validate(changed), 'refused', 'AUTHORITY_EVIDENCE_TIMESTAMP_INVALID');
  });

  it('rejects an issuer version mismatch with the correct issuer ID', async () => {
    expectFailure(
      await validate({ issuer_audit: { ...field('issuer_audit'), issuer_version: '9.0.0' } }),
      'refused',
      'AUTHORITY_EVIDENCE_ISSUER_INVALID',
    );
  });

  it.each([
    ['unknown action', { action_id: 'unknown action' }],
    ['effect mismatch', { action_effect: 'remote-write' }],
    ['human role', { principal: { kind: 'human', role: 'owner', declaration_source: 'cli-flag' } }],
    [
      'principal kind',
      { principal: { kind: 'derived-machine', actor: 'binding', transition: 'bind' } },
    ],
  ])('rejects independent %s provenance', async (_name, changed) => {
    expectFailure(await validate(changed), 'refused', 'AUTHORITY_EVIDENCE_PROVENANCE_INVALID');
  });

  it.each([
    ['dry run', { dry_run: true }],
    ['production promotion', { readiness: { ...field('readiness'), production_ready: true } }],
    [
      'unverified host',
      { host_enforcement: { mode: 'host-integrated', attestation: 'unverified' } },
    ],
    ['unknown host mode', { host_enforcement: { mode: 'unknown', attestation: 'verified' } }],
    ['missing host', { host_enforcement: undefined }],
  ])('rejects %s authority eligibility', async (_name, changed) => {
    expectFailure(await validate(changed), 'refused', 'AUTHORITY_EVIDENCE_READINESS_INVALID');
  });

  it('accepts verified host integration while preserving audit-only status', async () => {
    const result = expectSuccess<{ audit_only: boolean }>(
      await validate({
        host_enforcement: { mode: 'host-integrated', attestation: 'verified' },
      }),
    );
    expect(result.audit_only).toBe(true);
  });
});
