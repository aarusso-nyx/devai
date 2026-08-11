import { describe, expect, it } from 'vitest';
import {
  HUMAN_ROLES,
  MACHINE_ACTORS,
  applyPreparedMutation,
  computeMutationEnvelopeDigest,
  decide,
  declareHumanPrincipal,
  isCallerDeclarablePrincipal,
  prepareAuthorizedMutation,
  type ActionEffect,
  type AuthorityContext,
  type AuthorityPolicyAdapter,
  type AuthorityPolicyProvenance,
  type AuthorityRuntimeAdapter,
  type EnforcementMode,
  type MachinePrincipal,
  type MutationBoundaryAdapter,
  type MutationBatch,
  type MutationEnvelope,
  type MutationPlan,
  type MutationRequest,
  type PreparedMutation,
  type ResourceTarget,
  type TrustedExecutionState,
  type VerifiedPreparedMutationCapability,
} from '../../src/index.js';

// Invariants: INV-DEVAI-001

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
    {
      extension_id: 'example-authority',
      extension_version: '1.0.0',
      digest_sha256: digest('c'),
    },
  ],
  resolved_digest_sha256: digest('b'),
  materialized_from: {
    kind: 'project-config',
    path: '.devai/config/authority-policy.json',
  },
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

function sanitizeRequest(request: MutationRequest): MutationRequest {
  return {
    request_id: request.request_id,
    repository_id: request.repository_id,
    ...(request.declared_principal === undefined
      ? {}
      : { declared_principal: request.declared_principal }),
    action_id: request.action_id,
    dry_run: request.dry_run,
    requested_at: request.requested_at,
    invocation_id: request.invocation_id,
    consent: {
      write: request.consent.write,
      allow_publish: request.consent.allow_publish,
      experimental: request.consent.experimental,
    },
  };
}

function runtime(
  options: {
    effect?: ActionEffect;
    mode?: EnforcementMode;
    policy?: AuthorityPolicyProvenance;
    context?: AuthorityContext;
    executionState?: TrustedExecutionState;
    verified?: boolean;
  } = {},
): AuthorityRuntimeAdapter {
  const adapter: AuthorityRuntimeAdapter = {
    adapter_id: 'test-runtime',
    adapter_version: '1.0.0',
    materialize: (request) => {
      const draft = {
        envelope_id: `envelope-${request.request_id}`,
        request: sanitizeRequest(request),
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
      const digestMatches = computed === subject.plan.envelope.issued_by.envelope_digest_sha256;
      return {
        verified: (options.verified ?? true) && digestMatches,
        envelope_digest_sha256: computed,
        context: options.context ?? humanContext,
        ...(options.executionState === undefined
          ? {}
          : { execution_state: options.executionState }),
        reasons: options.verified === false || !digestMatches ? ['fixture rejected envelope'] : [],
      };
    },
  };
  return adapter;
}

const fsTarget: ResourceTarget = {
  kind: 'fs',
  id: 'fs:README.md',
  repository_id: 'example-repository',
  canonical_relative_path: 'README.md',
  operation: 'update',
};

function exactPlan(
  envelope: MutationEnvelope,
  targets: readonly ResourceTarget[] = [fsTarget],
): MutationPlan {
  return {
    plan_id: 'plan-exact',
    envelope,
    strategy: 'exact-plan',
    targets,
    atomicity: 'whole-plan',
  };
}

function policy(
  policyProvenance: AuthorityPolicyProvenance = provenance,
  outcome: 'allow' | 'deny' = 'allow',
): AuthorityPolicyAdapter {
  return {
    provenance: policyProvenance,
    evaluate: () => ({ outcome, reasons: [`fixture ${outcome}`] }),
  };
}

describe('authority decision seam', () => {
  it('declares exactly the five human roles and rejects machine actors', () => {
    for (const role of HUMAN_ROLES) {
      expect(
        declareHumanPrincipal({
          role,
          source: 'cli-flag',
          declared_at: '2026-07-15T00:00:00.000Z',
        }).role,
      ).toBe(role);
    }
    for (const actor of MACHINE_ACTORS) {
      expect(() =>
        declareHumanPrincipal({
          role: actor,
          source: 'cli-flag',
          declared_at: '2026-07-15T00:00:00.000Z',
        }),
      ).toThrow('not caller-declarable');
    }
  });

  it('keeps CI/post-merge-capable machine identities non-caller-declarable', () => {
    const machine: MachinePrincipal = {
      kind: 'machine',
      actor: 'release',
      derivation: {
        action_id: 'release publish',
        transition: 'release',
        trusted_adapter_id: 'ci-authority',
        invocation_id: 'run-42',
        context_digest_sha256: digest('e'),
        origin: {
          kind: 'ci-run',
          provider: 'github-actions',
          repository_id: 'example-repository',
          workflow_id: 'release',
          run_id: '42',
          event: 'push',
        },
      },
    };
    expect(isCallerDeclarablePrincipal(owner)).toBe(true);
    expect(isCallerDeclarablePrincipal(machine)).toBe(false);
  });

  it('scrubs spoofed effect, mode, policy, machine context, and progress from raw requests', () => {
    const trustedRuntime = runtime({ effect: 'local-write', mode: 'binding' });
    const spoofed = {
      ...baseRequest,
      action_effect: 'read',
      enforcement_mode: 'shadow',
      policy: { ...provenance, resolved_digest_sha256: digest('f') },
      machine_context: { actor: 'release' },
      execution_state: { applied_target_count: 99 },
    };
    const envelope = trustedRuntime.materialize(spoofed);
    expect(envelope.action_effect).toBe('local-write');
    expect(envelope.enforcement_mode).toBe('binding');
    expect(envelope.policy).toEqual(provenance);
    expect(envelope.request).not.toHaveProperty('action_effect');
    expect(envelope.request).not.toHaveProperty('enforcement_mode');
    expect(envelope.request).not.toHaveProperty('policy');
    expect(envelope.request).not.toHaveProperty('machine_context');
    expect(envelope.request).not.toHaveProperty('execution_state');

    const digestTampered = { ...envelope, action_effect: 'read' } as MutationEnvelope;
    const tamperDecision = decide({
      plan: exactPlan(digestTampered, []),
      runtime: trustedRuntime,
    });
    expect(tamperDecision.reason_code).toBe('UNVERIFIED_MUTATION_ENVELOPE');
    expect(tamperDecision.disposition).toBe('refuse');

    const idTampered = { ...envelope, envelope_id: 'envelope-replayed' } as MutationEnvelope;
    const idTamperDecision = decide({
      plan: exactPlan(idTampered),
      runtime: trustedRuntime,
    });
    expect(idTamperDecision.reason_code).toBe('UNVERIFIED_MUTATION_ENVELOPE');
    expect(idTamperDecision.disposition).toBe('refuse');
  });

  it('passes a verified read through and keeps read and dry-run decisions readiness-ineligible', () => {
    const readRuntime = runtime({ effect: 'read' });
    const readPlan = exactPlan(readRuntime.materialize(baseRequest), []);
    const readDecision = decide({ plan: readPlan, runtime: readRuntime });
    expect(readDecision.evaluation).toBe('not-applicable');
    expect(readDecision.disposition).toBe('proceed');
    expect(readDecision.readiness.eligible).toBe(false);

    const dryRunRuntime = runtime();
    const dryRunEnvelope = dryRunRuntime.materialize({
      ...baseRequest,
      dry_run: true,
      consent: { ...baseRequest.consent, write: false },
    });
    const dryRunDecision = decide({ plan: exactPlan(dryRunEnvelope), runtime: dryRunRuntime });
    expect(dryRunDecision.evaluation).toBe('deny');
    expect(dryRunDecision.disposition).toBe('proceed');
    expect(dryRunDecision.readiness.eligible).toBe(false);
  });

  it('refuses malformed paths, duplicate targets, and consent violations even in shadow', () => {
    const shadowRuntime = runtime({ mode: 'shadow' });
    const envelope = shadowRuntime.materialize({
      ...baseRequest,
      consent: { ...baseRequest.consent, write: false },
    });
    const invalidPath: ResourceTarget = {
      ...fsTarget,
      canonical_relative_path: './packages//core/../secret',
    };
    const decision = decide({
      plan: exactPlan(envelope, [invalidPath, invalidPath]),
      runtime: shadowRuntime,
      policy: policy(),
    });
    expect(decision.reason_code).toBe('MALFORMED_PLAN');
    expect(decision.disposition).toBe('refuse');
  });

  it('records shadow denials but proceeds and never promotes readiness', () => {
    const shadowRuntime = runtime({ mode: 'shadow' });
    const envelope = shadowRuntime.materialize(baseRequest);
    const cases = [
      decide({ plan: exactPlan(envelope), runtime: shadowRuntime }),
      decide({
        plan: exactPlan(envelope),
        runtime: shadowRuntime,
        policy: policy({ ...provenance, resolved_digest_sha256: digest('f') }),
      }),
      decide({
        plan: exactPlan(envelope),
        runtime: shadowRuntime,
        policy: policy(provenance, 'deny'),
      }),
      decide({
        plan: exactPlan(envelope),
        runtime: shadowRuntime,
        policy: {
          provenance,
          evaluate: () => {
            throw new Error('fixture policy crash');
          },
        },
      }),
    ];
    for (const decision of cases) {
      expect(decision.evaluation).toBe('deny');
      expect(decision.disposition).toBe('proceed');
      expect(decision.readiness.eligible).toBe(false);
    }
  });

  it('refuses a missing runtime even when the envelope is configured for shadow', () => {
    const shadowRuntime = runtime({ mode: 'shadow' });
    const decision = decide({ plan: exactPlan(shadowRuntime.materialize(baseRequest)) });
    expect(decision.reason_code).toBe('MISSING_RUNTIME_ADAPTER');
    expect(decision.disposition).toBe('refuse');
    expect(decision.readiness.eligible).toBe(false);
  });

  it('refuses the same runtime/policy failures in binding mode', () => {
    const bindingRuntime = runtime({ mode: 'binding' });
    const envelope = bindingRuntime.materialize(baseRequest);
    const cases = [
      decide({ plan: exactPlan(envelope) }),
      decide({ plan: exactPlan(envelope), runtime: bindingRuntime }),
      decide({
        plan: exactPlan(envelope),
        runtime: bindingRuntime,
        policy: policy({ ...provenance, policy_version: '2.0.0' }),
      }),
      decide({
        plan: exactPlan(envelope),
        runtime: bindingRuntime,
        policy: policy(provenance, 'deny'),
      }),
      decide({
        plan: exactPlan(envelope),
        runtime: bindingRuntime,
        policy: {
          provenance,
          evaluate: () => {
            throw new Error('fixture policy crash');
          },
        },
      }),
    ];
    for (const decision of cases) {
      expect(decision.evaluation).toBe('deny');
      expect(decision.disposition).toBe('refuse');
      expect(decision.readiness.eligible).toBe(false);
    }
  });

  it('makes only a verified binding allow for a real mutation authority-readiness eligible', () => {
    const trustedRuntime = runtime();
    const targets: readonly ResourceTarget[] = [
      fsTarget,
      {
        kind: 'git-ref',
        id: 'git:refs/heads/codex/r19',
        repository_id: 'example-repository',
        ref: 'refs/heads/codex/r19',
        operation: 'update',
      },
      {
        kind: 'db',
        id: 'db:task-ledger',
        connection_id: 'task-db',
        database_id: 'devai_task_r19',
        object_id: 'public.task_ledger',
        operation: 'insert',
      },
      {
        kind: 'remote',
        id: 'remote:github-check',
        system_id: 'github',
        endpoint_id: 'checks.create',
        operation_id: 'create-check',
        publication: false,
      },
    ];
    let observedTargets: readonly ResourceTarget[] = [];
    const allowPolicy: AuthorityPolicyAdapter = {
      provenance,
      evaluate: (subject) => {
        observedTargets = subject.plan.strategy === 'exact-plan' ? subject.plan.targets : [];
        return { outcome: 'allow', reasons: ['all resources allowed'] };
      },
    };
    const decision = decide({
      plan: exactPlan(trustedRuntime.materialize(baseRequest), targets),
      runtime: trustedRuntime,
      policy: allowPolicy,
    });
    expect(observedTargets.map((target) => target.kind)).toEqual(['fs', 'git-ref', 'db', 'remote']);
    expect(JSON.stringify(observedTargets)).not.toContain('/Users/');
    expect(JSON.stringify(observedTargets)).not.toContain('://');
    expect(decision.evaluation).toBe('allow');
    expect(decision.disposition).toBe('proceed');
    expect(decision.readiness.eligible).toBe(true);
  });

  it('refuses boundary preparation when targets change under the same plan and decision IDs', async () => {
    const trustedRuntime = runtime();
    const envelope = trustedRuntime.materialize(baseRequest);
    const original = exactPlan(envelope, [fsTarget]);
    const decision = decide({ plan: original, runtime: trustedRuntime, policy: policy() });
    let prepares = 0;
    const issued = new Set<PreparedMutation>();
    const adapter: MutationBoundaryAdapter = {
      adapter_id: 'fs-test',
      adapter_version: '1.0.0',
      target_kind: 'fs',
      prepare: async (subject, _decision, binding) => {
        prepares += 1;
        const prepared = {
          preparation_id: `issued:${binding.decision_id}`,
          adapter_id: 'fs-test',
          adapter_version: '1.0.0',
          plan_id: subject.plan.plan_id,
          subject_digest_sha256: binding.subject_digest_sha256,
          decision_digest_sha256: binding.decision_digest_sha256,
          target_ids:
            subject.plan.strategy === 'exact-plan'
              ? subject.plan.targets.map((target) => target.id)
              : [],
        } as unknown as PreparedMutation;
        issued.add(prepared);
        return prepared;
      },
      verifyPrepared: (prepared) => {
        const verified =
          issued.has(prepared) &&
          prepared.subject_digest_sha256.length === 64 &&
          prepared.decision_digest_sha256.length === 64;
        return verified
          ? {
              verified: true,
              capability: {
                prepared,
                adapter_id: 'fs-test',
                adapter_version: '1.0.0',
              } as VerifiedPreparedMutationCapability,
            }
          : { verified: false, reasons: ['preparation was not issued by this adapter'] };
      },
      apply: async (capability) => ({
        preparation_id: capability.prepared.preparation_id,
        applied_target_ids: capability.prepared.target_ids,
        evidence_refs: [],
      }),
    };
    const tampered = exactPlan(envelope, [
      {
        ...fsTarget,
        id: 'fs:CONSTITUTION.md',
        canonical_relative_path: 'CONSTITUTION.md',
      },
    ]);
    const outcome = await prepareAuthorizedMutation({
      adapter,
      subject: { plan: tampered },
      decision,
      context: humanContext,
    });
    expect(outcome.prepared).toBe(false);
    expect(prepares).toBe(0);

    const readRuntime = runtime({ effect: 'read' });
    const readPlan = exactPlan(readRuntime.materialize(baseRequest), []);
    const readDecision = decide({ plan: readPlan, runtime: readRuntime });
    const readPrepare = await prepareAuthorizedMutation({
      adapter,
      subject: { plan: readPlan },
      decision: readDecision,
      context: humanContext,
    });
    expect(readPrepare.prepared).toBe(false);

    const dryRuntime = runtime();
    const dryPlan = exactPlan(dryRuntime.materialize({ ...baseRequest, dry_run: true }), [
      fsTarget,
    ]);
    const dryDecision = decide({ plan: dryPlan, runtime: dryRuntime, policy: policy() });
    const dryPrepare = await prepareAuthorizedMutation({
      adapter,
      subject: { plan: dryPlan },
      decision: dryDecision,
      context: humanContext,
    });
    expect(dryPrepare.prepared).toBe(false);
    expect(prepares).toBe(0);

    let applies = 0;
    const applyingAdapter: MutationBoundaryAdapter = {
      ...adapter,
      apply: async (capability) => {
        applies += 1;
        return {
          preparation_id: capability.prepared.preparation_id,
          applied_target_ids: capability.prepared.target_ids,
          evidence_refs: [],
        };
      },
    };
    const validPrepare = await prepareAuthorizedMutation({
      adapter: applyingAdapter,
      subject: { plan: original },
      decision,
      context: humanContext,
    });
    expect(validPrepare.prepared).toBe(true);
    if (!validPrepare.prepared) throw new Error('fixture preparation failed');
    const validApply = await applyPreparedMutation({
      adapter: applyingAdapter,
      prepared: validPrepare.value,
    });
    expect(validApply.applied).toBe(true);
    expect(applies).toBe(1);

    const forged = {
      preparation_id: `issued:${decision.decision_id}`,
      adapter_id: 'fs-test',
      adapter_version: '1.0.0',
      plan_id: original.plan_id,
      subject_digest_sha256: decision.subject_digest_sha256,
      decision_digest_sha256: decision.decision_digest_sha256,
      target_ids: [fsTarget.id],
    } as unknown as PreparedMutation;
    const forgedApply = await applyPreparedMutation({ adapter: applyingAdapter, prepared: forged });
    expect(forgedApply.applied).toBe(false);
    expect(applies).toBe(1);
  });

  it('authorizes selectors for observation but never prepares without an exact batch', async () => {
    const trustedRuntime = runtime();
    const plan: MutationPlan = {
      plan_id: 'plan-selector-only',
      envelope: trustedRuntime.materialize(baseRequest),
      strategy: 'bounded-batches',
      selectors: [
        {
          kind: 'fs',
          repository_id: 'example-repository',
          canonical_relative_path_glob: 'packages/core/**',
          operations: ['update'],
        },
      ],
      bounds: { max_batches: 2, max_targets_per_batch: 2, max_total_targets: 4 },
      batch_atomicity: 'each-batch',
      recovery: 'preserve-and-report',
    };
    const decision = decide({ plan, runtime: trustedRuntime, policy: policy() });
    expect(decision.evaluation).toBe('allow');
    expect(decision.disposition).toBe('proceed');
    expect(decision.readiness.eligible).toBe(false);

    let prepares = 0;
    const boundary = {
      adapter_id: 'fs-test',
      adapter_version: '1.0.0',
      target_kind: 'fs',
      prepare: async () => {
        prepares += 1;
        throw new Error('selector-only authorization reached prepare');
      },
      verifyPrepared: () => ({ verified: false, reasons: ['not issued'] }),
      apply: async () => {
        throw new Error('selector-only authorization reached apply');
      },
    } satisfies MutationBoundaryAdapter;
    const prepared = await prepareAuthorizedMutation({
      adapter: boundary,
      subject: { plan },
      decision,
      context: humanContext,
    });
    expect(prepared.prepared).toBe(false);
    expect(prepares).toBe(0);
  });

  it('refuses out-of-envelope dynamic batches before policy and reports trusted recovery state', () => {
    const executionState: TrustedExecutionState = {
      applied_batch_ids: ['batch-1'],
      applied_target_count: 1,
      partial_effect_evidence_refs: ['EV-previous-batch'],
      recovery_checkpoint_ref: 'checkpoint:r19:1',
    };
    const trustedRuntime = runtime({ executionState });
    const plan: MutationPlan = {
      plan_id: 'plan-bounded',
      envelope: trustedRuntime.materialize(baseRequest),
      strategy: 'bounded-batches',
      selectors: [
        {
          kind: 'fs',
          repository_id: 'example-repository',
          canonical_relative_path_glob: 'packages/core/src/authority/**',
          operations: ['create', 'update'],
        },
      ],
      bounds: { max_batches: 3, max_targets_per_batch: 2, max_total_targets: 4 },
      batch_atomicity: 'each-batch',
      recovery: 'preserve-and-report',
    };
    const batch: MutationBatch = {
      batch_id: 'batch-2',
      plan_id: 'plan-bounded',
      ordinal: 2,
      atomicity: 'whole-batch',
      targets: [fsTarget],
    };
    let policyEvaluations = 0;
    const countingPolicy: AuthorityPolicyAdapter = {
      provenance,
      evaluate: () => {
        policyEvaluations += 1;
        return { outcome: 'allow', reasons: ['not reached'] };
      },
    };
    const decision = decide({ plan, batch, runtime: trustedRuntime, policy: countingPolicy });
    expect(decision.reason_code).toBe('MALFORMED_PLAN');
    expect(decision.disposition).toBe('refuse');
    expect(decision.recovery).toEqual(executionState);
    expect(policyEvaluations).toBe(0);
  });

  it('rejects unsafe integer bounds and empty selector operation sets', () => {
    const trustedRuntime = runtime({ mode: 'shadow' });
    const plan: MutationPlan = {
      plan_id: 'plan-invalid-bounds',
      envelope: trustedRuntime.materialize(baseRequest),
      strategy: 'bounded-batches',
      selectors: [
        {
          kind: 'fs',
          repository_id: 'example-repository',
          canonical_relative_path_glob: 'packages/**',
          operations: [],
        },
      ],
      bounds: {
        max_batches: Number.MAX_SAFE_INTEGER + 1,
        max_targets_per_batch: 1,
        max_total_targets: 1,
      },
      batch_atomicity: 'each-batch',
      recovery: 'preserve-and-report',
    };
    const decision = decide({ plan, runtime: trustedRuntime, policy: policy() });
    expect(decision.reason_code).toBe('MALFORMED_PLAN');
    expect(decision.disposition).toBe('refuse');
  });

  it('rejects replayed batches and unsafe or incoherent trusted progress', () => {
    const validTarget: ResourceTarget = {
      ...fsTarget,
      id: 'fs:authority-types',
      canonical_relative_path: 'packages/core/src/authority/types.ts',
    };
    const batch: MutationBatch = {
      batch_id: 'batch-2',
      plan_id: 'plan-progress',
      ordinal: 2,
      targets: [validTarget],
      atomicity: 'whole-batch',
    };
    const cases: readonly {
      state: TrustedExecutionState;
      reason: 'MALFORMED_PLAN' | 'UNVERIFIED_AUTHORITY_CONTEXT';
    }[] = [
      {
        state: {
          applied_batch_ids: ['batch-2'],
          applied_target_count: 1,
          partial_effect_evidence_refs: ['EV-replay'],
        },
        reason: 'MALFORMED_PLAN',
      },
      {
        state: {
          applied_batch_ids: ['batch-1'],
          applied_target_count: -1,
          partial_effect_evidence_refs: [],
        },
        reason: 'UNVERIFIED_AUTHORITY_CONTEXT',
      },
      {
        state: {
          applied_batch_ids: ['batch-1'],
          applied_target_count: Number.MAX_SAFE_INTEGER + 1,
          partial_effect_evidence_refs: [],
        },
        reason: 'UNVERIFIED_AUTHORITY_CONTEXT',
      },
      {
        state: {
          applied_batch_ids: [],
          applied_target_count: 1,
          partial_effect_evidence_refs: [],
        },
        reason: 'UNVERIFIED_AUTHORITY_CONTEXT',
      },
      {
        state: {
          applied_batch_ids: ['batch-1'],
          applied_target_count: 5,
          partial_effect_evidence_refs: [],
        },
        reason: 'UNVERIFIED_AUTHORITY_CONTEXT',
      },
    ];

    for (const testCase of cases) {
      const trustedRuntime = runtime({ executionState: testCase.state });
      const plan: MutationPlan = {
        plan_id: 'plan-progress',
        envelope: trustedRuntime.materialize(baseRequest),
        strategy: 'bounded-batches',
        selectors: [
          {
            kind: 'fs',
            repository_id: 'example-repository',
            canonical_relative_path_glob: 'packages/core/src/authority/**',
            operations: ['update'],
          },
        ],
        bounds: { max_batches: 3, max_targets_per_batch: 2, max_total_targets: 4 },
        batch_atomicity: 'each-batch',
        recovery: 'preserve-and-report',
      };
      const decision = decide({ plan, batch, runtime: trustedRuntime, policy: policy() });
      expect(decision.reason_code).toBe(testCase.reason);
      expect(decision.disposition).toBe('refuse');
    }
  });
});
