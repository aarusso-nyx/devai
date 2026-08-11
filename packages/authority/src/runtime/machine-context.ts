import {
  actionDocument,
  contextOwners,
  declarationOwners,
  equal,
  failure,
  isRecord,
  issueContext,
  issuerState,
  success,
} from './contracts.js';

export function deriveMachineAuthorityContext(input: unknown, deps: unknown) {
  if (!isRecord(input) || !isRecord(deps))
    return failure('refused', 'AUTHORITY_DECLARATION_RECEIPT_UNKNOWN');
  const state = issuerState(deps.receiptStore);
  if (!state || state.closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
  const receipt = input.declaration_receipt;
  if (!isRecord(receipt) || !declarationOwners.has(receipt)) {
    return failure('refused', 'AUTHORITY_DECLARATION_RECEIPT_UNKNOWN');
  }
  if (declarationOwners.get(receipt) !== state) {
    return failure('refused', 'AUTHORITY_DECLARATION_RECEIPT_UNKNOWN');
  }
  const record = state.declarations.get(receipt);
  if (!record) return failure('refused', 'AUTHORITY_DECLARATION_RECEIPT_UNKNOWN');
  if (record.used) return failure('refused', 'AUTHORITY_DECLARATION_RECEIPT_REPLAYED');
  if (
    record.action_id !== input.action_id ||
    record.invocation_id !== input.invocation_id ||
    !equal(record.consent, input.consent)
  )
    return failure('refused', 'AUTHORITY_DECLARATION_RECEIPT_BINDING_MISMATCH');
  const document = actionDocument(deps.actionContracts, String(input.action_id));
  if (!document) return failure('refused', 'AUTHORITY_ACTION_CONTRACT_NOT_FOUND');
  const action = document.view;
  if (!equal(action, record.action_contract)) {
    return failure('refused', 'AUTHORITY_DECLARATION_RECEIPT_BINDING_MISMATCH');
  }
  if (!isRecord(action.subject) || action.subject.kind !== 'derived-machine') {
    return failure('refused', 'AUTHORITY_ACTION_NOT_MACHINE_DERIVED');
  }
  const subject = action.subject;
  if (!['harness-write', 'bind', 'release'].includes(subject.transition)) {
    return failure('refused', 'AUTHORITY_MACHINE_TRANSITION_NOT_AUTHORIZING');
  }
  if (subject.initiator === 'none')
    return failure('refused', 'AUTHORITY_MACHINE_INITIATOR_FORBIDDEN');
  if (!isRecord(subject.initiator))
    return failure('refused', 'AUTHORITY_MACHINE_INITIATOR_REQUIRED');
  if (!subject.initiator.allowed_roles.includes(record.principal.role)) {
    return failure('refused', 'AUTHORITY_MACHINE_INITIATOR_ROLE_DENIED');
  }
  const origin = deps.verifiedOrigin;
  const declaration = record.principal.declaration;
  const originMatches =
    declaration.source === 'cli-flag'
      ? isRecord(origin) &&
        origin.kind === 'direct-cli' &&
        origin.invocation_id === input.invocation_id
      : isRecord(origin) &&
        origin.kind === 'interactive-session' &&
        origin.session_id === declaration.session_id;
  if (!originMatches) return failure('refused', 'AUTHORITY_MACHINE_ORIGIN_MISMATCH');
  if (!equal(input.consent, action.consent))
    return failure('refused', 'AUTHORITY_MACHINE_CONSENT_MISSING');

  record.used = true;
  const unsignedPrincipal = {
    kind: 'machine' as const,
    actor: subject.actor,
    derivation: {
      action_id: action.action_id,
      transition: subject.transition,
      origin,
      trusted_adapter_id: String(deps.trusted_adapter_id),
      invocation_id: String(input.invocation_id),
      context_digest_sha256: '',
    },
  };
  const digest = deps.canonicalSha256({
    action_id: action.action_id,
    actor: subject.actor,
    transition: subject.transition,
    origin,
    trusted_adapter_id: deps.trusted_adapter_id,
    invocation_id: input.invocation_id,
    initiated_by: record.principal,
    consent: input.consent,
  });
  const principal = {
    ...unsignedPrincipal,
    derivation: { ...unsignedPrincipal.derivation, context_digest_sha256: digest },
  };
  const context = {
    kind: 'trusted-transition' as const,
    principal,
    initiated_by: record.principal,
    action_id: action.action_id,
    consent: input.consent,
  };
  const contextReceipt = issueContext(state, {
    ...record,
    context,
    // Policy matching must retain the actual human initiator. The public
    // MachinePrincipal stays narrow; the issuer-private subject projection
    // carries the preserved initiator required by Article 10.
    subject: { ...principal, initiated_by: record.principal },
    closed: false,
  });
  contextOwners.set(contextReceipt, state);
  return success({ context, context_receipt: contextReceipt });
}
