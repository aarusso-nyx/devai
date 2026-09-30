import type { RegistryEntry } from '../define-command.js';
import {
  authorityBindings,
  classWriteVerbs,
  subjectGroups,
  POLICY_VERSION,
  canonicalBytes,
  sha256Bytes,
  canonicalSha256,
} from './policy-support.js';
import { buildCoreAuthorityRules } from './policy-core-rules.js';
import { buildAdditiveAuthorityRules } from './policy-additive-rules.js';
import { resolveBoundAdopterAuthorityExtension } from './policy-adopter-extension.js';

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
  // ADR-AUT-0003: the adopter extension the binding receipt names, compiled from its
  // source on every use so a source edited after binding no longer matches the policy.
  const adopter = resolveBoundAdopterAuthorityExtension({
    root,
    repositoryId,
    constitutionVersion: bindings.constitution_binding.version,
    classWriteVerbs: classWriteVerbs(entries),
  });
  const adopterExtension = adopter.status === 'compiled' ? adopter.extension : undefined;
  const adopterRules = adopterExtension?.rules ?? [];

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
    ...(adopterExtension === undefined
      ? []
      : [
          {
            extension_id: adopterExtension.extension_id,
            extension_version: adopterExtension.extension_version,
            source_document: adopterExtension,
            canonical_source_bytes: canonicalBytes(adopterExtension),
            rules: adopterRules,
          },
        ]),
  ];
  const rules = [...coreRules, ...additiveRules, ...adopterRules];
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
      ...(adopterExtension === undefined
        ? []
        : [
            {
              extension_id: adopterExtension.extension_id,
              extension_version: adopterExtension.extension_version,
              digest_sha256: sha256Bytes(canonicalBytes(adopterExtension)),
            },
          ]),
    ],
    resolved_digest_sha256: canonicalSha256(rules),
    materialized_from: { kind: 'project-config', path: '.devai/config/authority-policy.json' },
  };
  const sources = {
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
  if (adopter.status !== 'refused') return sources;
  // A bound source that is missing, invalid, or drifted since the bind refuses every use of
  // the trusted extensions, so every governed write fails closed with
  // ADOPTER_AUTHORITY_SOURCE_UNAVAILABLE or AUTHORITY_POLICY_DIGEST_MISMATCH until rebind.
  // The bindings, provenance, and bootstrap policy stay readable and grant no adopter rule,
  // so init bind can still report the source's own refusal and Doctor the mismatch.
  const reason = adopter.reason;
  return Object.defineProperty(sources, 'additiveExtensions', {
    enumerable: true,
    get(): typeof additiveExtensions {
      throw new Error(reason);
    },
  });
}
