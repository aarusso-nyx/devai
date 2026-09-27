import { createHash } from 'node:crypto';
import { canonicalSha256 } from '@devai-nyx/utils';
import type {
  AuthorityPolicyAdapter,
  AuthorityRuntimeAdapter,
  MutationBoundaryAdapter,
  PreparedMutation,
} from './adapters.js';
import type {
  AuthorityContext,
  AuthorityDecisionSubject,
  AuthorityPolicyProvenance,
  Decision,
  DecisionReasonCode,
  MutationBatch,
  MutationPlan,
  TrustedExecutionState,
  DecisionBindingVerification,
  MutationEnvelope,
  VerifiedDecisionBinding,
} from './types.js';
import { malformedPlan } from './decision-plan.js';

export interface DecideInput extends AuthorityDecisionSubject {
  /** Trusted runtime boundary; raw requests cannot submit security metadata. */
  readonly runtime?: AuthorityRuntimeAdapter;
  readonly policy?: AuthorityPolicyAdapter;
}

const SHA256 = /^[a-f0-9]{64}$/;

function decisionId(
  subjectDigest: string,
  contextDigest: string | null,
  policyDigest: string,
  evaluation: Decision['evaluation'],
  reason: DecisionReasonCode,
): string {
  return `AUTH-${createHash('sha256')
    .update(`${subjectDigest}|${contextDigest ?? ''}|${policyDigest}|${evaluation}|${reason}`)
    .digest('hex')
    .slice(0, 16)}`;
}

export function computeMutationEnvelopeDigest(envelope: MutationEnvelope): string {
  return canonicalSha256({
    envelope_id: envelope.envelope_id,
    request: envelope.request,
    action_effect: envelope.action_effect,
    enforcement_mode: envelope.enforcement_mode,
    policy: envelope.policy,
    issued_by: {
      adapter_id: envelope.issued_by.adapter_id,
      adapter_version: envelope.issued_by.adapter_version,
    },
  });
}

function validProvenance(provenance: AuthorityPolicyProvenance): boolean {
  if (provenance.policy_id.trim().length === 0 || provenance.policy_version.trim().length === 0) {
    return false;
  }
  return (
    provenance.repository_id.trim().length > 0 &&
    provenance.constitution.version.trim().length > 0 &&
    SHA256.test(provenance.constitution.digest_sha256) &&
    SHA256.test(provenance.source_policy.digest_sha256) &&
    SHA256.test(provenance.resolved_digest_sha256) &&
    provenance.additive_extensions.every((extension) => SHA256.test(extension.digest_sha256))
  );
}

function sameBinding(a: AuthorityPolicyProvenance, b: AuthorityPolicyProvenance): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function disposition(
  plan: MutationPlan,
  evaluation: Decision['evaluation'],
  reasonCode: DecisionReasonCode,
): Decision['disposition'] {
  if (
    reasonCode === 'MALFORMED_PLAN' ||
    reasonCode === 'MISSING_RUNTIME_ADAPTER' ||
    reasonCode === 'UNVERIFIED_MUTATION_ENVELOPE'
  ) {
    return 'refuse';
  }
  if (plan.envelope.request.dry_run || plan.envelope.enforcement_mode === 'shadow')
    return 'proceed';
  return evaluation === 'deny' ? 'refuse' : 'proceed';
}

function result(
  plan: MutationPlan,
  batch: MutationBatch | undefined,
  evaluation: Decision['evaluation'],
  reasonCode: DecisionReasonCode,
  reasons: readonly string[],
  obligations: readonly string[] = [],
  recovery?: TrustedExecutionState,
  context?: AuthorityContext,
): Decision {
  const nextDisposition = disposition(plan, evaluation, reasonCode);
  const eligible =
    evaluation === 'allow' &&
    nextDisposition === 'proceed' &&
    plan.envelope.enforcement_mode === 'binding' &&
    !plan.envelope.request.dry_run &&
    (plan.strategy === 'exact-plan' || batch !== undefined);
  const subject: AuthorityDecisionSubject = {
    plan,
    ...(batch === undefined ? {} : { batch }),
  };
  const subjectDigest = canonicalSha256(subject);
  const contextDigest = context === undefined ? null : canonicalSha256(context);
  const policyDigest = canonicalSha256(plan.envelope.policy);
  const unsigned = {
    decision_id: decisionId(subjectDigest, contextDigest, policyDigest, evaluation, reasonCode),
    subject_digest_sha256: subjectDigest,
    authority_context_digest_sha256: contextDigest,
    policy_binding_digest_sha256: policyDigest,
    plan_id: plan.plan_id,
    ...(batch === undefined ? {} : { batch_id: batch.batch_id }),
    enforcement_mode: plan.envelope.enforcement_mode,
    evaluation,
    disposition: nextDisposition,
    reason_code: reasonCode,
    reasons,
    policy: plan.envelope.policy,
    obligations,
    readiness: {
      eligible,
      reason: eligible
        ? 'Binding authority allowed this exact plan or batch; readiness still requires independent gates and evidence.'
        : plan.envelope.enforcement_mode === 'shadow'
          ? 'Shadow evaluation is observable but cannot promote production readiness.'
          : plan.envelope.request.dry_run
            ? 'Dry-run evaluation performs no governed mutation and cannot promote readiness.'
            : plan.strategy === 'bounded-batches' && batch === undefined
              ? 'Selector authorization is observable but only an exact batch may prepare a mutation or promote readiness.'
              : evaluation === 'not-applicable'
                ? 'Read-only passthrough does not prove mutation enforcement.'
                : 'A denied or refused mutation cannot promote readiness.',
    },
    ...(recovery === undefined ? {} : { recovery }),
  };
  return { ...unsigned, decision_digest_sha256: canonicalSha256(unsigned) };
}

export function verifyDecisionBinding(
  subject: AuthorityDecisionSubject,
  decision: Decision,
  context: AuthorityContext,
): DecisionBindingVerification {
  const reasons: string[] = [];
  const subjectDigest = canonicalSha256(subject);
  const contextDigest = canonicalSha256(context);
  const policyDigest = canonicalSha256(subject.plan.envelope.policy);
  if (decision.disposition !== 'proceed') reasons.push('decision disposition is not proceed');
  if (subject.plan.envelope.request.dry_run) reasons.push('dry-run cannot prepare a mutation');
  if (subject.plan.envelope.action_effect === 'read') {
    reasons.push('read action cannot prepare a mutation');
  }
  if (subject.plan.strategy === 'bounded-batches' && subject.batch === undefined) {
    reasons.push('bounded selector authorization cannot prepare without an exact batch');
  }
  if (subject.plan.envelope.enforcement_mode === 'binding' && decision.evaluation !== 'allow') {
    reasons.push('binding mutation requires an allow evaluation');
  }
  if (decision.plan_id !== subject.plan.plan_id) reasons.push('plan id differs');
  if (decision.batch_id !== subject.batch?.batch_id) reasons.push('batch id differs');
  if (decision.subject_digest_sha256 !== subjectDigest) reasons.push('subject digest differs');
  if (decision.authority_context_digest_sha256 !== contextDigest) {
    reasons.push('authority context digest differs');
  }
  if (decision.policy_binding_digest_sha256 !== policyDigest) reasons.push('policy digest differs');
  const { decision_digest_sha256: storedDecisionDigest, ...unsigned } = decision;
  if (canonicalSha256(unsigned) !== storedDecisionDigest) reasons.push('decision digest differs');
  const expectedId = decisionId(
    subjectDigest,
    contextDigest,
    policyDigest,
    decision.evaluation,
    decision.reason_code,
  );
  if (decision.decision_id !== expectedId) reasons.push('decision id differs');
  if (reasons.length > 0) return { verified: false, reasons };
  return {
    verified: true,
    capability: {
      decision_id: decision.decision_id,
      decision_digest_sha256: storedDecisionDigest,
      subject_digest_sha256: subjectDigest,
    } as VerifiedDecisionBinding,
  };
}

export type PrepareAuthorizedMutationResult =
  | { readonly prepared: false; readonly reasons: readonly string[] }
  | { readonly prepared: true; readonly value: PreparedMutation };

/** Mandatory binding verifier in front of every mutation adapter prepare. */
export async function prepareAuthorizedMutation(input: {
  readonly adapter: MutationBoundaryAdapter;
  readonly subject: AuthorityDecisionSubject;
  readonly decision: Decision;
  readonly context: AuthorityContext;
}): Promise<PrepareAuthorizedMutationResult> {
  const verification = verifyDecisionBinding(input.subject, input.decision, input.context);
  if (!verification.verified) return { prepared: false, reasons: verification.reasons };
  return {
    prepared: true,
    value: await input.adapter.prepare(input.subject, input.decision, verification.capability),
  };
}

export type ApplyPreparedMutationResult =
  | { readonly applied: false; readonly reasons: readonly string[] }
  | {
      readonly applied: true;
      readonly value: Awaited<ReturnType<MutationBoundaryAdapter['apply']>>;
    };

/** Mandatory adapter-local capability verification in front of apply. */
export async function applyPreparedMutation(input: {
  readonly adapter: MutationBoundaryAdapter;
  readonly prepared: PreparedMutation;
}): Promise<ApplyPreparedMutationResult> {
  if (
    input.prepared.adapter_id !== input.adapter.adapter_id ||
    input.prepared.adapter_version !== input.adapter.adapter_version
  ) {
    return { applied: false, reasons: ['prepared capability adapter binding differs'] };
  }
  const verification = input.adapter.verifyPrepared(input.prepared);
  if (!verification.verified) return { applied: false, reasons: verification.reasons };
  return { applied: true, value: await input.adapter.apply(verification.capability) };
}

function contextMatches(context: AuthorityContext, plan: MutationPlan): boolean {
  const request = plan.envelope.request;
  if (context.action_id !== request.action_id) return false;
  if (context.kind === 'human-session') {
    return (
      request.declared_principal !== undefined &&
      JSON.stringify(context.principal) === JSON.stringify(request.declared_principal)
    );
  }
  return (
    request.declared_principal === undefined &&
    context.principal.derivation.action_id === request.action_id &&
    context.principal.derivation.invocation_id === request.invocation_id &&
    SHA256.test(context.principal.derivation.context_digest_sha256)
  );
}

/**
 * Pure authority hand-off. It never applies a mutation. Shadow mode evaluates
 * the same targets as binding mode but proceeds after policy/context failures
 * and remains readiness-ineligible. Malformed or spoofed envelopes always
 * refuse. Binding mode refuses any denied exact plan or exact batch.
 */
export function decide(input: DecideInput): Decision {
  const { plan, batch, runtime, policy } = input;
  const subject: AuthorityDecisionSubject = {
    plan,
    ...(batch === undefined ? {} : { batch }),
  };
  // Batch refusal must preserve trusted partial/recovery evidence even when
  // the new batch is structurally outside its envelope. Verification is
  // observation-only and occurs before any mutation adapter is reached.
  const verification = runtime?.verify(subject);
  const planErrors = malformedPlan(plan, batch);
  if (planErrors.length > 0) {
    return result(
      plan,
      batch,
      'deny',
      'MALFORMED_PLAN',
      planErrors,
      [],
      verification?.verified === true ? verification.execution_state : undefined,
    );
  }

  if (runtime === undefined) {
    return result(plan, batch, 'deny', 'MISSING_RUNTIME_ADAPTER', [
      'no trusted authority runtime adapter is installed',
    ]);
  }
  // The optional chain above is impossible here because runtime was checked,
  // but keep this local alias explicit for TypeScript and code review.
  const verifiedRuntime = verification ?? runtime.verify(subject);
  const computedEnvelopeDigest = computeMutationEnvelopeDigest(plan.envelope);
  if (
    !verifiedRuntime.verified ||
    runtime.adapter_id !== plan.envelope.issued_by.adapter_id ||
    runtime.adapter_version !== plan.envelope.issued_by.adapter_version ||
    !SHA256.test(plan.envelope.issued_by.envelope_digest_sha256) ||
    verifiedRuntime.envelope_digest_sha256 !== plan.envelope.issued_by.envelope_digest_sha256 ||
    computedEnvelopeDigest !== plan.envelope.issued_by.envelope_digest_sha256
  ) {
    return result(plan, batch, 'deny', 'UNVERIFIED_MUTATION_ENVELOPE', [
      ...verifiedRuntime.reasons,
      'trusted runtime rejected the mutation envelope or its issuer binding',
    ]);
  }

  const recovery = verifiedRuntime.execution_state;
  if (batch !== undefined && plan.strategy === 'bounded-batches') {
    if (
      recovery === undefined ||
      !Number.isSafeInteger(recovery.applied_target_count) ||
      recovery.applied_target_count < 0 ||
      recovery.applied_batch_ids.some((batchId) => batchId.trim().length === 0) ||
      new Set(recovery.applied_batch_ids).size !== recovery.applied_batch_ids.length ||
      recovery.applied_batch_ids.length > plan.bounds.max_batches ||
      recovery.applied_target_count > plan.bounds.max_total_targets ||
      recovery.applied_batch_ids.length !== batch.ordinal - 1
    ) {
      return result(plan, batch, 'deny', 'UNVERIFIED_AUTHORITY_CONTEXT', [
        'bounded-batch progress is absent, unsafe, or incoherent in trusted runtime state',
      ]);
    }
    if (recovery.applied_batch_ids.includes(batch.batch_id)) {
      return result(
        plan,
        batch,
        'deny',
        'MALFORMED_PLAN',
        ['batch_id has already been applied'],
        [],
        recovery,
        verifiedRuntime.context,
      );
    }
    if (
      plan.strategy === 'bounded-batches' &&
      recovery.applied_target_count + batch.targets.length > plan.bounds.max_total_targets
    ) {
      return result(
        plan,
        batch,
        'deny',
        'MALFORMED_PLAN',
        ['batch would exceed the authorized total target bound'],
        [],
        recovery,
        verifiedRuntime.context,
      );
    }
  }

  if (plan.envelope.action_effect === 'read') {
    return result(
      plan,
      batch,
      'not-applicable',
      'READ_PASSTHROUGH',
      ['verified read action carries no mutation targets'],
      [],
      recovery,
      verifiedRuntime.context,
    );
  }
  if (!validProvenance(plan.envelope.policy)) {
    return result(
      plan,
      batch,
      'deny',
      'POLICY_PROVENANCE_INVALID',
      ['resolved policy provenance is incomplete or contains an invalid SHA-256 digest'],
      [],
      recovery,
      verifiedRuntime.context,
    );
  }
  if (verifiedRuntime.context === undefined || !contextMatches(verifiedRuntime.context, plan)) {
    return result(
      plan,
      batch,
      'deny',
      'UNVERIFIED_AUTHORITY_CONTEXT',
      ['trusted authority context is absent or does not match the request'],
      [],
      recovery,
    );
  }
  const authorityContext = verifiedRuntime.context;
  if (policy === undefined) {
    return result(
      plan,
      batch,
      'deny',
      'MISSING_POLICY_ADAPTER',
      ['no resolved authority policy adapter is installed'],
      [],
      recovery,
      authorityContext,
    );
  }
  if (
    !validProvenance(policy.provenance) ||
    !sameBinding(plan.envelope.policy, policy.provenance)
  ) {
    return result(
      plan,
      batch,
      'deny',
      'POLICY_BINDING_MISMATCH',
      ['policy adapter provenance does not match the trusted envelope binding'],
      [],
      recovery,
      authorityContext,
    );
  }

  try {
    const evaluation = policy.evaluate(subject, authorityContext);
    return evaluation.outcome === 'allow'
      ? result(
          plan,
          batch,
          'allow',
          'POLICY_ALLOW',
          evaluation.reasons,
          evaluation.obligations ?? [],
          recovery,
          authorityContext,
        )
      : result(
          plan,
          batch,
          'deny',
          'POLICY_DENY',
          evaluation.reasons,
          evaluation.obligations ?? [],
          recovery,
          authorityContext,
        );
  } catch (error) {
    return result(
      plan,
      batch,
      'deny',
      'POLICY_ADAPTER_ERROR',
      [
        `authority policy adapter failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
      [],
      recovery,
      authorityContext,
    );
  }
}
