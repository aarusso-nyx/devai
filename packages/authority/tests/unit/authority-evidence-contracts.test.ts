import { describe, expect, it, vi } from 'vitest';
import {
  actionDocument,
  actionRegistry,
  canonicalSha256,
  evidenceBindings,
  evidenceDocument,
  expectFailure,
  expectSuccess,
  fsTarget,
  runtimeApi,
} from './authority-runtime-testkit.js';

// Audit-only evidence contracts written against the retained authority mutation diagnostic
// (candidate 3dfdc316, report 414957d9); mutant ids are the report's.

type AnyRecord = Record<string, unknown>;
const viewOf = (document: unknown) => (document as { view: AnyRecord }).view;
const validatorFor = (document: unknown) => (value: unknown) => ({
  ok: true,
  value: { ...(document as object), raw: value },
});

async function validate(document: unknown, current: unknown = evidenceBindings()) {
  return (await runtimeApi()).validateAuthorityEvidence(viewOf(document), {
    current,
    canonicalSha256,
    validateSchema: validatorFor(document),
  });
}

const BOOTSTRAP_SUBJECT = {
  kind: 'derived-machine',
  actor: 'bootstrap',
  transition: 'bind',
  initiator: 'none',
};
const bootstrapPrincipal = { kind: 'derived-machine', actor: 'bootstrap', transition: 'bind' };
const bootstrapBindings = (effect: 'read' | 'local-write') =>
  evidenceBindings({
    actionContracts: actionRegistry([actionDocument(effect, BOOTSTRAP_SUBJECT)]),
  });
const ineligible = {
  authority_eligible: false,
  production_ready: false,
  reason: 'Bootstrap observation.',
};

describe('target summary identity', () => {
  const targets = (kinds: readonly string[]) => {
    const summary = [
      { kind: 'git-ref', operation: 'update', resource_id: 'git:refs/heads/main' },
      { kind: 'db', operation: 'insert', resource_id: 'db:main:orders' },
      { kind: 'fs', operation: 'update', resource_id: fsTarget.id },
    ];
    return {
      count: 3,
      kinds,
      target_ids_digest_sha256: canonicalSha256(summary.map((item) => item.resource_id).sort()),
      summary,
    };
  };

  // Mutants 6779, 6781, 6784-6787: the declared kinds are the sorted unique kinds of the
  // summary, in byte order.
  it('accepts kinds in byte order and refuses any other order', async () => {
    expectSuccess(await validate(evidenceDocument({ targets: targets(['db', 'fs', 'git-ref']) })));
    for (const kinds of [
      ['fs', 'db', 'git-ref'],
      ['git-ref', 'db', 'fs'],
      ['db', 'git-ref', 'fs'],
    ])
      expectFailure(
        await validate(evidenceDocument({ targets: targets(kinds) })),
        'refused',
        'AUTHORITY_EVIDENCE_SEMANTIC_INVALID',
      );
  });
});

describe('validated document identity', () => {
  // Mutant 6810: the validator's document is returned as the evidence, never a re-wrapped
  // copy of the raw input.
  it('returns the validator document itself as the evidence', async () => {
    const document = evidenceDocument();
    const result = (await runtimeApi()).validateAuthorityEvidence(viewOf(document), {
      current: evidenceBindings(),
      canonicalSha256,
      validateSchema: () => ({ ok: true, value: document }),
    });
    expect(expectSuccess<{ evidence: unknown }>(result).evidence).toBe(document);
  });

  // Codex review of de6a9ab (mutants 6952, 6964, 6982, 7042): provenance is established only
  // under a contract whose subject is one of the three declared kinds. A contract with no
  // subject, a null subject, a kind-less subject or an unknown kind proves nothing about the
  // principal and is refused as provenance-invalid, never accepted and never thrown.
  it.each([
    ['no subject', (view: AnyRecord) => delete view.subject],
    ['a null subject', (view: AnyRecord) => (view.subject = null)],
    [
      'a subject without a kind',
      (view: AnyRecord) => (view.subject = { allowed_roles: ['engineer'] }),
    ],
    [
      'an unknown subject kind',
      (view: AnyRecord) => (view.subject = { kind: 'service', allowed_roles: ['engineer'] }),
    ],
  ])('refuses provenance under a contract with %s', async (_name, edit) => {
    const contract = actionDocument() as { view: AnyRecord };
    edit(contract.view);
    const document = evidenceDocument();
    const validateSchema = vi.fn(validatorFor(document));
    const result = (await runtimeApi()).validateAuthorityEvidence(viewOf(document), {
      current: evidenceBindings({ actionContracts: actionRegistry([contract]) }),
      canonicalSha256,
      validateSchema,
    });
    expect(result).toEqual({
      ok: false,
      category: 'refused',
      code: 'AUTHORITY_EVIDENCE_PROVENANCE_INVALID',
      reasons: ['AUTHORITY_EVIDENCE_PROVENANCE_INVALID'],
    });
    expect(validateSchema).toHaveBeenCalledOnce();
  });

  it('accepts provenance under a human contract naming the principal role', async () => {
    const value = expectSuccess<{ evidence: { view: AnyRecord }; audit_only: true }>(
      await validate(evidenceDocument()),
    );
    expect(value.audit_only).toBe(true);
    expect(value.evidence.view.principal).toEqual({
      kind: 'human',
      role: 'engineer',
      declaration_source: 'cli-flag',
    });
  });
});

describe('bootstrap evidence', () => {
  // Mutants 7015, 7022-7027: a bootstrap mutation is coherent only as a refused denial and
  // is accepted as such while ineligible.
  it('accepts a refused bootstrap mutation and refuses a proceeding one', async () => {
    const denied = evidenceDocument({
      principal: bootstrapPrincipal,
      decision: {
        decision_id: 'decision-1',
        decision_digest_sha256: '1'.repeat(64),
        subject_digest_sha256: '2'.repeat(64),
        evaluation: 'deny',
        disposition: 'refuse',
        reason_code: 'AUTHORITY_BOOTSTRAP_DENIED',
        reasons: ['bootstrap cannot mutate'],
      },
      readiness: ineligible,
    });
    expectSuccess(await validate(denied, bootstrapBindings('local-write')));
    const proceeding = evidenceDocument({ principal: bootstrapPrincipal, readiness: ineligible });
    expectFailure(
      await validate(proceeding, bootstrapBindings('local-write')),
      'refused',
      'AUTHORITY_EVIDENCE_BOOTSTRAP_INVALID',
    );
    const incoherent = evidenceDocument({
      principal: bootstrapPrincipal,
      decision: { ...(viewOf(denied).decision as AnyRecord), disposition: 'proceed' },
      readiness: ineligible,
    });
    expectFailure(
      await validate(incoherent, bootstrapBindings('local-write')),
      'refused',
      'AUTHORITY_EVIDENCE_SEMANTIC_INVALID',
    );
  });

  it('accepts a not-applicable bootstrap read and refuses it once eligible', async () => {
    const read = (readiness: AnyRecord) =>
      evidenceDocument({
        action_id: 'test read',
        action_effect: 'read',
        principal: bootstrapPrincipal,
        decision: {
          decision_id: 'decision-1',
          decision_digest_sha256: '1'.repeat(64),
          subject_digest_sha256: '2'.repeat(64),
          evaluation: 'not-applicable',
          disposition: 'proceed',
          reason_code: 'READ_NOT_APPLICABLE',
          reasons: ['read actions need no decision'],
        },
        readiness,
      });
    expectSuccess(await validate(read(ineligible), bootstrapBindings('read')));
    expectFailure(
      await validate(read({ ...ineligible, authority_eligible: true }), bootstrapBindings('read')),
      'refused',
      'AUTHORITY_EVIDENCE_BOOTSTRAP_INVALID',
    );
  });
});

describe('authority eligibility', () => {
  // Mutants 7094, 7096: a read is never authority-eligible, even under a contract that
  // requires binding.
  it('refuses an eligible read even when its contract requires binding', async () => {
    const contract = actionDocument('read') as { view: AnyRecord };
    contract.view.readiness = { requires_binding: true, independent_acceptance_required: true };
    const document = evidenceDocument({ action_id: 'test read', action_effect: 'read' });
    expectFailure(
      await validate(document, evidenceBindings({ actionContracts: actionRegistry([contract]) })),
      'refused',
      'AUTHORITY_EVIDENCE_READINESS_INVALID',
    );
  });
});
