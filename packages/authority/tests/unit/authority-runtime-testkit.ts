import { createHash } from 'node:crypto';
import { computeMutationEnvelopeDigest, type MutationEnvelope } from '../../src/index.js';
import { canonicalJson } from '@devai-nyx/utils';

export const NOW = '2026-07-15T12:00:00.000Z';
export const LATER = '2026-07-15T13:00:00.000Z';
export const REPOSITORY_ID = 'example-repository';
export const PACKAGE_BINDING = { name: '@aarusso-nyx/devai', version: '0.6.0' } as const;
export const CONSTITUTION_BINDING = {
  version: '0.5.0',
  digest_sha256: 'c'.repeat(64),
} as const;
export const CONSENT = {
  write: true,
  allow_publish: false,
  experimental: false,
} as const;

export type Failure = Readonly<{
  ok: false;
  category: 'usage-error' | 'refused' | 'dependency-error';
  code: string;
  reasons: readonly string[];
}>;

export type Success<T = unknown> = Readonly<{ ok: true; value: T }>;
export type Tagged<T = unknown> = Success<T> | Failure;

export interface RuntimeApi {
  loadAuthorityPolicy(input: unknown, deps: unknown): Tagged;
  resolveAuthorityPolicy(policy: unknown, query: unknown, deps: unknown): unknown;
  materializeAuthorityPolicy(input: unknown, deps: unknown): Tagged;
  resolveAuthorityDeclaration(input: unknown, deps: unknown): Tagged;
  deriveMachineAuthorityContext(input: unknown, deps: unknown): Tagged;
  authorizePolicyMaterialization(input: unknown, deps: unknown): Tagged;
  createAuthorityDecisionIssuer(deps: unknown): AuthorityDecisionIssuer;
  validateAuthorityEvidence(input: unknown, deps: unknown): Tagged;
}

export interface AuthorityDecisionIssuer {
  readonly issuer_id: string;
  readonly issuer_version: string;
  issueAllow(input: unknown): unknown;
  issueDenial(input: unknown): unknown;
  consume(input: unknown): Tagged;
  dispose(): Tagged;
}

export async function runtimeApi(): Promise<RuntimeApi> {
  const runtimeModule = new URL('../../src/runtime/index.js', import.meta.url).href;
  return (await import(/* @vite-ignore */ runtimeModule)) as RuntimeApi;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalSha256(value: unknown): string {
  return sha256Bytes(canonicalBytes(value));
}

export function expectFailure(result: unknown, category: Failure['category'], code: string): void {
  const failure = result as Failure;
  if (failure.ok !== false || failure.category !== category || failure.code !== code) {
    throw new Error(`expected ${category}/${code}, received ${canonicalJson(result)}`);
  }
}

export function expectSuccess<T = unknown>(result: unknown): T {
  const success = result as Success<T>;
  if (success.ok !== true) {
    throw new Error(`expected success, received ${canonicalJson(result)}`);
  }
  return success.value;
}

export const fsTarget = {
  kind: 'fs',
  id: 'fs:packages/core/src/index.ts',
  repository_id: REPOSITORY_ID,
  canonical_relative_path: 'packages/core/src/index.ts',
  operation: 'update',
} as const;

export const secondFsTarget = {
  kind: 'fs',
  id: 'fs:packages/core/src/authority/types.ts',
  repository_id: REPOSITORY_ID,
  canonical_relative_path: 'packages/core/src/authority/types.ts',
  operation: 'update',
} as const;

export const remoteTarget = {
  kind: 'remote',
  id: 'remote:github-packages:publish',
  system_id: 'github-packages',
  endpoint_id: 'npm-package',
  operation_id: 'publish',
  publication: true,
} as const;

export const engineerRule = {
  rule_id: 'self-package-source',
  origin: 'additive-extension',
  precedence: 500,
  action_ids: ['test mutate'],
  selector: {
    kind: 'fs',
    repository_id: REPOSITORY_ID,
    canonical_relative_path_glob: 'packages/**/src/**',
    operations: ['create', 'update', 'delete', 'rename'],
  },
  effect: 'allow',
  subjects: [{ kind: 'human', roles: ['engineer'] }],
  required_consent: { write: true, allow_publish: false, experimental: false },
  constitutional_anchors: [6, 8],
  rationale: 'Engineer owns implementation source.',
} as const;

export const inspectorRule = {
  rule_id: 'self-package-tests',
  origin: 'additive-extension',
  precedence: 800,
  action_ids: ['test mutate'],
  selector: {
    kind: 'fs',
    repository_id: REPOSITORY_ID,
    canonical_relative_path_glob: 'packages/**/test/**',
    operations: ['create', 'update', 'delete', 'rename'],
  },
  effect: 'allow',
  subjects: [{ kind: 'human', roles: ['inspector'] }],
  required_consent: { write: true, allow_publish: false, experimental: false },
  constitutional_anchors: [6, 9],
  rationale: 'Inspector owns tests even below package source.',
} as const;

export const glossaryRule = {
  rule_id: 'core-glossary-joint',
  origin: 'immutable-core',
  precedence: 700,
  action_ids: ['test mutate'],
  selector: {
    kind: 'fs',
    repository_id: REPOSITORY_ID,
    canonical_relative_path_glob: 'docs/framework/glossary/**',
    operations: ['create', 'update', 'delete', 'rename'],
  },
  effect: 'allow',
  subjects: [{ kind: 'human', roles: ['owner', 'architect'] }],
  required_consent: { write: true, allow_publish: false, experimental: false },
  constitutional_anchors: [6],
  rationale: 'Glossary is explicitly joint.',
} as const;

export function actionDocument(
  effect: 'read' | 'harness-write' | 'local-write' | 'remote-write' = 'local-write',
  subject: unknown = { kind: 'human', allowed_roles: ['engineer'] },
  planner: unknown = {
    kind: 'exact-plan',
    planner_id: 'test-exact',
    target_kinds: ['fs'],
    atomicity: 'whole-plan',
  },
): unknown {
  const view = {
    schemaVersion: '1.0.0',
    action_id: effect === 'read' ? 'test read' : 'test mutate',
    effect,
    subject,
    consent: {
      write: effect !== 'read',
      allow_publish: effect === 'remote-write',
      experimental: false,
    },
    planner: effect === 'read' ? { kind: 'none' } : planner,
    boundary:
      effect === 'read'
        ? { kind: 'none' }
        : {
            kind: 'mutation-adapters',
            adapter_ids: ['fs-authority-boundary'],
            final_reverification: true,
          },
    readiness: { requires_binding: effect !== 'read', independent_acceptance_required: true },
  };
  return { raw: view, canonical_bytes: canonicalBytes(view), view };
}

export function actionDocumentWithId(
  actionId: string,
  effect: 'read' | 'harness-write' | 'local-write' | 'remote-write',
  subject: unknown,
  planner?: unknown,
): unknown {
  const document = actionDocument(effect, subject, planner);
  const view = {
    ...(document as { view: Record<string, unknown> }).view,
    action_id: actionId,
  };
  return { raw: view, canonical_bytes: canonicalBytes(view), view };
}

export function actionRegistry(documents: readonly unknown[]): unknown {
  return {
    get(actionId: string): unknown {
      return documents.find(
        (document) => (document as { view?: { action_id?: string } }).view?.action_id === actionId,
      );
    },
  };
}

export function makePolicyPlant(
  options: {
    rules?: readonly unknown[];
    additiveRules?: readonly unknown[];
    policyVersion?: string;
    repositoryId?: string;
    enforcement?: unknown;
    materializedAt?: string;
  } = {},
): {
  document: unknown;
  immutableCore: unknown;
  additiveExtensions: readonly unknown[];
  deps: Record<string, unknown>;
} {
  const coreRules = options.rules ?? [glossaryRule];
  const additiveRules = options.additiveRules ?? [engineerRule, inspectorRule];
  const sourceDocument = {
    policy_id: 'devai-core-authority',
    policy_version: '1.0.0',
    rules: coreRules,
  };
  const extensionDocument = {
    extension_id: 'example-authority',
    extension_version: '1.0.0',
    rules: additiveRules,
  };
  const coreBytes = canonicalBytes(sourceDocument);
  const extensionBytes = canonicalBytes(extensionDocument);
  const resolvedRules = [...coreRules, ...additiveRules];
  const raw = {
    schemaVersion: '1.0.0',
    policy_id: 'devai-authority',
    policy_version: options.policyVersion ?? '1.0.0',
    repository_id: options.repositoryId ?? REPOSITORY_ID,
    framework_package: PACKAGE_BINDING,
    constitution: CONSTITUTION_BINDING,
    source_policy: {
      policy_id: 'devai-core-authority',
      policy_version: '1.0.0',
      digest_sha256: sha256Bytes(coreBytes),
    },
    additive_extensions: [
      {
        extension_id: 'example-authority',
        extension_version: '1.0.0',
        digest_sha256: sha256Bytes(extensionBytes),
      },
    ],
    resolved_digest_sha256: canonicalSha256(resolvedRules),
    materialized_at: options.materializedAt ?? NOW,
    materialization: {
      action_id: 'init bind',
      invocation_id: 'invocation-materialize',
      machine_principal: {
        kind: 'machine',
        actor: 'binding',
        transition: 'bind',
        trusted_adapter_id: 'binding-authority',
        context_digest_sha256: 'd'.repeat(64),
      },
      initiated_by: { kind: 'human', role: 'architect', declaration_source: 'cli-flag' },
      consent: { write: true },
      materialization_digest_sha256: 'e'.repeat(64),
    },
    enforcement: options.enforcement ?? { mode: 'binding' },
    host_enforcement: { mode: 'cli-only' },
    rules: resolvedRules,
  };
  const immutableCore = {
    policy_id: 'devai-core-authority',
    policy_version: '1.0.0',
    source_document: sourceDocument,
    canonical_source_bytes: coreBytes,
    rules: coreRules,
  };
  const additiveExtensions = [
    {
      extension_id: 'example-authority',
      extension_version: '1.0.0',
      source_document: extensionDocument,
      canonical_source_bytes: extensionBytes,
      rules: additiveRules,
    },
  ];
  return {
    document: raw,
    immutableCore,
    additiveExtensions,
    deps: {
      now: NOW,
      expected_repository_id: REPOSITORY_ID,
      expected_policy_id: 'devai-authority',
      expected_minimum_policy_version: '1.0.0',
      expected_package: PACKAGE_BINDING,
      expected_constitution: CONSTITUTION_BINDING,
      immutableCore,
      additiveExtensions,
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

export function policyBindingFromPlant(plant: { document: unknown }): unknown {
  const document = plant.document as Record<string, unknown>;
  return {
    policy_id: document.policy_id,
    policy_version: document.policy_version,
    repository_id: document.repository_id,
    framework_package: document.framework_package,
    constitution: document.constitution,
    source_policy: document.source_policy,
    additive_extensions: document.additive_extensions,
    resolved_digest_sha256: document.resolved_digest_sha256,
    materialized_from: { kind: 'project-config', path: '.devai/config/authority-policy.json' },
  };
}

export function declarationDependencies(
  receiptStore: AuthorityDecisionIssuer,
  document: unknown = actionDocument(),
  session?: unknown,
  policyBinding?: unknown,
): Record<string, unknown> {
  const policy = makePolicyPlant();
  const policyDocument = policy.document as Record<string, unknown>;
  return {
    now: NOW,
    repository_id: REPOSITORY_ID,
    policy_binding: policyBinding ?? {
      policy_id: policyDocument.policy_id,
      policy_version: policyDocument.policy_version,
      repository_id: policyDocument.repository_id,
      framework_package: policyDocument.framework_package,
      constitution: policyDocument.constitution,
      source_policy: policyDocument.source_policy,
      additive_extensions: policyDocument.additive_extensions,
      resolved_digest_sha256: policyDocument.resolved_digest_sha256,
      materialized_from: { kind: 'project-config', path: '.devai/config/authority-policy.json' },
    },
    constitution_binding: CONSTITUTION_BINDING,
    package_binding: PACKAGE_BINDING,
    actionContracts: actionRegistry([document]),
    receiptStore,
    canonicalSha256,
    readSession: () => ({ ok: true, value: session }),
    validateSessionSchema: (value: unknown) => ({ ok: true, value }),
  };
}

export function sessionDocument(overrides: Record<string, unknown> = {}): unknown {
  const policy = makePolicyPlant().document as Record<string, unknown>;
  const draft = {
    schemaVersion: '1.0.0',
    session_id: 'AUTH-SESSION-abcdefghijklmnop',
    repository_id: REPOSITORY_ID,
    role: 'engineer',
    declaration_source: 'cli-flag',
    status: 'active',
    created_at: '2026-07-15T11:00:00.000Z',
    expires_at: LATER,
    created_by_invocation_id: 'invocation-session-start',
    policy_binding: {
      policy_id: policy.policy_id,
      policy_version: policy.policy_version,
      resolved_digest_sha256: policy.resolved_digest_sha256,
    },
    constitution_binding: CONSTITUTION_BINDING,
    package_binding: PACKAGE_BINDING,
    ...overrides,
  };
  const view = {
    ...draft,
    session_digest_sha256:
      typeof overrides.session_digest_sha256 === 'string'
        ? overrides.session_digest_sha256
        : canonicalSha256(draft),
  };
  return { raw: view, canonical_bytes: canonicalBytes(view), view };
}

export function evidenceDocument(overrides: Record<string, unknown> = {}): unknown {
  const view = {
    schemaVersion: '1.0.0',
    record_kind: 'audit-only-non-capability',
    id: 'AUTH-EV-0123456789abcdef',
    timestamp: NOW,
    invocation_id: 'invocation-1',
    repository_id: REPOSITORY_ID,
    action_id: 'test mutate',
    action_effect: 'local-write',
    dry_run: false,
    principal: { kind: 'human', role: 'engineer', declaration_source: 'cli-flag' },
    policy_binding: {
      policy_id: 'devai-authority',
      policy_version: '1.0.0',
      package_version: PACKAGE_BINDING.version,
      constitution_version: CONSTITUTION_BINDING.version,
      constitution_digest_sha256: CONSTITUTION_BINDING.digest_sha256,
      source_digest_sha256: 'a'.repeat(64),
      resolved_digest_sha256: 'b'.repeat(64),
      extension_digests_sha256: ['d'.repeat(64)],
    },
    enforcement_mode: 'binding',
    host_enforcement: { mode: 'cli-only', attestation: 'not-applicable' },
    targets: {
      count: 1,
      kinds: ['fs'],
      target_ids_digest_sha256: canonicalSha256([fsTarget.id]),
      summary: [{ kind: 'fs', operation: 'update', resource_id: fsTarget.id }],
    },
    decision: {
      decision_id: 'decision-1',
      decision_digest_sha256: '1'.repeat(64),
      subject_digest_sha256: '2'.repeat(64),
      evaluation: 'allow',
      disposition: 'proceed',
      reason_code: 'POLICY_ALLOW',
      reasons: ['matched self-package-source'],
    },
    issuer_audit: {
      issuer_id: 'test-authority-issuer',
      issuer_version: '1.0.0',
      issued_at: NOW,
      capability_material_present: false,
      replayable: false,
    },
    readiness: {
      authority_eligible: true,
      production_ready: false,
      reason: 'Independent acceptance remains required.',
    },
    ...overrides,
  };
  return { raw: view, canonical_bytes: canonicalBytes(view), view };
}

export function evidenceBindings(overrides: Record<string, unknown> = {}): unknown {
  return {
    now: NOW,
    repository_id: REPOSITORY_ID,
    policy: {
      policy_id: 'devai-authority',
      policy_version: '1.0.0',
      repository_id: REPOSITORY_ID,
      framework_package: PACKAGE_BINDING,
      constitution: CONSTITUTION_BINDING,
      source_policy: {
        policy_id: 'devai-core-authority',
        policy_version: '1.0.0',
        digest_sha256: 'a'.repeat(64),
      },
      additive_extensions: [
        {
          extension_id: 'example-authority',
          extension_version: '1.0.0',
          digest_sha256: 'd'.repeat(64),
        },
      ],
      resolved_digest_sha256: 'b'.repeat(64),
      materialized_from: {
        kind: 'project-config',
        path: '.devai/config/authority-policy.json',
      },
    },
    package: PACKAGE_BINDING,
    constitution: CONSTITUTION_BINDING,
    issuer: { issuer_id: 'test-authority-issuer', issuer_version: '1.0.0' },
    actionContracts: actionRegistry([actionDocument()]),
    ...overrides,
  };
}

export function createIssuer(
  api: RuntimeApi,
  overrides: Record<string, unknown> = {},
): AuthorityDecisionIssuer {
  let ordinal = 0;
  return api.createAuthorityDecisionIssuer({
    issuer_id: 'test-authority-issuer',
    issuer_version: '1.0.0',
    invocation_id: 'invocation-1',
    canonicalSha256,
    randomId: () => `authority-id-${++ordinal}`,
    now: () => NOW,
    receipt_ttl_ms: 1000,
    ...overrides,
  });
}

type FutureAuthorityPolicyProvenance = Readonly<{
  policy_id: string;
  policy_version: string;
  repository_id: string;
  framework_package: Readonly<{ name: '@aarusso-nyx/devai'; version: string }>;
  constitution: Readonly<{ version: string; digest_sha256: string }>;
  source_policy: Readonly<{
    policy_id: 'devai-core-authority';
    policy_version: string;
    digest_sha256: string;
  }>;
  additive_extensions: readonly Readonly<{
    extension_id: string;
    extension_version: string;
    digest_sha256: string;
  }>[];
  resolved_digest_sha256: string;
  materialized_from: Readonly<{
    kind: 'project-config';
    path: '.devai/config/authority-policy.json';
  }>;
}>;

function completePolicyProvenance(
  plant: ReturnType<typeof makePolicyPlant>,
): FutureAuthorityPolicyProvenance {
  const policyDocument = plant.document as {
    policy_id: string;
    policy_version: string;
    repository_id: string;
    framework_package: { name: '@aarusso-nyx/devai'; version: string };
    constitution: { version: string; digest_sha256: string };
    source_policy: {
      policy_id: 'devai-core-authority';
      policy_version: string;
      digest_sha256: string;
    };
    resolved_digest_sha256: string;
    additive_extensions: readonly {
      extension_id: string;
      extension_version: string;
      digest_sha256: string;
    }[];
  };
  return {
    policy_id: policyDocument.policy_id,
    policy_version: policyDocument.policy_version,
    repository_id: policyDocument.repository_id,
    framework_package: policyDocument.framework_package,
    constitution: policyDocument.constitution,
    source_policy: policyDocument.source_policy,
    additive_extensions: policyDocument.additive_extensions,
    resolved_digest_sha256: policyDocument.resolved_digest_sha256,
    materialized_from: {
      kind: 'project-config',
      path: '.devai/config/authority-policy.json',
    },
  };
}

interface TestEnvelopeOptions {
  readonly consent?: Readonly<{
    write: boolean;
    allow_publish: boolean;
    experimental: boolean;
  }>;
  readonly action_effect?: 'local-write' | 'remote-write';
}

function mutationEnvelope(
  plant: ReturnType<typeof makePolicyPlant>,
  options: TestEnvelopeOptions = {},
): MutationEnvelope {
  const policy = completePolicyProvenance(plant);
  const draft = {
    envelope_id: 'envelope-invocation-1-test-mutate',
    request: {
      request_id: 'request-invocation-1-test-mutate',
      repository_id: REPOSITORY_ID,
      action_id: 'test mutate',
      dry_run: false,
      requested_at: NOW,
      invocation_id: 'invocation-1',
      consent: options.consent ?? CONSENT,
    },
    action_effect: options.action_effect ?? 'local-write',
    enforcement_mode: 'binding',
    policy,
    issued_by: {
      adapter_id: 'test-authority-runtime',
      adapter_version: '1.0.0',
      envelope_digest_sha256: '0'.repeat(64),
    },
  } as unknown as MutationEnvelope;
  return {
    ...draft,
    issued_by: {
      ...draft.issued_by,
      envelope_digest_sha256: computeMutationEnvelopeDigest(draft),
    },
  } as MutationEnvelope;
}

export function exactSubject(
  targets: readonly unknown[] = [fsTarget],
  plant: ReturnType<typeof makePolicyPlant> = makePolicyPlant(),
  envelopeOptions: TestEnvelopeOptions = {},
): unknown {
  return {
    plan: {
      plan_id: 'plan-exact',
      envelope: mutationEnvelope(plant, envelopeOptions),
      strategy: 'exact-plan',
      targets,
      atomicity: 'whole-plan',
    },
  };
}

export function boundedSubject(
  targets: readonly unknown[] = [fsTarget],
  plant: ReturnType<typeof makePolicyPlant> = makePolicyPlant(),
): unknown {
  return {
    plan: {
      plan_id: 'plan-bounded',
      envelope: mutationEnvelope(plant),
      strategy: 'bounded-batches',
      selectors: [
        {
          kind: 'fs',
          repository_id: REPOSITORY_ID,
          canonical_relative_path_glob: 'packages/core/src/**',
          operations: ['update'],
        },
      ],
      bounds: { max_batches: 2, max_targets_per_batch: 2, max_total_targets: 3 },
      batch_atomicity: 'each-batch',
      recovery: 'preserve-and-report',
    },
    batch: {
      batch_id: 'batch-1',
      plan_id: 'plan-bounded',
      ordinal: 1,
      targets,
      atomicity: 'whole-batch',
    },
  };
}
