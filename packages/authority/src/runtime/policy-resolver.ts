import { minimatch } from 'minimatch';
import {
  contextOwners,
  deepFreeze,
  equal,
  isRecord,
  issuerState,
  resolutionRecords,
  type AnyRecord,
  type IssuerState,
} from './contracts.js';

const MATCH_OPTIONS = {
  dot: true,
  nocase: false,
  nonegate: true,
  nocomment: true,
  noext: true,
  nobrace: true,
  noglobstar: false,
  matchBase: false,
  windowsPathsNoEscape: false,
  platform: 'linux' as const,
};

function logical(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

function path(value: unknown): value is string {
  return (
    logical(value) &&
    !value.endsWith('/') &&
    !value.includes('//') &&
    !value.split('/').some((part) => part === '.' || part === '..')
  );
}

function glob(value: unknown): value is string {
  return path(value);
}

export function targetOperation(resource: AnyRecord): unknown {
  return resource.kind === 'remote' ? resource.operation_id : resource.operation;
}

export function resourceValid(resource: unknown): resource is AnyRecord {
  if (!isRecord(resource) || typeof resource.id !== 'string') return false;
  if (resource.kind === 'fs') {
    if (
      !logical(resource.repository_id) ||
      !path(resource.canonical_relative_path) ||
      !['create', 'update', 'delete', 'rename'].includes(resource.operation)
    )
      return false;
    if (resource.operation === 'rename')
      return (
        path(resource.rename_from_canonical_relative_path) &&
        resource.rename_from_canonical_relative_path !== resource.canonical_relative_path
      );
    return !Object.hasOwn(resource, 'rename_from_canonical_relative_path');
  }
  if (resource.kind === 'git-ref')
    return (
      logical(resource.repository_id) &&
      logical(resource.ref) &&
      ['create', 'update', 'delete', 'merge', 'push'].includes(resource.operation)
    );
  if (resource.kind === 'db')
    return (
      logical(resource.connection_id) &&
      logical(resource.database_id) &&
      logical(resource.object_id) &&
      ['insert', 'update', 'delete', 'ddl', 'execute'].includes(resource.operation)
    );
  if (resource.kind === 'remote')
    return (
      logical(resource.system_id) &&
      logical(resource.endpoint_id) &&
      logical(resource.operation_id) &&
      typeof resource.publication === 'boolean' &&
      !Object.hasOwn(resource, 'operation')
    );
  return false;
}

export function selectorMatches(
  selector: unknown,
  resource: AnyRecord,
  classifyOnly = false,
): boolean {
  if (!isRecord(selector) || selector.kind !== resource.kind) return false;
  if (selector.kind === 'fs') {
    if (
      !glob(selector.canonical_relative_path_glob) ||
      selector.repository_id !== resource.repository_id
    )
      return false;
    if (
      !minimatch(
        resource.canonical_relative_path,
        selector.canonical_relative_path_glob,
        MATCH_OPTIONS,
      )
    )
      return false;
    return classifyOnly || selector.operations?.includes(resource.operation);
  }
  if (selector.kind === 'git-ref') {
    if (
      !glob(selector.ref_glob) ||
      selector.repository_id !== resource.repository_id ||
      !minimatch(resource.ref, selector.ref_glob, MATCH_OPTIONS)
    )
      return false;
    return classifyOnly || selector.operations?.includes(resource.operation);
  }
  if (selector.kind === 'db') {
    if (
      !glob(selector.database_id_glob) ||
      !glob(selector.object_id_glob) ||
      selector.connection_id !== resource.connection_id
    )
      return false;
    if (
      !minimatch(resource.database_id, selector.database_id_glob, MATCH_OPTIONS) ||
      !minimatch(resource.object_id, selector.object_id_glob, MATCH_OPTIONS)
    )
      return false;
    return classifyOnly || selector.operations?.includes(resource.operation);
  }
  if (selector.kind === 'remote') {
    if (
      selector.system_id !== resource.system_id ||
      !selector.endpoint_ids?.includes(resource.endpoint_id) ||
      selector.publication !== resource.publication
    )
      return false;
    return classifyOnly || selector.operation_ids?.includes(resource.operation_id);
  }
  return false;
}

function queryValid(query: AnyRecord): boolean {
  const keys = Object.keys(query);
  if (
    !['action_id', 'context_receipt', 'consent', 'resource', 'operation'].every((key) =>
      keys.includes(key),
    ) ||
    keys.some(
      (key) => !['action_id', 'context_receipt', 'consent', 'resource', 'operation'].includes(key),
    )
  )
    return false;
  return (
    typeof query.action_id === 'string' &&
    isRecord(query.consent) &&
    resourceValid(query.resource) &&
    typeof query.operation === 'string'
  );
}

function subjectMatches(ruleSubject: AnyRecord, subject: unknown): boolean {
  if (!isRecord(subject)) return false;
  if (ruleSubject.kind === 'human')
    return subject.kind === 'human' && ruleSubject.roles?.includes(subject.role);
  if (ruleSubject.kind === 'derived-machine') {
    if (
      subject.kind !== 'machine' ||
      subject.actor !== ruleSubject.actor ||
      subject.derivation?.transition !== ruleSubject.transition
    )
      return false;
    if (ruleSubject.initiator === 'none') return true;
    return ruleSubject.initiator?.allowed_roles?.includes(subject.initiated_by?.role);
  }
  return false;
}

function deny(
  state: IssuerState | undefined,
  policy: AnyRecord | undefined,
  query: AnyRecord,
  code: string,
  matched: string[] = [],
) {
  const policyDigest = policy && state ? state.canonicalSha256(policy.provenance) : '';
  const operation = isRecord(query.resource) ? targetOperation(query.resource) : query.operation;
  const value = deepFreeze({
    outcome: 'deny' as const,
    category: 'refused' as const,
    code,
    policy_binding_digest_sha256: policyDigest,
    resource_target_id: isRecord(query.resource) ? String(query.resource.id ?? '') : '',
    resource_kind: isRecord(query.resource) ? query.resource.kind : 'fs',
    operation: String(operation ?? ''),
    matched_rule_ids: matched.sort(),
    reasons: [code],
    obligations: [],
    query_digest_sha256: state ? state.canonicalSha256(query) : '',
  });
  if (state && policy)
    resolutionRecords.set(value, {
      owner: state.issuer,
      policy,
      policy_digest: policyDigest,
      query_digest: value.query_digest_sha256,
      target_id: value.resource_target_id,
      query,
      context_receipt: query.context_receipt,
      outcome: 'deny',
    });
  return value;
}

function classification(rules: AnyRecord[], resource: AnyRecord): AnyRecord[] {
  const sides =
    resource.kind === 'fs' && resource.operation === 'rename'
      ? [
          resource,
          { ...resource, canonical_relative_path: resource.rename_from_canonical_relative_path },
        ]
      : [resource];
  const matchedBySide = sides.map((side) =>
    rules.filter((rule) => selectorMatches(rule.selector, side, true)),
  );
  if (matchedBySide.some((items) => items.length === 0)) return [];
  const union = new Map<string, AnyRecord>();
  for (const items of matchedBySide) for (const item of items) union.set(item.rule_id, item);
  const candidates = [...union.values()];
  const highest = Math.max(...candidates.map((rule) => Number(rule.precedence)));
  return candidates.filter((rule) => Number(rule.precedence) === highest);
}

export function resolveAuthorityPolicy(policy: unknown, queryValue: unknown, deps: unknown) {
  const query = isRecord(queryValue) ? queryValue : {};
  const dependencies = isRecord(deps) ? deps : {};
  const state = issuerState(dependencies.receiptStore);
  const receipt = query.context_receipt;
  if (!isRecord(receipt) || !contextOwners.has(receipt))
    return deny(
      state,
      isRecord(policy) ? policy : undefined,
      query,
      'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN',
    );
  const owner = contextOwners.get(receipt);
  if (!owner)
    return deny(
      state,
      isRecord(policy) ? policy : undefined,
      query,
      'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN',
    );
  const record = owner.contexts.get(receipt);
  if (!record)
    return deny(
      state,
      isRecord(policy) ? policy : undefined,
      query,
      'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN',
    );
  if (owner.closed || record.closed)
    return deny(
      state,
      isRecord(policy) ? policy : undefined,
      query,
      'AUTHORITY_CONTEXT_RECEIPT_REPLAYED',
    );
  if (!queryValid(query))
    return deny(state, isRecord(policy) ? policy : undefined, query, 'AUTHORITY_QUERY_INVALID');
  if (query.operation !== targetOperation(query.resource))
    return deny(
      state,
      isRecord(policy) ? policy : undefined,
      query,
      'AUTHORITY_QUERY_OPERATION_MISMATCH',
    );
  if (
    owner !== state ||
    record.action_id !== query.action_id ||
    !equal(record.consent, query.consent)
  ) {
    return deny(
      state,
      isRecord(policy) ? policy : undefined,
      query,
      'AUTHORITY_CONTEXT_RECEIPT_BINDING_MISMATCH',
    );
  }
  if (!state)
    return deny(
      state,
      isRecord(policy) ? policy : undefined,
      query,
      'AUTHORITY_CONTEXT_RECEIPT_BINDING_MISMATCH',
    );
  if (
    !isRecord(policy) ||
    !isRecord(policy.provenance) ||
    !isRecord(policy.document) ||
    !isRecord(policy.document.view)
  ) {
    return deny(state, undefined, query, 'AUTHORITY_POLICY_BINDING_MISMATCH');
  }
  if (!equal(record.policy, policy.provenance))
    return deny(state, policy, query, 'AUTHORITY_POLICY_BINDING_MISMATCH');
  const rules = policy.document.view.rules;
  if (!Array.isArray(rules)) return deny(state, policy, query, 'AUTHORITY_POLICY_BINDING_MISMATCH');
  const classified = classification(rules, query.resource);
  if (classified.length === 0) return deny(state, policy, query, 'UNCLASSIFIED_RESOURCE');
  const actionRules = classified.filter((rule) => rule.action_ids?.includes(query.action_id));
  if (actionRules.length === 0)
    return deny(
      state,
      policy,
      query,
      'AUTHORITY_ACTION_DENIED',
      classified.map((rule) => rule.rule_id),
    );
  const subjectRules = actionRules.filter(
    (rule) =>
      Array.isArray(rule.subjects) &&
      rule.subjects.some((subject: AnyRecord) => subjectMatches(subject, record.subject)),
  );
  if (subjectRules.length === 0)
    return deny(
      state,
      policy,
      query,
      'AUTHORITY_SUBJECT_DENIED',
      actionRules.map((rule) => rule.rule_id),
    );
  const operationRules = subjectRules.filter((rule) =>
    selectorMatches(rule.selector, query.resource),
  );
  if (operationRules.length === 0)
    return deny(
      state,
      policy,
      query,
      'AUTHORITY_OPERATION_DENIED',
      subjectRules.map((rule) => rule.rule_id),
    );
  const consentRules = operationRules.filter((rule) =>
    ['write', 'allow_publish', 'experimental'].every(
      (key) => !rule.required_consent?.[key] || query.consent[key] === true,
    ),
  );
  if (consentRules.length === 0)
    return deny(
      state,
      policy,
      query,
      'AUTHORITY_CONSENT_REQUIRED',
      operationRules.map((rule) => rule.rule_id),
    );
  const effects = new Set(consentRules.map((rule) => rule.effect));
  if (effects.size > 1)
    return deny(
      state,
      policy,
      query,
      'AMBIGUOUS_POLICY_MATCH',
      consentRules.map((rule) => rule.rule_id),
    );
  if (effects.has('deny'))
    return deny(
      state,
      policy,
      query,
      'POLICY_DENY',
      consentRules.map((rule) => rule.rule_id),
    );
  const policyDigest = state.canonicalSha256(policy.provenance);
  const queryProjection = {
    policy_binding_digest_sha256: policyDigest,
    action_id: query.action_id,
    subject: record.subject,
    operation: query.operation,
    resource: query.resource,
    consent: query.consent,
  };
  const value = deepFreeze({
    outcome: 'allow' as const,
    code: 'POLICY_ALLOW' as const,
    policy_binding_digest_sha256: policyDigest,
    resource_target_id: query.resource.id,
    resource_kind: query.resource.kind,
    operation: query.operation,
    matched_rule_ids: consentRules.map((rule) => rule.rule_id).sort(),
    obligations: [],
    query_digest_sha256: state.canonicalSha256(queryProjection),
  });
  resolutionRecords.set(value, {
    owner: state.issuer,
    policy,
    policy_digest: policyDigest,
    query_digest: value.query_digest_sha256,
    target_id: value.resource_target_id,
    query,
    context_receipt: receipt,
    outcome: 'allow',
  });
  return value;
}
