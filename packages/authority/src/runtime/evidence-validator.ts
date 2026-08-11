import {
  actionDocument,
  equal,
  failure,
  isRecord,
  success,
  validInstant,
  type AnyRecord,
} from './contracts.js';

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function validateAuthorityEvidence(input: unknown, deps: unknown) {
  if (!isRecord(deps) || !isRecord(deps.current) || typeof deps.validateSchema !== 'function') {
    return failure('refused', 'AUTHORITY_EVIDENCE_SCHEMA_INVALID');
  }
  const validated = deps.validateSchema(input);
  if (!isRecord(validated) || validated.ok !== true) return validated;
  const document =
    isRecord(validated.value) && isRecord(validated.value.view)
      ? validated.value
      : {
          raw: input,
          canonical_bytes: new TextEncoder().encode(JSON.stringify(input)),
          view: input,
        };
  const view = document.view;
  if (
    !isRecord(view) ||
    !isRecord(view.targets) ||
    !Array.isArray(view.targets.summary) ||
    !isRecord(view.decision) ||
    !isRecord(view.issuer_audit) ||
    !isRecord(view.readiness)
  ) {
    return failure('refused', 'AUTHORITY_EVIDENCE_SCHEMA_INVALID');
  }
  const summary = view.targets.summary as AnyRecord[];
  const kinds = sorted([...new Set(summary.map((item) => String(item.kind)))]);
  const ids = sorted(summary.map((item) => String(item.resource_id)));
  const coherent =
    (view.decision.evaluation === 'allow' && view.decision.disposition === 'proceed') ||
    (view.decision.evaluation === 'deny' && view.decision.disposition === 'refuse') ||
    (view.decision.evaluation === 'not-applicable' &&
      view.decision.disposition === 'proceed' &&
      view.action_effect === 'read');
  if (
    view.targets.count !== summary.length ||
    !equal(view.targets.kinds, kinds) ||
    view.targets.target_ids_digest_sha256 !== deps.canonicalSha256(ids) ||
    !coherent
  )
    return failure('refused', 'AUTHORITY_EVIDENCE_SEMANTIC_INVALID');
  if (
    !validInstant(view.timestamp) ||
    !validInstant(view.issuer_audit.issued_at) ||
    Date.parse(view.timestamp) > Date.parse(deps.current.now) ||
    Date.parse(view.issuer_audit.issued_at) > Date.parse(deps.current.now) ||
    Date.parse(view.issuer_audit.issued_at) > Date.parse(view.timestamp)
  )
    return failure('refused', 'AUTHORITY_EVIDENCE_TIMESTAMP_INVALID');
  const policy = deps.current.policy;
  const expectedPolicy = {
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    package_version: deps.current.package.version,
    constitution_version: deps.current.constitution.version,
    constitution_digest_sha256: deps.current.constitution.digest_sha256,
    source_digest_sha256: policy.source_policy.digest_sha256,
    resolved_digest_sha256: policy.resolved_digest_sha256,
    extension_digests_sha256: policy.additive_extensions.map(
      (extension: AnyRecord) => extension.digest_sha256,
    ),
  };
  if (
    view.repository_id !== deps.current.repository_id ||
    !equal(view.policy_binding, expectedPolicy)
  ) {
    return failure('refused', 'AUTHORITY_EVIDENCE_BINDING_MISMATCH');
  }
  if (
    view.issuer_audit.issuer_id !== deps.current.issuer.issuer_id ||
    view.issuer_audit.issuer_version !== deps.current.issuer.issuer_version
  ) {
    return failure('refused', 'AUTHORITY_EVIDENCE_ISSUER_INVALID');
  }
  const documentAction = actionDocument(deps.current.actionContracts, String(view.action_id));
  if (!documentAction) return failure('refused', 'AUTHORITY_EVIDENCE_PROVENANCE_INVALID');
  const action = documentAction.view;
  const principal = view.principal;
  const bootstrap =
    isRecord(principal) && principal.kind === 'derived-machine' && principal.actor === 'bootstrap';
  let provenanceValid = action.effect === view.action_effect && isRecord(principal);
  if (action.subject?.kind === 'human')
    provenanceValid &&=
      principal.kind === 'human' && action.subject.allowed_roles.includes(principal.role);
  else if (action.subject?.kind === 'derived-machine')
    provenanceValid &&=
      principal.kind === 'derived-machine' &&
      principal.actor === action.subject.actor &&
      principal.transition === action.subject.transition;
  else if (action.subject?.kind === 'none')
    provenanceValid &&= bootstrap && view.action_effect === 'read';
  if (!provenanceValid) return failure('refused', 'AUTHORITY_EVIDENCE_PROVENANCE_INVALID');
  if (bootstrap) {
    const validBootstrap =
      (view.action_effect === 'read' &&
        view.decision.evaluation === 'not-applicable' &&
        view.decision.disposition === 'proceed') ||
      (view.action_effect !== 'read' &&
        view.decision.evaluation === 'deny' &&
        view.decision.disposition === 'refuse');
    if (!validBootstrap || view.readiness.authority_eligible === true)
      return failure('refused', 'AUTHORITY_EVIDENCE_BOOTSTRAP_INVALID');
  }
  if (action.subject?.kind === 'derived-machine' && !bootstrap) {
    const initiator = principal.initiated_by;
    if (action.subject.initiator === 'none') {
      if (initiator !== 'none') return failure('refused', 'AUTHORITY_EVIDENCE_INITIATOR_INVALID');
    } else if (
      !isRecord(initiator) ||
      !action.subject.initiator.allowed_roles.includes(initiator.role)
    ) {
      return failure('refused', 'AUTHORITY_EVIDENCE_INITIATOR_INVALID');
    }
  }
  if (view.readiness.production_ready !== false)
    return failure('refused', 'AUTHORITY_EVIDENCE_READINESS_INVALID');
  if (view.readiness.authority_eligible === true) {
    const eligible =
      view.enforcement_mode === 'binding' &&
      view.action_effect !== 'read' &&
      view.dry_run === false &&
      view.decision.evaluation === 'allow' &&
      view.decision.disposition === 'proceed' &&
      !bootstrap &&
      action.readiness?.requires_binding === true &&
      (view.host_enforcement?.mode === 'cli-only' ||
        (view.host_enforcement?.mode === 'host-integrated' &&
          view.host_enforcement?.attestation === 'verified'));
    if (!eligible) return failure('refused', 'AUTHORITY_EVIDENCE_READINESS_INVALID');
  }
  return success({ evidence: document, audit_only: true as const });
}
