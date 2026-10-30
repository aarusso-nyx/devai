import { resolveDocumentationBinding } from './documentation-binding.js';
import type { RegistryEntry } from '../define-command.js';
import {
  authorityBindings,
  prospectiveAuthorityBindings,
  classWriteVerbs,
  subjectGroups,
} from './policy-support.js';
import { prepareAuthoritySourceRules, completeAuthoritySources } from '@devai-nyx/authority';
import { resolveBoundAdopterAuthorityExtension } from './policy-adopter-extension.js';

export {
  canonicalBytes,
  canonicalSha256,
  sha256Bytes,
  repositoryIdFor,
  authorityBindings,
} from './policy-support.js';

function buildSources(
  entries: readonly RegistryEntry[],
  root: string,
  packageVersion: string,
  installedConstitutionText?: string,
  documentationMode: 'ordinary' | 'materialization' | 'bootstrap' = 'ordinary',
) {
  return buildFromBindings(
    entries,
    root,
    packageVersion,
    authorityBindings(root, packageVersion, installedConstitutionText),
    documentationMode,
  );
}

export function buildProspectiveAuthoritySources(
  entries: readonly RegistryEntry[],
  root: string,
  packageVersion: string,
) {
  const projection = prospectiveAuthorityBindings(root, packageVersion);
  return {
    ...projection,
    sources: buildFromBindings(entries, root, packageVersion, projection.bindings),
  };
}

function buildFromBindings(
  entries: readonly RegistryEntry[],
  root: string,
  packageVersion: string,
  bindings: ReturnType<typeof authorityBindings>,
  documentationMode: 'ordinary' | 'materialization' | 'bootstrap' = 'ordinary',
) {
  const repositoryId = bindings.repository_id;
  const groups = subjectGroups(entries);
  const documentation =
    documentationMode === 'bootstrap'
      ? undefined
      : resolveDocumentationBinding(
          { root, bindings, entries },
          documentationMode === 'materialization',
        );
  const prepared = prepareAuthoritySourceRules(entries, bindings, documentation, groups);
  // ADR-AUT-0003: the adopter extension the binding receipt names, compiled from its
  // source on every use so a source edited after binding no longer matches the policy.
  const adopter = resolveBoundAdopterAuthorityExtension({
    root,
    repositoryId,
    constitutionVersion: bindings.constitution_binding.version,
    classWriteVerbs: classWriteVerbs(entries),
  });
  return completeAuthoritySources({ bindings, documentation, prepared, adopter });
}

/** Ordinary writes never consume pending bind state. */
export function buildTrustedAuthoritySources(
  entries: readonly RegistryEntry[],
  root: string,
  packageVersion: string,
  installedConstitutionText?: string,
) {
  return buildSources(entries, root, packageVersion, installedConstitutionText);
}

/** Called only inside the broker's registered init materialization capability. A pending
 * complete receipt contributes rules for materialization, never a verified write handle. */
export function buildMaterializationAuthoritySources(
  entries: readonly RegistryEntry[],
  root: string,
  packageVersion: string,
) {
  return buildSources(entries, root, packageVersion, undefined, 'materialization');
}

/** Recovery bootstrap never carries a documentation implementation grant. */
export function buildBootstrapAuthoritySources(
  entries: readonly RegistryEntry[],
  root: string,
  packageVersion: string,
  installedConstitutionText?: string,
) {
  return buildSources(entries, root, packageVersion, installedConstitutionText, 'bootstrap');
}
