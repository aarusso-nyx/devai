import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSENT,
  NOW,
  actionDocument,
  canonicalSha256,
  createIssuer,
  declarationDependencies,
  engineerRule,
  expectSuccess,
  fsTarget,
  makePolicyPlant,
  runtimeApi,
} from './authority-runtime-testkit.js';

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));
async function fixture(subjects?: readonly unknown[]) {
  const api = await runtimeApi(),
    issuer = createIssuer(api);
  disposers.push(() => {
    issuer.dispose();
  });
  const plant = makePolicyPlant(
    subjects === undefined ? {} : { additiveRules: [{ ...engineerRule, subjects }] },
  );
  const policy = expectSuccess<{ provenance: unknown }>(
    api.loadAuthorityPolicy({ document: plant.document }, plant.deps),
  );
  const declaration = expectSuccess<{ context_receipt: unknown }>(
    api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-1',
        dry_run: false,
        declaration: { as_role: 'engineer' },
        consent: CONSENT,
      },
      declarationDependencies(issuer, undefined, undefined, policy.provenance),
    ),
  );
  const query: Record<string, unknown> = {
    action_id: 'test mutate',
    context_receipt: declaration.context_receipt,
    consent: CONSENT,
    resource: fsTarget,
    operation: 'update',
  };
  return {
    policy,
    query,
    resolve: (input = query) =>
      api.resolveAuthorityPolicy(policy, input, { receiptStore: issuer, canonicalSha256 }),
  };
}

describe('policy query and decision identity', () => {
  it.each(
    [
      { name: 'architect initiator', allowedRole: 'architect', allowed: true, subject: undefined },
      { name: 'engineer initiator', allowedRole: 'engineer', allowed: false, subject: undefined },
      {
        name: 'human architect rule',
        allowedRole: 'architect',
        allowed: false,
        subject: { kind: 'human', roles: ['architect'] },
      },
      {
        name: 'human engineer rule',
        allowedRole: 'architect',
        allowed: false,
        subject: { kind: 'human', roles: ['engineer'] },
      },
      {
        name: 'different release machine',
        allowedRole: 'architect',
        allowed: false,
        subject: {
          kind: 'derived-machine',
          actor: 'release',
          transition: 'release',
          initiator: { allowed_roles: ['architect'], preserve_in_context: true },
        },
      },
      {
        name: 'harness without initiator',
        allowedRole: 'architect',
        allowed: false,
        subject: {
          kind: 'derived-machine',
          actor: 'harness',
          transition: 'harness-write',
          initiator: 'none',
        },
      },
      {
        name: 'matching harness with no policy initiator restriction',
        allowedRole: 'architect',
        allowed: true,
        harness: true,
        subject: {
          kind: 'derived-machine',
          actor: 'harness',
          transition: 'harness-write',
          initiator: 'none',
        },
      },
    ].map((entry) => ({ harness: false, ...entry })),
  )(
    'matches a derived context against $name',
    async ({ allowedRole, allowed, subject, harness }) => {
      const api = await runtimeApi(),
        issuer = createIssuer(api);
      disposers.push(() => {
        issuer.dispose();
      });
      const action = actionDocument(harness ? 'harness-write' : 'local-write', {
        kind: 'derived-machine',
        actor: harness ? 'harness' : 'binding',
        transition: harness ? 'harness-write' : 'bind',
        initiator: { allowed_roles: ['architect'], preserve_in_context: true },
      });
      const plant = makePolicyPlant({
        additiveRules: [
          {
            ...engineerRule,
            subjects: [
              subject ?? {
                kind: 'derived-machine',
                actor: 'binding',
                transition: 'bind',
                initiator: { allowed_roles: [allowedRole], preserve_in_context: true },
              },
            ],
          },
        ],
      });
      const policy = expectSuccess<{ provenance: unknown }>(
        api.loadAuthorityPolicy({ document: plant.document }, plant.deps),
      );
      const deps = declarationDependencies(issuer, action, undefined, policy.provenance);
      const declaration = expectSuccess<{ declaration_receipt: unknown }>(
        api.resolveAuthorityDeclaration(
          {
            action_id: 'test mutate',
            invocation_id: 'invocation-1',
            dry_run: false,
            declaration: { as_role: 'architect' },
            consent: CONSENT,
          },
          deps,
        ),
      );
      const derived = expectSuccess<{ context_receipt: unknown }>(
        api.deriveMachineAuthorityContext(
          {
            action_id: 'test mutate',
            invocation_id: 'invocation-1',
            declaration_receipt: declaration.declaration_receipt,
            consent: CONSENT,
          },
          {
            actionContracts: deps.actionContracts,
            receiptStore: issuer,
            verifiedOrigin: { kind: 'direct-cli', invocation_id: 'invocation-1' },
            trusted_adapter_id: harness ? 'harness-authority' : 'binding-authority',
            canonicalSha256,
          },
        ),
      );
      const result = api.resolveAuthorityPolicy(
        policy,
        {
          action_id: 'test mutate',
          context_receipt: derived.context_receipt,
          consent: CONSENT,
          resource: fsTarget,
          operation: 'update',
        },
        { receiptStore: issuer, canonicalSha256 },
      );
      expect(result).toMatchObject({
        outcome: allowed ? 'allow' : 'deny',
        code: allowed ? 'POLICY_ALLOW' : 'AUTHORITY_SUBJECT_DENIED',
        matched_rule_ids: [engineerRule.rule_id],
        obligations: [],
      });
    },
  );

  it('refuses a human receipt for a machine-only rule even without an initiator requirement', async () => {
    const h = await fixture([
      { kind: 'derived-machine', actor: 'harness', transition: 'harness-write', initiator: 'none' },
    ]);
    expect(h.resolve()).toMatchObject({
      outcome: 'deny',
      code: 'AUTHORITY_SUBJECT_DENIED',
      matched_rule_ids: [engineerRule.rule_id],
      obligations: [],
    });
  });

  it('binds a complete allowed outcome to the actual human, resource, policy and consent', async () => {
    const h = await fixture(),
      policyDigest = canonicalSha256(h.policy.provenance);
    const result = h.resolve();
    expect(result).toEqual({
      outcome: 'allow',
      code: 'POLICY_ALLOW',
      policy_binding_digest_sha256: policyDigest,
      resource_target_id: fsTarget.id,
      resource_kind: 'fs',
      operation: 'update',
      matched_rule_ids: [engineerRule.rule_id],
      obligations: [],
      query_digest_sha256: canonicalSha256({
        policy_binding_digest_sha256: policyDigest,
        action_id: 'test mutate',
        subject: {
          kind: 'human',
          role: 'engineer',
          declaration: { source: 'cli-flag', declared_at: NOW },
        },
        operation: 'update',
        resource: fsTarget,
        consent: CONSENT,
      }),
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each(['action_id', 'context_receipt', 'consent', 'resource', 'operation'])(
    'rejects missing query field %s',
    async (field) => {
      const h = await fixture();
      Reflect.deleteProperty(h.query, field);
      const code =
        field === 'context_receipt'
          ? 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN'
          : 'AUTHORITY_QUERY_INVALID';
      expect(h.resolve()).toMatchObject({
        outcome: 'deny',
        category: 'refused',
        code,
        reasons: [code],
        matched_rule_ids: [],
        obligations: [],
      });
    },
  );
  it.each(['principal', 'subject', 'policy', 'allow_publish'])(
    'rejects injected query authority %s',
    async (field) => {
      const h = await fixture();
      h.query[field] = true;
      expect(h.resolve()).toEqual({
        outcome: 'deny',
        category: 'refused',
        code: 'AUTHORITY_QUERY_INVALID',
        reasons: ['AUTHORITY_QUERY_INVALID'],
        policy_binding_digest_sha256: canonicalSha256(h.policy.provenance),
        resource_target_id: fsTarget.id,
        resource_kind: 'fs',
        operation: 'update',
        matched_rule_ids: [],
        obligations: [],
        query_digest_sha256: canonicalSha256(h.query),
      });
    },
  );
  it.each([
    { field: 'action_id', value: 1 },
    { field: 'action_id', value: null },
    { field: 'consent', value: null },
    { field: 'consent', value: [] },
    { field: 'resource', value: null },
    { field: 'operation', value: 1 },
  ])('rejects malformed query field $field=$value', async ({ field, value }) => {
    const h = await fixture();
    h.query[field] = value;
    expect(h.resolve()).toMatchObject({
      outcome: 'deny',
      code: 'AUTHORITY_QUERY_INVALID',
      reasons: ['AUTHORITY_QUERY_INVALID'],
      obligations: [],
    });
  });
  it('preserves complete denial details for a classified operation mismatch', async () => {
    const h = await fixture();
    h.query.operation = 'delete';
    expect(h.resolve()).toEqual({
      outcome: 'deny',
      category: 'refused',
      code: 'AUTHORITY_QUERY_OPERATION_MISMATCH',
      reasons: ['AUTHORITY_QUERY_OPERATION_MISMATCH'],
      policy_binding_digest_sha256: canonicalSha256(h.policy.provenance),
      resource_target_id: fsTarget.id,
      resource_kind: 'fs',
      operation: 'update',
      matched_rule_ids: [],
      obligations: [],
      query_digest_sha256: canonicalSha256(h.query),
    });
  });
});
