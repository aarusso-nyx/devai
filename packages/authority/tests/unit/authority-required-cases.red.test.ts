import { describe, expect, it } from 'vitest';
import { computeMutationEnvelopeDigest, type MutationEnvelope } from '../../src/index.js';
import {
  CONSENT,
  NOW,
  actionDocument,
  actionDocumentWithId,
  boundedSubject,
  canonicalBytes,
  canonicalSha256,
  createIssuer,
  declarationDependencies,
  evidenceBindings,
  evidenceDocument,
  engineerRule,
  exactSubject,
  expectFailure,
  expectSuccess,
  fsTarget,
  glossaryRule,
  inspectorRule,
  makePolicyPlant,
  policyBindingFromPlant,
  runtimeApi,
  remoteTarget,
  secondFsTarget,
  sha256Bytes,
} from './authority-runtime-testkit.js';

// Invariants: INV-AUTH-001, INV-AUTH-002, INV-AUTH-003, INV-AUTH-004

describe('R19 strict SemVer policy classifier matrix', () => {
  it.each([
    ['leading-zero core', '01.0.0', '1.0.0', 'AUTHORITY_POLICY_SEMANTIC_INVALID'],
    ['empty prerelease', '1.0.0-', '1.0.0', 'AUTHORITY_POLICY_SEMANTIC_INVALID'],
    ['numeric prerelease leading zero', '1.0.0-01', '1.0.0', 'AUTHORITY_POLICY_SEMANTIC_INVALID'],
    ['prerelease numeric ordering', '1.0.0-2', '1.0.0-10', 'AUTHORITY_POLICY_DOWNGRADE'],
    ['prerelease lexical ordering', '1.0.0-alpha', '1.0.0-beta', 'AUTHORITY_POLICY_DOWNGRADE'],
    [
      'arbitrary precision core',
      '999999999999999999999999.0.0',
      '1000000000000000000000000.0.0',
      'AUTHORITY_POLICY_DOWNGRADE',
    ],
  ])(
    '%s is classified without lexical or floating-point comparison',
    async (_name, version, minimum, code) => {
      const api = await runtimeApi();
      const plant = makePolicyPlant({ policyVersion: version });
      const result = api.loadAuthorityPolicy(
        { document: plant.document },
        { ...plant.deps, expected_minimum_policy_version: minimum },
      );
      expectFailure(result, 'refused', code);
    },
  );

  it('treats a release as greater than its prerelease', async () => {
    const api = await runtimeApi();
    const plant = makePolicyPlant({ policyVersion: '1.0.0' });
    expectSuccess(
      api.loadAuthorityPolicy(
        { document: plant.document },
        { ...plant.deps, expected_minimum_policy_version: '1.0.0-rc.9' },
      ),
    );
  });

  it('keeps W01 outer-schema rejection ahead of SemVer build-metadata precedence', async () => {
    const api = await runtimeApi();
    const plant = makePolicyPlant({ policyVersion: '1.0.0+build.7' });
    const result = api.loadAuthorityPolicy(
      { document: plant.document },
      {
        ...plant.deps,
        expected_minimum_policy_version: '1.0.0',
        validatePolicySchema: () => ({
          ok: false,
          category: 'refused',
          code: 'AUTHORITY_POLICY_SCHEMA_INVALID',
          reasons: ['W01 policy_version schema excludes build metadata'],
        }),
      },
    );
    expectFailure(result, 'refused', 'AUTHORITY_POLICY_SCHEMA_INVALID');
  });
});

describe('R19 materialization total precedence inventory', () => {
  function authenticMaterialization(
    api: Awaited<ReturnType<typeof runtimeApi>>,
    issuer = createIssuer(api, { invocation_id: 'invocation-materialize' }),
  ) {
    const action = actionDocumentWithId('init bind', 'local-write', {
      kind: 'derived-machine',
      actor: 'binding',
      transition: 'bind',
      initiator: { allowed_roles: ['architect'], preserve_in_context: true },
    });
    const declaration = declarationDependencies(issuer, action);
    const { receiptStore: _receiptStore, ...withoutStore } = declaration;
    const authorization = expectSuccess(
      api.authorizePolicyMaterialization(
        {
          action_id: 'init bind',
          invocation_id: 'invocation-materialize',
          target_operation: 'create',
          declaration: { as_role: 'architect' },
          consent: CONSENT,
        },
        {
          receiptStore: issuer,
          declaration: withoutStore,
          derivation: {
            actionContracts: declaration.actionContracts,
            verifiedOrigin: { kind: 'direct-cli', invocation_id: 'invocation-materialize' },
            trusted_adapter_id: 'binding-authority',
            canonicalSha256,
          },
        },
      ),
    );
    return { issuer, authorization };
  }

  function extensionArtifact(
    extensionId: string,
    extensionVersion: string,
    rules: readonly unknown[],
  ) {
    const sourceDocument = {
      extension_id: extensionId,
      extension_version: extensionVersion,
      rules,
    };
    return {
      extension_id: extensionId,
      extension_version: extensionVersion,
      source_document: sourceDocument,
      canonical_source_bytes: canonicalBytes(sourceDocument),
      rules,
    };
  }

  function materializationDeps(
    issuer: ReturnType<typeof createIssuer>,
    overrides: Record<string, unknown> = {},
  ) {
    const plant = makePolicyPlant();
    return {
      materialized_at: NOW,
      package_binding: plant.deps.expected_package,
      constitution_binding: plant.deps.expected_constitution,
      immutableCore: plant.immutableCore,
      additiveExtensions: plant.additiveExtensions,
      receiptStore: issuer,
      validatePolicySchema: (value: unknown) => ({
        ok: true,
        value: { raw: value, canonical_bytes: canonicalBytes(value), view: value },
      }),
      canonicalSha256,
      canonicalBytes,
      sha256Bytes,
      ...overrides,
    };
  }

  function materializationInput(authorization: unknown, overrides: Record<string, unknown> = {}) {
    return {
      repository_id: 'example-repository',
      enforcement: { mode: 'binding' },
      host_enforcement: { mode: 'cli-only' },
      authorization,
      target_operation: 'create',
      ...overrides,
    };
  }

  it('refuses an unknown value and a structural clone before construction', async () => {
    const api = await runtimeApi();
    const { issuer, authorization } = authenticMaterialization(api);
    for (const candidate of [{}, structuredClone(authorization)]) {
      expectFailure(
        api.materializeAuthorityPolicy(
          materializationInput(candidate),
          materializationDeps(issuer),
        ),
        'refused',
        'AUTHORITY_MATERIALIZATION_AUTHORIZATION_UNKNOWN',
      );
    }
  });

  it('refuses a genuine authorization owned by a different issuer/store', async () => {
    const api = await runtimeApi();
    const foreign = authenticMaterialization(
      api,
      createIssuer(api, {
        issuer_id: 'foreign-materialization-issuer',
        invocation_id: 'invocation-materialize',
      }),
    );
    const localIssuer = createIssuer(api, { invocation_id: 'invocation-materialize' });
    expectFailure(
      api.materializeAuthorityPolicy(
        materializationInput(foreign.authorization),
        materializationDeps(localIssuer),
      ),
      'refused',
      'AUTHORITY_MATERIALIZATION_AUTHORIZATION_BINDING_MISMATCH',
    );
  });

  it.each([
    [
      'caller repository/operation binding',
      'caller-binding',
      'AUTHORITY_MATERIALIZATION_BINDING_MISMATCH',
    ],
    ['source invalid', 'source-invalid', 'AUTHORITY_POLICY_SOURCE_INVALID'],
    ['extension invalid', 'extension-invalid', 'AUTHORITY_POLICY_EXTENSION_INVALID'],
    ['duplicate extension id', 'duplicate-extension', 'AUTHORITY_POLICY_DUPLICATE_EXTENSION_ID'],
    ['duplicate rule id', 'duplicate-rule', 'AUTHORITY_POLICY_DUPLICATE_RULE_ID'],
    ['non-additive extension', 'non-additive', 'AUTHORITY_POLICY_EXTENSION_NON_ADDITIVE'],
    ['invalid shadow', 'shadow-invalid', 'AUTHORITY_POLICY_SHADOW_INVALID'],
    [
      'constructed schema',
      'constructed-schema-invalid',
      'AUTHORITY_MATERIALIZED_POLICY_SCHEMA_INVALID',
    ],
    [
      'claimed handle replay',
      'authorization-replay',
      'AUTHORITY_MATERIALIZATION_AUTHORIZATION_REPLAYED',
    ],
    [
      'private-record corruption',
      'private-binding-corruption',
      'AUTHORITY_MATERIALIZATION_AUTHORIZATION_BINDING_MISMATCH',
    ],
  ])('%s (%s) has the frozen first-match code %s', async (_name, scenario, expectedCode) => {
    const api = await runtimeApi();
    const { issuer, authorization } = authenticMaterialization(api);
    const plant = makePolicyPlant();
    const baseExtension = plant.additiveExtensions[0] as {
      extension_id: string;
      extension_version: string;
      rules: readonly unknown[];
    };
    const duplicateRules = [engineerRule, engineerRule];
    const nonAdditiveRule = {
      ...glossaryRule,
      rule_id: 'extension-glossary-override',
      origin: 'additive-extension',
      precedence: 800,
      subjects: [{ kind: 'human', roles: ['engineer'] }],
    };
    const extensions =
      scenario === 'extension-invalid'
        ? [
            {
              ...extensionArtifact('example-authority', '1.0.0', [engineerRule]),
              canonical_source_bytes: canonicalBytes({ tampered: true }),
            },
          ]
        : scenario === 'duplicate-extension'
          ? [
              extensionArtifact('example-authority', '1.0.0', [engineerRule]),
              extensionArtifact('example-authority', '1.0.1', [inspectorRule]),
            ]
          : scenario === 'duplicate-rule'
            ? [extensionArtifact('example-authority', '1.0.0', duplicateRules)]
            : scenario === 'non-additive'
              ? [extensionArtifact('example-authority', '1.0.0', [nonAdditiveRule])]
              : [
                  extensionArtifact(
                    baseExtension.extension_id,
                    baseExtension.extension_version,
                    baseExtension.rules,
                  ),
                ];
    const defectDeps = materializationDeps(issuer, {
      package_binding:
        scenario === 'private-binding-corruption'
          ? { name: '@aarusso-nyx/devai', version: '0.5.0' }
          : plant.deps.expected_package,
      immutableCore:
        scenario === 'source-invalid'
          ? {
              ...(plant.immutableCore as object),
              canonical_source_bytes: canonicalBytes({ tampered: true }),
            }
          : plant.immutableCore,
      additiveExtensions: extensions,
      validatePolicySchema: (value: unknown) =>
        scenario === 'constructed-schema-invalid'
          ? {
              ok: false,
              category: 'refused',
              code: 'AUTHORITY_MATERIALIZED_POLICY_SCHEMA_INVALID',
              reasons: ['constructed document rejected by canonical validator'],
            }
          : {
              ok: true,
              value: { raw: value, canonical_bytes: canonicalBytes(value), view: value },
            },
    });
    const input = materializationInput(authorization, {
      repository_id: scenario === 'caller-binding' ? 'other-repository' : 'example-repository',
      enforcement:
        scenario === 'shadow-invalid' ? { mode: 'shadow', shadow: {} } : { mode: 'binding' },
    });
    if (scenario === 'authorization-replay') {
      api.materializeAuthorityPolicy(input, defectDeps);
    }
    const first = api.materializeAuthorityPolicy(input, defectDeps);
    expectFailure(first, 'refused', expectedCode);
    expectFailure(
      api.materializeAuthorityPolicy(input, defectDeps),
      'refused',
      'AUTHORITY_MATERIALIZATION_AUTHORIZATION_REPLAYED',
    );
  });
});

type ResolverFixture = Readonly<{
  role?: string;
  actionId?: string;
  queryActionId?: string;
  rules?: readonly unknown[];
  resource?: unknown;
  operation?: string;
  unknownContext?: boolean;
  declarationPolicyFactory?: () => ReturnType<typeof makePolicyPlant>;
}>;

async function runResolverFixture(fixture: ResolverFixture = {}): Promise<Record<string, unknown>> {
  const api = await runtimeApi();
  const issuer = createIssuer(api);
  const role = fixture.role ?? 'engineer';
  const actionId = fixture.actionId ?? 'test mutate';
  const action = actionDocumentWithId(actionId, 'local-write', {
    kind: 'human',
    allowed_roles: [role],
  });
  const plant = makePolicyPlant({ additiveRules: fixture.rules ?? [engineerRule] });
  const declarationPlant = fixture.declarationPolicyFactory?.() ?? plant;
  const declaration = expectSuccess<{ context_receipt: unknown }>(
    api.resolveAuthorityDeclaration(
      {
        action_id: actionId,
        invocation_id: 'invocation-1',
        dry_run: false,
        declaration: { as_role: role },
        consent: CONSENT,
      },
      declarationDependencies(issuer, action, undefined, policyBindingFromPlant(declarationPlant)),
    ),
  );
  const policy = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
  return api.resolveAuthorityPolicy(
    policy,
    {
      action_id: fixture.queryActionId ?? actionId,
      context_receipt: fixture.unknownContext ? {} : declaration.context_receipt,
      consent: CONSENT,
      resource: fixture.resource ?? fsTarget,
      operation: fixture.operation ?? 'update',
    },
    { receiptStore: issuer, canonicalSha256 },
  ) as Record<string, unknown>;
}

async function runReplayedResolverFixture(): Promise<Record<string, unknown>> {
  const fixture = await requiredAllowFixture();
  const subject = exactSubject();
  const issued = fixture.issuer.issueAllow(requiredIssueInput(fixture, subject));
  expect(issued).toMatchObject({ issued: true, outcome: 'allow' });
  const plant = makePolicyPlant();
  const policy = expectSuccess(
    fixture.api.loadAuthorityPolicy({ document: plant.document }, plant.deps),
  );
  return fixture.api.resolveAuthorityPolicy(
    policy,
    {
      action_id: 'test mutate',
      context_receipt: fixture.contextReceipt,
      consent: CONSENT,
      resource: fsTarget,
      operation: 'update',
    },
    { receiptStore: fixture.issuer, canonicalSha256 },
  ) as Record<string, unknown>;
}

describe('R19 resolver total-order and selector matrix', () => {
  const operationOnlyRule = {
    ...engineerRule,
    selector: { ...engineerRule.selector, operations: ['update'] },
  };
  const consentRule = {
    ...engineerRule,
    required_consent: { ...engineerRule.required_consent, experimental: true },
  };
  const denyRule = { ...engineerRule, rule_id: 'self-package-source-deny', effect: 'deny' };
  const scenarios = [
    {
      name: 'unknown context',
      expectedCode: 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN',
      run: () => runResolverFixture({ unknownContext: true }),
    },
    {
      name: 'replayed context',
      expectedCode: 'AUTHORITY_CONTEXT_RECEIPT_REPLAYED',
      run: runReplayedResolverFixture,
    },
    {
      name: 'selector submitted as apply resource',
      expectedCode: 'AUTHORITY_QUERY_INVALID',
      run: () =>
        runResolverFixture({
          resource: { kind: 'fs', canonical_relative_path_glob: 'packages/**' },
        }),
    },
    {
      name: 'remote operation field instead of operation_id',
      expectedCode: 'AUTHORITY_QUERY_INVALID',
      run: () =>
        runResolverFixture({
          resource: {
            kind: 'remote',
            id: remoteTarget.id,
            system_id: remoteTarget.system_id,
            endpoint_id: remoteTarget.endpoint_id,
            operation: remoteTarget.operation_id,
            publication: remoteTarget.publication,
          },
        }),
    },
    {
      name: 'well-formed query/resource operation disagreement',
      expectedCode: 'AUTHORITY_QUERY_OPERATION_MISMATCH',
      run: () => runResolverFixture({ operation: 'delete' }),
    },
    {
      name: 'context binding substitution',
      expectedCode: 'AUTHORITY_CONTEXT_RECEIPT_BINDING_MISMATCH',
      run: () => runResolverFixture({ queryActionId: 'test other' }),
    },
    {
      name: 'policy binding substitution',
      expectedCode: 'AUTHORITY_POLICY_BINDING_MISMATCH',
      run: () =>
        runResolverFixture({
          rules: [{ ...engineerRule, rationale: 'foreign policy binding fixture' }],
          declarationPolicyFactory: () => makePolicyPlant(),
        }),
    },
    {
      name: 'unclassified identity',
      expectedCode: 'UNCLASSIFIED_RESOURCE',
      run: () =>
        runResolverFixture({
          resource: { ...fsTarget, id: 'fs:unknown', canonical_relative_path: 'unknown/path.ts' },
        }),
    },
    {
      name: 'action denied',
      expectedCode: 'AUTHORITY_ACTION_DENIED',
      run: () => runResolverFixture({ actionId: 'test other' }),
    },
    {
      name: 'subject denied',
      expectedCode: 'AUTHORITY_SUBJECT_DENIED',
      run: () => runResolverFixture({ role: 'auditor' }),
    },
    {
      name: 'operation denied',
      expectedCode: 'AUTHORITY_OPERATION_DENIED',
      run: () =>
        runResolverFixture({
          rules: [operationOnlyRule],
          resource: { ...fsTarget, operation: 'delete' },
          operation: 'delete',
        }),
    },
    {
      name: 'consent missing',
      expectedCode: 'AUTHORITY_CONSENT_REQUIRED',
      run: () => runResolverFixture({ rules: [consentRule] }),
    },
    {
      name: 'equal-highest conflict',
      expectedCode: 'AMBIGUOUS_POLICY_MATCH',
      run: () => runResolverFixture({ rules: [engineerRule, denyRule] }),
    },
    {
      name: 'explicit deny',
      expectedCode: 'POLICY_DENY',
      run: () => runResolverFixture({ rules: [denyRule] }),
    },
    {
      name: 'otherwise allow',
      expectedCode: 'POLICY_ALLOW',
      run: () => runResolverFixture(),
    },
  ];

  it.each(scenarios)('$name occupies its exact resolver precedence slot', async (scenario) => {
    const result = await scenario.run();
    expect(result).toMatchObject(
      scenario.expectedCode === 'POLICY_ALLOW'
        ? { outcome: 'allow', code: scenario.expectedCode }
        : { outcome: 'deny', category: 'refused', code: scenario.expectedCode },
    );
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['dot:true admits dotfiles', 'packages/.hidden/file.ts', 'packages/**', 'POLICY_ALLOW'],
    [
      'leading slash forbidden',
      '/packages/core/src/index.ts',
      'packages/**',
      'AUTHORITY_QUERY_INVALID',
    ],
    [
      'backslash forbidden',
      'packages\\core\\src\\index.ts',
      'packages/**',
      'AUTHORITY_QUERY_INVALID',
    ],
    ['NUL forbidden', 'packages/core/\0index.ts', 'packages/**', 'AUTHORITY_QUERY_INVALID'],
    ['dot segment forbidden', 'packages/./core/index.ts', 'packages/**', 'AUTHORITY_QUERY_INVALID'],
    [
      'dot-dot segment forbidden',
      'packages/../core/index.ts',
      'packages/**',
      'AUTHORITY_QUERY_INVALID',
    ],
    [
      'repeated slash forbidden',
      'packages//core/index.ts',
      'packages/**',
      'AUTHORITY_QUERY_INVALID',
    ],
    ['trailing slash forbidden', 'packages/core/src/', 'packages/**', 'AUTHORITY_QUERY_INVALID'],
    [
      'negation is literal',
      '!packages/core/src/index.ts',
      '!packages/core/src/index.ts',
      'POLICY_ALLOW',
    ],
    [
      'comment is literal',
      '#packages/core/src/index.ts',
      '#packages/core/src/index.ts',
      'POLICY_ALLOW',
    ],
    [
      'extglob disabled',
      '@(packages)/core/src/index.ts',
      '@(packages)/core/src/index.ts',
      'POLICY_ALLOW',
    ],
    [
      'brace disabled',
      '{packages,libs}/core/src/index.ts',
      '{packages,libs}/core/src/index.ts',
      'POLICY_ALLOW',
    ],
    [
      'matching is case-sensitive',
      'Packages/core/src/index.ts',
      'packages/**',
      'UNCLASSIFIED_RESOURCE',
    ],
  ])('pins POSIX/minimatch selector semantics: %s', async (_name, path, glob, code) => {
    const api = await runtimeApi();
    const issuer = createIssuer(api);
    const selectorRule = {
      ...engineerRule,
      rule_id: 'selector-semantics',
      selector: { ...engineerRule.selector, canonical_relative_path_glob: glob },
    };
    const plant = makePolicyPlant({ additiveRules: [selectorRule] });
    const policy = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
    const boundDeclaration = expectSuccess<{ context_receipt: unknown }>(
      api.resolveAuthorityDeclaration(
        {
          action_id: 'test mutate',
          invocation_id: 'invocation-1',
          dry_run: false,
          declaration: { as_role: 'engineer' },
          consent: CONSENT,
        },
        declarationDependencies(issuer, undefined, undefined, policyBindingFromPlant(plant)),
      ),
    );
    const result = api.resolveAuthorityPolicy(
      policy,
      {
        action_id: 'test mutate',
        context_receipt: boundDeclaration.context_receipt,
        consent: CONSENT,
        resource: {
          ...fsTarget,
          id: `fs:${path}`,
          canonical_relative_path: path,
        },
        operation: 'update',
      },
      { receiptStore: issuer, canonicalSha256 },
    ) as Record<string, unknown>;
    expect(result).toMatchObject(
      code === 'POLICY_ALLOW'
        ? { outcome: 'allow', code, matched_rule_ids: ['selector-semantics'] }
        : { outcome: 'deny', category: 'refused', code },
    );
  });

  it.each([
    ['remote exact membership', 'engineer', remoteTarget, 'POLICY_ALLOW', 'remote-exact'],
    [
      'remote system is case-sensitive',
      'engineer',
      { ...remoteTarget, system_id: 'GitHub-Packages' },
      'UNCLASSIFIED_RESOURCE',
      undefined,
    ],
    [
      'remote endpoint is case-sensitive',
      'engineer',
      { ...remoteTarget, endpoint_id: 'NPM-Package' },
      'UNCLASSIFIED_RESOURCE',
      undefined,
    ],
    [
      'remote publication is exact',
      'engineer',
      { ...remoteTarget, publication: false },
      'UNCLASSIFIED_RESOURCE',
      undefined,
    ],
    [
      'rename source independently classified',
      'engineer',
      { ...fsTarget, operation: 'rename', rename_from_canonical_relative_path: 'docs/outside.md' },
      'UNCLASSIFIED_RESOURCE',
      undefined,
    ],
    [
      'rename destination independently classified',
      'engineer',
      {
        ...fsTarget,
        canonical_relative_path: 'docs/outside.md',
        operation: 'rename',
        rename_from_canonical_relative_path: 'packages/core/src/index.ts',
      },
      'UNCLASSIFIED_RESOURCE',
      undefined,
    ],
    [
      'joint glossary Owner allow',
      'owner',
      {
        ...fsTarget,
        id: 'fs:glossary',
        canonical_relative_path: 'docs/framework/glossary/authority.md',
      },
      'POLICY_ALLOW',
      'core-glossary-joint',
    ],
    [
      'joint glossary Architect allow',
      'architect',
      {
        ...fsTarget,
        id: 'fs:glossary',
        canonical_relative_path: 'docs/framework/glossary/authority.md',
      },
      'POLICY_ALLOW',
      'core-glossary-joint',
    ],
    [
      'joint glossary Engineer denied',
      'engineer',
      {
        ...fsTarget,
        id: 'fs:glossary',
        canonical_relative_path: 'docs/framework/glossary/authority.md',
      },
      'AUTHORITY_SUBJECT_DENIED',
      undefined,
    ],
    [
      'Inspector test outranks Engineer source',
      'inspector',
      {
        ...fsTarget,
        id: 'fs:test',
        canonical_relative_path: 'packages/core/src/test/authority.test.ts',
      },
      'POLICY_ALLOW',
      'self-package-tests',
    ],
  ])('%s', async (_name, role, target, code, matchedRule) => {
    const api = await runtimeApi();
    const issuer = createIssuer(api);
    const effect = (target as { kind: string }).kind === 'remote' ? 'remote-write' : 'local-write';
    const action = actionDocument(effect, { kind: 'human', allowed_roles: [role] });
    const remoteRule = {
      ...engineerRule,
      rule_id: 'remote-exact',
      selector: {
        kind: 'remote',
        system_id: 'github-packages',
        endpoint_ids: ['npm-package'],
        operation_ids: ['publish'],
        publication: true,
      },
      required_consent: { write: true, allow_publish: true, experimental: false },
    };
    const plant =
      (target as { kind: string }).kind === 'remote'
        ? makePolicyPlant({ rules: [], additiveRules: [remoteRule] })
        : makePolicyPlant({ rules: [glossaryRule], additiveRules: [engineerRule, inspectorRule] });
    const policy = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
    const boundDeclaration = expectSuccess<{ context_receipt: unknown }>(
      api.resolveAuthorityDeclaration(
        {
          action_id: 'test mutate',
          invocation_id: 'invocation-1',
          dry_run: false,
          declaration: { as_role: role },
          consent: effect === 'remote-write' ? { ...CONSENT, allow_publish: true } : CONSENT,
        },
        declarationDependencies(issuer, action, undefined, policyBindingFromPlant(plant)),
      ),
    );
    const result = api.resolveAuthorityPolicy(
      policy,
      {
        action_id: 'test mutate',
        context_receipt: boundDeclaration.context_receipt,
        consent: effect === 'remote-write' ? { ...CONSENT, allow_publish: true } : CONSENT,
        resource: target,
        operation:
          (target as { operation?: string; operation_id?: string }).operation ??
          (target as { operation_id: string }).operation_id,
      },
      { receiptStore: issuer, canonicalSha256 },
    ) as Record<string, unknown>;
    expect(result).toMatchObject(
      code === 'POLICY_ALLOW'
        ? { outcome: 'allow', code, matched_rule_ids: [matchedRule] }
        : { outcome: 'deny', category: 'refused', code },
    );
  });
});

async function requiredAllowFixture(targets: readonly unknown[] = [fsTarget]) {
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
  const policy = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
  const resolutions = targets.map((resource) =>
    api.resolveAuthorityPolicy(
      policy,
      {
        action_id: 'test mutate',
        context_receipt: declaration.context_receipt,
        consent: CONSENT,
        resource,
        operation: (resource as { operation: string }).operation,
      },
      { receiptStore: issuer, canonicalSha256 },
    ),
  );
  for (const resolution of resolutions) {
    expect(resolution).toMatchObject({ outcome: 'allow', code: 'POLICY_ALLOW' });
  }
  return { api, issuer, contextReceipt: declaration.context_receipt, resolutions };
}

function requiredIssueInput(
  fixture: Awaited<ReturnType<typeof requiredAllowFixture>>,
  subject: unknown,
  resolutions: readonly unknown[] = fixture.resolutions,
) {
  return {
    resolutions,
    subject,
    context_receipt: fixture.contextReceipt,
    invocation_id: 'invocation-1',
    boundary_adapter_id: 'fs-authority-boundary',
  };
}

async function requiredIssuedReceipt() {
  const fixture = await requiredAllowFixture();
  const subject = exactSubject();
  const issued = fixture.issuer.issueAllow(requiredIssueInput(fixture, subject)) as {
    issued: boolean;
    outcome: string;
    receipt: unknown;
  };
  expect(issued).toMatchObject({ issued: true, outcome: 'allow' });
  expect(issued.receipt).toBeTruthy();
  return { ...fixture, subject, receipt: issued.receipt };
}

async function requiredDenyFixture() {
  const api = await runtimeApi();
  const issuer = createIssuer(api);
  const denyRule = { ...engineerRule, rule_id: 'self-package-source-deny', effect: 'deny' };
  const plant = makePolicyPlant({ additiveRules: [denyRule] });
  const action = actionDocument();
  const declarationInput = {
    action_id: 'test mutate',
    invocation_id: 'invocation-1',
    dry_run: false,
    declaration: { as_role: 'engineer' },
    consent: CONSENT,
  };
  const deps = declarationDependencies(issuer, action, undefined, policyBindingFromPlant(plant));
  const first = expectSuccess<{ context_receipt: unknown }>(
    api.resolveAuthorityDeclaration(declarationInput, deps),
  );
  const second = expectSuccess<{ context_receipt: unknown }>(
    api.resolveAuthorityDeclaration(declarationInput, deps),
  );
  const policy = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
  const denial = api.resolveAuthorityPolicy(
    policy,
    {
      action_id: 'test mutate',
      context_receipt: first.context_receipt,
      consent: CONSENT,
      resource: fsTarget,
      operation: 'update',
    },
    { receiptStore: issuer, canonicalSha256 },
  );
  expect(denial).toMatchObject({ outcome: 'deny', code: 'POLICY_DENY' });
  return {
    api,
    issuer,
    denial,
    contextReceipt: first.context_receipt,
    otherContextReceipt: second.context_receipt,
    subject: exactSubject([fsTarget], plant),
  };
}

describe('R19 issuer complete-set, batch, and receipt matrix', () => {
  it.each([
    [
      'exact plan with batch',
      () => ({
        ...(exactSubject() as object),
        batch: (boundedSubject() as { batch: unknown }).batch,
      }),
    ],
    [
      'bounded plan without batch',
      () => {
        const { batch: _batch, ...subject } = boundedSubject() as Record<string, unknown>;
        return subject;
      },
    ],
    [
      'bounded wrong plan_id',
      () => {
        const subject = boundedSubject() as { plan: unknown; batch: Record<string, unknown> };
        return { ...subject, batch: { ...subject.batch, plan_id: 'plan-foreign' } };
      },
    ],
    [
      'bounded duplicate targets',
      () => {
        const subject = boundedSubject() as { plan: unknown; batch: Record<string, unknown> };
        return { ...subject, batch: { ...subject.batch, targets: [fsTarget, fsTarget] } };
      },
    ],
    [
      'bounded out-of-selector target',
      () => boundedSubject([{ ...fsTarget, canonical_relative_path: 'docs/README.md' }]),
    ],
    [
      'bounded per-batch overflow',
      () =>
        boundedSubject([
          fsTarget,
          secondFsTarget,
          {
            ...fsTarget,
            id: 'fs:packages/core/src/third.ts',
            canonical_relative_path: 'packages/core/src/third.ts',
          },
        ]),
    ],
  ])('%s refuses a concrete non-exact subject before issuance', async (_name, subject) => {
    const fixture = await requiredAllowFixture();
    const result = fixture.issuer.issueAllow(requiredIssueInput(fixture, subject(), []));
    expectFailure(result, 'refused', 'AUTHORITY_DECISION_SUBJECT_NOT_EXACT');
    expect(result).not.toHaveProperty('receipt');
  });

  it('refuses an unrecognized structural allow before issuing a receipt', async () => {
    const fixture = await requiredAllowFixture();
    const result = fixture.issuer.issueAllow(requiredIssueInput(fixture, exactSubject(), [{}]));
    expectFailure(result, 'refused', 'AUTHORITY_DECISION_INPUT_INVALID');
    expect(result).not.toHaveProperty('receipt');
  });

  it.each([
    ['structural allow clone', (allow: unknown) => ({ ...(allow as object) })],
    ['JSON-round-tripped allow', (allow: unknown) => JSON.parse(JSON.stringify(allow))],
  ])('%s is not private resolver membership', async (_name, cloneAllow) => {
    const fixture = await requiredAllowFixture();
    const result = fixture.issuer.issueAllow(
      requiredIssueInput(fixture, exactSubject(), [cloneAllow(fixture.resolutions[0])]),
    );
    expectFailure(result, 'refused', 'AUTHORITY_DECISION_INPUT_INVALID');
    expect(result).not.toHaveProperty('receipt');
  });

  it('issues a full audit denial with no receipt or verified binding', async () => {
    const fixture = await requiredDenyFixture();
    const issued = fixture.issuer.issueDenial({
      resolution: fixture.denial,
      subject: fixture.subject,
      context_receipt: fixture.contextReceipt,
      invocation_id: 'invocation-1',
    }) as Record<string, unknown>;
    expect(issued).toMatchObject({
      issued: true,
      outcome: 'deny',
      decision: { evaluation: 'deny', disposition: 'refuse' },
    });
    expect(issued).not.toHaveProperty('receipt');
    expect(issued).not.toHaveProperty('binding');
    expect(issued).not.toHaveProperty('verifiedDecisionBinding');
  });

  it('refuses cloned denial identity and denial/context substitution', async () => {
    const fixture = await requiredDenyFixture();
    for (const denial of [
      { ...(fixture.denial as object) },
      JSON.parse(JSON.stringify(fixture.denial)),
    ]) {
      expectFailure(
        fixture.issuer.issueDenial({
          resolution: denial,
          subject: fixture.subject,
          context_receipt: fixture.contextReceipt,
          invocation_id: 'invocation-1',
        }),
        'refused',
        'AUTHORITY_DECISION_DENIAL_UNKNOWN',
      );
    }
    expectFailure(
      fixture.issuer.issueDenial({
        resolution: fixture.denial,
        subject: fixture.subject,
        context_receipt: fixture.otherContextReceipt,
        invocation_id: 'invocation-1',
      }),
      'refused',
      'AUTHORITY_DECISION_DENIAL_BINDING_MISMATCH',
    );
  });

  it('refuses duplicate resolution identity before later set defects', async () => {
    const fixture = await requiredAllowFixture();
    const result = fixture.issuer.issueAllow(
      requiredIssueInput(fixture, exactSubject(), [fixture.resolutions[0], fixture.resolutions[0]]),
    );
    expectFailure(result, 'refused', 'AUTHORITY_DECISION_RESOLUTION_DUPLICATE');
    expect(result).not.toHaveProperty('receipt');
  });

  it('refuses a same-identity allow from a foreign policy binding', async () => {
    const fixture = await requiredAllowFixture();
    const subject = exactSubject() as { plan: Record<string, unknown> };
    const envelope = subject.plan.envelope as Record<string, unknown>;
    const foreignEnvelopeDraft = {
      ...envelope,
      policy: {
        ...(envelope.policy as object),
        resolved_digest_sha256: 'f'.repeat(64),
      },
    } as unknown as MutationEnvelope;
    const foreignEnvelope = {
      ...foreignEnvelopeDraft,
      issued_by: {
        ...foreignEnvelopeDraft.issued_by,
        envelope_digest_sha256: computeMutationEnvelopeDigest(foreignEnvelopeDraft),
      },
    } as MutationEnvelope;
    const foreignSubject = {
      ...subject,
      plan: {
        ...subject.plan,
        envelope: foreignEnvelope,
      },
    };
    const result = fixture.issuer.issueAllow(requiredIssueInput(fixture, foreignSubject));
    expectFailure(result, 'refused', 'AUTHORITY_DECISION_RESOLUTION_FOREIGN_POLICY');
    expect(result).not.toHaveProperty('receipt');
  });

  it('refuses an otherwise valid allow that is extra to the exact plan', async () => {
    const fixture = await requiredAllowFixture([fsTarget, secondFsTarget]);
    const result = fixture.issuer.issueAllow(requiredIssueInput(fixture, exactSubject([fsTarget])));
    expectFailure(result, 'refused', 'AUTHORITY_DECISION_RESOLUTION_EXTRA');
    expect(result).not.toHaveProperty('receipt');
  });

  it('refuses a same-target allow whose exact query differs', async () => {
    const fixture = await requiredAllowFixture();
    const result = fixture.issuer.issueAllow(
      requiredIssueInput(fixture, exactSubject([{ ...fsTarget, operation: 'delete' }])),
    );
    expectFailure(result, 'refused', 'AUTHORITY_DECISION_RESOLUTION_QUERY_MISMATCH');
    expect(result).not.toHaveProperty('receipt');
  });

  it('refuses one representative allow for a multi-target exact plan', async () => {
    const fixture = await requiredAllowFixture([fsTarget, secondFsTarget]);
    const result = fixture.issuer.issueAllow(
      requiredIssueInput(fixture, exactSubject([fsTarget, secondFsTarget]), [
        fixture.resolutions[0],
      ]),
    );
    expectFailure(result, 'refused', 'AUTHORITY_DECISION_RESOLUTION_MISSING');
    expect(result).not.toHaveProperty('receipt');
  });

  it('accepts a structurally valid plan-linked fabricated batch only as policy exactness, never final apply authority', async () => {
    const fixture = await requiredAllowFixture();
    const subject = boundedSubject();
    const issued = fixture.issuer.issueAllow(requiredIssueInput(fixture, subject)) as {
      issued: boolean;
      outcome: string;
      receipt: unknown;
    };
    expect(issued).toMatchObject({ issued: true, outcome: 'allow' });
    expect(issued.receipt).toBeTruthy();
    expect(subject).not.toHaveProperty('planner_receipt');
    expect(subject).not.toHaveProperty('planner_registry_membership');
  });

  it.each([
    ['receipt structural clone', (receipt: unknown) => ({ ...(receipt as object) })],
    ['receipt JSON round-trip', (receipt: unknown) => JSON.parse(JSON.stringify(receipt))],
  ])('%s is unknown to the issuer store', async (_name, transform) => {
    const fixture = await requiredIssuedReceipt();
    expectFailure(
      fixture.issuer.consume({
        receipt: transform(fixture.receipt),
        subject: fixture.subject,
        invocation_id: 'invocation-1',
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_DECISION_RECEIPT_UNKNOWN',
    );
  });

  it('distinguishes a receipt owned by a foreign issuer', async () => {
    const fixture = await requiredIssuedReceipt();
    const foreignIssuer = createIssuer(fixture.api, { issuer_id: 'foreign-authority-issuer' });
    expectFailure(
      foreignIssuer.consume({
        receipt: fixture.receipt,
        subject: fixture.subject,
        invocation_id: 'invocation-1',
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_DECISION_RECEIPT_FOREIGN_ISSUER',
    );
  });

  it('expires from the issuer-owned clock rather than caller input', async () => {
    let clock = NOW;
    const api = await runtimeApi();
    const issuer = createIssuer(api, { now: () => clock });
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
    const policy = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
    const allow = api.resolveAuthorityPolicy(
      policy,
      {
        action_id: 'test mutate',
        context_receipt: declaration.context_receipt,
        consent: CONSENT,
        resource: fsTarget,
        operation: 'update',
      },
      { receiptStore: issuer, canonicalSha256 },
    );
    const subject = exactSubject();
    const issued = issuer.issueAllow({
      resolutions: [allow],
      subject,
      context_receipt: declaration.context_receipt,
      invocation_id: 'invocation-1',
      boundary_adapter_id: 'fs-authority-boundary',
    }) as { issued: boolean; receipt: unknown };
    expect(issued.issued).toBe(true);
    clock = '2026-07-15T12:00:02.000Z';
    expectFailure(
      issuer.consume({
        receipt: issued.receipt,
        subject,
        invocation_id: 'invocation-1',
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_DECISION_RECEIPT_EXPIRED',
    );
  });

  it('burns a valid receipt atomically on first consumption', async () => {
    const fixture = await requiredIssuedReceipt();
    const input = {
      receipt: fixture.receipt,
      subject: fixture.subject,
      invocation_id: 'invocation-1',
      adapter_id: 'fs-authority-boundary',
    };
    expectSuccess(fixture.issuer.consume(input));
    expectFailure(fixture.issuer.consume(input), 'refused', 'AUTHORITY_DECISION_RECEIPT_REPLAYED');
  });

  it('dispose invalidates an outstanding decision receipt and a separate live context', async () => {
    const fixture = await requiredIssuedReceipt();
    const live = expectSuccess<{ context_receipt: unknown }>(
      fixture.api.resolveAuthorityDeclaration(
        {
          action_id: 'test mutate',
          invocation_id: 'invocation-1',
          dry_run: false,
          declaration: { as_role: 'engineer' },
          consent: CONSENT,
        },
        declarationDependencies(fixture.issuer),
      ),
    );
    const plant = makePolicyPlant();
    const policy = expectSuccess(
      fixture.api.loadAuthorityPolicy({ document: plant.document }, plant.deps),
    );
    expectSuccess(fixture.issuer.dispose());
    expectFailure(
      fixture.issuer.consume({
        receipt: fixture.receipt,
        subject: fixture.subject,
        invocation_id: 'invocation-1',
        adapter_id: 'fs-authority-boundary',
      }),
      'refused',
      'AUTHORITY_DECISION_ISSUER_CLOSED',
    );
    expect(
      fixture.api.resolveAuthorityPolicy(
        policy,
        {
          action_id: 'test mutate',
          context_receipt: live.context_receipt,
          consent: CONSENT,
          resource: fsTarget,
          operation: 'update',
        },
        { receiptStore: fixture.issuer, canonicalSha256 },
      ),
    ).toMatchObject({
      outcome: 'deny',
      category: 'refused',
      code: 'AUTHORITY_CONTEXT_RECEIPT_REPLAYED',
    });
  });

  it.each([
    ['wrong boundary adapter', { adapter_id: 'git-authority-boundary' }],
    ['wrong invocation', { invocation_id: 'invocation-foreign' }],
    ['changed subject', { subject: exactSubject([secondFsTarget]) }],
  ])('%s is a concrete receipt binding mismatch', async (_name, override) => {
    const fixture = await requiredIssuedReceipt();
    expectFailure(
      fixture.issuer.consume({
        receipt: fixture.receipt,
        subject: fixture.subject,
        invocation_id: 'invocation-1',
        adapter_id: 'fs-authority-boundary',
        ...override,
      }),
      'refused',
      'AUTHORITY_DECISION_RECEIPT_BINDING_MISMATCH',
    );
  });
});

describe('R19 evidence total-order matrix', () => {
  const viewOf = (document: unknown) => (document as { view: Record<string, unknown> }).view;
  const validatorFor = (document: unknown) => (value: unknown) => ({
    ok: true,
    value: { ...(document as object), raw: value },
  });
  const readinessDefect = {
    authority_eligible: true,
    production_ready: false,
    reason: 'invalid for the exercised posture',
  };
  const auditorPrincipal = {
    kind: 'human',
    role: 'auditor',
    declaration_source: 'cli-flag',
  };
  const bootstrapPrincipal = {
    kind: 'derived-machine',
    actor: 'bootstrap',
    transition: 'bootstrap',
    trusted_adapter_id: 'bootstrap-authority',
    context_digest_sha256: '3'.repeat(64),
    initiated_by: 'none',
  };
  const bindingWithEngineerInitiator = {
    kind: 'derived-machine',
    actor: 'binding',
    transition: 'bind',
    trusted_adapter_id: 'binding-authority',
    context_digest_sha256: '4'.repeat(64),
    initiated_by: { role: 'engineer', declaration_source: 'cli-flag' },
  };

  it.each([
    [
      'target/decision semantic coherence precedes timestamp',
      evidenceDocument({
        timestamp: '2026-07-15T12:00:01.000Z',
        targets: {
          count: 2,
          kinds: ['fs'],
          target_ids_digest_sha256: canonicalSha256([fsTarget.id]),
          summary: [{ kind: 'fs', operation: 'update', resource_id: fsTarget.id }],
        },
      }),
      evidenceBindings(),
      actionDocument(),
      'AUTHORITY_EVIDENCE_SEMANTIC_INVALID',
    ],
    [
      'future timestamp precedes current binding',
      evidenceDocument({ timestamp: '2026-07-15T12:00:01.000Z' }),
      evidenceBindings({ repository_id: 'other-repository' }),
      actionDocument(),
      'AUTHORITY_EVIDENCE_TIMESTAMP_INVALID',
    ],
    [
      'current binding precedes issuer identity',
      evidenceDocument(),
      evidenceBindings({
        repository_id: 'other-repository',
        issuer: { issuer_id: 'foreign-issuer', issuer_version: '1.0.0' },
      }),
      actionDocument(),
      'AUTHORITY_EVIDENCE_BINDING_MISMATCH',
    ],
    [
      'issuer identity precedes action/principal provenance',
      evidenceDocument({ principal: auditorPrincipal }),
      evidenceBindings({ issuer: { issuer_id: 'foreign-issuer', issuer_version: '1.0.0' } }),
      actionDocument(),
      'AUTHORITY_EVIDENCE_ISSUER_INVALID',
    ],
    [
      'action/principal provenance precedes readiness',
      evidenceDocument({ principal: auditorPrincipal, dry_run: true, readiness: readinessDefect }),
      evidenceBindings(),
      actionDocument(),
      'AUTHORITY_EVIDENCE_PROVENANCE_INVALID',
    ],
    [
      'bootstrap containment precedes readiness',
      evidenceDocument({
        action_id: 'test read',
        action_effect: 'read',
        dry_run: true,
        principal: bootstrapPrincipal,
        targets: {
          count: 0,
          kinds: [],
          target_ids_digest_sha256: canonicalSha256([]),
          summary: [],
        },
        decision: {
          decision_id: 'invalid-bootstrap-read',
          decision_digest_sha256: '1'.repeat(64),
          subject_digest_sha256: '2'.repeat(64),
          evaluation: 'allow',
          disposition: 'proceed',
          reason_code: 'POLICY_ALLOW',
          reasons: ['bootstrap read cannot be an allow decision'],
        },
        readiness: readinessDefect,
      }),
      evidenceBindings(),
      actionDocument('read', { kind: 'none' }),
      'AUTHORITY_EVIDENCE_BOOTSTRAP_INVALID',
    ],
    [
      'initiator semantics precede readiness',
      evidenceDocument({
        principal: bindingWithEngineerInitiator,
        dry_run: true,
        readiness: readinessDefect,
      }),
      evidenceBindings(),
      actionDocument(
        'local-write',
        {
          kind: 'derived-machine',
          actor: 'binding',
          transition: 'bind',
          initiator: { allowed_roles: ['architect'], preserve_in_context: true },
        },
        { kind: 'exact-plan', planner_id: 'test-bind', target_kinds: ['fs'] },
      ),
      'AUTHORITY_EVIDENCE_INITIATOR_INVALID',
    ],
    [
      'readiness eligibility is last',
      evidenceDocument({ dry_run: true, readiness: readinessDefect }),
      evidenceBindings(),
      actionDocument(),
      'AUTHORITY_EVIDENCE_READINESS_INVALID',
    ],
  ])('%s with exact outcome %s', async (_name, document, current, action, code) => {
    const api = await runtimeApi();
    const bindings = current as Record<string, unknown>;
    const registeredActionId = (action as { view: { action_id: string } }).view.action_id;
    const result = api.validateAuthorityEvidence(viewOf(document), {
      current: {
        ...bindings,
        actionContracts: {
          get(actionId: string): unknown {
            return actionId === registeredActionId ? action : undefined;
          },
        },
      },
      canonicalSha256,
      validateSchema: validatorFor(document),
    });
    expectFailure(result, 'refused', code);
  });

  it('ordinary live read emits no authority evidence and bootstrap read is the sole ineligible audit exception', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-read' });
    const readAction = actionDocument('read', { kind: 'none' });
    const declaration = expectSuccess<{
      principal: null;
      evidence?: unknown;
    }>(
      api.resolveAuthorityDeclaration(
        {
          action_id: 'test read',
          invocation_id: 'invocation-read',
          dry_run: false,
          declaration: {},
          consent: { write: false, allow_publish: false, experimental: false },
        },
        declarationDependencies(issuer, readAction),
      ),
    );
    expect(declaration.principal).toBeNull();
    expect(declaration).not.toHaveProperty('evidence');

    const historicalBootstrapRead = evidenceDocument({
      action_id: 'test read',
      action_effect: 'read',
      dry_run: true,
      principal: bootstrapPrincipal,
      targets: {
        count: 0,
        kinds: [],
        target_ids_digest_sha256: canonicalSha256([]),
        summary: [],
      },
      decision: {
        decision_id: 'historical-bootstrap-read',
        decision_digest_sha256: '1'.repeat(64),
        subject_digest_sha256: '2'.repeat(64),
        evaluation: 'not-applicable',
        disposition: 'proceed',
        reason_code: 'AUTHORITY_NOT_APPLICABLE',
        reasons: ['historical bootstrap read/plan audit record'],
      },
      readiness: {
        authority_eligible: false,
        production_ready: false,
        reason: 'Historical bootstrap reads are audit-only.',
      },
    });
    const bootstrapResult = api.validateAuthorityEvidence(viewOf(historicalBootstrapRead), {
      current: {
        ...(evidenceBindings() as Record<string, unknown>),
        actionContracts: {
          get(actionId: string): unknown {
            return actionId === 'test read' ? readAction : undefined;
          },
        },
      },
      canonicalSha256,
      validateSchema: validatorFor(historicalBootstrapRead),
    });
    const accepted = expectSuccess<{
      evidence: { view: Record<string, unknown> };
      audit_only: true;
    }>(bootstrapResult);
    expect(accepted.audit_only).toBe(true);
    expect(accepted.evidence.view).toMatchObject({
      action_effect: 'read',
      principal: { actor: 'bootstrap', transition: 'bootstrap' },
      decision: { evaluation: 'not-applicable', disposition: 'proceed' },
      readiness: { authority_eligible: false, production_ready: false },
    });
    expect(accepted).not.toHaveProperty('receipt');
  });
});
