import { declareHumanPrincipal, isHumanRole } from '../principals.js';
import type { HumanPrincipal, HumanRole } from '../types.js';
import {
  actionDocument,
  declarationOwners,
  equal,
  failure,
  isRecord,
  issueContext,
  issuerState,
  opaque,
  success,
  type AnyRecord,
} from './contracts.js';

const MACHINE_KEYS = new Set([
  'principal',
  'principal_kind',
  'actor',
  'machine_actor',
  'transition',
  'machine_transition',
  'trusted_adapter_id',
  'initiated_by',
]);
const SESSION_ID = /^AUTH-SESSION-[A-Za-z0-9_-]{16,}$/;

function actionValid(view: AnyRecord, actionId: string): boolean {
  return (
    view.action_id === actionId &&
    ['read', 'harness-write', 'local-write', 'remote-write'].includes(view.effect) &&
    isRecord(view.subject) &&
    isRecord(view.consent)
  );
}

function declarationFailure(declaration: unknown) {
  if (!isRecord(declaration)) return failure('usage-error', 'AUTHORITY_DECLARATION_FIELD_INVALID');
  const keys = Object.keys(declaration);
  if (keys.some((key) => MACHINE_KEYS.has(key))) {
    return failure('usage-error', 'AUTHORITY_MACHINE_DECLARATION_FORBIDDEN');
  }
  if (keys.some((key) => key !== 'as_role' && key !== 'authority_session')) {
    return failure('usage-error', 'AUTHORITY_DECLARATION_FIELD_INVALID');
  }
  return undefined;
}

export function resolveAuthorityDeclaration(input: unknown, deps: unknown) {
  if (!isRecord(input) || !isRecord(deps)) {
    return failure('usage-error', 'AUTHORITY_DECLARATION_FIELD_INVALID');
  }
  const document = actionDocument(deps.actionContracts, String(input.action_id));
  if (!document) return failure('refused', 'AUTHORITY_ACTION_CONTRACT_NOT_FOUND');
  const action = document.view;
  if (!actionValid(action, String(input.action_id))) {
    return failure('refused', 'AUTHORITY_ACTION_CONTRACT_INVALID');
  }
  const declarationError = declarationFailure(input.declaration);
  if (declarationError) return declarationError;
  const declaration = input.declaration as AnyRecord;
  const hasRole = Object.hasOwn(declaration, 'as_role');
  const hasSession = Object.hasOwn(declaration, 'authority_session');
  if (hasRole && hasSession) return failure('usage-error', 'AUTHORITY_DECLARATION_CONFLICT');

  const state = issuerState(deps.receiptStore);
  if (!state || state.closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
  if (action.effect === 'read') {
    if (hasRole || hasSession) {
      return failure('usage-error', 'AUTHORITY_DECLARATION_NOT_APPLICABLE');
    }
    const contextReceipt = issueContext(state, {
      action_id: action.action_id,
      action_effect: 'read',
      invocation_id: String(input.invocation_id),
      repository_id: String(deps.repository_id),
      policy: deps.policy_binding,
      consent: action.consent,
      context: null,
      subject: null,
      closed: false,
    });
    return success({
      kind: 'read',
      action_id: action.action_id,
      action_effect: 'read',
      principal: null,
      declaration_receipt: null,
      context_receipt: contextReceipt,
    });
  }
  if (!hasRole && !hasSession) return failure('usage-error', 'AUTHORITY_DECLARATION_MISSING');
  const consent = input.consent;
  if (
    !isRecord(consent) ||
    !['write', 'allow_publish', 'experimental'].every(
      (key) => typeof consent[key] === 'boolean' && (!action.consent[key] || consent[key] === true),
    ) ||
    Object.keys(consent).some((key) => !['write', 'allow_publish', 'experimental'].includes(key))
  ) {
    return failure('refused', 'AUTHORITY_ACTION_CONSENT_MISMATCH');
  }

  let principal: HumanPrincipal;
  if (hasRole) {
    if (typeof declaration.as_role !== 'string' || !isHumanRole(declaration.as_role)) {
      return failure('usage-error', 'AUTHORITY_ROLE_INVALID');
    }
    principal = declareHumanPrincipal({
      role: declaration.as_role,
      source: 'cli-flag',
      declared_at: String(deps.now),
    });
  } else {
    if (
      typeof declaration.authority_session !== 'string' ||
      !SESSION_ID.test(declaration.authority_session)
    ) {
      return failure('usage-error', 'AUTHORITY_SESSION_ID_INVALID');
    }
    const read = deps.readSession(declaration.authority_session);
    if (!isRecord(read) || read.ok !== true) return read;
    if (read.value === undefined) return failure('refused', 'AUTHORITY_SESSION_NOT_FOUND');
    const validated = deps.validateSessionSchema(read.value);
    if (!isRecord(validated) || validated.ok !== true) return validated;
    const sessionDocument = validated.value;
    const session =
      isRecord(sessionDocument) && isRecord(sessionDocument.view)
        ? sessionDocument.view
        : sessionDocument;
    if (!isRecord(session)) return failure('refused', 'AUTHORITY_SESSION_SCHEMA_INVALID');
    const raw =
      isRecord(sessionDocument) && isRecord(sessionDocument.raw) ? sessionDocument.raw : session;
    const { session_digest_sha256: _digest, ...unsigned } = raw;
    if (deps.canonicalSha256(unsigned) !== session.session_digest_sha256) {
      return failure('refused', 'AUTHORITY_SESSION_DIGEST_MISMATCH');
    }
    if (session.status === 'revoked') return failure('refused', 'AUTHORITY_SESSION_REVOKED');
    if (session.status === 'stale') return failure('refused', 'AUTHORITY_SESSION_STALE');
    if (session.status === 'expired' || Date.parse(session.expires_at) <= Date.parse(deps.now)) {
      return failure('refused', 'AUTHORITY_SESSION_EXPIRED');
    }
    if (session.repository_id !== deps.repository_id) {
      return failure('refused', 'AUTHORITY_SESSION_REPOSITORY_MISMATCH');
    }
    const binding = session.policy_binding;
    if (
      !isRecord(binding) ||
      binding.policy_id !== deps.policy_binding.policy_id ||
      binding.policy_version !== deps.policy_binding.policy_version ||
      binding.resolved_digest_sha256 !== deps.policy_binding.resolved_digest_sha256
    )
      return failure('refused', 'AUTHORITY_SESSION_POLICY_MISMATCH');
    if (!equal(session.constitution_binding, deps.constitution_binding)) {
      return failure('refused', 'AUTHORITY_SESSION_CONSTITUTION_MISMATCH');
    }
    if (!equal(session.package_binding, deps.package_binding)) {
      return failure('refused', 'AUTHORITY_SESSION_PACKAGE_MISMATCH');
    }
    principal = declareHumanPrincipal({
      role: String(session.role),
      source: 'session-state',
      session_id: declaration.authority_session,
      declared_at: String(deps.now),
    });
  }

  const subject = action.subject;
  const allowedRoles: readonly HumanRole[] =
    subject.kind === 'human' ? subject.allowed_roles : (subject.initiator?.allowed_roles ?? []);
  if (!allowedRoles.includes(principal.role)) {
    return failure('refused', 'AUTHORITY_HUMAN_ROLE_DENIED');
  }

  const declarationReceipt = opaque();
  const record = {
    action_id: action.action_id,
    action_effect: action.effect,
    invocation_id: String(input.invocation_id),
    dry_run: Boolean(input.dry_run),
    repository_id: String(deps.repository_id),
    policy: deps.policy_binding,
    constitution: deps.constitution_binding,
    package: deps.package_binding,
    consent,
    principal,
    action_contract: action,
    used: false,
  };
  state.declarations.set(declarationReceipt, record);
  declarationOwners.set(declarationReceipt, state);
  if (subject.kind === 'derived-machine') {
    return success({
      kind: 'machine-initiation',
      action_id: action.action_id,
      action_effect: action.effect,
      initiated_by: principal,
      declaration_receipt: declarationReceipt,
      context_receipt: null,
    });
  }
  const context = {
    kind: 'human-session' as const,
    principal,
    action_id: action.action_id,
    origin:
      principal.declaration.source === 'cli-flag'
        ? { kind: 'direct-cli' as const, invocation_id: String(input.invocation_id) }
        : { kind: 'interactive-session' as const, session_id: principal.declaration.session_id },
  };
  const contextReceipt = issueContext(state, {
    ...record,
    context,
    subject: principal,
    closed: false,
  });
  return success({
    kind: 'human',
    action_id: action.action_id,
    action_effect: action.effect,
    principal,
    declaration_receipt: declarationReceipt,
    context_receipt: contextReceipt,
  });
}
