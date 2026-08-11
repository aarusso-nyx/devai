import {
  deepFreeze,
  equal,
  failure,
  isRecord,
  success,
  validInstant,
  type AnyRecord,
} from './contracts.js';
import { AUTHORITY_POLICY_MATERIALIZED_PATH } from '../paths.js';

type SemVer = { core: string[]; pre: string[] | null };

function semver(value: unknown): SemVer | undefined {
  if (typeof value !== 'string') return undefined;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match) return undefined;
  if (match[1] === undefined || match[2] === undefined || match[3] === undefined) return undefined;
  const pre = match[4]?.split('.') ?? null;
  if (pre?.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))
    return undefined;
  return { core: [match[1], match[2], match[3]], pre };
}

function decimalCompare(a: string, b: string): number {
  const aa = a.replace(/^0+/, '') || '0';
  const bb = b.replace(/^0+/, '') || '0';
  return aa.length === bb.length
    ? aa < bb
      ? -1
      : aa > bb
        ? 1
        : 0
    : aa.length < bb.length
      ? -1
      : 1;
}

function compareVersion(a: string, b: string): number {
  const left = semver(a);
  const right = semver(b);
  if (!left || !right) throw new Error('invalid trusted SemVer dependency');
  for (let index = 0; index < 3; index += 1) {
    const leftCore = left.core[index];
    const rightCore = right.core[index];
    if (leftCore === undefined || rightCore === undefined)
      throw new Error('invalid trusted SemVer dependency');
    const result = decimalCompare(leftCore, rightCore);
    if (result !== 0) return result;
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    if (left.pre[index] === undefined) return -1;
    if (right.pre[index] === undefined) return 1;
    const leftPart = left.pre[index];
    const rightPart = right.pre[index];
    if (leftPart === undefined || rightPart === undefined)
      throw new Error('invalid trusted SemVer dependency');
    const aNumeric = /^\d+$/.test(leftPart);
    const bNumeric = /^\d+$/.test(rightPart);
    if (aNumeric && bNumeric) {
      const result = decimalCompare(leftPart, rightPart);
      if (result !== 0) return result;
    } else if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    else if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function bytesEqual(a: unknown, b: unknown): boolean {
  return (
    a instanceof Uint8Array &&
    b instanceof Uint8Array &&
    a.length === b.length &&
    a.every((v, i) => v === b[i])
  );
}

function semanticInvalid(document: AnyRecord, now: string): boolean {
  const versions = [
    document.policy_version,
    document.framework_package?.version,
    document.source_policy?.policy_version,
    ...(Array.isArray(document.additive_extensions)
      ? document.additive_extensions.map((extension: AnyRecord) => extension?.extension_version)
      : []),
  ];
  if (versions.some((version) => !semver(version))) return true;
  if (
    !validInstant(document.materialized_at) ||
    Date.parse(document.materialized_at) > Date.parse(now)
  )
    return true;
  if (document.enforcement?.mode === 'shadow') {
    const expiry = document.enforcement.shadow?.expires_at;
    if (!validInstant(expiry) || Date.parse(expiry) <= Date.parse(document.materialized_at))
      return true;
  }
  return false;
}

export function loadAuthorityPolicy(input: unknown, deps: unknown) {
  if (!isRecord(input) || !isRecord(deps))
    return failure('refused', 'AUTHORITY_POLICY_SCHEMA_INVALID');
  if (input.document === undefined) return failure('refused', 'AUTHORITY_POLICY_MISSING');
  if (!isRecord(input.document)) return failure('refused', 'AUTHORITY_POLICY_SCHEMA_INVALID');
  const document = input.document;
  if (semanticInvalid(document, deps.now))
    return failure('refused', 'AUTHORITY_POLICY_SEMANTIC_INVALID');
  const validated = deps.validatePolicySchema(input.document);
  if (!isRecord(validated) || validated.ok !== true) return validated;
  const validatedDocument =
    isRecord(validated.value) && isRecord(validated.value.view)
      ? validated.value
      : {
          raw: input.document,
          canonical_bytes: deps.canonicalBytes(input.document),
          view: input.document,
        };
  const view = validatedDocument.view as AnyRecord;
  if (semanticInvalid(view, deps.now))
    return failure('refused', 'AUTHORITY_POLICY_SEMANTIC_INVALID');

  const core = deps.immutableCore;
  const extensions = deps.additiveExtensions;
  if (!isRecord(core) || !Array.isArray(extensions) || !Array.isArray(core.rules)) {
    return failure('refused', 'AUTHORITY_POLICY_SOURCE_RULE_MISMATCH');
  }
  const coreBytes = deps.canonicalBytes(core.source_document);
  if (
    core.policy_id !== 'devai-core-authority' ||
    !semver(core.policy_version) ||
    !bytesEqual(coreBytes, core.canonical_source_bytes) ||
    !equal(core.source_document?.rules, core.rules)
  )
    return failure('refused', 'AUTHORITY_POLICY_SOURCE_RULE_MISMATCH');
  for (const extension of extensions) {
    if (
      !isRecord(extension) ||
      !Array.isArray(extension.rules) ||
      !semver(extension.extension_version)
    ) {
      return failure('refused', 'AUTHORITY_POLICY_SOURCE_RULE_MISMATCH');
    }
    if (
      !bytesEqual(
        deps.canonicalBytes(extension.source_document),
        extension.canonical_source_bytes,
      ) ||
      !equal(extension.source_document?.rules, extension.rules)
    ) {
      return failure('refused', 'AUTHORITY_POLICY_SOURCE_RULE_MISMATCH');
    }
  }
  const coreIds = new Map(core.rules.map((rule: AnyRecord) => [rule.rule_id, rule]));
  const extensionRules = extensions.flatMap((extension: AnyRecord) => extension.rules);
  if (
    extensionRules.some(
      (rule: AnyRecord) => rule.origin !== 'additive-extension' || coreIds.has(rule.rule_id),
    )
  ) {
    return failure('refused', 'AUTHORITY_POLICY_EXTENSION_NON_ADDITIVE');
  }
  const rules = [...core.rules, ...extensionRules];
  const resolvedBytes = deps.canonicalBytes(rules);
  if (!bytesEqual(resolvedBytes, deps.canonicalBytes(view.rules))) {
    return failure('refused', 'AUTHORITY_POLICY_RESOLVED_BYTES_MISMATCH');
  }
  const sourceDigest = deps.sha256Bytes(coreBytes);
  const extensionDigests = extensions.map((extension: AnyRecord) =>
    deps.sha256Bytes(deps.canonicalBytes(extension.source_document)),
  );
  const resolvedDigest = deps.canonicalSha256(rules);
  if (
    view.source_policy?.digest_sha256 !== sourceDigest ||
    !Array.isArray(view.additive_extensions) ||
    view.additive_extensions.length !== extensions.length ||
    view.additive_extensions.some(
      (extension: AnyRecord, index: number) => extension.digest_sha256 !== extensionDigests[index],
    ) ||
    view.resolved_digest_sha256 !== resolvedDigest
  )
    return failure('refused', 'AUTHORITY_POLICY_DIGEST_MISMATCH');
  if (
    view.repository_id !== deps.expected_repository_id ||
    view.policy_id !== deps.expected_policy_id ||
    !equal(view.framework_package, deps.expected_package) ||
    !equal(view.constitution, deps.expected_constitution) ||
    view.source_policy?.policy_id !== core.policy_id ||
    view.source_policy?.policy_version !== core.policy_version ||
    view.additive_extensions.some(
      (item: AnyRecord, index: number) =>
        item.extension_id !== extensions[index].extension_id ||
        item.extension_version !== extensions[index].extension_version,
    )
  )
    return failure('refused', 'AUTHORITY_POLICY_BINDING_MISMATCH');
  if (compareVersion(view.policy_version, deps.expected_minimum_policy_version) < 0) {
    return failure('refused', 'AUTHORITY_POLICY_DOWNGRADE');
  }
  if (
    view.enforcement?.mode === 'shadow' &&
    Date.parse(view.enforcement.shadow.expires_at) <= Date.parse(deps.now)
  ) {
    return failure('refused', 'AUTHORITY_POLICY_STALE');
  }
  const provenance = {
    policy_id: view.policy_id,
    policy_version: view.policy_version,
    repository_id: view.repository_id,
    framework_package: view.framework_package,
    constitution: view.constitution,
    source_policy: { ...view.source_policy, digest_sha256: sourceDigest },
    additive_extensions: view.additive_extensions.map((item: AnyRecord, index: number) => ({
      ...item,
      digest_sha256: extensionDigests[index],
    })),
    resolved_digest_sha256: resolvedDigest,
    materialized_from: { kind: 'project-config', path: AUTHORITY_POLICY_MATERIALIZED_PATH },
  };
  return success(
    deepFreeze({ document: validatedDocument, provenance, resolved_rule_bytes: resolvedBytes }),
  );
}
