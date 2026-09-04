import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  withProtectedReleasePrepareCapacity,
  type AuthorityHostEffectScope,
  type ProtectedReleasePrepareCapacityBinding,
} from '@devai-nyx/authority';
import { canonicalSha256 } from '@devai-nyx/utils';
import type { ReleaseLifecycleRequest } from '../../src/services/release-lifecycle-execution.js';

function bindingFor(request: ReleaseLifecycleRequest): ProtectedReleasePrepareCapacityBinding {
  const plan = request.receipt_locators?.find((receipt) => receipt.kind === 'release-plan-receipt');
  if (plan === undefined) throw new Error('test release prepare request lacks its plan receipt');
  return {
    action_id: 'release prepare',
    repository: request.repository_locator,
    candidate: {
      commit: request.candidate_locator.commit,
      tree: request.candidate_locator.tree,
    },
    plan_receipt_digest_sha256: plan.receipt_digest_sha256,
  };
}

/**
 * A genuine live prepare scope for lifecycle tests. The account is charged by
 * each host effect on this issuer; no request callback supplies a budget.
 * `executeReleaseLifecycleAction` installs its own capacity sequence, so its
 * callers use the default mode. Direct kernel tests opt into `wrap_capacity`.
 */
export async function withReleasePrepareAuthorityFixture<T>(
  request: ReleaseLifecycleRequest,
  callback: () => Promise<T>,
  options: Readonly<{ wrap_capacity?: boolean }> = {},
): Promise<T> {
  const binding = bindingFor(request);
  let ordinal = 0;
  let appliedBatches = 0;
  let appliedTargets = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'release-prepare-test-authority',
    issuer_version: '1.0.0',
    invocation_id: 'release-prepare-test-invocation',
    canonicalSha256,
    randomId: () => `release-prepare-test-authority-${String(++ordinal)}`,
    now: () => '2026-09-03T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'release prepare',
    invocation_id: 'release-prepare-test-invocation',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => {
      if (appliedBatches >= 256 || appliedTargets >= 8192) {
        throw new Error('release-prepare-capacity-unavailable');
      }
      appliedBatches += 1;
      appliedTargets += 1;
      return apply();
    },
    read_prepare_capacity: (selected) => {
      if (canonicalSha256(selected) !== canonicalSha256(binding)) {
        throw new Error('release-prepare-capacity-unavailable');
      }
      return {
        remaining_batches: 256 - appliedBatches,
        remaining_targets: 8192 - appliedTargets,
      };
    },
  };
  try {
    return await runWithAuthorityHostEffects(scope, () =>
      options.wrap_capacity === true
        ? withProtectedReleasePrepareCapacity(binding, callback)
        : callback(),
    );
  } finally {
    issuer.dispose();
  }
}
