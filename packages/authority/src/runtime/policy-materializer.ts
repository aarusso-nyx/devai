import { deriveMachineAuthorityContext } from './machine-context.js';
import { resolveAuthorityDeclaration } from './declaration.js';
import { AUTHORITY_POLICY_MATERIALIZED_PATH } from '../paths.js';
import {
  deepFreeze,
  equal,
  failure,
  isRecord,
  issuerState,
  materializationOwners,
  opaque,
  success,
  validInstant,
  type AnyRecord,
} from './contracts.js';

export function authorizePolicyMaterialization(input: unknown, deps: unknown) {
  if (!isRecord(input) || !isRecord(deps))
    return failure('refused', 'AUTHORITY_MATERIALIZATION_ACTION_INVALID');
  if (
    input.action_id !== 'init bind' ||
    !['create', 'update'].includes(input.target_operation)
  ) {
    return failure('refused', 'AUTHORITY_MATERIALIZATION_ACTION_INVALID');
  }
  if (!isRecord(input.consent) || input.consent.write !== true) {
    return failure('refused', 'AUTHORITY_MATERIALIZATION_WRITE_CONSENT_REQUIRED');
  }
  const state = issuerState(deps.receiptStore);
  if (!state || state.closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
  const declaration = resolveAuthorityDeclaration(input, {
    ...deps.declaration,
    receiptStore: deps.receiptStore,
  });
  if (!isRecord(declaration) || declaration.ok !== true) {
    if (declaration?.code === 'AUTHORITY_HUMAN_ROLE_DENIED') {
      return failure('refused', 'AUTHORITY_MATERIALIZATION_ARCHITECT_REQUIRED');
    }
    return declaration;
  }
  if (declaration.value.initiated_by?.role !== 'architect') {
    return failure('refused', 'AUTHORITY_MATERIALIZATION_ARCHITECT_REQUIRED');
  }
  const derived = deriveMachineAuthorityContext(
    {
      action_id: input.action_id,
      invocation_id: input.invocation_id,
      declaration_receipt: declaration.value.declaration_receipt,
      consent: input.consent,
    },
    { ...deps.derivation, receiptStore: deps.receiptStore },
  );
  if (!isRecord(derived) || derived.ok !== true) return derived;
  const authorization = opaque();
  const record = {
    action_id: input.action_id,
    invocation_id: input.invocation_id,
    repository_id: deps.declaration.repository_id,
    target_operation: input.target_operation,
    consent: input.consent,
    principal: declaration.value.initiated_by,
    context_receipt: derived.value.context_receipt,
    package: deps.declaration.package_binding,
    constitution: deps.declaration.constitution_binding,
    immutableCore: deps.immutableCore,
    additiveExtensions: deps.additiveExtensions,
    used: false,
  };
  state.materializations.set(authorization, record);
  materializationOwners.set(authorization, state);
  return success(authorization);
}

function validShadow(enforcement: unknown, materializedAt: string): boolean {
  if (!isRecord(enforcement)) return false;
  if (enforcement.mode === 'binding') return Object.keys(enforcement).length === 1;
  if (enforcement.mode !== 'shadow' || !isRecord(enforcement.shadow)) return false;
  return (
    typeof enforcement.shadow.reason === 'string' &&
    enforcement.shadow.reason.length > 0 &&
    validInstant(enforcement.shadow.expires_at) &&
    Date.parse(enforcement.shadow.expires_at) > Date.parse(materializedAt) &&
    enforcement.shadow.approved_by?.role === 'architect'
  );
}

export function materializeAuthorityPolicy(input: unknown, deps: unknown) {
  if (!isRecord(input) || !isRecord(deps))
    return failure('refused', 'AUTHORITY_MATERIALIZATION_AUTHORIZATION_UNKNOWN');
  const state = issuerState(deps.receiptStore);
  const authorization = input.authorization;
  if (!isRecord(authorization) || !materializationOwners.has(authorization)) {
    return failure('refused', 'AUTHORITY_MATERIALIZATION_AUTHORIZATION_UNKNOWN');
  }
  if (!state || materializationOwners.get(authorization) !== state) {
    return failure('refused', 'AUTHORITY_MATERIALIZATION_AUTHORIZATION_BINDING_MISMATCH');
  }
  const record = state.materializations.get(authorization);
  if (!record) return failure('refused', 'AUTHORITY_MATERIALIZATION_AUTHORIZATION_UNKNOWN');
  if (record.used) return failure('refused', 'AUTHORITY_MATERIALIZATION_AUTHORIZATION_REPLAYED');
  record.used = true;
  if (
    state.closed ||
    record.action_id !== 'init bind' ||
    record.principal.role !== 'architect' ||
    record.consent.write !== true ||
    !equal(record.package, deps.package_binding) ||
    !equal(record.constitution, deps.constitution_binding)
  ) {
    return failure('refused', 'AUTHORITY_MATERIALIZATION_AUTHORIZATION_BINDING_MISMATCH');
  }
  if (
    record.repository_id !== input.repository_id ||
    record.target_operation !== input.target_operation
  ) {
    return failure('refused', 'AUTHORITY_MATERIALIZATION_BINDING_MISMATCH');
  }
  const core = deps.immutableCore;
  const extensions = deps.additiveExtensions;
  if (
    !isRecord(core) ||
    !Array.isArray(core.rules) ||
    !isRecord(core.source_document) ||
    !(core.canonical_source_bytes instanceof Uint8Array) ||
    !equal([...deps.canonicalBytes(core.source_document)], [...core.canonical_source_bytes]) ||
    !equal(core.source_document.rules, core.rules)
  ) {
    return failure('refused', 'AUTHORITY_POLICY_SOURCE_INVALID');
  }
  if (
    !Array.isArray(extensions) ||
    extensions.some(
      (extension: unknown) =>
        !isRecord(extension) ||
        !Array.isArray(extension.rules) ||
        !isRecord(extension.source_document) ||
        !(extension.canonical_source_bytes instanceof Uint8Array) ||
        !equal(
          [...deps.canonicalBytes(extension.source_document)],
          [...extension.canonical_source_bytes],
        ) ||
        !equal(extension.source_document.rules, extension.rules),
    )
  ) {
    return failure('refused', 'AUTHORITY_POLICY_EXTENSION_INVALID');
  }
  const extensionIds = extensions.map((extension: AnyRecord) => extension.extension_id);
  if (new Set(extensionIds).size !== extensionIds.length)
    return failure('refused', 'AUTHORITY_POLICY_DUPLICATE_EXTENSION_ID');
  const allRules = [
    ...core.rules,
    ...extensions.flatMap((extension: AnyRecord) => extension.rules),
  ];
  const ruleIds = allRules.map((rule: AnyRecord) => rule.rule_id);
  if (new Set(ruleIds).size !== ruleIds.length)
    return failure('refused', 'AUTHORITY_POLICY_DUPLICATE_RULE_ID');
  if (
    extensions.some((extension: AnyRecord) =>
      extension.rules.some(
        (rule: AnyRecord) =>
          rule.origin !== 'additive-extension' ||
          core.rules.some(
            (coreRule: AnyRecord) =>
              equal(coreRule.selector, rule.selector) &&
              Number(rule.precedence) >= Number(coreRule.precedence),
          ),
      ),
    )
  ) {
    return failure('refused', 'AUTHORITY_POLICY_EXTENSION_NON_ADDITIVE');
  }
  if (!validShadow(input.enforcement, deps.materialized_at))
    return failure('refused', 'AUTHORITY_POLICY_SHADOW_INVALID');
  const sourceBytes = deps.canonicalBytes(core.source_document);
  const additive = extensions.map((extension: AnyRecord) => ({
    extension_id: extension.extension_id,
    extension_version: extension.extension_version,
    digest_sha256: deps.sha256Bytes(deps.canonicalBytes(extension.source_document)),
  }));
  const context = state.contexts.get(record.context_receipt)?.context as AnyRecord;
  const materialization = {
    action_id: 'init bind',
    invocation_id: record.invocation_id,
    machine_principal: {
      kind: 'machine',
      actor: 'binding',
      transition: 'bind',
      trusted_adapter_id: context?.principal?.derivation?.trusted_adapter_id,
      context_digest_sha256: context?.principal?.derivation?.context_digest_sha256,
    },
    initiated_by: {
      kind: 'human',
      role: 'architect',
      declaration_source: record.principal.declaration.source,
      ...(record.principal.declaration.source === 'session-state'
        ? { session_id: record.principal.declaration.session_id }
        : {}),
    },
    consent: { write: true },
  };
  const materializationWithDigest = {
    ...materialization,
    materialization_digest_sha256: deps.canonicalSha256(materialization),
  };
  const raw = {
    schemaVersion: '1.0.0',
    policy_id: 'devai-authority',
    policy_version: deps.package_binding.version,
    repository_id: input.repository_id,
    framework_package: deps.package_binding,
    constitution: deps.constitution_binding,
    source_policy: {
      policy_id: core.policy_id,
      policy_version: core.policy_version,
      digest_sha256: deps.sha256Bytes(sourceBytes),
    },
    additive_extensions: additive,
    resolved_digest_sha256: deps.canonicalSha256(allRules),
    materialized_at: deps.materialized_at,
    materialization: materializationWithDigest,
    enforcement: input.enforcement,
    host_enforcement: input.host_enforcement,
    rules: allRules,
  };
  const validated = deps.validatePolicySchema(raw);
  if (!isRecord(validated) || validated.ok !== true) return validated;
  const document =
    isRecord(validated.value) && isRecord(validated.value.view)
      ? validated.value
      : { raw, canonical_bytes: deps.canonicalBytes(raw), view: raw };
  const bytes =
    document.canonical_bytes instanceof Uint8Array
      ? document.canonical_bytes
      : deps.canonicalBytes(raw);
  return success(
    deepFreeze({
      document,
      artifact: {
        kind: 'fs',
        repository_id: input.repository_id,
        canonical_relative_path: AUTHORITY_POLICY_MATERIALIZED_PATH,
        operation: input.target_operation,
        bytes,
        digest_sha256: deps.sha256Bytes(bytes),
      },
    }),
  );
}
