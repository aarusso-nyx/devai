/** Proposed exact candidate capability; current released constitutions remain refused. */
import {
  documentationImplementationFiles,
  documentationImplementationRules,
  SUPPORTED_DOCUMENTATION_IMPLEMENTATION_CONSTITUTIONS,
} from '@devai-nyx/authority';
import { classWriteVerbs } from './policy-support.js';
import type { RegistryEntry } from '../define-command.js';

interface ConstitutionIdentity {
  readonly version: string;
  readonly digest_sha256: string;
}

function refuse(detail: string): never {
  throw new Error(`DOCUMENTATION_IMPLEMENTATION_INVALID:${detail}`);
}

/**
 * Pure core compiler; the resolver binds its complete source, and the policy loader
 * verifies its materialized rules before a classification handle can be issued.
 */
export function compileDocumentationImplementationRules(input: {
  readonly block: unknown;
  readonly constitution: ConstitutionIdentity;
  readonly repositoryId: string;
  readonly entries: readonly RegistryEntry[];
}) {
  // Absence does not consult the new gate and leaves existing no-block results unchanged.
  if (input.block === undefined) return undefined;
  if (
    !SUPPORTED_DOCUMENTATION_IMPLEMENTATION_CONSTITUTIONS.some(
      (accepted) =>
        accepted.version === input.constitution.version &&
        accepted.digest_sha256 === input.constitution.digest_sha256,
    )
  ) {
    throw new Error('DOCUMENTATION_IMPLEMENTATION_CONSTITUTION_UNSUPPORTED');
  }
  const files = documentationImplementationFiles(input.block);
  const verbs = classWriteVerbs(input.entries).root;
  // Never drop a selected class and accidentally restore the enclosing Architect grant.
  if (verbs.length === 0) return refuse('registered Engineer write verbs unavailable');
  const rules = documentationImplementationRules(files, input.repositoryId, verbs);
  return { files, rules };
}
