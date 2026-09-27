import type { RegistryEntry } from '../define-command.js';
import {
  authorityBindings,
  subjectGroups,
  POLICY_VERSION,
  canonicalBytes,
  sha256Bytes,
  canonicalSha256,
} from './policy-support.js';
import { buildCoreAuthorityRules } from './policy-core-rules.js';
import { buildAdditiveAuthorityRules } from './policy-additive-rules.js';

export {
  canonicalBytes,
  canonicalSha256,
  sha256Bytes,
  repositoryIdFor,
  authorityBindings,
} from './policy-support.js';

export function buildTrustedAuthoritySources(
  entries: readonly RegistryEntry[],
  root: string,
  packageVersion: string,
  installedConstitutionText?: string,
) {
  const bindings = authorityBindings(root, packageVersion, installedConstitutionText);
  const repositoryId = bindings.repository_id;
  const groups = subjectGroups(entries);
  const human = (role: string) => [{ kind: 'human', roles: [role] }];
  const joint = [{ kind: 'human', roles: ['owner', 'architect'] }];
  const coreRules = buildCoreAuthorityRules({ entries, human, groups, repositoryId, joint });

  const additiveRules = buildAdditiveAuthorityRules({ repositoryId, groups, human });

  const sourceDocument = {
    policy_id: 'devai-core-authority',
    policy_version: POLICY_VERSION,
    rules: coreRules,
  };
  const extensionDocument = {
    extension_id: 'devai-adopter-authority',
    extension_version: POLICY_VERSION,
    rules: additiveRules,
  };
  const immutableCore = {
    policy_id: 'devai-core-authority',
    policy_version: POLICY_VERSION,
    source_document: sourceDocument,
    canonical_source_bytes: canonicalBytes(sourceDocument),
    rules: coreRules,
  };
  const additiveExtensions = [
    {
      extension_id: 'devai-adopter-authority',
      extension_version: POLICY_VERSION,
      source_document: extensionDocument,
      canonical_source_bytes: canonicalBytes(extensionDocument),
      rules: additiveRules,
    },
  ];
  const rules = [...coreRules, ...additiveRules];
  const provenance = {
    policy_id: 'devai-authority',
    policy_version: packageVersion,
    repository_id: repositoryId,
    framework_package: bindings.package_binding,
    constitution: bindings.constitution_binding,
    source_policy: {
      policy_id: 'devai-core-authority',
      policy_version: POLICY_VERSION,
      digest_sha256: sha256Bytes(canonicalBytes(sourceDocument)),
    },
    additive_extensions: [
      {
        extension_id: 'devai-adopter-authority',
        extension_version: POLICY_VERSION,
        digest_sha256: sha256Bytes(canonicalBytes(extensionDocument)),
      },
    ],
    resolved_digest_sha256: canonicalSha256(rules),
    materialized_from: { kind: 'project-config', path: '.devai/config/authority-policy.json' },
  };
  return {
    ...bindings,
    immutableCore,
    additiveExtensions,
    rules,
    provenance,
    virtualPolicy: {
      document: { raw: { rules }, canonical_bytes: canonicalBytes({ rules }), view: { rules } },
      provenance,
      resolved_rule_bytes: canonicalBytes(rules),
    },
  };
}
