import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import {
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
  type MutationEnvelope,
  type MutationPlan,
  type MutationRequest,
  type ResourceTarget,
  type ResourceTargetSelector,
  type TrustedExecutionState,
} from '../../src/index.js';

// Remaining measured residue of the retained round-3 authority mutation report (3175bd2) for
// `decision.ts`, after authority-decision-contracts.test.ts and
// authority-bounded-batch-boundary-contracts.test.ts. Those two pin the per-cause refusals, the
// readiness reasons and the bounded-batch boundaries; neither asserts the decision id a relying
// party reproduces, the absence of the optional recovery key, the extension roster inside the
// policy provenance, blank-but-non-empty database identifiers, or the enforcement mode that
// scopes the allow requirement of the binding verifier. Every assertion reads an observable
// Decision field or the public binding verification.

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
  /** Provenance the trusted runtime binds into the envelope it materializes. */
  readonly provenance?: AuthorityPolicyProvenance;
}

function runtime(options: RuntimeOptions = {}): AuthorityRuntimeAdapter {
  const bound = options.provenance ?? provenance;
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
        policy: bound,
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

function boundedPlan(envelope: MutationEnvelope): MutationPlan {
  return {
    plan_id: 'plan-bounded',
    envelope,
    strategy: 'bounded-batches',
    selectors: [fsSelector],
    bounds: { max_batches: 2, max_targets_per_batch: 2, max_total_targets: 3 },
    batch_atomicity: 'each-batch',
    recovery: 'preserve-and-report',
  };
}

const firstBatch: MutationBatch = {
  batch_id: 'batch-1',
  plan_id: 'plan-bounded',
  ordinal: 1,
  targets: [docsTarget],
  atomicity: 'whole-batch',
};

function policy(
  outcome: 'allow' | 'deny' = 'allow',
  bound: AuthorityPolicyProvenance = provenance,
): AuthorityPolicyAdapter {
  return {
    provenance: bound,
    evaluate: () => ({ outcome, reasons: [`fixture ${outcome}`] }),
  };
}

const fresh: TrustedExecutionState = {
  applied_batch_ids: [],
  applied_target_count: 0,
  partial_effect_evidence_refs: [],
};

describe('decision identity derivation', () => {
  /**
   * The derivation a relying party reproduces from the digests the decision publishes:
   * `AUTH-` plus the first 16 hex characters of the SHA-256 over the pipe-joined tuple.
   * The first case cross-checks this formula against the shipped verifier, which
   * re-derives the same id, so the second case extends a formula already agreed
   * rather than restating an implementation detail.
   */
  function deriveDecisionId(
    subjectDigest: string,
    contextDigest: string,
    policyDigest: string,
    evaluation: Decision['evaluation'],
    reasonCode: Decision['reason_code'],
  ): string {
    return `AUTH-${createHash('sha256')
      .update(`${subjectDigest}|${contextDigest}|${policyDigest}|${evaluation}|${reasonCode}`)
      .digest('hex')
      .slice(0, 16)}`;
  }

  it('derives the decision id from the subject, context and policy digests it publishes', () => {
    const trusted = runtime();
    const plan = exactPlan(trusted.materialize(baseRequest));
    const decision = decide({ plan, runtime: trusted, policy: policy() });
    expect(decision.reason_code).toBe('POLICY_ALLOW');
    expect(decision.decision_id).toBe(
      deriveDecisionId(
        canonicalSha256({ plan }),
        canonicalSha256(humanContext),
        canonicalSha256(provenance),
        'allow',
        'POLICY_ALLOW',
      ),
    );
    // The shipped verifier re-derives the id the same way, so the formula above is the
    // published one rather than a private restatement.
    expect(verifyDecisionBinding({ plan }, decision, humanContext)).toMatchObject({
      verified: true,
    });
  });

  // Mutant 4651: a decision reached before any trusted authority context exists publishes a
  // null context digest, and its id is derived over an *empty* context field. Substituting any
  // other filler would make the id irreproducible for the exact tuple the decision publishes.
  it('derives a context-less decision id over an empty authority context field', () => {
    const plan = exactPlan(runtime().materialize(baseRequest));
    const decision = decide({ plan, policy: policy() });
    expect(decision).toMatchObject({
      reason_code: 'MISSING_RUNTIME_ADAPTER',
      evaluation: 'deny',
      authority_context_digest_sha256: null,
    });
    expect(decision.decision_id).toBe(
      deriveDecisionId(
        canonicalSha256({ plan }),
        '',
        canonicalSha256(provenance),
        'deny',
        'MISSING_RUNTIME_ADAPTER',
      ),
    );
  });
});

describe('decision recovery key presence', () => {
  // Mutant 4788: `recovery` is optional in the published Decision. When the trusted runtime
  // reported no execution state the key is absent, not present with an undefined value, so a
  // consumer testing key presence cannot mistake "no trusted progress" for "progress reported".
  it('omits the recovery key when the trusted runtime reported no execution state', () => {
    const trusted = runtime();
    const decision = decide({
      plan: exactPlan(trusted.materialize(baseRequest)),
      runtime: trusted,
      policy: policy(),
    });
    expect(decision.reason_code).toBe('POLICY_ALLOW');
    expect(Object.hasOwn(decision, 'recovery')).toBe(false);
    expect('recovery' in decision).toBe(false);
    expect(Object.keys(decision)).not.toContain('recovery');
  });

  it('carries the recovery key when the trusted runtime reported execution state', () => {
    const trusted = runtime({ executionState: fresh });
    const decision = decide({
      plan: boundedPlan(trusted.materialize(baseRequest)),
      batch: firstBatch,
      runtime: trusted,
      policy: policy(),
    });
    expect(decision.reason_code).toBe('POLICY_ALLOW');
    expect(Object.hasOwn(decision, 'recovery')).toBe(true);
    expect(decision.recovery).toStrictEqual(fresh);
  });
});

describe('policy provenance extension roster', () => {
  const invalidExtension = {
    extension_id: 'broken-authority',
    extension_version: '1.0.0',
    digest_sha256: 'not-a-sha-256-digest',
  };

  // Mutant 4687: every additive extension digest must be a SHA-256, not merely one of them. A
  // roster mixing a valid digest with an invalid one is refused exactly like an all-invalid one.
  it('refuses a provenance whose extension roster mixes a valid and an invalid digest', () => {
    const mixed: AuthorityPolicyProvenance = {
      ...provenance,
      additive_extensions: [...provenance.additive_extensions, invalidExtension],
    };
    const trusted = runtime({ provenance: mixed });
    const decision = decide({
      plan: exactPlan(trusted.materialize(baseRequest)),
      runtime: trusted,
      policy: policy('allow', mixed),
    });
    expect(decision).toMatchObject({
      reason_code: 'POLICY_PROVENANCE_INVALID',
      evaluation: 'deny',
      disposition: 'refuse',
      reasons: ['resolved policy provenance is incomplete or contains an invalid SHA-256 digest'],
    });
  });

  it('admits a provenance whose extension roster is entirely valid', () => {
    const both: AuthorityPolicyProvenance = {
      ...provenance,
      additive_extensions: [
        ...provenance.additive_extensions,
        { ...invalidExtension, digest_sha256: digest('e') },
      ],
    };
    const trusted = runtime({ provenance: both });
    const decision = decide({
      plan: exactPlan(trusted.materialize(baseRequest)),
      runtime: trusted,
      policy: policy('allow', both),
    });
    expect(decision).toMatchObject({ reason_code: 'POLICY_ALLOW', evaluation: 'allow' });
  });
});

describe('database resource identifier blanks', () => {
  const dbTarget: ResourceTarget = {
    kind: 'db',
    id: 'db:devai/table:events',
    connection_id: 'control',
    database_id: 'devai',
    object_id: 'table:events',
    operation: 'insert',
  };

  // Mutant 4988: a database identifier is refused when it is blank, not only when it is the
  // empty string. Batch 4 pins the empty forms, which an untrimmed length check also refuses.
  it.each<['connection_id' | 'database_id' | 'object_id']>([
    ['connection_id'],
    ['database_id'],
    ['object_id'],
  ])('refuses a db target whose %s is whitespace only', (field) => {
    const trusted = runtime();
    const decision = decide({
      plan: exactPlan(trusted.materialize(baseRequest), [{ ...dbTarget, [field]: '   \t' }]),
      runtime: trusted,
      policy: policy(),
    });
    expect(decision).toMatchObject({
      reason_code: 'MALFORMED_PLAN',
      evaluation: 'deny',
      disposition: 'refuse',
      reasons: ['db resource identifiers must not be empty'],
    });
  });

  it('admits a db target whose identifiers all carry content', () => {
    const trusted = runtime();
    const decision = decide({
      plan: exactPlan(trusted.materialize(baseRequest), [dbTarget]),
      runtime: trusted,
      policy: policy(),
    });
    expect(decision).toMatchObject({ reason_code: 'POLICY_ALLOW', evaluation: 'allow' });
  });
});

describe('binding verification enforcement scope', () => {
  // Mutant 4821: the allow requirement of the binding verifier is scoped to binding
  // enforcement. A shadow decision is verified on its own terms — shadow proceeds after a
  // policy failure by design (`decide` doc comment) and is contained by readiness
  // ineligibility and by the enforcement mode the decision publishes, not by this reason. The
  // installed path is unaffected: the decision issuer mints receipts for allow resolutions
  // only, so a shadow denial never reaches a boundary adapter through it.
  it('verifies a shadow denial, whose containment is readiness ineligibility', () => {
    const trusted = runtime({ mode: 'shadow' });
    const plan = exactPlan(trusted.materialize(baseRequest));
    const decision = decide({ plan, runtime: trusted, policy: policy('deny') });
    expect(decision).toMatchObject({
      reason_code: 'POLICY_DENY',
      evaluation: 'deny',
      disposition: 'proceed',
      enforcement_mode: 'shadow',
      readiness: {
        eligible: false,
        reason: 'Shadow evaluation is observable but cannot promote production readiness.',
      },
    });
    const verification = verifyDecisionBinding({ plan }, decision, humanContext);
    expect(verification.verified).toBe(true);
  });

  it('refuses the same denial under binding enforcement', () => {
    const trusted = runtime();
    const plan = exactPlan(trusted.materialize(baseRequest));
    const decision = decide({ plan, runtime: trusted, policy: policy('deny') });
    expect(decision).toMatchObject({
      reason_code: 'POLICY_DENY',
      evaluation: 'deny',
      disposition: 'refuse',
      enforcement_mode: 'binding',
    });
    expect(verifyDecisionBinding({ plan }, decision, humanContext)).toStrictEqual({
      verified: false,
      reasons: [
        'decision disposition is not proceed',
        'binding mutation requires an allow evaluation',
      ],
    });
  });
});
