import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import {
  executeAuthorizedEffect,
  type EffectAuthorizationEvent,
  type EffectAuthorizationEventResolver,
  type EffectAuthorizationGrantRequest,
  type EffectAuthorizationLedger,
} from '@devai-nyx/authority';
import type { ReleaseLifecycleStateRecord, ReleaseTransitionResult } from './types.js';
import { same } from './receipts.js';
import { reduceReleaseLifecycle } from './reducer.js';
export { resumeReleaseLifecycle } from './resume.js';
export { reduceReleaseLifecycle } from './reducer.js';
export {
  computeReleaseStateRecordDigest,
  computeReleaseReadReceiptDigest,
  finalizeReleasePlanReceipt,
  finalizeReleaseOfflineVerificationReceipt,
  verifyReleasePlanReceiptIdentity,
  verifyReleaseOfflineReceiptIdentity,
  computePublicationSignedPayloadDigest,
  computePublicationReceiptDigest,
} from './receipts.js';
export type {
  PersistedReleaseState,
  DerivedReleaseState,
  ReleaseIdentity,
  ReleaseCandidateIdentity,
  ReleaseArtifactIdentity,
  ReleaseStateReference,
  ReleaseLifecycleStateRecord,
  PublicationExpectation,
  ReleasePlanReceipt,
  ReleaseOfflineVerificationReceipt,
  ReleasePublicationReceipt,
  ReleaseDerivedReceipt,
  ReleaseLifecycleObservation,
  ReleaseLifecycleError,
  ReleaseLifecycleReduction,
  PublicationSignatureVerifier,
  ReleaseTransitionResult,
} from './types.js';

export function finalizeReleaseLifecycleState(
  draft: Omit<ReleaseLifecycleStateRecord, 'record_digest_sha256'>,
): ReleaseLifecycleStateRecord {
  const record = {
    ...draft,
    record_digest_sha256: canonicalSha256(draft),
  };
  return parsers.releaseLifecycleState.parse<ReleaseLifecycleStateRecord>(record);
}

/**
 * Local/harness transition boundary. The candidate state is fully reduced
 * before the adapter runs, and is appended only after the adapter succeeds.
 */
export async function executeReleaseTransition<T>(input: {
  readonly records: readonly unknown[];
  readonly draft: Omit<ReleaseLifecycleStateRecord, 'record_digest_sha256'>;
  readonly adapter?: () => T | Promise<T>;
  readonly appendState: (state: ReleaseLifecycleStateRecord) => void | Promise<void>;
}): Promise<ReleaseTransitionResult<T>> {
  let state: ReleaseLifecycleStateRecord;
  try {
    state = finalizeReleaseLifecycleState(input.draft);
    const reduction = reduceReleaseLifecycle([...input.records, state]);
    if (!reduction.ok || state.effect === 'remote-write') {
      return {
        ok: false,
        phase: 'validation',
        code: reduction.ok ? 'release-state-effect-mismatch' : reduction.errors.join(','),
      };
    }
  } catch (cause) {
    return { ok: false, phase: 'validation', code: 'release-state-schema-invalid', cause };
  }
  if (input.adapter === undefined) {
    return { ok: false, phase: 'adapter', code: 'release-action-provider-unavailable' };
  }
  let adapterResult: T;
  try {
    adapterResult = await input.adapter();
  } catch (cause) {
    return { ok: false, phase: 'adapter', code: 'release-action-provider-failed', cause };
  }
  try {
    await input.appendState(state);
  } catch (cause) {
    return { ok: false, phase: 'append', code: 'release-state-append-failed', cause };
  }
  return { ok: true, state, adapter_result: adapterResult };
}

function authorizationMatchesReleaseState(
  state: ReleaseLifecycleStateRecord,
  request: EffectAuthorizationGrantRequest,
): boolean {
  const actor = state['actor'];
  if (
    actor === null ||
    typeof actor !== 'object' ||
    !('role' in actor) ||
    state.authorization_event_id !== request.authorization_event_id ||
    state.action_id !== request.action_id ||
    state.effect !== request.effect ||
    !same(state.repository, request.repository) ||
    !same(state.candidate, request.candidate) ||
    !same(state['consent'], request.consent) ||
    actor.role !== request.subject_role
  )
    return false;
  const expectation = state.publication_expectation;
  return (
    expectation === null ||
    (expectation.authorization_event_id === request.authorization_event_id &&
      request.resource.kind === 'remote' &&
      request.resource.system_id === expectation.destination.system_id &&
      request.resource.exact_identifier === expectation.destination.exact_identifier &&
      same(request.resource.operations, [expectation.destination.operation]))
  );
}

/**
 * Remote transition boundary. Exact one-time authorization is consumed before
 * the adapter is entered. No missing, stale, replayed, or mismatched grant can
 * reach the adapter, and state advances only after the protected adapter
 * returns successfully.
 */
export async function executeAuthorizedReleaseTransition<T>(input: {
  readonly records: readonly unknown[];
  readonly draft: Omit<ReleaseLifecycleStateRecord, 'record_digest_sha256'>;
  readonly authorizationLedger: unknown;
  readonly resolveAuthorizationEvent: EffectAuthorizationEventResolver;
  readonly authorizationRequest: EffectAuthorizationGrantRequest;
  readonly appendAuthorizationConsumption: (
    event: EffectAuthorizationEvent,
    ledger: EffectAuthorizationLedger,
  ) => void | Promise<void>;
  readonly adapter?: () => T | Promise<T>;
  readonly appendState: (state: ReleaseLifecycleStateRecord) => void | Promise<void>;
}): Promise<ReleaseTransitionResult<T>> {
  let state: ReleaseLifecycleStateRecord;
  try {
    state = finalizeReleaseLifecycleState(input.draft);
    const reduction = reduceReleaseLifecycle([...input.records, state]);
    if (!reduction.ok || state.effect !== 'remote-write') {
      return {
        ok: false,
        phase: 'validation',
        code: reduction.ok ? 'release-state-effect-mismatch' : reduction.errors.join(','),
      };
    }
  } catch (cause) {
    return { ok: false, phase: 'validation', code: 'release-state-schema-invalid', cause };
  }
  if (!authorizationMatchesReleaseState(state, input.authorizationRequest)) {
    return { ok: false, phase: 'validation', code: 'release-state-authorization-mismatch' };
  }
  if (input.adapter === undefined) {
    return { ok: false, phase: 'adapter', code: 'release-action-provider-unavailable' };
  }
  const authorized = await executeAuthorizedEffect({
    ledger: input.authorizationLedger,
    resolveEvent: input.resolveAuthorizationEvent,
    request: input.authorizationRequest,
    consumed_by_state_id: state.state_id,
    appendConsumption: input.appendAuthorizationConsumption,
    adapter: input.adapter,
  });
  if (!authorized.ok) {
    return {
      ok: false,
      phase: authorized.phase === 'authorization' ? 'authorization' : 'adapter',
      code: authorized.code,
      ...(authorized.cause === undefined ? {} : { cause: authorized.cause }),
    };
  }
  try {
    await input.appendState(state);
  } catch (cause) {
    return { ok: false, phase: 'append', code: 'release-state-append-failed', cause };
  }
  return { ok: true, state, adapter_result: authorized.value };
}
