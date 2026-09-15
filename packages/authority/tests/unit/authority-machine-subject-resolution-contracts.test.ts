import { afterEach, describe, expect, it } from 'vitest';
import { parsers } from '@devai-nyx/schemas';
import { loadAuthorityPolicy, resolveAuthorityPolicy } from '../../src/runtime/index.js';
import {
  CONSENT,
  actionDocument,
  canonicalSha256,
  createIssuer,
  declarationDependencies,
  engineerRule,
  expectSuccess,
  fsTarget,
  makePolicyPlant,
  policyBindingFromPlant,
  runtimeApi,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';

// Derived-machine subject resolution contracts written against the retained authority
// mutation diagnostic (candidate 3dfdc316, report 414957d9); mutant ids are the report's.
// Every query carries a genuine machine context derived from an Architect declaration, so
// the rule subject is matched against the issuer's own machine principal.

type AnyRecord = Record<string, unknown>;
const INVOCATION = 'invocation-binding';
const issuers: AuthorityDecisionIssuer[] = [];
afterEach(() => {
  for (const issuer of issuers.splice(0)) issuer.dispose();
});

const ARCHITECT_INITIATOR = { allowed_roles: ['architect'], preserve_in_context: true };
/** Action subjects: the machine principal the declaration derives, initiated by an Architect. */
const BINDING_ACTION = {
  kind: 'derived-machine',
  actor: 'binding',
  transition: 'bind',
  initiator: ARCHITECT_INITIATOR,
};
const HARNESS_ACTION = {
  kind: 'derived-machine',
  actor: 'harness',
  transition: 'harness-write',
  initiator: ARCHITECT_INITIATOR,
};

const machineRule = (subject: AnyRecord) => ({
  ...engineerRule,
  rule_id: 'machine-rule',
  subjects: [subject],
});

/**
 * Every policy here is a valid product policy: `law/schemas/authority-policy.schema.json`
 * `machineSubject` admits `initiator: 'none'` only beside `harness`/`harness-write`, and
 * requires `binding`/`bind` and `release`/`release` to name an object initiator with exactly
 * `['architect']` and `preserve_in_context: true`. Conformity is asserted, not assumed.
 */
async function resolveAsMachine(actionSubject: AnyRecord, ruleSubject: AnyRecord) {
  const plant = makePolicyPlant({ additiveRules: [machineRule(ruleSubject)] });
  expect(parsers.authorityPolicy.safeParse(plant.document).ok).toBe(true);
  const api = await runtimeApi();
  const issuer = createIssuer(api, { invocation_id: INVOCATION });
  issuers.push(issuer);
  const deps = declarationDependencies(
    issuer,
    actionDocument('local-write', actionSubject),
    undefined,
    policyBindingFromPlant(plant),
  );
  const declaration = expectSuccess<{ declaration_receipt: unknown }>(
    api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: INVOCATION,
        dry_run: false,
        declaration: { as_role: 'architect' },
        consent: CONSENT,
      },
      deps,
    ),
  );
  const context = expectSuccess<{ context_receipt: unknown }>(
    api.deriveMachineAuthorityContext(
      {
        action_id: 'test mutate',
        invocation_id: INVOCATION,
        declaration_receipt: declaration.declaration_receipt,
        consent: CONSENT,
      },
      {
        actionContracts: deps.actionContracts,
        verifiedOrigin: { kind: 'direct-cli', invocation_id: INVOCATION },
        trusted_adapter_id: 'binding-authority',
        receiptStore: issuer,
        canonicalSha256,
      },
    ),
  );
  const policy = expectSuccess(loadAuthorityPolicy({ document: plant.document }, plant.deps));
  return resolveAuthorityPolicy(
    policy,
    {
      action_id: 'test mutate',
      context_receipt: context.context_receipt,
      consent: CONSENT,
      resource: fsTarget,
      operation: 'update',
    },
    { receiptStore: issuer },
  ) as AnyRecord;
}

describe('derived-machine rule subjects under valid product policies', () => {
  // Mutants 8334-8337, 8351, 8353: a machine principal matches a derived-machine rule
  // subject only when actor and transition agree and the preserved initiator's role is
  // allowed.
  it('allows the binding principal under the binding rule naming its Architect initiator', async () => {
    const result = await resolveAsMachine(BINDING_ACTION, {
      kind: 'derived-machine',
      actor: 'binding',
      transition: 'bind',
      initiator: ARCHITECT_INITIATOR,
    });
    expect(result).toMatchObject({ outcome: 'allow', matched_rule_ids: ['machine-rule'] });
  });

  it('allows the harness principal under a harness rule that names no initiator', async () => {
    const result = await resolveAsMachine(HARNESS_ACTION, {
      kind: 'derived-machine',
      actor: 'harness',
      transition: 'harness-write',
      initiator: 'none',
    });
    expect(result).toMatchObject({ outcome: 'allow', matched_rule_ids: ['machine-rule'] });
  });

  it('denies the harness principal under a harness rule allowing another initiator role', async () => {
    const result = await resolveAsMachine(HARNESS_ACTION, {
      kind: 'derived-machine',
      actor: 'harness',
      transition: 'harness-write',
      initiator: { allowed_roles: ['inspector'], preserve_in_context: true },
    });
    expect(result).toMatchObject({ outcome: 'deny', code: 'AUTHORITY_SUBJECT_DENIED' });
  });

  it.each([
    ['binding principal', BINDING_ACTION, 'release', 'release'],
    ['harness principal', HARNESS_ACTION, 'binding', 'bind'],
  ])(
    'denies the %s under a rule for the %s/%s transition',
    async (_name, action, actor, transition) => {
      const result = await resolveAsMachine(action, {
        kind: 'derived-machine',
        actor,
        transition,
        initiator: ARCHITECT_INITIATOR,
      });
      expect(result).toMatchObject({ outcome: 'deny', code: 'AUTHORITY_SUBJECT_DENIED' });
    },
  );

  it('denies the machine principal under a human rule subject naming the initiating role', async () => {
    const result = await resolveAsMachine(BINDING_ACTION, { kind: 'human', roles: ['architect'] });
    expect(result).toMatchObject({ outcome: 'deny', code: 'AUTHORITY_SUBJECT_DENIED' });
  });
});
