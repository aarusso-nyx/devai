import { documentationContextMatchesPolicy } from './documentation-context.js';
import { validateAuthorityPolicyIntegrity } from './policy-integrity.js';
import { failure, isRecord, success } from './contracts.js';

export function loadAuthorityPolicy(input: unknown, deps: unknown) {
  const result = validateAuthorityPolicyIntegrity(input, deps);
  if (!isRecord(result) || result.ok !== true) return result;
  const { policy, documentation, specializedRules } = result.value;
  if (documentation !== undefined || specializedRules) {
    if (
      !isRecord(input) ||
      !isRecord(deps) ||
      !isRecord(documentation) ||
      !documentationContextMatchesPolicy(
        deps.documentationContext,
        input.document,
        documentation.files,
      )
    ) {
      return failure('refused', 'DOCUMENTATION_IMPLEMENTATION_CONTEXT_BINDING_MISMATCH');
    }
  }
  return success(policy);
}
