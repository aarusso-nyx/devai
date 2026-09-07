import { describe, expect, it } from 'vitest';
import {
  CONSENT,
  NOW,
  REPOSITORY_ID,
  actionDocumentWithId,
  canonicalBytes,
  canonicalSha256,
  createIssuer,
  declarationDependencies,
  expectFailure,
  expectSuccess,
  makePolicyPlant,
  runtimeApi,
  sha256Bytes,
} from './authority-runtime-testkit.js';

// Policy materialization contract cases written against the retained authority mutation
// diagnostic (candidate 3dfdc316, report 414957d9), for runtime/policy-materializer.ts.
// authority-policy-runtime.red.test.ts pins the shadow rules, custody of the source
// documents and single-use authorization; the cases here pin the action gate, the closed
// issuer, extension composition (mixed validity, duplicate ids, non-additive precedence)
// and the fields of the materialized document itself.

type Api = Awaited<ReturnType<typeof runtimeApi>>;
type AnyRecord = Record<string, unknown>;

function materializationFixture(api: Api, allowedRoles: readonly string[] = ['architect']) {
  const issuer = createIssuer(api, { invocation_id: 'invocation-materialize' });
  const action = actionDocumentWithId('init bind', 'local-write', {
    kind: 'derived-machine',
    actor: 'binding',
    transition: 'bind',
    initiator: { allowed_roles: allowedRoles, preserve_in_context: true },
  });
  const declaration = declarationDependencies(issuer, action) as AnyRecord;
  const { receiptStore: _store, ...declarationWithoutStore } = declaration;
  return {
    issuer,
    deps: {
      receiptStore: issuer,
      declaration: declarationWithoutStore,
      derivation: {
        actionContracts: declaration.actionContracts,
        verifiedOrigin: { kind: 'direct-cli', invocation_id: 'invocation-materialize' },
        trusted_adapter_id: 'binding-authority',
        canonicalSha256,
      },
    },
  };
}

function authorizeInput(overrides: AnyRecord = {}) {
  return {
    action_id: 'init bind',
    invocation_id: 'invocation-materialize',
    target_operation: 'create',
    declaration: { as_role: 'architect' },
    consent: CONSENT,
    ...overrides,
  };
}

async function authorized(plantOptions: Parameters<typeof makePolicyPlant>[0] = {}) {
  const api = await runtimeApi();
  const fixture = materializationFixture(api);
  const authorization = expectSuccess(
    api.authorizePolicyMaterialization(authorizeInput(), fixture.deps),
  );
  const plant = makePolicyPlant(plantOptions);
  return {
    api,
    issuer: fixture.issuer,
    plant,
    input: {
      repository_id: REPOSITORY_ID,
      enforcement: { mode: 'binding' },
      host_enforcement: { mode: 'cli-only' },
      authorization,
      target_operation: 'create',
    },
    deps: {
      materialized_at: NOW,
      package_binding: (plant.deps as AnyRecord).expected_package,
      constitution_binding: (plant.deps as AnyRecord).expected_constitution,
      immutableCore: plant.immutableCore,
      additiveExtensions: plant.additiveExtensions,
      receiptStore: fixture.issuer,
      validatePolicySchema: (value: unknown) => ({
        ok: true,
        value: { raw: value, canonical_bytes: canonicalBytes(value), view: value },
      }),
      canonicalSha256,
      canonicalBytes,
      sha256Bytes,
    },
  };
}

function documentOf(result: unknown): AnyRecord {
  const value = expectSuccess<{ artifact: { bytes: Uint8Array } }>(result);
  return JSON.parse(new TextDecoder().decode(value.artifact.bytes)) as AnyRecord;
}

function extensionLike(source: AnyRecord, overrides: AnyRecord): AnyRecord {
  const sourceDocument = { ...(source.source_document as AnyRecord), ...overrides };
  return {
    ...source,
    ...overrides,
    source_document: sourceDocument,
    rules: sourceDocument.rules,
    canonical_source_bytes: canonicalBytes(sourceDocument),
  };
}

describe('materialization authorization gate', () => {
  // Mutants 7714-7722: only init bind with a create or update target is authorizable.
  it.each<[string, AnyRecord]>([
    ['another action', { action_id: 'init adopt' }],
    ['a delete target', { target_operation: 'delete' }],
    ['a missing target operation', { target_operation: undefined }],
  ])('refuses %s', async (_name, overrides) => {
    const api = await runtimeApi();
    const fixture = materializationFixture(api);
    expectFailure(
      api.authorizePolicyMaterialization(authorizeInput(overrides), fixture.deps),
      'refused',
      'AUTHORITY_MATERIALIZATION_ACTION_INVALID',
    );
  });

  it('accepts an update target', async () => {
    const api = await runtimeApi();
    const fixture = materializationFixture(api);
    expectSuccess(
      api.authorizePolicyMaterialization(
        authorizeInput({ target_operation: 'update' }),
        fixture.deps,
      ),
    );
  });

  // Mutant 7760: even when the action contract admits other roles, materialization itself
  // requires the initiating architect.
  it('requires an architect even when the action contract admits engineers', async () => {
    const api = await runtimeApi();
    const fixture = materializationFixture(api, ['architect', 'engineer']);
    expectFailure(
      api.authorizePolicyMaterialization(
        authorizeInput({ declaration: { as_role: 'engineer' } }),
        fixture.deps,
      ),
      'refused',
      'AUTHORITY_MATERIALIZATION_ARCHITECT_REQUIRED',
    );
    expectSuccess(api.authorizePolicyMaterialization(authorizeInput(), fixture.deps));
  });

  it('refuses authorization from a disposed issuer', async () => {
    const api = await runtimeApi();
    const fixture = materializationFixture(api);
    expectSuccess(fixture.issuer.dispose());
    expectFailure(
      api.authorizePolicyMaterialization(authorizeInput(), fixture.deps),
      'refused',
      'AUTHORITY_DECISION_ISSUER_CLOSED',
    );
  });
});

describe('materialization binding contracts', () => {
  // Mutants 7860-7865: an authorization does not survive its issuer.
  it('refuses to materialize an authorization whose issuer was disposed', async () => {
    const { api, issuer, input, deps } = await authorized();
    expectSuccess(issuer.dispose());
    expectFailure(
      api.materializeAuthorityPolicy(input, deps),
      'refused',
      'AUTHORITY_MATERIALIZATION_AUTHORIZATION_BINDING_MISMATCH',
    );
  });

  it('refuses a repository substitution', async () => {
    const { api, input, deps } = await authorized();
    expectFailure(
      api.materializeAuthorityPolicy({ ...input, repository_id: 'other-repository' }, deps),
      'refused',
      'AUTHORITY_MATERIALIZATION_BINDING_MISMATCH',
    );
  });
});

describe('extension composition contracts', () => {
  // Mutant 7916: one invalid extension among valid ones taints the set.
  it('refuses a set in which one extension is invalid beside a valid one', async () => {
    const { api, input, deps, plant } = await authorized();
    const valid = plant.additiveExtensions[0] as AnyRecord;
    const broken = { ...extensionLike(valid, { extension_id: 'broken-extension' }), rules: [] };
    expectFailure(
      api.materializeAuthorityPolicy(input, { ...deps, additiveExtensions: [valid, broken] }),
      'refused',
      'AUTHORITY_POLICY_EXTENSION_INVALID',
    );
  });

  // Mutant 7940: extension ids are compared as given; distinct ids compose, equal ids refuse.
  it('refuses a duplicated extension id and composes distinct ones', async () => {
    const { api, input, deps, plant } = await authorized();
    const first = plant.additiveExtensions[0] as AnyRecord;
    const rules = (first.rules as AnyRecord[]).map((rule) => ({
      ...rule,
      rule_id: `${String(rule.rule_id)}-second`,
    }));
    const second = extensionLike(first, { extension_id: 'second-extension', rules });
    const duplicate = extensionLike(first, { rules });
    expectFailure(
      api.materializeAuthorityPolicy(input, { ...deps, additiveExtensions: [first, duplicate] }),
      'refused',
      'AUTHORITY_POLICY_DUPLICATE_EXTENSION_ID',
    );
    const fresh = await authorized();
    const document = documentOf(
      fresh.api.materializeAuthorityPolicy(fresh.input, {
        ...fresh.deps,
        additiveExtensions: [first, second],
      }),
    );
    expect(
      (document.additive_extensions as AnyRecord[]).map((extension) => extension.extension_id),
    ).toEqual([first.extension_id, 'second-extension']);
  });

  it('refuses a rule id that repeats across core and extensions', async () => {
    const { api, input, deps, plant } = await authorized();
    const first = plant.additiveExtensions[0] as AnyRecord;
    const coreRule = (plant.immutableCore as AnyRecord).rules as AnyRecord[];
    const clash = extensionLike(first, {
      extension_id: 'clashing-extension',
      rules: [{ ...(first.rules as AnyRecord[])[0], rule_id: coreRule[0]?.rule_id }],
    });
    expectFailure(
      api.materializeAuthorityPolicy(input, { ...deps, additiveExtensions: [first, clash] }),
      'refused',
      'AUTHORITY_POLICY_DUPLICATE_RULE_ID',
    );
  });

  // Mutants 7956, 7958, 7963, 7966, 7971, 7972: an extension rule may only add authority
  // below the core rule for the same selector; equal precedence, higher precedence, or a
  // non-extension origin are refused even when every other rule is additive.
  it.each<[string, (coreRule: AnyRecord) => AnyRecord]>([
    [
      'equal precedence on a core selector',
      (coreRule) => ({ selector: coreRule.selector, precedence: coreRule.precedence }),
    ],
    [
      'higher precedence on a core selector',
      (coreRule) => ({ selector: coreRule.selector, precedence: Number(coreRule.precedence) + 1 }),
    ],
    ['a core origin', () => ({ origin: 'immutable-core' })],
  ])('refuses an extension rule with %s beside an additive one', async (_name, rewrite) => {
    const { api, input, deps, plant } = await authorized();
    const first = plant.additiveExtensions[0] as AnyRecord;
    const coreRule = ((plant.immutableCore as AnyRecord).rules as AnyRecord[])[0] as AnyRecord;
    const additive = (first.rules as AnyRecord[])[0] as AnyRecord;
    const nonAdditive = extensionLike(first, {
      extension_id: 'non-additive-extension',
      rules: [{ ...additive, rule_id: 'non-additive-rule', ...rewrite(coreRule) }],
    });
    expectFailure(
      api.materializeAuthorityPolicy(input, { ...deps, additiveExtensions: [first, nonAdditive] }),
      'refused',
      'AUTHORITY_POLICY_EXTENSION_NON_ADDITIVE',
    );
  });

  it('admits an extension rule below the core precedence on the same selector', async () => {
    const { api, input, deps, plant } = await authorized();
    const first = plant.additiveExtensions[0] as AnyRecord;
    const coreRule = ((plant.immutableCore as AnyRecord).rules as AnyRecord[])[0] as AnyRecord;
    const additive = (first.rules as AnyRecord[])[0] as AnyRecord;
    const lower = extensionLike(first, {
      extension_id: 'lower-extension',
      rules: [
        {
          ...additive,
          rule_id: 'lower-rule',
          selector: coreRule.selector,
          precedence: Number(coreRule.precedence) - 1,
        },
      ],
    });
    const document = documentOf(
      api.materializeAuthorityPolicy(input, { ...deps, additiveExtensions: [first, lower] }),
    );
    expect((document.rules as AnyRecord[]).map((rule) => rule.rule_id)).toContain('lower-rule');
  });
});

describe('materialized document contracts', () => {
  // Mutants 7982-8010: the document binds the materialization it was issued under, the
  // source policy, each extension digest, the resolved rule digest and the package version.
  it('emits the bound materialization, source policy and resolved rules', async () => {
    const { api, input, deps, plant } = await authorized();
    const document = documentOf(api.materializeAuthorityPolicy(input, deps));
    const core = plant.immutableCore as AnyRecord;
    const extension = plant.additiveExtensions[0] as AnyRecord;
    const materialization = document.materialization as AnyRecord;
    const { materialization_digest_sha256: digest, ...unsigned } = materialization;
    expect(materialization).toMatchObject({
      action_id: 'init bind',
      invocation_id: 'invocation-materialize',
      machine_principal: {
        kind: 'machine',
        actor: 'binding',
        transition: 'bind',
        trusted_adapter_id: 'binding-authority',
        context_digest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      initiated_by: { kind: 'human', role: 'architect', declaration_source: 'cli-flag' },
      consent: { write: true },
    });
    expect(digest).toBe(canonicalSha256(unsigned));
    expect(document).toMatchObject({
      schemaVersion: '1.0.0',
      policy_id: 'devai-authority',
      policy_version: (deps.package_binding as AnyRecord).version,
      repository_id: REPOSITORY_ID,
      source_policy: {
        policy_id: core.policy_id,
        policy_version: core.policy_version,
        digest_sha256: sha256Bytes(canonicalBytes(core.source_document)),
      },
      additive_extensions: [
        {
          extension_id: extension.extension_id,
          extension_version: extension.extension_version,
          digest_sha256: sha256Bytes(canonicalBytes(extension.source_document)),
        },
      ],
      resolved_digest_sha256: canonicalSha256([
        ...(core.rules as unknown[]),
        ...(extension.rules as unknown[]),
      ]),
      materialized_at: NOW,
      enforcement: { mode: 'binding' },
      host_enforcement: { mode: 'cli-only' },
    });
    expect(document.rules).toEqual([
      ...(core.rules as unknown[]),
      ...(extension.rules as unknown[]),
    ]);
  });

  // Mutants 8019, 8020: a validator that returns no view leaves the raw document as the view
  // and its canonical bytes as the artifact.
  it('falls back to the raw document when the validator returns no view', async () => {
    const { api, input, deps } = await authorized();
    const value = expectSuccess<{
      document: AnyRecord;
      artifact: { bytes: Uint8Array; digest_sha256: string };
    }>(
      api.materializeAuthorityPolicy(input, {
        ...deps,
        validatePolicySchema: () => ({ ok: true, value: {} }),
      }),
    );
    expect(value.document.view).toEqual(value.document.raw);
    expect(value.artifact.bytes).toEqual(canonicalBytes(value.document.raw));
    expect(value.artifact.digest_sha256).toBe(sha256Bytes(value.artifact.bytes));
  });
});
