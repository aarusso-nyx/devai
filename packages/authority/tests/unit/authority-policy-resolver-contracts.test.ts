import { afterEach, describe, expect, it } from 'vitest';
import { resourceValid, selectorMatches } from '../../src/runtime/policy-resolver.js';
import { dbTarget, gitTarget } from './authority-boundary-testkit.js';
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
  runtimeApi,
  secondFsTarget,
} from './authority-runtime-testkit.js';

// Policy resolver contract cases written against the retained authority mutation
// diagnostic (candidate 3dfdc316, report 414957d9), for runtime/policy-resolver.ts.
// policy-resource-matching.test.ts pins the resource grammar and selector isolation,
// policy-query-binding.test.ts the query identity and derived-machine subjects, and
// authority-policy-precedence.test.ts precedence. The cases here pin the guards those
// leave open: selectors and rules missing optional members, the fields of a denial, and
// each binding of a resolution to its context, subject and consent.

type AnyRecord = Record<string, unknown>;

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));

async function session(rules: readonly unknown[] = [engineerRule]) {
  const api = await runtimeApi();
  const issuer = createIssuer(api);
  disposers.push(() => {
    issuer.dispose();
  });
  const plant = makePolicyPlant({ additiveRules: rules });
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
      declarationDependencies(issuer, actionDocument(), undefined, policy.provenance),
    ),
  );
  const query: AnyRecord = {
    action_id: 'test mutate',
    context_receipt: declaration.context_receipt,
    consent: CONSENT,
    resource: fsTarget,
    operation: 'update',
  };
  return {
    api,
    issuer,
    policy,
    query,
    resolve: (input: AnyRecord = query, receiptStore: unknown = issuer) =>
      api.resolveAuthorityPolicy(policy, input, { receiptStore, canonicalSha256 }) as AnyRecord,
  };
}

const fsSelector = {
  kind: 'fs',
  repository_id: fsTarget.repository_id,
  canonical_relative_path_glob: 'packages/**',
  operations: ['update'],
};

describe('resource and selector guards', () => {
  // Mutant 8161: an unknown kind is never read as a remote resource, even with remote fields.
  it('rejects an unknown kind carrying remote-shaped fields', () => {
    expect(
      resourceValid({
        kind: 'http',
        id: 'http:x',
        system_id: 'registry',
        endpoint_id: 'packages',
        operation_id: 'publish',
        publication: false,
      }),
    ).toBe(false);
  });

  // Mutants 8208, 8227, 8252, 8266, 8273: a selector without its operation list never
  // matches an operation, still classifies, and never throws.
  it.each([
    ['fs', fsSelector, fsTarget],
    [
      'git-ref',
      {
        kind: 'git-ref',
        repository_id: gitTarget.repository_id,
        ref_glob: 'refs/heads/*',
        operations: ['update'],
      },
      gitTarget,
    ],
    [
      'db',
      {
        kind: 'db',
        connection_id: dbTarget.connection_id,
        database_id_glob: '*',
        object_id_glob: '*',
        operations: ['ddl'],
      },
      dbTarget,
    ],
  ])(
    '%s selector without operations classifies but never authorizes an operation',
    (_kind, selector, resource) => {
      const { operations: _operations, ...withoutOperations } = selector as AnyRecord & {
        operations: unknown;
      };
      expect(selectorMatches(selector, resource as AnyRecord)).toBe(true);
      // Without an operation list the selector authorizes nothing: the result is falsy.
      expect(selectorMatches(withoutOperations, resource as AnyRecord)).toBeFalsy();
      expect(selectorMatches(withoutOperations, resource as AnyRecord, true)).toBe(true);
    },
  );

  it('remote selector without endpoint or operation lists never matches and never throws', () => {
    const resource = {
      kind: 'remote',
      id: 'remote:r',
      system_id: 'registry',
      endpoint_id: 'packages',
      operation_id: 'publish',
      publication: false,
    };
    const full = {
      kind: 'remote',
      system_id: 'registry',
      endpoint_ids: ['packages'],
      operation_ids: ['publish'],
      publication: false,
    };
    expect(selectorMatches(full, resource)).toBe(true);
    const { endpoint_ids: _endpoints, ...withoutEndpoints } = full;
    const { operation_ids: _operations, ...withoutOperations } = full;
    expect(selectorMatches(withoutEndpoints, resource)).toBe(false);
    expect(selectorMatches(withoutEndpoints, resource, true)).toBe(false);
    expect(selectorMatches(withoutOperations, resource)).toBeFalsy();
    expect(selectorMatches(withoutOperations, resource, true)).toBe(true);
  });

  // Mutants 8236, 8237: each db glob is validated on its own.
  it.each(['database_id_glob', 'object_id_glob'])(
    'rejects a db selector whose %s is not a glob',
    (field) => {
      const selector = {
        kind: 'db',
        connection_id: dbTarget.connection_id,
        database_id_glob: '*',
        object_id_glob: '*',
        operations: ['ddl'],
        [field]: '/absolute',
      };
      expect(selectorMatches(selector, dbTarget as AnyRecord)).toBe(false);
      expect(selectorMatches(selector, dbTarget as AnyRecord, true)).toBe(false);
    },
  );

  // Mutant 8253: an unknown kind shared by selector and resource never matches, even with
  // remote-shaped fields on both.
  it('never matches an unknown kind shared by selector and resource', () => {
    const selector = {
      kind: 'http',
      system_id: 's',
      endpoint_ids: ['e'],
      operation_ids: ['o'],
      publication: false,
    };
    const resource = {
      kind: 'http',
      id: 'http:x',
      system_id: 's',
      endpoint_id: 'e',
      operation_id: 'o',
      publication: false,
    };
    expect(selectorMatches(selector, resource)).toBe(false);
    expect(selectorMatches(selector, resource, true)).toBe(false);
  });
});

describe('denial record contracts', () => {
  // Mutants 8360, 8363, 8367, 8371: a denial carries the policy digest, the target identity,
  // the operation, its code as the sole reason and no obligations; when the query names no
  // record resource, the identity fields fall back to empty strings.
  it('emits a complete denial for an unknown context receipt', async () => {
    const s = await session();
    const query = { ...s.query, context_receipt: {} };
    expect(s.resolve(query)).toEqual({
      outcome: 'deny',
      category: 'refused',
      code: 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN',
      policy_binding_digest_sha256: canonicalSha256(s.policy.provenance),
      resource_target_id: fsTarget.id,
      resource_kind: 'fs',
      operation: 'update',
      matched_rule_ids: [],
      reasons: ['AUTHORITY_CONTEXT_RECEIPT_UNKNOWN'],
      obligations: [],
      query_digest_sha256: canonicalSha256(query),
    });
  });

  it('falls back to empty identity fields when the query names no record resource', async () => {
    const s = await session();
    const query = {
      action_id: 'test mutate',
      context_receipt: {},
      consent: CONSENT,
      resource: 'fs:README.md',
    };
    expect(s.resolve(query)).toMatchObject({
      code: 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN',
      resource_target_id: '',
      resource_kind: 'fs',
      operation: '',
      reasons: ['AUTHORITY_CONTEXT_RECEIPT_UNKNOWN'],
    });
  });
});

describe('context binding contracts', () => {
  // Mutant 8442: a resolution binds the receipt's issuer, action and consent, each alone.
  it("refuses a receipt resolved through another issuer's store", async () => {
    const s = await session();
    const other = createIssuer(s.api);
    disposers.push(() => {
      other.dispose();
    });
    expect(s.resolve(s.query, other)).toMatchObject({
      outcome: 'deny',
      code: 'AUTHORITY_CONTEXT_RECEIPT_BINDING_MISMATCH',
    });
  });

  it.each<[string, AnyRecord]>([
    ['another action', { action_id: 'other action' }],
    ['different consent', { consent: { ...CONSENT, experimental: true } }],
  ])('refuses a query with %s from the declared context', async (_name, override) => {
    const s = await session();
    expect(s.resolve({ ...s.query, ...override })).toMatchObject({
      outcome: 'deny',
      code: 'AUTHORITY_CONTEXT_RECEIPT_BINDING_MISMATCH',
    });
  });
});

describe('rule matching contracts', () => {
  // Mutant 8480: a rule without action ids never grants an action, and never throws.
  it('denies the action when the matching rule declares no action ids', async () => {
    const { action_ids: _actions, ...withoutActions } = engineerRule;
    const s = await session([withoutActions]);
    expect(s.resolve()).toMatchObject({
      outcome: 'deny',
      code: 'AUTHORITY_ACTION_DENIED',
      matched_rule_ids: [engineerRule.rule_id],
    });
  });

  // Mutants 8323, 8326: a human rule subject matches by declared role, and a rule subject
  // without roles matches nobody rather than throwing.
  it('denies a human principal whose role the rule does not list', async () => {
    const s = await session([{ ...engineerRule, subjects: [{ kind: 'human', roles: ['owner'] }] }]);
    expect(s.resolve()).toMatchObject({
      outcome: 'deny',
      code: 'AUTHORITY_SUBJECT_DENIED',
      matched_rule_ids: [engineerRule.rule_id],
    });
  });

  it('denies when the rule subject lists no roles at all', async () => {
    const s = await session([{ ...engineerRule, subjects: [{ kind: 'human' }] }]);
    expect(s.resolve()).toMatchObject({ outcome: 'deny', code: 'AUTHORITY_SUBJECT_DENIED' });
  });

  // Mutant 8491: one matching subject among several is enough.
  it('allows when one of several rule subjects matches the principal', async () => {
    const s = await session([
      {
        ...engineerRule,
        subjects: [
          { kind: 'human', roles: ['owner'] },
          { kind: 'human', roles: ['engineer'] },
        ],
      },
    ]);
    expect(s.resolve()).toMatchObject({
      outcome: 'allow',
      matched_rule_ids: [engineerRule.rule_id],
    });
  });

  // Mutants 8509, 8510, 8517: each required consent key is enforced on its own, and a rule
  // without a consent requirement grants without one.
  // `write` cannot be withheld here: a mutating declaration itself refuses it upstream
  // (AUTHORITY_ACTION_CONSENT_MISMATCH), so only the two optional keys reach the resolver.
  it.each(['allow_publish', 'experimental'] as const)(
    'requires consent %s when the rule demands it',
    async (key) => {
      const s = await session([{ ...engineerRule, required_consent: { [key]: true } }]);
      const withheld = { ...CONSENT, [key]: false };
      // The declared context must carry the same consent the query presents.
      const declaration = expectSuccess<{ context_receipt: unknown }>(
        s.api.resolveAuthorityDeclaration(
          {
            action_id: 'test mutate',
            invocation_id: 'invocation-1',
            dry_run: false,
            declaration: { as_role: 'engineer' },
            consent: withheld,
          },
          declarationDependencies(s.issuer, actionDocument(), undefined, s.policy.provenance),
        ),
      );
      expect(
        s.resolve({ ...s.query, context_receipt: declaration.context_receipt, consent: withheld }),
      ).toMatchObject({
        outcome: 'deny',
        code: 'AUTHORITY_CONSENT_REQUIRED',
        matched_rule_ids: [engineerRule.rule_id],
      });
    },
  );

  it('allows a rule that declares no consent requirement', async () => {
    const { required_consent: _consent, ...withoutConsent } = engineerRule;
    const s = await session([withoutConsent]);
    expect(s.resolve()).toMatchObject({
      outcome: 'allow',
      matched_rule_ids: [engineerRule.rule_id],
    });
  });

  it('classifies a second target under the same rule independently', async () => {
    const s = await session();
    expect(s.resolve({ ...s.query, resource: secondFsTarget })).toMatchObject({
      outcome: 'allow',
      resource_target_id: secondFsTarget.id,
    });
  });
});
