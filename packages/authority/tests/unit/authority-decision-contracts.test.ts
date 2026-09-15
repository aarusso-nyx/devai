import { describe, expect, it } from 'vitest';
import {
  applyPreparedMutation,
  computeMutationEnvelopeDigest,
  decide,
  declareHumanPrincipal,
  verifyDecisionBinding,
  type AuthorityContext,
  type AuthorityPolicyAdapter,
  type AuthorityPolicyProvenance,
  type AuthorityRuntimeAdapter,
  type Decision,
  type MutationBatch,
  type MutationBoundaryAdapter,
  type MutationEnvelope,
  type MutationPlan,
  type MutationRequest,
  type PreparedMutation,
  type ResourceTarget,
  type ResourceTargetSelector,
  type TrustedExecutionState,
} from '../../src/index.js';

// Decision contract cases written against the retained authority mutation diagnostic
// (candidate 3dfdc316, report 414957d9). authority-seam.test.ts pins envelope binding and
// replay; it asserts none of the per-cause plan refusals, readiness reasons, obligations,
// context matching or bounded recovery coherence below. Every assertion is an observable
// field of the emitted Decision or verification, never an implementation constant.

const digest = (character: string): string => character.repeat(64);

const provenance: AuthorityPolicyProvenance = {
  policy_id: 'devai-authority',
  policy_version: '1.0.0',
  repository_id: 'example-repository',
  framework_package: { name: '@aarusso-nyx/devai', version: '0.6.0' },
  constitution: { version: '0.5.0', digest_sha256: digest('d') },
  source_policy: {
    policy_id: 'devai-core-authority',
    policy_version: '1.0.0',
    digest_sha256: digest('a'),
  },
  additive_extensions: [
    { extension_id: 'example-authority', extension_version: '1.0.0', digest_sha256: digest('c') },
  ],
  resolved_digest_sha256: digest('b'),
  materialized_from: { kind: 'project-config', path: '.devai/config/authority-policy.json' },
};

const owner = declareHumanPrincipal({
  role: 'owner',
  source: 'session-state',
  session_id: 'session-1',
  declared_at: '2026-07-15T00:00:00.000Z',
});

const baseRequest: MutationRequest = {
  request_id: 'request-1',
  repository_id: 'example-repository',
  declared_principal: owner,
  action_id: 'test action',
  dry_run: false,
  requested_at: '2026-07-15T00:00:00.000Z',
  invocation_id: 'invocation-1',
  consent: { write: true, allow_publish: false, experimental: false },
};

const humanContext: AuthorityContext = {
  kind: 'human-session',
  principal: owner,
  action_id: 'test action',
  origin: { kind: 'interactive-session', session_id: 'session-1' },
};

const machineContext: AuthorityContext = {
  kind: 'trusted-transition',
  principal: {
    kind: 'machine',
    actor: 'harness',
    derivation: {
      action_id: 'test action',
      transition: 'harness-write',
      origin: { kind: 'direct-cli', invocation_id: 'invocation-1' },
      trusted_adapter_id: 'test-runtime',
      invocation_id: 'invocation-1',
      context_digest_sha256: digest('e'),
    },
  },
  action_id: 'test action',
  consent: { write: true, allow_publish: false, experimental: false },
};

interface RuntimeOptions {
  effect?: MutationEnvelope['action_effect'];
  mode?: MutationEnvelope['enforcement_mode'];
  policy?: AuthorityPolicyProvenance;
  context?: AuthorityContext | null;
  executionState?: TrustedExecutionState;
  verified?: boolean;
  /** Overrides the digest the trusted runtime reports, independent of the envelope. */
  reportedDigest?: string;
}

function runtime(options: RuntimeOptions = {}): AuthorityRuntimeAdapter {
  return {
    adapter_id: 'test-runtime',
    adapter_version: '1.0.0',
    materialize: (request) => {
      const draft = {
        envelope_id: `envelope-${request.request_id}`,
        request,
        action_effect: options.effect ?? 'local-write',
        enforcement_mode: options.mode ?? 'binding',
        policy: options.policy ?? provenance,
        issued_by: {
          adapter_id: 'test-runtime',
          adapter_version: '1.0.0',
          envelope_digest_sha256: digest('0'),
        },
      } as unknown as MutationEnvelope;
      return {
        ...draft,
        issued_by: {
          ...draft.issued_by,
          envelope_digest_sha256: computeMutationEnvelopeDigest(draft),
        },
      } as MutationEnvelope;
    },
    verify: (subject) => {
      const computed = computeMutationEnvelopeDigest(subject.plan.envelope);
      const matches = computed === subject.plan.envelope.issued_by.envelope_digest_sha256;
      const verified = (options.verified ?? true) && matches;
      return {
        verified,
        envelope_digest_sha256: options.reportedDigest ?? computed,
        ...(options.context === null ? {} : { context: options.context ?? humanContext }),
        ...(options.executionState === undefined
          ? {}
          : { execution_state: options.executionState }),
        reasons: verified ? [] : ['fixture rejected envelope'],
      };
    },
  };
}

const fsTarget: ResourceTarget = {
  kind: 'fs',
  id: 'fs:README.md',
  repository_id: 'example-repository',
  canonical_relative_path: 'README.md',
  operation: 'update',
};
const gitTarget: ResourceTarget = {
  kind: 'git-ref',
  id: 'git:refs/heads/main',
  repository_id: 'example-repository',
  ref: 'refs/heads/main',
  operation: 'update',
};
const dbTarget: ResourceTarget = {
  kind: 'db',
  id: 'db:events',
  connection_id: 'control',
  database_id: 'devai',
  object_id: 'table:events',
  operation: 'insert',
};
const remoteTarget: ResourceTarget = {
  kind: 'remote',
  id: 'remote:registry',
  system_id: 'registry',
  endpoint_id: 'packages',
  operation_id: 'publish',
  publication: true,
};
const fsSelector: ResourceTargetSelector = {
  kind: 'fs',
  repository_id: 'example-repository',
  canonical_relative_path_glob: 'docs/**',
  operations: ['update'],
};

function exactPlan(envelope: MutationEnvelope, targets: readonly ResourceTarget[] = [fsTarget]) {
  return {
    plan_id: 'plan-exact',
    envelope,
    strategy: 'exact-plan',
    targets,
    atomicity: 'whole-plan',
  } as MutationPlan;
}

function boundedPlan(
  envelope: MutationEnvelope,
  selectors: readonly ResourceTargetSelector[] = [fsSelector],
  bounds = { max_batches: 2, max_targets_per_batch: 2, max_total_targets: 3 },
): MutationPlan {
  return {
    plan_id: 'plan-bounded',
    envelope,
    strategy: 'bounded-batches',
    selectors,
    bounds,
    batch_atomicity: 'each-batch',
    recovery: 'preserve-and-report',
  };
}

const docsTarget: ResourceTarget = {
  ...fsTarget,
  id: 'fs:docs/guide.md',
  canonical_relative_path: 'docs/guide.md',
};

function batchOf(targets: readonly ResourceTarget[] = [docsTarget], ordinal = 1): MutationBatch {
  return {
    batch_id: `batch-${String(ordinal)}`,
    plan_id: 'plan-bounded',
    ordinal,
    targets,
    atomicity: 'whole-batch',
  };
}

function policy(
  outcome: 'allow' | 'deny' = 'allow',
  extra: Partial<{ provenance: AuthorityPolicyProvenance; obligations: readonly string[] }> = {},
): AuthorityPolicyAdapter {
  return {
    provenance: extra.provenance ?? provenance,
    evaluate: () => ({
      outcome,
      reasons: [`fixture ${outcome}`],
      ...(extra.obligations === undefined ? {} : { obligations: extra.obligations }),
    }),
  };
}

const fresh: TrustedExecutionState = {
  applied_batch_ids: [],
  applied_target_count: 0,
  partial_effect_evidence_refs: [],
};

function decideExact(
  targets: readonly ResourceTarget[],
  options: RuntimeOptions = {},
  request: MutationRequest = baseRequest,
): Decision {
  const trusted = runtime(options);
  return decide({
    plan: exactPlan(trusted.materialize(request), targets),
    runtime: trusted,
    policy: policy(),
  });
}

function malformed(decision: Decision, ...reasons: string[]) {
  expect(decision).toMatchObject({
    evaluation: 'deny',
    disposition: 'refuse',
    reason_code: 'MALFORMED_PLAN',
    reasons,
    obligations: [],
  });
}

describe('decision identity', () => {
  // Mutants 4588, 4592: the decision id is derived from the bound subject, not a constant.
  it('derives distinct well-formed ids for distinct subjects', () => {
    const trusted = runtime();
    const envelope = trusted.materialize(baseRequest);
    const first = decide({ plan: exactPlan(envelope), runtime: trusted, policy: policy() });
    const second = decide({
      plan: { ...exactPlan(envelope), plan_id: 'plan-other' },
      runtime: trusted,
      policy: policy(),
    });
    expect(first.decision_id).toMatch(/^AUTH-[a-f0-9]{16}$/u);
    expect(second.decision_id).toMatch(/^AUTH-[a-f0-9]{16}$/u);
    expect(first.decision_id).not.toBe(second.decision_id);
    expect(first.reason_code).toBe('POLICY_ALLOW');
  });
});

describe('readiness and disposition contracts', () => {
  // Mutants 4678, 4681, 4690, 4706: a binding allow over an exact plan is the only eligible shape.
  it('marks a binding exact-plan allow as readiness eligible', () => {
    const decision = decideExact([fsTarget]);
    expect(decision).toMatchObject({
      evaluation: 'allow',
      disposition: 'proceed',
      reason_code: 'POLICY_ALLOW',
      reasons: ['fixture allow'],
      readiness: {
        eligible: true,
        reason:
          'Binding authority allowed this exact plan or batch; readiness still requires independent gates and evidence.',
      },
    });
    expect(decision).not.toHaveProperty('batch_id');
  });

  // Mutants 4707, 4708, 4709, 4711: shadow mode proceeds on a denial but is never eligible.
  it('proceeds in shadow mode on a policy denial without readiness', () => {
    const trusted = runtime({ mode: 'shadow' });
    const decision = decide({
      plan: exactPlan(trusted.materialize(baseRequest)),
      runtime: trusted,
      policy: policy('deny'),
    });
    expect(decision).toMatchObject({
      evaluation: 'deny',
      disposition: 'proceed',
      reason_code: 'POLICY_DENY',
      readiness: {
        eligible: false,
        reason: 'Shadow evaluation is observable but cannot promote production readiness.',
      },
    });
  });

  // Mutants 4712, 4713, 4714: a dry run proceeds but cannot promote readiness.
  it('proceeds on a dry run without readiness', () => {
    const decision = decideExact([fsTarget], {}, { ...baseRequest, dry_run: true });
    expect(decision).toMatchObject({
      evaluation: 'allow',
      disposition: 'proceed',
      readiness: {
        eligible: false,
        reason: 'Dry-run evaluation performs no governed mutation and cannot promote readiness.',
      },
    });
  });

  // Mutants 4693, 4715-4721: selector authorization without a batch is observable only.
  it('allows a bounded plan without a batch as observation only', () => {
    const trusted = runtime();
    const decision = decide({
      plan: boundedPlan(trusted.materialize(baseRequest)),
      runtime: trusted,
      policy: policy(),
    });
    expect(decision).toMatchObject({
      evaluation: 'allow',
      disposition: 'proceed',
      readiness: {
        eligible: false,
        reason:
          'Selector authorization is observable but only an exact batch may prepare a mutation or promote readiness.',
      },
    });
    expect(decision).not.toHaveProperty('batch_id');
  });

  // Mutants 4696, 4704, 5295-5297: a batch decision binds the batch id and the batch subject.
  it('binds an exact batch into the decision and makes it eligible', () => {
    const trusted = runtime({ executionState: fresh });
    const plan = boundedPlan(trusted.materialize(baseRequest));
    const batch = batchOf();
    const withBatch = decide({ plan, batch, runtime: trusted, policy: policy() });
    const withoutBatch = decide({ plan, runtime: trusted, policy: policy() });
    expect(withBatch).toMatchObject({
      batch_id: 'batch-1',
      evaluation: 'allow',
      readiness: { eligible: true },
    });
    expect(withBatch.subject_digest_sha256).not.toBe(withoutBatch.subject_digest_sha256);
  });

  // Mutants 4722-4727, 5430-5432: a verified read action is a not-applicable passthrough.
  it('passes a verified read action through as not applicable', () => {
    const trusted = runtime({ effect: 'read' });
    const decision = decide({
      plan: exactPlan(trusted.materialize(baseRequest), []),
      runtime: trusted,
      policy: policy(),
    });
    expect(decision).toMatchObject({
      evaluation: 'not-applicable',
      disposition: 'proceed',
      reason_code: 'READ_PASSTHROUGH',
      reasons: ['verified read action carries no mutation targets'],
      obligations: [],
      readiness: {
        eligible: false,
        reason: 'Read-only passthrough does not prove mutation enforcement.',
      },
    });
  });

  // Mutant 4729: a binding denial is refused and not eligible.
  it('refuses a binding denial', () => {
    const trusted = runtime();
    const decision = decide({
      plan: exactPlan(trusted.materialize(baseRequest)),
      runtime: trusted,
      policy: policy('deny'),
    });
    expect(decision).toMatchObject({
      evaluation: 'deny',
      disposition: 'refuse',
      reason_code: 'POLICY_DENY',
      reasons: ['fixture deny'],
      readiness: {
        eligible: false,
        reason: 'A denied or refused mutation cannot promote readiness.',
      },
    });
  });

  // Mutants 4646, 5345, 5346: an unverified envelope is refused even in shadow mode.
  it('refuses an unverified envelope even in shadow mode', () => {
    const trusted = runtime({ mode: 'shadow', verified: false });
    const decision = decide({
      plan: exactPlan(trusted.materialize(baseRequest)),
      runtime: trusted,
      policy: policy(),
    });
    expect(decision).toMatchObject({
      evaluation: 'deny',
      disposition: 'refuse',
      reason_code: 'UNVERIFIED_MUTATION_ENVELOPE',
      reasons: [
        'fixture rejected envelope',
        'trusted runtime rejected the mutation envelope or its issuer binding',
      ],
      obligations: [],
    });
  });

  // Mutants 5318, 5319: a missing runtime adapter is refused even in shadow mode.
  it('refuses a plan without a trusted runtime adapter', () => {
    const trusted = runtime({ mode: 'shadow' });
    const decision = decide({
      plan: exactPlan(trusted.materialize(baseRequest)),
      policy: policy(),
    });
    expect(decision).toMatchObject({
      evaluation: 'deny',
      disposition: 'refuse',
      reason_code: 'MISSING_RUNTIME_ADAPTER',
      reasons: ['no trusted authority runtime adapter is installed'],
      obligations: [],
    });
  });

  // Mutants 5482, 5486: policy obligations pass through on allow and deny; absent means none.
  it.each(['allow', 'deny'] as const)('carries policy obligations on %s', (outcome) => {
    const trusted = runtime();
    const plan = exactPlan(trusted.materialize(baseRequest));
    expect(
      decide({
        plan,
        runtime: trusted,
        policy: policy(outcome, { obligations: ['record evidence'] }),
      }),
    ).toMatchObject({
      reason_code: outcome === 'allow' ? 'POLICY_ALLOW' : 'POLICY_DENY',
      obligations: ['record evidence'],
    });
    expect(decide({ plan, runtime: trusted, policy: policy(outcome) }).obligations).toEqual([]);
  });
});

describe('envelope and issuer binding contracts', () => {
  // Mutants 5323-5340: each issuer binding condition alone denies the envelope, with the
  // trusted runtime otherwise reporting it verified.
  const untrusted = (decision: Decision) =>
    expect(decision).toMatchObject({
      reason_code: 'UNVERIFIED_MUTATION_ENVELOPE',
      disposition: 'refuse',
      reasons: ['trusted runtime rejected the mutation envelope or its issuer binding'],
    });

  it('refuses an envelope issued by another runtime adapter id', () => {
    const trusted = runtime();
    const plan = exactPlan(trusted.materialize(baseRequest));
    untrusted(
      decide({ plan, runtime: { ...trusted, adapter_id: 'other-runtime' }, policy: policy() }),
    );
  });

  it('refuses an envelope issued by another runtime adapter version', () => {
    const trusted = runtime();
    const plan = exactPlan(trusted.materialize(baseRequest));
    untrusted(
      decide({ plan, runtime: { ...trusted, adapter_version: '2.0.0' }, policy: policy() }),
    );
  });

  it('refuses an envelope whose reported digest differs from the runtime recomputation', () => {
    const trusted = runtime({ reportedDigest: digest('f') });
    const plan = exactPlan(trusted.materialize(baseRequest));
    untrusted(decide({ plan, runtime: trusted, policy: policy() }));
  });

  it('refuses an envelope whose issuer digest is not a SHA-256 even when the runtime vouches for it', () => {
    const base = runtime();
    const envelope = base.materialize(baseRequest);
    const tampered = {
      ...envelope,
      issued_by: { ...envelope.issued_by, envelope_digest_sha256: 'not-a-digest' },
    } as MutationEnvelope;
    const vouching: AuthorityRuntimeAdapter = {
      ...base,
      verify: () => ({
        verified: true,
        envelope_digest_sha256: 'not-a-digest',
        context: humanContext,
        reasons: [],
      }),
    };
    untrusted(decide({ plan: exactPlan(tampered), runtime: vouching, policy: policy() }));
  });
});

describe('policy binding contracts', () => {
  // Mutants 4628, 5439-5441: provenance with an invalid additive extension digest is refused.
  it('refuses an envelope whose policy provenance carries an invalid extension digest', () => {
    const broken = {
      ...provenance,
      additive_extensions: [
        { extension_id: 'x', extension_version: '1.0.0', digest_sha256: 'zz'.repeat(32) },
      ],
    };
    const trusted = runtime({ policy: broken });
    expect(
      decide({
        plan: exactPlan(trusted.materialize(baseRequest)),
        runtime: trusted,
        policy: policy(),
      }),
    ).toMatchObject({
      reason_code: 'POLICY_PROVENANCE_INVALID',
      disposition: 'refuse',
      reasons: ['resolved policy provenance is incomplete or contains an invalid SHA-256 digest'],
      obligations: [],
    });
  });

  it('refuses a missing policy adapter', () => {
    const trusted = runtime();
    expect(
      decide({ plan: exactPlan(trusted.materialize(baseRequest)), runtime: trusted }),
    ).toMatchObject({
      reason_code: 'MISSING_POLICY_ADAPTER',
      disposition: 'refuse',
      reasons: ['no resolved authority policy adapter is installed'],
      obligations: [],
    });
  });

  // Mutants 5471-5473: the policy adapter must carry exactly the envelope's provenance.
  it.each([
    ['a different resolved digest', { ...provenance, resolved_digest_sha256: digest('9') }],
    ['an invalid digest of its own', { ...provenance, resolved_digest_sha256: 'short' }],
  ])('refuses a policy adapter with %s', (_name, adapterProvenance) => {
    const trusted = runtime();
    expect(
      decide({
        plan: exactPlan(trusted.materialize(baseRequest)),
        runtime: trusted,
        policy: policy('allow', { provenance: adapterProvenance }),
      }),
    ).toMatchObject({
      reason_code: 'POLICY_BINDING_MISMATCH',
      disposition: 'refuse',
      reasons: ['policy adapter provenance does not match the trusted envelope binding'],
      obligations: [],
    });
  });
});

describe('authority context contracts', () => {
  const unverifiedContext = (decision: Decision) =>
    expect(decision).toMatchObject({
      reason_code: 'UNVERIFIED_AUTHORITY_CONTEXT',
      disposition: 'refuse',
      reasons: ['trusted authority context is absent or does not match the request'],
      obligations: [],
    });

  // Mutants 5264, 5460-5462: absent or mismatched context is refused.
  it('refuses when the trusted runtime supplies no context', () => {
    unverifiedContext(decideExact([fsTarget], { context: null }));
  });

  it('refuses a context for another action', () => {
    unverifiedContext(
      decideExact([fsTarget], { context: { ...humanContext, action_id: 'other action' } }),
    );
  });

  // Mutants 5272-5277: a human context needs the request's declared principal to match it.
  it('refuses a human context when the request declares no principal', () => {
    const request = { ...baseRequest };
    delete (request as { declared_principal?: unknown }).declared_principal;
    unverifiedContext(decideExact([fsTarget], {}, request));
  });

  it('refuses a human context whose principal differs from the declared one', () => {
    const other = declareHumanPrincipal({
      role: 'engineer',
      source: 'session-state',
      session_id: 'session-2',
      declared_at: '2026-07-15T00:00:00.000Z',
    });
    unverifiedContext(decideExact([fsTarget], { context: { ...humanContext, principal: other } }));
  });

  // Mutants 5279-5291 (no prior coverage): a machine context is accepted only for a request
  // without a declared principal whose derivation binds the same action and invocation.
  it('accepts a machine context derived from the same action and invocation', () => {
    const request = { ...baseRequest };
    delete (request as { declared_principal?: unknown }).declared_principal;
    expect(decideExact([fsTarget], { context: machineContext }, request)).toMatchObject({
      reason_code: 'POLICY_ALLOW',
      authority_context_digest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it.each<[string, AuthorityContext]>([
    [
      'another invocation',
      {
        ...machineContext,
        principal: {
          ...machineContext.principal,
          derivation: {
            ...(machineContext.principal as { derivation: object }).derivation,
            invocation_id: 'invocation-2',
          },
        } as AuthorityContext['principal'],
      } as AuthorityContext,
    ],
    [
      'another action in its derivation',
      {
        ...machineContext,
        principal: {
          ...machineContext.principal,
          derivation: {
            ...(machineContext.principal as { derivation: object }).derivation,
            action_id: 'other action',
          },
        } as AuthorityContext['principal'],
      } as AuthorityContext,
    ],
    [
      'a malformed context digest',
      {
        ...machineContext,
        principal: {
          ...machineContext.principal,
          derivation: {
            ...(machineContext.principal as { derivation: object }).derivation,
            context_digest_sha256: 'short',
          },
        } as AuthorityContext['principal'],
      } as AuthorityContext,
    ],
  ])('refuses a machine context derived from %s', (_name, context) => {
    const request = { ...baseRequest };
    delete (request as { declared_principal?: unknown }).declared_principal;
    unverifiedContext(decideExact([fsTarget], { context }, request));
  });

  it('refuses a machine context when the request declares a principal', () => {
    unverifiedContext(decideExact([fsTarget], { context: machineContext }));
  });
});

describe('malformed target contracts', () => {
  // Mutants 4844-4872, 4886-4949: each malformed field is named in the plan refusal.
  it.each([
    '',
    '/etc/passwd',
    './README.md',
    'docs/',
    'docs\\guide.md',
    'docs\0guide.md',
    'docs//guide.md',
    'docs/./guide.md',
    'docs/../guide.md',
    '..',
  ])('refuses fs target path %j', (canonical_relative_path) => {
    malformed(
      decideExact([{ ...fsTarget, canonical_relative_path } as ResourceTarget]),
      'fs target path must be canonical and repository-relative',
    );
  });

  it('refuses a malformed fs rename source', () => {
    malformed(
      decideExact([
        {
          ...fsTarget,
          operation: 'rename',
          rename_from_canonical_relative_path: '/old',
        } as ResourceTarget,
      ]),
      'fs rename source must be canonical and repository-relative',
    );
  });

  it('refuses an empty target id and an empty fs repository id independently', () => {
    malformed(
      decideExact([{ ...fsTarget, id: '  ' } as ResourceTarget]),
      'resource target id must not be empty',
    );
    malformed(
      decideExact([{ ...fsTarget, repository_id: '' } as ResourceTarget]),
      'fs repository_id must not be empty',
    );
  });

  it('names each empty git-ref identifier', () => {
    malformed(
      decideExact([{ ...gitTarget, repository_id: ' ' } as ResourceTarget]),
      'git repository_id must not be empty',
    );
    malformed(
      decideExact([{ ...gitTarget, ref: '' } as ResourceTarget]),
      'git ref must not be empty',
    );
  });

  it.each(['connection_id', 'database_id', 'object_id'])('refuses an empty db %s', (field) => {
    malformed(
      decideExact([{ ...dbTarget, [field]: '' } as ResourceTarget]),
      'db resource identifiers must not be empty',
    );
  });

  it.each(['system_id', 'endpoint_id', 'operation_id'])('refuses an empty remote %s', (field) => {
    malformed(
      decideExact([{ ...remoteTarget, publication: false, [field]: '' } as ResourceTarget]),
      'remote semantic identifiers must not be empty',
    );
  });

  it('refuses a remote endpoint that is a URL', () => {
    malformed(
      decideExact([
        {
          ...remoteTarget,
          publication: false,
          endpoint_id: 'https://registry.invalid/api',
        } as ResourceTarget,
      ]),
      'remote endpoint_id must be semantic, not a URL',
    );
  });

  // Mutants 5038-5059: duplicate ids and duplicate identities are distinct refusals, and an
  // identity spans every discriminating field of its kind.
  it('refuses duplicated target ids and duplicated target identities separately', () => {
    malformed(
      decideExact([fsTarget, { ...fsTarget, id: 'fs:README.md#delete', operation: 'delete' }]),
      'resource target identities must be unique',
    );
    malformed(
      decideExact([
        fsTarget,
        { ...fsTarget, id: 'fs:README.md', canonical_relative_path: 'docs/other.md' },
      ]),
      'resource target IDs must be unique',
    );
  });

  it.each<[string, ResourceTarget, ResourceTarget]>([
    ['fs repository', fsTarget, { ...fsTarget, id: 'fs:other', repository_id: 'other-repository' }],
    ['git ref', gitTarget, { ...gitTarget, id: 'git:other', ref: 'refs/heads/other' }],
    ['db object', dbTarget, { ...dbTarget, id: 'db:other', object_id: 'table:other' }],
    [
      'remote operation',
      { ...remoteTarget, publication: false },
      { ...remoteTarget, publication: false, id: 'remote:other', operation_id: 'unpublish' },
    ],
  ])('treats targets differing only by %s as distinct identities', (_name, first, second) => {
    expect(decideExact([first, second]).reason_code).toBe('POLICY_ALLOW');
  });
});

describe('malformed plan contracts', () => {
  it('refuses an empty plan id', () => {
    const trusted = runtime();
    malformed(
      decide({
        plan: { ...exactPlan(trusted.materialize(baseRequest)), plan_id: ' ' },
        runtime: trusted,
        policy: policy(),
      }),
      'plan_id must not be empty',
    );
  });

  // Mutants 5147-5158: read actions carry neither targets nor bounds.
  it.each([
    ['targets', (envelope: MutationEnvelope) => exactPlan(envelope, [fsTarget])],
    ['bounds', (envelope: MutationEnvelope) => boundedPlan(envelope)],
  ])('refuses a read action carrying %s', (_name, build) => {
    const trusted = runtime({ effect: 'read' });
    const decision = decide({
      plan: build(trusted.materialize(baseRequest)),
      runtime: trusted,
      policy: policy(),
    });
    expect(decision.reason_code).toBe('MALFORMED_PLAN');
    expect(decision.reasons).toContain('read actions cannot carry mutation targets or bounds');
  });

  // Mutants 5160-5165: a mutating action needs write consent unless it is a dry run.
  it('requires write consent for a mutating action unless it is a dry run', () => {
    const noWrite = { ...baseRequest, consent: { ...baseRequest.consent, write: false } };
    malformed(
      decideExact([fsTarget], {}, noWrite),
      'mutating actions require explicit write consent',
    );
    expect(decideExact([fsTarget], {}, { ...noWrite, dry_run: true }).reason_code).toBe(
      'POLICY_ALLOW',
    );
  });

  // Mutants 5172-5184: exact plans carry no batch and at least one target.
  it('refuses an exact plan with a batch or without targets', () => {
    const trusted = runtime();
    const envelope = trusted.materialize(baseRequest);
    malformed(
      decide({ plan: exactPlan(envelope), batch: batchOf(), runtime: trusted, policy: policy() }),
      'exact plans cannot carry a dynamic batch',
    );
    malformed(decideExact([]), 'exact mutating plans must declare at least one target');
  });

  // Mutants 5187, 5189, 4961-5034: bounded plans need selectors, and each selector is checked.
  it('refuses a bounded plan without selectors', () => {
    const trusted = runtime();
    malformed(
      decide({
        plan: boundedPlan(trusted.materialize(baseRequest), []),
        runtime: trusted,
        policy: policy(),
      }),
      'bounded plans must declare target selectors',
    );
  });

  it.each<[string, ResourceTargetSelector, string]>([
    [
      'an fs selector with a non-canonical glob',
      { ...fsSelector, canonical_relative_path_glob: '/docs/**' },
      'fs selector must have a canonical relative glob and permitted operations',
    ],
    [
      'an fs selector without operations',
      { ...fsSelector, operations: [] },
      'fs selector must have a canonical relative glob and permitted operations',
    ],
    [
      'a git-ref selector with an empty glob',
      {
        kind: 'git-ref',
        repository_id: 'example-repository',
        ref_glob: ' ',
        operations: ['update'],
      },
      'git-ref selector identifiers and operations must not be empty',
    ],
    [
      'a db selector with an empty identifier',
      {
        kind: 'db',
        connection_id: '',
        database_id_glob: '*',
        object_id_glob: '*',
        operations: ['insert'],
      },
      'db selector identifiers and operations must not be empty',
    ],
    [
      'a remote selector with a URL endpoint',
      {
        kind: 'remote',
        system_id: 'registry',
        endpoint_ids: ['https://x'],
        operation_ids: ['publish'],
        publication: false,
      },
      'remote selector must use non-empty semantic identifiers',
    ],
    [
      'a remote selector without operations',
      {
        kind: 'remote',
        system_id: 'registry',
        endpoint_ids: ['packages'],
        operation_ids: [],
        publication: false,
      },
      'remote selector must use non-empty semantic identifiers',
    ],
  ])('refuses %s', (_name, selector, reason) => {
    const trusted = runtime();
    malformed(
      decide({
        plan: boundedPlan(trusted.materialize(baseRequest), [selector]),
        runtime: trusted,
        policy: policy(),
      }),
      reason,
    );
  });

  // Mutants 5193-5203: every bound is a positive safe integer.
  it.each<[string, Record<string, number>]>([
    ['a zero batch bound', { max_batches: 0 }],
    ['a negative per-batch bound', { max_targets_per_batch: -1 }],
    ['a fractional total bound', { max_total_targets: 1.5 }],
    ['an unsafe total bound', { max_total_targets: Number.MAX_SAFE_INTEGER + 2 }],
  ])('refuses %s', (_name, override) => {
    const trusted = runtime();
    const bounds = { max_batches: 2, max_targets_per_batch: 2, max_total_targets: 3, ...override };
    malformed(
      decide({
        plan: boundedPlan(trusted.materialize(baseRequest), [fsSelector], bounds),
        runtime: trusted,
        policy: policy(),
      }),
      'bounded plan limits must be positive safe integers',
    );
  });

  // Mutants 5209-5232: batch ordinal and target count are bounded inclusively.
  it.each<[string, MutationBatch, string]>([
    ['ordinal zero', batchOf([docsTarget], 0), 'batch ordinal exceeds the authorized bound'],
    [
      'a fractional ordinal',
      batchOf([docsTarget], 1.5),
      'batch ordinal exceeds the authorized bound',
    ],
    [
      'an ordinal past the batch bound',
      batchOf([docsTarget], 3),
      'batch ordinal exceeds the authorized bound',
    ],
    ['no targets', batchOf([], 1), 'batch target count exceeds the authorized bound'],
    [
      'more targets than the per-batch bound',
      batchOf(
        [
          docsTarget,
          { ...docsTarget, id: 'fs:docs/b.md', canonical_relative_path: 'docs/b.md' },
          { ...docsTarget, id: 'fs:docs/c.md', canonical_relative_path: 'docs/c.md' },
        ],
        1,
      ),
      'batch target count exceeds the authorized bound',
    ],
  ])('refuses a batch with %s', (_name, batch, reason) => {
    const trusted = runtime({ executionState: fresh });
    const decision = decide({
      plan: boundedPlan(trusted.materialize(baseRequest)),
      batch,
      runtime: trusted,
      policy: policy(),
    });
    expect(decision.reason_code).toBe('MALFORMED_PLAN');
    expect(decision.reasons).toContain(reason);
  });

  it('admits a batch at the ordinal and per-batch bounds', () => {
    const applied: TrustedExecutionState = {
      applied_batch_ids: ['batch-1'],
      applied_target_count: 1,
      partial_effect_evidence_refs: ['evidence:1'],
    };
    const trusted = runtime({ executionState: applied });
    const batch = batchOf(
      [docsTarget, { ...docsTarget, id: 'fs:docs/b.md', canonical_relative_path: 'docs/b.md' }],
      2,
    );
    expect(
      decide({
        plan: boundedPlan(trusted.materialize(baseRequest)),
        batch,
        runtime: trusted,
        policy: policy(),
      }),
    ).toMatchObject({
      reason_code: 'POLICY_ALLOW',
      batch_id: 'batch-2',
      recovery: applied,
    });
  });

  // Mutants 5237, 5240, 5062: a batch target must match one selector, and the refusal names it.
  it('names a batch target outside every selector and admits one matching a later selector', () => {
    const trusted = runtime({ executionState: fresh });
    const envelope = trusted.materialize(baseRequest);
    const outside = decide({
      plan: boundedPlan(envelope),
      batch: batchOf([fsTarget]),
      runtime: trusted,
      policy: policy(),
    });
    expect(outside.reason_code).toBe('MALFORMED_PLAN');
    expect(outside.reasons).toEqual([
      "batch target 'fs:README.md' is outside the pre-authorized selectors",
    ]);
    const secondSelector = decide({
      plan: boundedPlan(envelope, [
        { ...fsSelector, canonical_relative_path_glob: 'src/**' },
        fsSelector,
      ]),
      batch: batchOf([docsTarget]),
      runtime: trusted,
      policy: policy(),
    });
    expect(secondSelector.reason_code).toBe('POLICY_ALLOW');
  });

  // Mutants 5249-5261: publication targets need publish consent; non-publication ones do not.
  it('requires publish consent only for publication targets', () => {
    malformed(decideExact([remoteTarget]), 'publication targets require explicit publish consent');
    expect(decideExact([{ ...remoteTarget, publication: false }]).reason_code).toBe('POLICY_ALLOW');
    expect(
      decideExact(
        [remoteTarget],
        {},
        { ...baseRequest, consent: { ...baseRequest.consent, allow_publish: true } },
      ).reason_code,
    ).toBe('POLICY_ALLOW');
  });
});

describe('bounded recovery coherence contracts', () => {
  const incoherent = (decision: Decision) =>
    expect(decision).toMatchObject({
      reason_code: 'UNVERIFIED_AUTHORITY_CONTEXT',
      disposition: 'refuse',
      reasons: ['bounded-batch progress is absent, unsafe, or incoherent in trusted runtime state'],
    });

  function decideBatch(
    executionState: TrustedExecutionState | undefined,
    batch: MutationBatch = batchOf(),
  ) {
    const trusted = runtime(executionState === undefined ? {} : { executionState });
    return decide({
      plan: boundedPlan(trusted.materialize(baseRequest)),
      batch,
      runtime: trusted,
      policy: policy(),
    });
  }

  // Mutants 5378-5398: each incoherence in trusted progress refuses the batch.
  it.each<[string, TrustedExecutionState | undefined, MutationBatch]>([
    ['no execution state', undefined, batchOf()],
    ['a fractional applied target count', { ...fresh, applied_target_count: 0.5 }, batchOf()],
    ['a negative applied target count', { ...fresh, applied_target_count: -1 }, batchOf()],
    [
      'an empty applied batch id',
      { ...fresh, applied_batch_ids: [' '], applied_target_count: 1 },
      batchOf([docsTarget], 2),
    ],
    [
      // The batch itself stays inside the plan bounds: the incoherence is in the trusted
      // progress record, which malformedPlan never inspects.
      'a duplicated applied batch id',
      { ...fresh, applied_batch_ids: ['a', 'a'], applied_target_count: 2 },
      batchOf([docsTarget], 2),
    ],
    [
      'more applied batches than the batch bound',
      { ...fresh, applied_batch_ids: ['a', 'b', 'c'], applied_target_count: 3 },
      batchOf([docsTarget], 2),
    ],
    [
      'more applied targets than the total bound',
      { ...fresh, applied_batch_ids: ['a'], applied_target_count: 4 },
      batchOf([docsTarget], 2),
    ],
    [
      'an ordinal that does not follow the applied batches',
      { ...fresh, applied_batch_ids: ['a'], applied_target_count: 1 },
      batchOf([docsTarget], 1),
    ],
  ])('refuses a batch against %s', (_name, executionState, batch) => {
    incoherent(decideBatch(executionState, batch));
  });

  // Mutants 5404-5406: a batch already applied is refused with the recovery and context bound.
  it('refuses a batch that trusted progress already records as applied', () => {
    const applied: TrustedExecutionState = {
      ...fresh,
      applied_batch_ids: ['batch-2'],
      applied_target_count: 1,
    };
    const decision = decideBatch(applied, batchOf([docsTarget], 2));
    expect(decision).toMatchObject({
      reason_code: 'MALFORMED_PLAN',
      disposition: 'refuse',
      reasons: ['batch_id has already been applied'],
      obligations: [],
      recovery: applied,
      authority_context_digest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  // Mutants 5408, 5416, 5420-5422: applied plus batch targets may not exceed the total bound.
  it('refuses a batch whose targets would exceed the total bound and admits one that reaches it', () => {
    const applied: TrustedExecutionState = {
      ...fresh,
      applied_batch_ids: ['batch-1'],
      applied_target_count: 2,
    };
    const two = [
      docsTarget,
      { ...docsTarget, id: 'fs:docs/b.md', canonical_relative_path: 'docs/b.md' },
    ];
    expect(decideBatch(applied, batchOf(two, 2))).toMatchObject({
      reason_code: 'MALFORMED_PLAN',
      reasons: ['batch would exceed the authorized total target bound'],
      recovery: applied,
    });
    expect(decideBatch(applied, batchOf([docsTarget], 2))).toMatchObject({
      reason_code: 'POLICY_ALLOW',
      recovery: applied,
    });
  });

  it('preserves trusted recovery on a structurally malformed batch', () => {
    const applied: TrustedExecutionState = {
      ...fresh,
      applied_batch_ids: ['batch-1'],
      applied_target_count: 1,
    };
    expect(decideBatch(applied, batchOf([], 2))).toMatchObject({
      reason_code: 'MALFORMED_PLAN',
      recovery: applied,
    });
  });
});

describe('decision binding verification contracts', () => {
  // Mutants 4742-4762: each non-preparable shape is named, and a shadow allow still verifies.
  it('refuses to prepare a dry-run decision', () => {
    const trusted = runtime();
    const plan = exactPlan(trusted.materialize({ ...baseRequest, dry_run: true }));
    const decision = decide({ plan, runtime: trusted, policy: policy() });
    expect(verifyDecisionBinding({ plan }, decision, humanContext)).toMatchObject({
      verified: false,
      reasons: ['dry-run cannot prepare a mutation'],
    });
  });

  it('refuses to prepare a read decision', () => {
    const trusted = runtime({ effect: 'read' });
    const plan = exactPlan(trusted.materialize(baseRequest), []);
    const decision = decide({ plan, runtime: trusted, policy: policy() });
    // A read passthrough is not-applicable, so binding mode adds its own reason as well.
    expect(verifyDecisionBinding({ plan }, decision, humanContext)).toMatchObject({
      verified: false,
      reasons: [
        'read action cannot prepare a mutation',
        'binding mutation requires an allow evaluation',
      ],
    });
  });

  it('refuses to prepare bounded selector authorization without a batch', () => {
    const trusted = runtime();
    const plan = boundedPlan(trusted.materialize(baseRequest));
    const decision = decide({ plan, runtime: trusted, policy: policy() });
    expect(verifyDecisionBinding({ plan }, decision, humanContext)).toMatchObject({
      verified: false,
      reasons: ['bounded selector authorization cannot prepare without an exact batch'],
    });
  });

  it('verifies a shadow allow over an exact plan', () => {
    const trusted = runtime({ mode: 'shadow' });
    const plan = exactPlan(trusted.materialize(baseRequest));
    const decision = decide({ plan, runtime: trusted, policy: policy() });
    expect(verifyDecisionBinding({ plan }, decision, humanContext)).toMatchObject({
      verified: true,
    });
  });
});

describe('prepared mutation application contracts', () => {
  const prepared = {
    preparation_id: 'prep-1',
    adapter_id: 'fs-adapter',
    adapter_version: '1.0.0',
    plan_id: 'plan-exact',
    subject_digest_sha256: digest('1'),
    decision_digest_sha256: digest('2'),
    target_ids: ['fs:README.md'],
  } as unknown as PreparedMutation;

  function adapter(overrides: Partial<MutationBoundaryAdapter> = {}): MutationBoundaryAdapter {
    return {
      adapter_id: 'fs-adapter',
      adapter_version: '1.0.0',
      target_kind: 'fs',
      prepare: () => Promise.reject(new Error('not used')),
      verifyPrepared: () => ({ verified: false, reasons: ['fixture refused the capability'] }),
      apply: () =>
        Promise.resolve({
          preparation_id: 'prep-1',
          applied_target_ids: ['fs:README.md'],
          evidence_refs: [],
        }),
      ...overrides,
    };
  }

  // Mutants 4818-4828: the prepared capability must name this adapter's id and version
  // before the adapter is even asked to verify it.
  it.each([
    ['id', { adapter_id: 'git-adapter' }],
    ['version', { adapter_version: '2.0.0' }],
  ])('refuses a capability bound to another adapter %s', async (_name, override) => {
    let verified = 0;
    const result = await applyPreparedMutation({
      adapter: adapter({
        ...override,
        verifyPrepared: () => {
          verified += 1;
          return { verified: false, reasons: [] };
        },
      }),
      prepared,
    });
    expect(result).toEqual({
      applied: false,
      reasons: ['prepared capability adapter binding differs'],
    });
    expect(verified).toBe(0);
  });

  it("returns the adapter's own verification refusal", async () => {
    expect(await applyPreparedMutation({ adapter: adapter(), prepared })).toEqual({
      applied: false,
      reasons: ['fixture refused the capability'],
    });
  });
});
