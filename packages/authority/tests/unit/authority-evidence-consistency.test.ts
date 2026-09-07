import { describe, expect, it } from 'vitest';
import {
  actionDocument,
  actionRegistry,
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
async function validate(overrides: Record<string, unknown>, action = actionDocument()) {
  const document = evidenceDocument(overrides) as { view: unknown };
  return (await runtimeApi()).validateAuthorityEvidence(document.view, {
    current: evidenceBindings({ actionContracts: actionRegistry([action]) }),
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

const machine = { kind: 'derived-machine', actor: 'binding', transition: 'bind' };
const initiator = { kind: 'human', role: 'architect', declaration_source: 'cli-flag' };
const machineAction = actionDocument('local-write', {
  ...machine,
  initiator: { allowed_roles: ['architect'], preserve_in_context: true },
});
const ineligible = { ...field('readiness'), authority_eligible: false };
const bootstrapRead = {
  action_id: 'test read',
  action_effect: 'read',
  principal: { kind: 'derived-machine', actor: 'bootstrap' },
  readiness: ineligible,
  decision: { ...field('decision'), evaluation: 'not-applicable', disposition: 'proceed' },
};
const readAction = actionDocument('read', { kind: 'none' });

describe('machine and bootstrap evidence provenance', () => {
  it('accepts a bound machine action with the declared human initiator', async () => {
    expectSuccess(
      await validate({ principal: { ...machine, initiated_by: initiator } }, machineAction),
    );
  });

  it.each([
    ['kind', { kind: 'human' }],
    ['actor', { actor: 'other' }],
    ['transition', { transition: 'other' }],
  ])('rejects an independent machine %s mismatch', async (_name, changed) => {
    expectFailure(
      await validate(
        { principal: { ...machine, initiated_by: initiator, ...changed } },
        machineAction,
      ),
      'refused',
      'AUTHORITY_EVIDENCE_PROVENANCE_INVALID',
    );
  });

  it.each([
    ['absent', undefined],
    ['none', 'none'],
    ['wrong role', { ...initiator, role: 'engineer' }],
  ])('rejects %s human initiation for a machine action', async (_name, initiated_by) => {
    expectFailure(
      await validate({ principal: { ...machine, initiated_by } }, machineAction),
      'refused',
      'AUTHORITY_EVIDENCE_INITIATOR_INVALID',
    );
  });

  it('distinguishes explicit no-initiator actions from human initiated actions', async () => {
    const action = actionDocument('local-write', { ...machine, initiator: 'none' });
    expectSuccess(await validate({ principal: { ...machine, initiated_by: 'none' } }, action));
    expectFailure(
      await validate({ principal: { ...machine, initiated_by: initiator } }, action),
      'refused',
      'AUTHORITY_EVIDENCE_INITIATOR_INVALID',
    );
  });

  it('accepts bootstrap reads only as ineligible audit evidence', async () => {
    const result = expectSuccess<{ audit_only: boolean }>(
      await validate(bootstrapRead, readAction),
    );
    expect(result.audit_only).toBe(true);
  });

  it.each(['allow', 'deny'])('rejects coherent %s bootstrap reads', async (evaluation) => {
    expectFailure(
      await validate(
        {
          ...bootstrapRead,
          decision: {
            ...field('decision'),
            evaluation,
            disposition: evaluation === 'allow' ? 'proceed' : 'refuse',
          },
        },
        readAction,
      ),
      'refused',
      'AUTHORITY_EVIDENCE_BOOTSTRAP_INVALID',
    );
  });

  it('rejects bootstrap authority eligibility before general readiness checks', async () => {
    expectFailure(
      await validate({ ...bootstrapRead, readiness: field('readiness') }, readAction),
      'refused',
      'AUTHORITY_EVIDENCE_BOOTSTRAP_INVALID',
    );
  });

  it.each([
    { kind: 'human', role: 'engineer' },
    { kind: 'derived-machine', actor: 'binding' },
  ])('rejects a non-bootstrap principal on a subject-free read', async (principal) => {
    expectFailure(
      await validate({ ...bootstrapRead, principal }, readAction),
      'refused',
      'AUTHORITY_EVIDENCE_PROVENANCE_INVALID',
    );
  });
});
