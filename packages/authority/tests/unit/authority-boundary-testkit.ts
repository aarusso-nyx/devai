import {
  CONSENT,
  REPOSITORY_ID,
  actionDocument,
  canonicalSha256,
  createIssuer,
  declarationDependencies,
  exactSubject,
  expectSuccess,
  makePolicyPlant,
  policyBindingFromPlant,
  runtimeApi,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';

export type BoundaryCategory = 'usage-error' | 'refused' | 'dependency-error';
export type BoundaryTagged<T = unknown> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; category: BoundaryCategory; code: string; reasons: readonly string[] }>;

export interface AuthorityBoundaryRuntime {
  readonly plannerRegistry: Readonly<{
    registerPlan(input: unknown): BoundaryTagged;
    registerBatch(input: unknown): BoundaryTagged;
    recovery(input: unknown): BoundaryTagged;
  }>;
  prepare(input: unknown): BoundaryTagged;
  apply(input: unknown): BoundaryTagged;
  dispose(): BoundaryTagged;
}

export interface BoundaryApi {
  classifyAuthorityResource(input: unknown, deps?: unknown): BoundaryTagged;
  createAuthorityBoundaryRuntime(deps: unknown): AuthorityBoundaryRuntime;
  validateDirectMutatorInventory(input: unknown): BoundaryTagged;
}

export async function boundaryApi(): Promise<BoundaryApi> {
  const moduleUrl = new URL('../../src/boundaries/index.js', import.meta.url).href;
  return (await import(/* @vite-ignore */ moduleUrl)) as BoundaryApi;
}

export function expectBoundaryFailure(
  result: unknown,
  category: BoundaryCategory,
  code: string,
): void {
  const failure = result as { ok: false; category: string; code: string };
  if (failure.ok !== false || failure.category !== category || failure.code !== code) {
    throw new Error(`expected ${category}/${code}, received ${JSON.stringify(result)}`);
  }
}

export const gitTarget = {
  kind: 'git-ref',
  id: 'git-ref:example-repository:refs/heads/main',
  repository_id: REPOSITORY_ID,
  ref: 'refs/heads/main',
  operation: 'update',
  protected: true,
} as const;

export const dbTarget = {
  kind: 'db',
  id: 'db:devai-control:devai:table:authority_events',
  connection_id: 'devai-control',
  database_id: 'devai',
  object_id: 'table:authority_events',
  operation: 'ddl',
} as const;

export const remoteTarget = {
  kind: 'remote',
  id: 'remote:sensor-runtime:invoke',
  system_id: 'sensor-runtime',
  endpoint_id: 'observations',
  operation_id: 'invoke',
  publication: true,
} as const;

export function ruleForTarget(target: Record<string, unknown>): Record<string, unknown> {
  const kind = target.kind as string;
  const selector =
    kind === 'fs'
      ? {
          kind: 'fs',
          repository_id: target.repository_id,
          canonical_relative_path_glob: target.canonical_relative_path,
          operations: [target.operation],
        }
      : kind === 'git-ref'
        ? {
            kind: 'git-ref',
            repository_id: target.repository_id,
            ref_glob: target.ref,
            operations: [target.operation],
          }
        : kind === 'db'
          ? {
              kind: 'db',
              connection_id: target.connection_id,
              database_id_glob: target.database_id,
              object_id_glob: target.object_id,
              operations: [target.operation],
            }
          : {
              kind: 'remote',
              system_id: target.system_id,
              endpoint_ids: [target.endpoint_id],
              operation_ids: [target.operation_id],
              publication: target.publication,
            };
  return {
    rule_id: `test-${kind}-allow`,
    origin: 'additive-extension',
    precedence: 500,
    action_ids: ['test mutate'],
    selector,
    effect: 'allow',
    subjects: [{ kind: 'human', roles: ['engineer'] }],
    required_consent: {
      write: true,
      allow_publish: kind === 'remote' && target.publication === true,
      experimental: false,
    },
    constitutional_anchors: [6, 14],
    rationale: 'W03 exact boundary fixture.',
  };
}

export async function authorizedBoundaryFixture(
  target: Record<string, unknown>,
  options: Readonly<{
    invocationId?: string;
    consent?: typeof CONSENT;
    subject?: unknown;
    subjectFactory?: (plant: ReturnType<typeof makePolicyPlant>) => unknown;
    issuer?: AuthorityDecisionIssuer;
  }> = {},
): Promise<
  Readonly<{
    issuer: AuthorityDecisionIssuer;
    context_receipt: unknown;
    decision_receipt: unknown;
    resolution: unknown;
    subject: unknown;
    plant: ReturnType<typeof makePolicyPlant>;
  }>
> {
  const api = await runtimeApi();
  const invocationId = options.invocationId ?? 'invocation-1';
  const consent =
    target.kind === 'remote' && target.publication === true
      ? ({ ...CONSENT, allow_publish: true } as const)
      : (options.consent ?? CONSENT);
  const issuer = options.issuer ?? createIssuer(api, { invocation_id: invocationId });
  const plant = makePolicyPlant({ additiveRules: [ruleForTarget(target)] });
  const declaration = expectSuccess<{ context_receipt: unknown }>(
    api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: invocationId,
        dry_run: false,
        declaration: { as_role: 'engineer' },
        consent,
      },
      declarationDependencies(
        issuer,
        actionDocument(target.kind === 'remote' ? 'remote-write' : 'local-write', {
          kind: 'human',
          allowed_roles: ['engineer'],
        }),
        undefined,
        policyBindingFromPlant(plant),
      ),
    ),
  );
  const policy = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
  const operation = target.kind === 'remote' ? target.operation_id : (target.operation as unknown);
  const resolution = api.resolveAuthorityPolicy(
    policy,
    {
      action_id: 'test mutate',
      context_receipt: declaration.context_receipt,
      consent,
      resource: target,
      operation,
    },
    { receiptStore: issuer, canonicalSha256 },
  );
  const subject =
    options.subjectFactory?.(plant) ??
    options.subject ??
    exactSubject([target], plant, {
      consent,
      action_effect: target.kind === 'remote' ? 'remote-write' : 'local-write',
    });
  const decision = issuer.issueAllow({
    resolutions: [resolution],
    subject,
    context_receipt: declaration.context_receipt,
    invocation_id: invocationId,
    boundary_adapter_id: `${String(target.kind)}-authority-boundary`,
  }) as { issued: true; receipt: unknown };
  if (decision.issued !== true || decision.receipt === undefined) {
    throw new Error(`expected genuine decision receipt, received ${JSON.stringify(decision)}`);
  }
  return {
    issuer,
    context_receipt: declaration.context_receipt,
    decision_receipt: decision.receipt,
    resolution,
    subject,
    plant,
  };
}

export async function authorizedBoundarySetFixture(
  targets: readonly Record<string, unknown>[],
): Promise<
  Readonly<{
    issuer: AuthorityDecisionIssuer;
    context_receipt: unknown;
    resolutions: readonly unknown[];
    subject: unknown;
    plant: ReturnType<typeof makePolicyPlant>;
  }>
> {
  const api = await runtimeApi();
  const issuer = createIssuer(api);
  const rules = targets.map((target, index) => ({
    ...ruleForTarget(target),
    rule_id: `test-${String(target.kind)}-allow-${String(index + 1)}`,
  }));
  const plant = makePolicyPlant({ additiveRules: rules });
  const declaration = expectSuccess<{ context_receipt: unknown }>(
    api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-1',
        dry_run: false,
        declaration: { as_role: 'engineer' },
        consent: CONSENT,
      },
      declarationDependencies(issuer, actionDocument(), undefined, policyBindingFromPlant(plant)),
    ),
  );
  const policy = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
  const resolutions = targets.map((target) =>
    api.resolveAuthorityPolicy(
      policy,
      {
        action_id: 'test mutate',
        context_receipt: declaration.context_receipt,
        consent: CONSENT,
        resource: target,
        operation: target.kind === 'remote' ? target.operation_id : target.operation,
      },
      { receiptStore: issuer, canonicalSha256 },
    ),
  );
  const subject = exactSubject(targets, plant);
  return {
    issuer,
    context_receipt: declaration.context_receipt,
    resolutions,
    subject,
    plant,
  };
}

export function boundaryDependencies(
  issuer: AuthorityDecisionIssuer,
  events: string[],
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    invocation_id: 'invocation-1',
    repository_id: REPOSITORY_ID,
    repository_root: '/workspace/devai',
    receiptStore: issuer,
    now: () => '2026-07-15T12:00:00.000Z',
    canonicalSha256,
    fs: {
      realpath: (path: string) => path,
      lstat: () => ({ kind: 'file', inode: 1, mtime_ms: 1 }),
      writeAtomic: (path: string) => events.push(`fs:write:${path}`),
      renameAtomic: (source: string, destination: string) =>
        events.push(`fs:rename:${source}:${destination}`),
    },
    git: {
      updateRef: (ref: string) => events.push(`git:update:${ref}`),
      push: (ref: string) => events.push(`git:push:${ref}`),
      deleteRef: (ref: string) => events.push(`git:delete:${ref}`),
    },
    db: {
      execute: (connectionId: string, operation: string) =>
        events.push(`db:${connectionId}:${operation}`),
    },
    remote: {
      invoke: (systemId: string, endpointId: string, operationId: string) =>
        events.push(`remote:${systemId}:${endpointId}:${operationId}`),
    },
    ...overrides,
  };
}
