import { describe, expect, it } from 'vitest';
import {
  CONSENT,
  NOW,
  REPOSITORY_ID,
  actionDocument,
  actionDocumentWithId,
  canonicalBytes,
  canonicalSha256,
  createIssuer,
  declarationDependencies,
  engineerRule,
  expectFailure,
  expectSuccess,
  fsTarget,
  glossaryRule,
  inspectorRule,
  makePolicyPlant,
  runtimeApi,
  sha256Bytes,
} from './authority-runtime-testkit.js';

// Invariants: INV-AUTH-001, INV-AUTH-002, INV-AUTH-003

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('R19 authority policy loading', () => {
  it('classifies missing, wrong-shape, semantic-invalid, downgrade, and stale distinctly', async () => {
    const api = await runtimeApi();
    const plant = makePolicyPlant();
    expectFailure(
      api.loadAuthorityPolicy({ document: undefined }, plant.deps),
      'refused',
      'AUTHORITY_POLICY_MISSING',
    );
    expectFailure(
      api.loadAuthorityPolicy({ document: null }, plant.deps),
      'refused',
      'AUTHORITY_POLICY_SCHEMA_INVALID',
    );

    const invalidVersion = { ...(plant.document as object), policy_version: '01.0.0' };
    expectFailure(
      api.loadAuthorityPolicy({ document: invalidVersion }, plant.deps),
      'refused',
      'AUTHORITY_POLICY_SEMANTIC_INVALID',
    );
    const future = { ...(plant.document as object), materialized_at: '2026-07-15T12:00:01.000Z' };
    expectFailure(
      api.loadAuthorityPolicy({ document: future }, plant.deps),
      'refused',
      'AUTHORITY_POLICY_SEMANTIC_INVALID',
    );

    const downgradePlant = makePolicyPlant({ policyVersion: '0.9.0' });
    expectFailure(
      api.loadAuthorityPolicy({ document: downgradePlant.document }, downgradePlant.deps),
      'refused',
      'AUTHORITY_POLICY_DOWNGRADE',
    );

    const stalePlant = makePolicyPlant({
      materializedAt: '2026-07-15T10:00:00.000Z',
      enforcement: {
        mode: 'shadow',
        shadow: {
          reason: 'migration observation',
          approved_by: { role: 'architect', declaration_source: 'cli-flag' },
          expires_at: NOW,
        },
      },
    });
    expectFailure(
      api.loadAuthorityPolicy({ document: stalePlant.document }, stalePlant.deps),
      'refused',
      'AUTHORITY_POLICY_STALE',
    );
  });

  it('refuses source, merged-rule, digest, binding, and non-additive divergence in frozen order', async () => {
    const api = await runtimeApi();
    const plant = makePolicyPlant();

    const badSourceDeps = {
      ...plant.deps,
      immutableCore: {
        ...(plant.immutableCore as object),
        canonical_source_bytes: canonicalBytes({ different: true }),
      },
    };
    expectFailure(
      api.loadAuthorityPolicy({ document: plant.document }, badSourceDeps),
      'refused',
      'AUTHORITY_POLICY_SOURCE_RULE_MISMATCH',
    );

    const divergentRules = { ...(plant.document as object), rules: [glossaryRule] };
    expectFailure(
      api.loadAuthorityPolicy({ document: divergentRules }, plant.deps),
      'refused',
      'AUTHORITY_POLICY_RESOLVED_BYTES_MISMATCH',
    );

    const document = plant.document as Record<string, unknown>;
    const badDigest = {
      ...document,
      source_policy: { ...(document.source_policy as object), digest_sha256: 'f'.repeat(64) },
    };
    expectFailure(
      api.loadAuthorityPolicy({ document: badDigest }, plant.deps),
      'refused',
      'AUTHORITY_POLICY_DIGEST_MISMATCH',
    );

    const otherRepo = { ...document, repository_id: 'other-repository' };
    expectFailure(
      api.loadAuthorityPolicy({ document: otherRepo }, plant.deps),
      'refused',
      'AUTHORITY_POLICY_BINDING_MISMATCH',
    );

    const weakening = makePolicyPlant({
      additiveRules: [
        {
          ...glossaryRule,
          origin: 'additive-extension',
          subjects: [{ kind: 'human', roles: ['engineer'] }],
        },
      ],
    });
    expectFailure(
      api.loadAuthorityPolicy({ document: weakening.document }, weakening.deps),
      'refused',
      'AUTHORITY_POLICY_EXTENSION_NON_ADDITIVE',
    );
  });

  it('returns only recomputed provenance and canonical merged bytes for a valid policy', async () => {
    const api = await runtimeApi();
    const plant = makePolicyPlant();
    const loaded = expectSuccess<{
      provenance: Record<string, unknown>;
      resolved_rule_bytes: Uint8Array;
      document: { raw: unknown; canonical_bytes: Uint8Array };
    }>(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
    expect(loaded.provenance).toMatchObject({
      repository_id: REPOSITORY_ID,
      policy_id: 'devai-authority',
      resolved_digest_sha256: (plant.document as { resolved_digest_sha256: string })
        .resolved_digest_sha256,
    });
    expect(loaded.resolved_rule_bytes).toEqual(
      canonicalBytes((plant.document as { rules: unknown }).rules),
    );
    expect(loaded.document.raw).toBe(plant.document);
    expect(loaded.document.canonical_bytes).toEqual(canonicalBytes(plant.document));
  });

  it('loads binding as the default and preserves an explicit unexpired shadow posture', async () => {
    const api = await runtimeApi();
    const bindingPlant = makePolicyPlant();
    const binding = expectSuccess<{ document: { view: Record<string, unknown> } }>(
      api.loadAuthorityPolicy({ document: bindingPlant.document }, bindingPlant.deps),
    );
    expect(binding.document.view.enforcement).toEqual({ mode: 'binding' });

    const shadowPlant = makePolicyPlant({
      enforcement: {
        mode: 'shadow',
        shadow: {
          reason: 'bounded migration observation',
          approved_by: { role: 'architect', declaration_source: 'cli-flag' },
          expires_at: '2026-07-15T13:00:00.000Z',
        },
      },
    });
    const shadow = expectSuccess<{ document: { view: Record<string, unknown> } }>(
      api.loadAuthorityPolicy({ document: shadowPlant.document }, shadowPlant.deps),
    );
    expect(shadow.document.view.enforcement).toMatchObject({ mode: 'shadow' });
  });

  it('returns policy validator unavailability as dependency data', async () => {
    const api = await runtimeApi();
    const plant = makePolicyPlant();
    expectFailure(
      api.loadAuthorityPolicy(
        { document: plant.document },
        {
          ...plant.deps,
          validatePolicySchema: () => ({
            ok: false,
            category: 'dependency-error',
            code: 'AUTHORITY_POLICY_VALIDATOR_UNAVAILABLE',
            reasons: ['canonical policy validator unavailable'],
          }),
        },
      ),
      'dependency-error',
      'AUTHORITY_POLICY_VALIDATOR_UNAVAILABLE',
    );
  });
});

describe('R19 policy materialization authorization and purity', () => {
  function materializationFixture(api: Awaited<ReturnType<typeof runtimeApi>>) {
    const issuer = createIssuer(api, { invocation_id: 'invocation-materialize' });
    const action = actionDocumentWithId('init bind', 'local-write', {
      kind: 'derived-machine',
      actor: 'binding',
      transition: 'bind',
      initiator: { allowed_roles: ['architect'], preserve_in_context: true },
    });
    const declaration = declarationDependencies(issuer, action);
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

  it.each([
    [{}, 'usage-error', 'AUTHORITY_DECLARATION_MISSING'],
    [{ as_role: 'engineer' }, 'refused', 'AUTHORITY_MATERIALIZATION_ARCHITECT_REQUIRED'],
  ])(
    'refuses invalid materialization initiation with %s/%s',
    async (declaration, category, code) => {
      const api = await runtimeApi();
      const fixture = materializationFixture(api);
      const result = api.authorizePolicyMaterialization(
        {
          action_id: 'init bind',
          invocation_id: 'invocation-materialize',
          target_operation: 'create',
          declaration,
          consent: CONSENT,
        },
        fixture.deps,
      );
      expectFailure(result, category as 'usage-error' | 'refused', code);
    },
  );

  it('requires exact write consent before authorizing materialization', async () => {
    const api = await runtimeApi();
    const fixture = materializationFixture(api);
    const result = api.authorizePolicyMaterialization(
      {
        action_id: 'init bind',
        invocation_id: 'invocation-materialize',
        target_operation: 'create',
        declaration: { as_role: 'architect' },
        consent: { ...CONSENT, write: false },
      },
      fixture.deps,
    );
    expectFailure(result, 'refused', 'AUTHORITY_MATERIALIZATION_WRITE_CONSENT_REQUIRED');
  });

  it('refuses derivation contract drift that would substitute the initiating Architect', async () => {
    const api = await runtimeApi();
    const fixture = materializationFixture(api);
    const ownerOnly = actionDocumentWithId('init bind', 'local-write', {
      kind: 'derived-machine',
      actor: 'binding',
      transition: 'bind',
      initiator: { allowed_roles: ['owner'], preserve_in_context: true },
    });
    const ownerRegistry = (
      declarationDependencies(fixture.issuer, ownerOnly) as { actionContracts: unknown }
    ).actionContracts;
    const result = api.authorizePolicyMaterialization(
      {
        action_id: 'init bind',
        invocation_id: 'invocation-materialize',
        target_operation: 'create',
        declaration: { as_role: 'architect' },
        consent: CONSENT,
      },
      {
        ...fixture.deps,
        derivation: {
          ...(fixture.deps.derivation as object),
          actionContracts: ownerRegistry,
        },
      },
    );
    expectFailure(result, 'refused', 'AUTHORITY_DECLARATION_RECEIPT_BINDING_MISMATCH');
  });

  it('returns a pure exact policy artifact and consumes authorization once', async () => {
    const api = await runtimeApi();
    const fixture = materializationFixture(api);
    const authorization = expectSuccess(
      api.authorizePolicyMaterialization(
        {
          action_id: 'init bind',
          invocation_id: 'invocation-materialize',
          target_operation: 'create',
          declaration: { as_role: 'architect' },
          consent: CONSENT,
        },
        fixture.deps,
      ),
    );
    const plant = makePolicyPlant();
    const deps = {
      materialized_at: NOW,
      package_binding: (plant.deps as Record<string, unknown>).expected_package,
      constitution_binding: (plant.deps as Record<string, unknown>).expected_constitution,
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
    };
    const input = {
      repository_id: REPOSITORY_ID,
      enforcement: { mode: 'binding' },
      host_enforcement: { mode: 'cli-only' },
      authorization,
      target_operation: 'create',
    };
    const value = expectSuccess<{ artifact: Record<string, unknown> }>(
      api.materializeAuthorityPolicy(input, deps),
    );
    expect(value.artifact).toMatchObject({
      kind: 'fs',
      repository_id: REPOSITORY_ID,
      canonical_relative_path: '.devai/config/authority-policy.json',
      operation: 'create',
    });
    expect(value.artifact.bytes).toBeInstanceOf(Uint8Array);
    expect(value.artifact.digest_sha256).toBe(sha256Bytes(value.artifact.bytes as Uint8Array));
    expectFailure(
      api.materializeAuthorityPolicy(input, deps),
      'refused',
      'AUTHORITY_MATERIALIZATION_AUTHORIZATION_REPLAYED',
    );
  });

  it('refuses a cloned authorization and repository substitution without writing', async () => {
    const api = await runtimeApi();
    const fixture = materializationFixture(api);
    const authorization = expectSuccess(
      api.authorizePolicyMaterialization(
        {
          action_id: 'init bind',
          invocation_id: 'invocation-materialize',
          target_operation: 'create',
          declaration: { as_role: 'architect' },
          consent: CONSENT,
        },
        fixture.deps,
      ),
    );
    const plant = makePolicyPlant();
    const deps = {
      materialized_at: NOW,
      package_binding: plant.deps.expected_package,
      constitution_binding: plant.deps.expected_constitution,
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
    };
    const base = {
      repository_id: REPOSITORY_ID,
      enforcement: { mode: 'binding' },
      host_enforcement: { mode: 'cli-only' },
      target_operation: 'create',
    };
    expectFailure(
      api.materializeAuthorityPolicy({ ...base, authorization: clone(authorization) }, deps),
      'refused',
      'AUTHORITY_MATERIALIZATION_AUTHORIZATION_UNKNOWN',
    );
    expectFailure(
      api.materializeAuthorityPolicy(
        { ...base, repository_id: 'other-repository', authorization },
        deps,
      ),
      'refused',
      'AUTHORITY_MATERIALIZATION_BINDING_MISMATCH',
    );
  });

  it('returns materialized-policy validator unavailability after claiming authorization', async () => {
    const api = await runtimeApi();
    const fixture = materializationFixture(api);
    const authorization = expectSuccess(
      api.authorizePolicyMaterialization(
        {
          action_id: 'init bind',
          invocation_id: 'invocation-materialize',
          target_operation: 'create',
          declaration: { as_role: 'architect' },
          consent: CONSENT,
        },
        fixture.deps,
      ),
    );
    const plant = makePolicyPlant();
    const input = {
      repository_id: REPOSITORY_ID,
      enforcement: { mode: 'binding' },
      host_enforcement: { mode: 'cli-only' },
      authorization,
      target_operation: 'create',
    };
    const deps = {
      materialized_at: NOW,
      package_binding: plant.deps.expected_package,
      constitution_binding: plant.deps.expected_constitution,
      immutableCore: plant.immutableCore,
      additiveExtensions: plant.additiveExtensions,
      receiptStore: fixture.issuer,
      validatePolicySchema: () => ({
        ok: false,
        category: 'dependency-error',
        code: 'AUTHORITY_POLICY_VALIDATOR_UNAVAILABLE',
        reasons: ['canonical materialized-policy validator unavailable'],
      }),
      canonicalSha256,
      canonicalBytes,
      sha256Bytes,
    };
    expectFailure(
      api.materializeAuthorityPolicy(input, deps),
      'dependency-error',
      'AUTHORITY_POLICY_VALIDATOR_UNAVAILABLE',
    );
    expectFailure(
      api.materializeAuthorityPolicy(input, deps),
      'refused',
      'AUTHORITY_MATERIALIZATION_AUTHORIZATION_REPLAYED',
    );
  });
});

describe('R19 single-query policy resolution', () => {
  it('allows exact classified source and binds/freeze the outcome', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api);
    const declaration = expectSuccess<{ context_receipt: unknown }>(
      api.resolveAuthorityDeclaration(
        {
          action_id: 'test mutate',
          invocation_id: 'invocation-1',
          dry_run: false,
          declaration: { as_role: 'engineer' },
          consent: CONSENT,
        },
        declarationDependencies(issuer),
      ),
    );
    const plant = makePolicyPlant();
    const loaded = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
    const result = api.resolveAuthorityPolicy(
      loaded,
      {
        action_id: 'test mutate',
        context_receipt: declaration.context_receipt,
        consent: CONSENT,
        resource: fsTarget,
        operation: 'update',
      },
      { receiptStore: issuer, canonicalSha256 },
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      outcome: 'allow',
      code: 'POLICY_ALLOW',
      resource_target_id: fsTarget.id,
      operation: 'update',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    [
      'UNCLASSIFIED_RESOURCE',
      { ...fsTarget, id: 'fs:unknown', canonical_relative_path: 'unknown/path.ts' },
      'update',
    ],
    ['AUTHORITY_QUERY_OPERATION_MISMATCH', fsTarget, 'delete'],
  ])('returns %s for a classified query defect', async (code, resource, operation) => {
    const api = await runtimeApi();
    const issuer = createIssuer(api);
    const declaration = expectSuccess<{ context_receipt: unknown }>(
      api.resolveAuthorityDeclaration(
        {
          action_id: 'test mutate',
          invocation_id: 'invocation-1',
          dry_run: false,
          declaration: { as_role: 'engineer' },
          consent: CONSENT,
        },
        declarationDependencies(issuer),
      ),
    );
    const plant = makePolicyPlant();
    const loaded = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
    const result = api.resolveAuthorityPolicy(
      loaded,
      {
        action_id: 'test mutate',
        context_receipt: declaration.context_receipt,
        consent: CONSENT,
        resource,
        operation,
      },
      { receiptStore: issuer, canonicalSha256 },
    );
    expect(result).toMatchObject({ outcome: 'deny', category: 'refused', code });
    expect(Object.isFrozen(result as object)).toBe(true);
  });

  it('gives the protected Inspector test rule precedence over broad package source', async () => {
    const api = await runtimeApi();
    const target = {
      ...fsTarget,
      id: 'fs:test',
      canonical_relative_path: 'packages/core/src/test/authority.test.ts',
    };
    for (const [role, expected] of [
      ['inspector', 'POLICY_ALLOW'],
      ['engineer', 'AUTHORITY_SUBJECT_DENIED'],
    ] as const) {
      const issuer = createIssuer(api);
      const action = actionDocument('local-write', { kind: 'human', allowed_roles: [role] });
      const declaration = expectSuccess<{ context_receipt: unknown }>(
        api.resolveAuthorityDeclaration(
          {
            action_id: 'test mutate',
            invocation_id: 'invocation-1',
            dry_run: false,
            declaration: { as_role: role },
            consent: CONSENT,
          },
          declarationDependencies(issuer, action),
        ),
      );
      const plant = makePolicyPlant({ additiveRules: [engineerRule, inspectorRule] });
      const loaded = expectSuccess(
        api.loadAuthorityPolicy({ document: plant.document }, plant.deps),
      );
      const result = api.resolveAuthorityPolicy(
        loaded,
        {
          action_id: 'test mutate',
          context_receipt: declaration.context_receipt,
          consent: CONSENT,
          resource: target,
          operation: 'update',
        },
        { receiptStore: issuer, canonicalSha256 },
      ) as Record<string, unknown>;
      expect(result.code).toBe(expected);
    }
  });
});
