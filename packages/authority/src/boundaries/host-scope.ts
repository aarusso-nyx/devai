import { AsyncLocalStorage } from 'node:async_hooks';
import { issuerState } from '../runtime/contracts.js';
import type { AuthorityHostEffectRequest } from './host-atomic-effects.js';

/**
 * The sole raw host-effect seam for DEVAI's supported CLI runtime.
 *
 * Every mutating import is routed here, and production calls require the
 * one-shot action scope installed by the CLI authority boundary. Read-only
 * filesystem functions remain ordinary reads. There is deliberately no test
 * or environment bypass: tests exercise the same final boundary as production.
 */
export interface AuthorityHostEffectScope {
  readonly action_id: string;
  readonly invocation_id: string;
  readonly effect: 'read' | 'harness-write' | 'local-write' | 'remote-write';
  readonly receipt_store: object;
  readonly apply_effect: (request: AuthorityHostEffectRequest, apply: () => unknown) => unknown;
  /** Installed by the prepare broker only; reads its existing bounded-plan account. */
  readonly read_prepare_capacity?: (
    binding: ProtectedReleasePrepareCapacityBinding,
  ) => ProtectedReleasePrepareCapacity;
  /** Separate export account; no prepare allowance is transferable to this action. */
  readonly read_export_capacity?: (
    binding: ProtectedReleaseExportCapacityBinding,
  ) => ProtectedReleaseExportCapacity;
}

export const scopes = new AsyncLocalStorage<AuthorityHostEffectScope>();

export interface ProtectedReleasePrepareCapacityBinding {
  readonly action_id: 'release prepare';
  readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly plan_receipt_digest_sha256: string;
}

export interface ProtectedReleasePrepareCapacity {
  readonly remaining_batches: number;
  readonly remaining_targets: number;
}

export interface ProtectedReleaseExportCapacityBinding {
  readonly action_id: 'release export';
  readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly plan_receipt_digest_sha256: string;
}

export interface ProtectedReleaseExportCapacity {
  readonly remaining_batches: number;
  readonly remaining_targets: number;
}

export function runWithAuthorityHostEffects<T>(
  scope: AuthorityHostEffectScope,
  callback: () => T,
): T {
  if (
    scope.action_id.length === 0 ||
    scope.invocation_id.length === 0 ||
    typeof scope.apply_effect !== 'function' ||
    !issuerState(scope.receipt_store) ||
    issuerState(scope.receipt_store)?.closed === true ||
    issuerState(scope.receipt_store)?.invocation_id !== scope.invocation_id
  ) {
    throw new Error('AUTHORITY_HOST_SCOPE_INVALID');
  }
  return scopes.run(Object.freeze({ ...scope }), callback);
}
