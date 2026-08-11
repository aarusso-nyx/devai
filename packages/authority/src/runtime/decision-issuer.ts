import {
  closeContext,
  contextOwners,
  decisionOwners,
  failure,
  isRecord,
  opaque,
  registerIssuer,
  resolutionRecords,
  success,
  type AnyRecord,
  type IssuerState,
  type ResolutionRecord,
} from './contracts.js';
import { resourceValid, selectorMatches, targetOperation } from './policy-resolver.js';

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactTargets(subject: unknown): readonly AnyRecord[] | undefined {
  if (!isRecord(subject) || !isRecord(subject.plan)) return undefined;
  const plan = subject.plan;
  if (!isRecord(plan.envelope) || !isRecord(plan.envelope.request)) return undefined;
  if (plan.strategy === 'exact-plan') {
    if (
      Object.hasOwn(subject, 'batch') ||
      !Array.isArray(plan.targets) ||
      plan.targets.length === 0 ||
      plan.atomicity !== 'whole-plan' ||
      plan.targets.some((target: unknown) => !resourceValid(target))
    )
      return undefined;
    if (new Set(plan.targets.map((target: AnyRecord) => target.id)).size !== plan.targets.length)
      return undefined;
    return plan.targets;
  }
  if (
    plan.strategy !== 'bounded-batches' ||
    !isRecord(subject.batch) ||
    !isRecord(plan.bounds) ||
    !Array.isArray(plan.selectors)
  )
    return undefined;
  const batch = subject.batch;
  if (
    batch.plan_id !== plan.plan_id ||
    !validIdentifier(batch.batch_id) ||
    !Number.isSafeInteger(batch.ordinal) ||
    batch.ordinal < 0 ||
    batch.atomicity !== 'whole-batch' ||
    !Array.isArray(batch.targets) ||
    batch.targets.length === 0 ||
    batch.targets.length > plan.bounds.max_targets_per_batch ||
    batch.targets.some((target: unknown) => !resourceValid(target))
  )
    return undefined;
  if (new Set(batch.targets.map((target: AnyRecord) => target.id)).size !== batch.targets.length)
    return undefined;
  if (
    batch.targets.some(
      (target: AnyRecord) =>
        !plan.selectors.some((selector: unknown) => selectorMatches(selector, target)),
    )
  )
    return undefined;
  return batch.targets;
}

function decision(
  state: IssuerState,
  subject: AnyRecord,
  context: AnyRecord | null,
  evaluation: 'allow' | 'deny',
  reasonCode: string,
  matched: readonly string[],
) {
  const subjectDigest = state.canonicalSha256(subject);
  const contextDigest = state.canonicalSha256(context);
  const policyDigest = state.canonicalSha256(subject.plan.envelope.policy);
  const unsigned = {
    decision_id: state.randomId(),
    subject_digest_sha256: subjectDigest,
    authority_context_digest_sha256: contextDigest,
    policy_binding_digest_sha256: policyDigest,
    plan_id: subject.plan.plan_id,
    ...(subject.batch ? { batch_id: subject.batch.batch_id } : {}),
    enforcement_mode: subject.plan.envelope.enforcement_mode,
    evaluation,
    disposition: evaluation === 'allow' ? 'proceed' : 'refuse',
    reason_code: reasonCode,
    reasons: matched.length > 0 ? matched.map((id) => `matched ${id}`) : [reasonCode],
    policy: subject.plan.envelope.policy,
    obligations: [],
    readiness: {
      eligible:
        evaluation === 'allow' &&
        subject.plan.envelope.enforcement_mode === 'binding' &&
        subject.plan.envelope.request.dry_run === false,
      reason: 'Independent acceptance remains required.',
    },
  };
  return { ...unsigned, decision_digest_sha256: state.canonicalSha256(unsigned) };
}

export function createAuthorityDecisionIssuer(deps: unknown) {
  if (!isRecord(deps)) throw new Error('authority decision issuer dependencies are required');
  if (
    !Number.isInteger(deps.receipt_ttl_ms) ||
    deps.receipt_ttl_ms < 1 ||
    deps.receipt_ttl_ms > 30_000
  ) {
    throw new Error('receipt ttl must be an integer in 1..30000 milliseconds');
  }
  const issuer: AnyRecord = {
    issuer_id: String(deps.issuer_id),
    issuer_version: String(deps.issuer_version),
  };
  const state: IssuerState = {
    issuer,
    issuer_id: issuer.issuer_id,
    issuer_version: issuer.issuer_version,
    invocation_id: String(deps.invocation_id),
    canonicalSha256: deps.canonicalSha256,
    randomId: deps.randomId,
    now: deps.now,
    ttl: deps.receipt_ttl_ms,
    closed: false,
    declarations: new WeakMap(),
    contexts: new WeakMap(),
    materializations: new WeakMap(),
    decisions: new WeakMap(),
    activeContexts: new Set(),
  };

  issuer.issueAllow = (input: unknown) => {
    if (state.closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    if (
      !isRecord(input) ||
      !validIdentifier(input.invocation_id) ||
      !validIdentifier(input.boundary_adapter_id) ||
      !Array.isArray(input.resolutions)
    )
      return failure('refused', 'AUTHORITY_DECISION_INPUT_INVALID');
    const contextReceipt = input.context_receipt;
    if (!isRecord(contextReceipt) || !contextOwners.has(contextReceipt))
      return failure('refused', 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN');
    if (contextOwners.get(contextReceipt) !== state)
      return failure('refused', 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN');
    const contextRecord = state.contexts.get(contextReceipt);
    if (!contextRecord) return failure('refused', 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN');
    if (contextRecord.closed) return failure('refused', 'AUTHORITY_CONTEXT_RECEIPT_REPLAYED');
    if (
      input.invocation_id !== state.invocation_id ||
      contextRecord.invocation_id !== input.invocation_id
    )
      return failure('refused', 'AUTHORITY_CONTEXT_RECEIPT_BINDING_MISMATCH');
    const targets = exactTargets(input.subject);
    if (!targets) return failure('refused', 'AUTHORITY_DECISION_SUBJECT_NOT_EXACT');
    const records = input.resolutions.map((resolution: unknown) =>
      isRecord(resolution) ? resolutionRecords.get(resolution) : undefined,
    );
    if (records.some((record) => !record || record.outcome !== 'allow'))
      return failure('refused', 'AUTHORITY_DECISION_INPUT_INVALID');
    const trustedRecords = records as ResolutionRecord[];
    if (
      new Set(input.resolutions).size !== input.resolutions.length ||
      new Set(trustedRecords.map((record) => `${record.target_id}|${record.query_digest}`)).size !==
        records.length
    )
      return failure('refused', 'AUTHORITY_DECISION_RESOLUTION_DUPLICATE');
    const subject = input.subject as AnyRecord;
    const subjectPolicyDigest = state.canonicalSha256(subject.plan.envelope.policy);
    if (trustedRecords.some((record) => record.policy_digest !== subjectPolicyDigest))
      return failure('refused', 'AUTHORITY_DECISION_RESOLUTION_FOREIGN_POLICY');
    const targetIds = new Set(targets.map((target) => target.id));
    if (trustedRecords.some((record) => !targetIds.has(record.target_id)))
      return failure('refused', 'AUTHORITY_DECISION_RESOLUTION_EXTRA');
    for (const record of trustedRecords) {
      const target = targets.find((candidate) => candidate.id === record.target_id);
      if (!target) return failure('refused', 'AUTHORITY_DECISION_RESOLUTION_EXTRA');
      if (
        record.context_receipt !== contextReceipt ||
        record.query.action_id !== subject.plan.envelope.request.action_id ||
        record.query.operation !== targetOperation(target) ||
        state.canonicalSha256(record.query.resource) !== state.canonicalSha256(target) ||
        state.canonicalSha256(record.query.consent) !==
          state.canonicalSha256(subject.plan.envelope.request.consent)
      )
        return failure('refused', 'AUTHORITY_DECISION_RESOLUTION_QUERY_MISMATCH');
    }
    if (records.length < targets.length)
      return failure('refused', 'AUTHORITY_DECISION_RESOLUTION_MISSING');
    const created = decision(
      state,
      subject,
      contextRecord.context as AnyRecord | null,
      'allow',
      'POLICY_ALLOW',
      input.resolutions.flatMap((resolution: AnyRecord) => resolution.matched_rule_ids),
    );
    const receipt = opaque();
    const issuedAt = Date.parse(state.now());
    state.decisions.set(receipt, {
      owner: issuer,
      subject,
      subject_digest: state.canonicalSha256(subject),
      invocation_id: input.invocation_id,
      adapter_id: input.boundary_adapter_id,
      context_digest: state.canonicalSha256(contextRecord.context),
      decision: created,
      expires_at: issuedAt + state.ttl,
      used: false,
    });
    decisionOwners.set(receipt, state);
    closeContext(state, contextReceipt);
    return { issued: true, outcome: 'allow', decision: created, receipt };
  };

  issuer.issueDenial = (input: unknown) => {
    if (state.closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    if (!isRecord(input) || !validIdentifier(input.invocation_id))
      return failure('refused', 'AUTHORITY_DECISION_INPUT_INVALID');
    const contextReceipt = input.context_receipt;
    if (!isRecord(contextReceipt) || contextOwners.get(contextReceipt) !== state)
      return failure('refused', 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN');
    const contextRecord = state.contexts.get(contextReceipt);
    if (!contextRecord) return failure('refused', 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN');
    if (contextRecord.closed) return failure('refused', 'AUTHORITY_CONTEXT_RECEIPT_REPLAYED');
    const record = isRecord(input.resolution) ? resolutionRecords.get(input.resolution) : undefined;
    if (!record || record.outcome !== 'deny')
      return failure('refused', 'AUTHORITY_DECISION_DENIAL_UNKNOWN');
    if (record.context_receipt !== contextReceipt || input.invocation_id !== state.invocation_id)
      return failure('refused', 'AUTHORITY_DECISION_DENIAL_BINDING_MISMATCH');
    const subject = input.subject as AnyRecord;
    const created = decision(
      state,
      subject,
      contextRecord.context as AnyRecord | null,
      'deny',
      (input.resolution as AnyRecord).code,
      (input.resolution as AnyRecord).matched_rule_ids ?? [],
    );
    closeContext(state, contextReceipt);
    return { issued: true, outcome: 'deny', decision: created };
  };

  issuer.consume = (input: unknown) => {
    if (state.closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    if (!isRecord(input) || !isRecord(input.receipt) || !decisionOwners.has(input.receipt))
      return failure('refused', 'AUTHORITY_DECISION_RECEIPT_UNKNOWN');
    const owner = decisionOwners.get(input.receipt);
    if (!owner) return failure('refused', 'AUTHORITY_DECISION_RECEIPT_UNKNOWN');
    if (owner !== state) return failure('refused', 'AUTHORITY_DECISION_RECEIPT_FOREIGN_ISSUER');
    const record = state.decisions.get(input.receipt);
    if (!record) return failure('refused', 'AUTHORITY_DECISION_RECEIPT_UNKNOWN');
    if (record.used) return failure('refused', 'AUTHORITY_DECISION_RECEIPT_REPLAYED');
    if (Date.parse(state.now()) > record.expires_at) {
      record.used = true;
      return failure('refused', 'AUTHORITY_DECISION_RECEIPT_EXPIRED');
    }
    if (
      input.invocation_id !== record.invocation_id ||
      input.adapter_id !== record.adapter_id ||
      state.canonicalSha256(input.subject) !== record.subject_digest
    )
      return failure('refused', 'AUTHORITY_DECISION_RECEIPT_BINDING_MISMATCH');
    record.used = true;
    return success({
      decision_id: record.decision.decision_id,
      decision_digest_sha256: record.decision.decision_digest_sha256,
      subject_digest_sha256: record.subject_digest,
    });
  };

  issuer.dispose = () => {
    if (state.closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    state.closed = true;
    for (const receipt of state.activeContexts) closeContext(state, receipt);
    return success({ disposed: true as const });
  };
  registerIssuer(issuer, state);
  return issuer;
}
