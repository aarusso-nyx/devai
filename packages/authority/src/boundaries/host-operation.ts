import type { ProtectedReleaseRepositoryIdentity } from './release-repository-identity.js';
import {
  readProtectedReleaseRepositoryIdentity,
  repositoryIdentityFailure,
} from './host-repository-context.js';
import { scopes, type AuthorityHostEffectScope } from './host-scope.js';
import {
  assertProtectedReleaseExportCapacityEffect,
  assertProtectedReleasePrepareCapacityEffect,
} from './host-capacity.js';

export function currentRepositoryBinding<
  T extends { readonly repository: ProtectedReleaseRepositoryIdentity['repository'] },
>(binding: T): T & ProtectedReleaseRepositoryIdentity {
  const identity = readProtectedReleaseRepositoryIdentity();
  if (
    binding.repository.id !== identity.repository.id ||
    binding.repository.commit !== identity.repository.commit ||
    binding.repository.tree !== identity.repository.tree
  )
    return repositoryIdentityFailure();
  return Object.freeze({ ...binding, ...identity });
}
let protectedOperationSequence = 0;

/** Advances the process-wide protected operation counter shared by every adapter. */
export function nextProtectedOperationSequence(): number {
  protectedOperationSequence += 1;
  return protectedOperationSequence;
}

export function requireScope(mode: 'mutation' | 'process'): AuthorityHostEffectScope {
  const scope = scopes.getStore();
  if (!scope) {
    throw new Error('AUTHORITY_FINAL_BOUNDARY_REQUIRED');
  }
  assertProtectedReleasePrepareCapacityEffect(scope.receipt_store);
  assertProtectedReleaseExportCapacityEffect(scope.receipt_store);
  if (mode === 'mutation' && scope.effect === 'read') {
    throw new Error('AUTHORITY_READ_ACTION_MUTATION_FORBIDDEN');
  }
  return scope;
}
