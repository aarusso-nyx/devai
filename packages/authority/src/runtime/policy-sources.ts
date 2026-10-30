import { buildCoreAuthorityRules } from './policy-core-rules.js';
import { buildAdditiveAuthorityRules } from './policy-additive-rules.js';
import {
  subjectGroups,
  POLICY_VERSION,
  canonicalBytes,
  sha256Bytes,
  canonicalSha256,
  type PolicyBindings,
  type PolicyRegistryEntry,
} from './policy-construction.js';
import type { BoundAdopterAuthorityExtension } from './policy-adopter-extension.js';
import type {
  DocumentationImplementationProvenance,
  documentationImplementationRules,
} from '../documentation-implementation.js';

export interface PolicyDocumentationSource {
  readonly files: readonly string[];
  readonly rules: ReturnType<typeof documentationImplementationRules>;
  readonly provenance: DocumentationImplementationProvenance;
}

export function prepareAuthoritySourceRules(
  entries: readonly PolicyRegistryEntry[],
  bindings: PolicyBindings,
  documentation: PolicyDocumentationSource | undefined,
  groups = subjectGroups(entries),
) {
  const repositoryId = bindings.repository_id;
  const human = (role: string) => [{ kind: 'human', roles: [role] }];
  const joint = [{ kind: 'human', roles: ['owner', 'architect'] }];
  const coreRules = [
    ...buildCoreAuthorityRules({ entries, human, groups, repositoryId, joint }),
    ...(documentation?.rules ?? []),
  ];
  const additiveRules = buildAdditiveAuthorityRules({ repositoryId, groups, human });
  return { coreRules, additiveRules };
}

export function completeAuthoritySources(input: {
  readonly bindings: PolicyBindings;
  readonly documentation: PolicyDocumentationSource | undefined;
  readonly prepared: ReturnType<typeof prepareAuthoritySourceRules>;
  readonly adopter: BoundAdopterAuthorityExtension;
}) {
  const { bindings, documentation, adopter } = input;
  const { coreRules, additiveRules } = input.prepared;
  const repositoryId = bindings.repository_id;
  const packageVersion = bindings.package_binding.version;
  const adopterExtension = adopter.status === 'compiled' ? adopter.extension : undefined;
  const adopterRules = adopterExtension?.rules ?? [];
  const sourceDocument = {
    policy_id: 'devai-core-authority',
    policy_version: POLICY_VERSION,
    ...(documentation === undefined
      ? {}
      : {
          documentation_implementation: {
            files: documentation.files,
            provenance: documentation.provenance,
          },
        }),
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
