import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import {
  computeMutationEnvelopeDigest,
  decide,
  declareHumanPrincipal,
  verifyDecisionBinding,
  type AuthorityContext,
  type AuthorityDecisionSubject,
  type AuthorityPolicyAdapter,
  type AuthorityPolicyProvenance,
  type AuthorityRuntimeAdapter,
  type MutationBatch,
  type MutationEnvelope,
  type MutationPlan,
  type MutationRequest,
  type ResourceTarget,
  type ResourceTargetSelector,
  type TrustedExecutionState,
} from '../../src/index.js';

// Bounded-batch residue of the retained round-3 authority mutation report (3175bd2), which
// already measured authority-decision-contracts.test.ts. That file pins the per-cause plan
// refusals, the readiness reasons of batch-less decisions, and the recovery incoherences that
// are decided together with the ordinal check; it asserts none of the boundaries below:
// selector globs over dot-prefixed refs and database objects, the exact subject the trusted
// adapters receive, readiness under an exact batch, progress incoherence that must decide on
// its own, a batch starting exactly at the total bound, and the envelope digest the decision
// recomputes instead of trusting. Every assertion reads an observable Decision field, the
// binding verification, or the value handed to an injected test adapter.

const REPOSITORY_ID = 'example-repository';
const digest = (character: string): string => character.repeat(64);

const provenance: AuthorityPolicyProvenance = {
  policy_id: 'devai-authority',
  policy_version: '1.0.0',
  repository_id: REPOSITORY_ID,
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
  repository_id: REPOSITORY_ID,
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

interface RuntimeOptions {
  readonly mode?: MutationEnvelope['enforcement_mode'];
  readonly executionState?: TrustedExecutionState;
  /** Records the subject the trusted runtime is actually asked to verify. */
  readonly onVerify?: (subject: AuthorityDecisionSubject) => void;
}

function runtime(options: RuntimeOptions = {}): AuthorityRuntimeAdapter {
  return {
    adapter_id: 'test-runtime',
    adapter_version: '1.0.0',
    materialize: (request) => {
      const fields: Pick<
        MutationEnvelope,
        'envelope_id' | 'request' | 'action_effect' | 'enforcement_mode' | 'policy' | 'issued_by'
      > = {
        envelope_id: `envelope-${request.request_id}`,
        request,
        action_effect: 'local-write',
        enforcement_mode: options.mode ?? 'binding',
        policy: provenance,
        issued_by: {
          adapter_id: 'test-runtime',
          adapter_version: '1.0.0',
          envelope_digest_sha256: digest('0'),
        },
      };
      // This injected runtime is a kernel unit fixture. Its brand assertion does
      // not establish installed-host provenance or certification acceptance.
      const draft = fields as MutationEnvelope;
      return {
        ...draft,
        issued_by: {
          ...draft.issued_by,
          envelope_digest_sha256: computeMutationEnvelopeDigest(draft),
        },
      } as MutationEnvelope;
    },
    verify: (subject) => {
      options.onVerify?.(subject);
      const computed = computeMutationEnvelopeDigest(subject.plan.envelope);
      return {
        verified: computed === subject.plan.envelope.issued_by.envelope_digest_sha256,
        envelope_digest_sha256: computed,
        context: humanContext,
        ...(options.executionState === undefined
          ? {}
          : { execution_state: options.executionState }),
        reasons: [],
      };
    },
  };
}

const docsTarget: ResourceTarget = {
  kind: 'fs',
  id: 'fs:docs/guide.md',
  repository_id: REPOSITORY_ID,
  canonical_relative_path: 'docs/guide.md',
  operation: 'update',
};

const fsSelector: ResourceTargetSelector = {
  kind: 'fs',
  repository_id: REPOSITORY_ID,
  canonical_relative_path_glob: 'docs/**',
  operations: ['update'],
};

const defaultBounds = { max_batches: 2, max_targets_per_batch: 2, max_total_targets: 3 };

function exactPlan(
  envelope: MutationEnvelope,
  targets: readonly ResourceTarget[] = [docsTarget],
): MutationPlan {
  return {
    plan_id: 'plan-exact',
    envelope,
    strategy: 'exact-plan',
    targets,
    atomicity: 'whole-plan',
  };
}

function boundedPlan(
  envelope: MutationEnvelope,
  selectors: readonly ResourceTargetSelector[] = [fsSelector],
  bounds = defaultBounds,
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
  onEvaluate?: (subject: AuthorityDecisionSubject) => void,
): AuthorityPolicyAdapter {
  return {
    provenance,
    evaluate: (subject) => {
      onEvaluate?.(subject);
      return { outcome, reasons: [`fixture ${outcome}`] };
    },
  };
}

const fresh: TrustedExecutionState = {
  applied_batch_ids: [],
  applied_target_count: 0,
  partial_effect_evidence_refs: [],
};

describe('bounded selector matching boundaries', () => {
  const gitSelector: ResourceTargetSelector = {
    kind: 'git-ref',
    repository_id: REPOSITORY_ID,
    ref_glob: 'refs/heads/*',
    operations: ['update'],
  };
  const dottedRef: ResourceTarget = {
    kind: 'git-ref',
    id: 'git:refs/heads/release.v1',
    repository_id: REPOSITORY_ID,
    ref: 'refs/heads/release.v1',
    operation: 'update',
  };
  const dottedDatabaseSelector: ResourceTargetSelector = {
    kind: 'db',
    connection_id: 'control',
    database_id_glob: '*',
    object_id_glob: 'table:events',
    operations: ['insert'],
  };
  const dottedDatabase: ResourceTarget = {
    kind: 'db',
    id: 'db:.internal',
    connection_id: 'control',
    database_id: '.internal',
    object_id: 'table:events',
    operation: 'insert',
  };
  const dottedObjectSelector: ResourceTargetSelector = {
    kind: 'db',
    connection_id: 'control',
    database_id_glob: 'devai',
    object_id_glob: '*',
    operations: ['insert'],
  };
  const dottedObject: ResourceTarget = {
    kind: 'db',
    id: 'db:.events',
    connection_id: 'control',
    database_id: 'devai',
    object_id: '.events',
    operation: 'insert',
  };

  // Database and object identifiers may start with dots. Git forbids a ref component
  // starting with a dot: use an actual valid dotted ref here, without claiming this
  // case distinguishes the git-ref dot-option mutants 5154/5155.
  it.each<[string, ResourceTargetSelector, ResourceTarget]>([
    ['a valid dotted git ref', gitSelector, dottedRef],
    ['a dot-prefixed database id', dottedDatabaseSelector, dottedDatabase],
    ['a dot-prefixed object id', dottedObjectSelector, dottedObject],
  ])('authorizes a batch target with %s', (_name, selector, target) => {
    if (target.kind === 'git-ref') {
      expect(
        execFileSync('/usr/bin/git', ['check-ref-format', target.ref], { encoding: 'utf8' }),
      ).toBe('');
    }
    const trusted = runtime({ executionState: fresh });
    const decision = decide({
      plan: boundedPlan(trusted.materialize(baseRequest), [selector]),
      batch: batchOf([target]),
      runtime: trusted,
      policy: policy(),
    });
    expect(decision).toMatchObject({
      reason_code: 'POLICY_ALLOW',
      batch_id: 'batch-1',
      readiness: { eligible: true },
    });
  });
});

describe('bounded subject binding boundaries', () => {
  // Mutants 5353-5356: the trusted runtime verifies, and the policy adapter evaluates, exactly
  // the subject the decision binds by digest. A batch may neither be dropped from nor invented
  // for the subject the injected adapters are shown.
  it('hands both injected adapters the subject the decision binds', () => {
    const verified: AuthorityDecisionSubject[] = [];
    const evaluated: AuthorityDecisionSubject[] = [];
    const trusted = runtime({
      executionState: fresh,
      onVerify: (subject) => verified.push(subject),
    });
    const plan = boundedPlan(trusted.materialize(baseRequest));
    const batch = batchOf();
    const record = (subject: AuthorityDecisionSubject): void => {
      evaluated.push(subject);
    };
    const withBatch = decide({ plan, batch, runtime: trusted, policy: policy('allow', record) });
    const withoutBatch = decide({ plan, runtime: trusted, policy: policy('allow', record) });
    expect(verified).toStrictEqual([{ plan, batch }, { plan }]);
    expect(evaluated).toStrictEqual([{ plan, batch }, { plan }]);
    expect(withBatch.subject_digest_sha256).toBe(canonicalSha256({ plan, batch }));
    expect(withoutBatch.subject_digest_sha256).toBe(canonicalSha256({ plan }));
  });

  // Mutant 4814: bounded selector authorization refuses to prepare without a batch, but a
  // bounded decision carrying its exact batch is preparable.
  it('verifies a binding decision over a bounded plan carrying its exact batch', () => {
    const trusted = runtime({ executionState: fresh });
    const plan = boundedPlan(trusted.materialize(baseRequest));
    const batch = batchOf();
    const decision = decide({ plan, batch, runtime: trusted, policy: policy() });
    expect(decision.reason_code).toBe('POLICY_ALLOW');
    expect(verifyDecisionBinding({ plan, batch }, decision, humanContext)).toMatchObject({
      verified: true,
    });
  });
});

describe('bounded readiness boundaries', () => {
  // Mutant 4778: once an exact batch is present, a denial is reported as a denial rather than
  // as observation-only selector authorization.
  it('reports a denied bounded batch as denied rather than as observation only', () => {
    const trusted = runtime({ executionState: fresh });
    const decision = decide({
      plan: boundedPlan(trusted.materialize(baseRequest)),
      batch: batchOf(),
      runtime: trusted,
      policy: policy('deny'),
    });
    expect(decision).toMatchObject({
      evaluation: 'deny',
      disposition: 'refuse',
      batch_id: 'batch-1',
      readiness: {
        eligible: false,
        reason: 'A denied or refused mutation cannot promote readiness.',
      },
    });
  });

  // Mutant 4740: shadow mode is never readiness-eligible, including on an allow that a binding
  // exact plan would have made eligible.
  it('keeps a shadow allow over an exact plan readiness ineligible', () => {
    const trusted = runtime({ mode: 'shadow' });
    const decision = decide({
      plan: exactPlan(trusted.materialize(baseRequest)),
      runtime: trusted,
      policy: policy(),
    });
    expect(decision).toMatchObject({
      evaluation: 'allow',
      disposition: 'proceed',
      enforcement_mode: 'shadow',
      readiness: {
        eligible: false,
        reason: 'Shadow evaluation is observable but cannot promote production readiness.',
      },
    });
  });
});

describe('trusted progress and attestation boundaries', () => {
  // Mutant 5442: a repeated applied batch id is incoherent on its own. The ordinal follows the
  // recorded progress and every other bound holds, so only the uniqueness check can refuse it.
  it('refuses trusted progress that repeats an applied batch id the ordinal still follows', () => {
    const repeated: TrustedExecutionState = {
      applied_batch_ids: ['batch-1', 'batch-1'],
      applied_target_count: 2,
      partial_effect_evidence_refs: [],
    };
    const trusted = runtime({ executionState: repeated });
    const decision = decide({
      plan: boundedPlan(trusted.materialize(baseRequest), [fsSelector], {
        max_batches: 3,
        max_targets_per_batch: 2,
        max_total_targets: 4,
      }),
      batch: batchOf([docsTarget], 3),
      runtime: trusted,
      policy: policy(),
    });
    expect(decision).toMatchObject({
      reason_code: 'UNVERIFIED_AUTHORITY_CONTEXT',
      disposition: 'refuse',
      reasons: ['bounded-batch progress is absent, unsafe, or incoherent in trusted runtime state'],
    });
  });

  // Mutants 5448, 5481: applied progress that has reached the total bound is still coherent, so
  // the next batch is refused as an exceeded bound with the recovery, the context and no
  // obligations bound, not as incoherent trusted progress.
  it('refuses a batch that starts exactly at the authorized total target bound', () => {
    const applied: TrustedExecutionState = {
      applied_batch_ids: ['batch-1'],
      applied_target_count: defaultBounds.max_total_targets,
      partial_effect_evidence_refs: [],
    };
    const trusted = runtime({ executionState: applied });
    const decision = decide({
      plan: boundedPlan(trusted.materialize(baseRequest), [fsSelector], {
        ...defaultBounds,
        max_targets_per_batch: defaultBounds.max_total_targets,
      }),
      batch: batchOf([docsTarget], 2),
      runtime: trusted,
      policy: policy(),
    });
    expect(decision).toMatchObject({
      reason_code: 'MALFORMED_PLAN',
      disposition: 'refuse',
      reasons: ['batch would exceed the authorized total target bound'],
      obligations: [],
      recovery: applied,
      authority_context_digest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  // Mutant 5399: the envelope digest is recomputed from the envelope itself. A trusted runtime
  // that vouches for a well-formed issuer binding it also attests cannot substitute another
  // envelope's digest for this one.
  it('refuses an envelope whose recomputed digest differs from the attested issuer binding', () => {
    const base = runtime();
    const envelope = base.materialize(baseRequest);
    const foreign = base.materialize({ ...baseRequest, request_id: 'request-2' });
    const attested = foreign.issued_by.envelope_digest_sha256;
    const stale = {
      ...envelope,
      issued_by: { ...envelope.issued_by, envelope_digest_sha256: attested },
    } as MutationEnvelope;
    const vouching: AuthorityRuntimeAdapter = {
      ...base,
      verify: () => ({
        verified: true,
        envelope_digest_sha256: attested,
        context: humanContext,
        reasons: [],
      }),
    };
    expect(attested).toMatch(/^[a-f0-9]{64}$/u);
    expect(attested).not.toBe(computeMutationEnvelopeDigest(stale));
    expect(decide({ plan: exactPlan(stale), runtime: vouching, policy: policy() })).toMatchObject({
      reason_code: 'UNVERIFIED_MUTATION_ENVELOPE',
      disposition: 'refuse',
      reasons: ['trusted runtime rejected the mutation envelope or its issuer binding'],
      obligations: [],
    });
  });
});
