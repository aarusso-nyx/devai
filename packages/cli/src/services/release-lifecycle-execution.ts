import {
  withProtectedReleasePrepareCapacity,
  withProtectedReleaseExportCapacity,
} from '@devai-nyx/authority';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ReleaseProviderInvocationContext,
  ReleaseLifecycleRequest,
  ReleaseProviderResult,
  PersistedReleaseAction,
  VerifiedReceipt,
  AuthorizationAttemptBinding,
  TrustedReleaseAuthority,
  ExecuteReleaseResult,
} from './release-lifecycle-execution-types.js';
import {
  validateReleaseLifecycleRequest,
  EFFECT_BY_ACTION,
  computeReleaseRequestDigest,
  primaryCandidate,
} from './release-lifecycle-execution-support.js';
import { verifyBoundReceipts } from './release-lifecycle-execution-receipts.js';
import {
  deriveAttemptId,
  storeRecordReference,
  buildStoreRecord,
} from './release-lifecycle-execution-records.js';
import {
  assertTrustedAuthority,
  authorizationDestination,
  verifyGrantResolution,
} from './release-lifecycle-execution-authorization.js';
import {
  completeReleaseAttempt,
  consumeAttemptAuthorization,
  releaseActionPreconditionFailure,
  type ReleaseGrantProof,
  type ReleaseLifecycleExecutionInput,
} from './release-lifecycle-execution-attempt.js';
import { reconcileReleaseStore } from './release-lifecycle-execution-reconcile.js';
import {
  captureExportProviderResult,
  immutableProviderData,
} from './release-lifecycle-execution-provider-data.js';

export type { ReleaseLifecycleExecutionInput } from './release-lifecycle-execution-attempt.js';

export { resumeReleaseLifecycleExecution } from './release-lifecycle-execution-resume.js';
export {
  readVerifiedReleaseOfflineContext,
  createVerifiedReleaseMutationCheck,
  executeOfflineVerification,
} from './release-lifecycle-execution-offline.js';
export { ReleaseLifecycleFileStore } from './release-lifecycle-execution-file-store.js';
export {
  finalizeReleaseStateV2,
  verifyReleaseStateIdentity,
  finalizeStoreRecord,
  verifyStoreRecordIdentity,
  reduceStoreRecords,
  finalizeStoreHead,
  verifyStoreHeadIdentity,
  reduceReleaseStates,
} from './release-lifecycle-execution-records.js';
export { resolveReleaseMutationRequirements } from './release-lifecycle-execution-receipts.js';
export {
  validateReleaseLifecycleRequest,
  computeReleaseRequestDigest,
  offlineArtifactProjection,
  offlineReleaseUnitsProjection,
} from './release-lifecycle-execution-support.js';
export {
  type ReleaseAction,
  type PersistedReleaseAction,
  type PersistedReleaseState,
  type LegacyArtifactIdentity,
  type OpaqueArtifactIdentity,
  type ArtifactIdentity,
  type ArtifactSinkCommitIdentity,
  type CertificationPackageEntry,
  type GitReleaseBlobLocator,
  type CertificationOutputBlobHandle,
  type CertificationPackageEntryManifest,
  type TrustIdentity,
  type ReleaseLifecycleRequest,
  type PackageEvidence,
  type ReleaseUnitEvidence,
  type ReleaseStateMaterial,
  type TrustedReleaseAuthority,
  type PublicationControls,
  type ReleaseLifecycleStateV2,
  type StateReference,
  type StateStorageHead,
  type StoreHead,
  type StoreRecord,
  type ReleaseProviderResult,
  type ReleaseProvider,
  type ReleaseProviderInvocationContext,
  type TrustedArtifactReader,
  type OfflineVerificationProvider,
  type VerifiedReleaseOfflineContext,
  type ReleasePlanInputResolver,
  type TrustedOfflineReceiptVerifier,
  type AuthorizationResolution,
  type AuthorizationConsumptionProof,
  type AuthorizationBridge,
  type AuthorizationAttemptBinding,
  type ReceiptResolver,
  type ReleaseMutationRequirement,
  type StoreReduction,
  type ExecuteReleaseResult,
  type OfflineVerificationResult,
  type StateReduction,
  type PublicationSignatureVerifier,
  RELEASE_ACTIONS,
} from './release-lifecycle-execution-types.js';

const providerInvocationScope = new AsyncLocalStorage<ReleaseProviderInvocationContext>();
const liveProviderInvocations = new WeakMap<object, ReleaseLifecycleRequest>();

/** Requires the actual request argument and context issued to this provider call. */
export function assertReleaseProviderInvocationContext(
  request: ReleaseLifecycleRequest,
  value: unknown,
): ReleaseProviderInvocationContext {
  if (
    value === null ||
    typeof value !== 'object' ||
    providerInvocationScope.getStore() !== value ||
    liveProviderInvocations.get(value) !== request
  ) {
    throw new Error('release-provider-invocation-unbound');
  }
  return value as ReleaseProviderInvocationContext;
}

/**
 * Execute exactly one persisted lifecycle action. All authority and producer
 * effects are injected. The core owns identities, append ordering, and state.
 */
export async function executeReleaseLifecycleAction(
  input: ReleaseLifecycleExecutionInput,
): Promise<ExecuteReleaseResult> {
  let request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction };
  let authority: TrustedReleaseAuthority;
  let receipts: readonly VerifiedReceipt[];
  try {
    request = immutableProviderData(
      validateReleaseLifecycleRequest(input.request, input.action),
    ) as ReleaseLifecycleRequest & {
      readonly action_id: PersistedReleaseAction;
    };
  } catch (error) {
    return {
      ok: false,
      phase: 'validation',
      code: error instanceof Error ? error.message : 'release-request-projection-invalid',
    };
  }
  try {
    authority = assertTrustedAuthority(request.action_id, input.authority);
    receipts = verifyBoundReceipts(request, input.resolveReceipt, input.resolvePlanInput);
  } catch (error) {
    return {
      ok: false,
      phase: 'validation',
      code: error instanceof Error ? error.message : 'release-receipt-identity-mismatch',
    };
  }
  const remote = EFFECT_BY_ACTION[request.action_id] === 'remote-write';
  const potentiallyIrreversible = remote || request.action_id === 'release export';
  const precondition = releaseActionPreconditionFailure(input, request, remote);
  if (precondition !== undefined) return precondition;
  try {
    const execute = () =>
      input.store.withExecutionLock<ExecuteReleaseResult>(async () => {
        const reconciled = await reconcileReleaseStore(input, request, receipts);
        if (!reconciled.ok) return reconciled;
        const { storeRecords, states, head, verifiedPriorState } = reconciled;

        const priorRecord = storeRecords.at(-1) ?? null;
        const nextSequence = priorRecord === null ? 0 : priorRecord.sequence + 1;
        const requestDigest = computeReleaseRequestDigest(request);
        const attemptId = deriveAttemptId({
          request_digest_sha256: requestDigest,
          action_id: request.action_id,
          sequence: nextSequence,
          predecessor_record: priorRecord === null ? null : storeRecordReference(priorRecord),
        });
        let authorizationEventId: string | null = null;
        let binding: AuthorizationAttemptBinding | undefined;
        let grantProof: ReleaseGrantProof | undefined;
        if (remote) {
          binding = {
            attempt_id: attemptId,
            action_id: request.action_id,
            request_digest_sha256: requestDigest,
            repository: request.repository_locator,
            candidate: primaryCandidate(request),
            destination: authorizationDestination(request),
          };
          try {
            const resolution = await input.authorization?.resolve(binding);
            if (resolution === undefined)
              throw new Error('release-authorization-provider-unavailable');
            grantProof = verifyGrantResolution(resolution, binding, authority, input.recorded_at);
            authorizationEventId = grantProof.grant_event_id;
            if (
              priorRecord?.record_kind === 'failure' &&
              priorRecord.authorization_event_id === authorizationEventId
            ) {
              throw new Error('fresh-exact-authorization-required');
            }
          } catch (error) {
            return {
              ok: false,
              phase: 'authorization',
              code:
                error instanceof Error
                  ? error.message
                  : 'release-authorization-attempt-binding-invalid',
            };
          }
        }
        if (input.provider === undefined) {
          return { ok: false, phase: 'provider', code: 'release-provider-unavailable' };
        }
        const provider = input.provider;
        const attempt = buildStoreRecord(
          request,
          priorRecord,
          head,
          attemptId,
          'attempt',
          authorizationEventId,
        );
        try {
          input.store.appendStoreRecord(attempt);
        } catch (error) {
          return {
            ok: false,
            phase: 'append',
            code: error instanceof Error ? error.message : 'release-state-store-unsafe',
          };
        }

        if (remote && binding !== undefined && authorizationEventId !== null) {
          const refused = await consumeAttemptAuthorization({
            input,
            request,
            authority,
            binding,
            grantProof,
            authorizationEventId,
            attempt,
            head,
            attemptId,
          });
          if (refused !== undefined) return refused;
        }

        let result: ReleaseProviderResult;
        try {
          const context = immutableProviderData<ReleaseProviderInvocationContext>({
            action_id: request.action_id,
            request_digest_sha256: requestDigest,
            attempt_id: attemptId,
            attempt_record: storeRecordReference(attempt),
            prior_state: verifiedPriorState,
          });
          liveProviderInvocations.set(context, request);
          try {
            const supplied = await providerInvocationScope.run(context, () =>
              provider(request, context),
            );
            result =
              request.action_id === 'release export'
                ? captureExportProviderResult(supplied)
                : supplied;
          } finally {
            liveProviderInvocations.delete(context);
          }
        } catch {
          // Export may have crossed its one-use signer boundary before throwing.
          // Only a managed provider can positively report failure before signing.
          result = potentiallyIrreversible
            ? { outcome: 'unknown', code: 'release-provider-result-unknown' }
            : { outcome: 'failure', code: 'release-provider-failed' };
        }
        if (result.outcome !== 'success') {
          const unsafeFailure =
            potentiallyIrreversible &&
            result.outcome === 'failure' &&
            (result.provider_handle !== undefined ||
              result.dispatch_status !== 'failed-before-dispatch');
          const terminalResult = unsafeFailure
            ? ({ ...result, outcome: 'unknown', code: 'release-provider-result-unknown' } as const)
            : result;
          if (!remote && terminalResult.outcome !== 'unknown' && result.transaction !== undefined) {
            try {
              await result.transaction.rollback();
            } finally {
              await result.transaction.dispose();
            }
          }
          const kind = terminalResult.outcome === 'unknown' ? 'unknown-provider-result' : 'failure';
          const terminal = buildStoreRecord(
            request,
            attempt,
            head,
            attemptId,
            kind,
            authorizationEventId,
            terminalResult,
          );
          input.store.appendStoreRecord(terminal);
          return {
            ok: false,
            phase: terminalResult.outcome === 'unknown' ? 'ambiguous' : 'provider',
            code:
              terminalResult.outcome === 'unknown'
                ? 'release-provider-result-unknown'
                : (terminalResult.code ?? 'release-provider-failed'),
            record: terminal,
          };
        }
        if (remote && result.provider_handle === undefined) {
          const unknown = buildStoreRecord(
            request,
            attempt,
            head,
            attemptId,
            'unknown-provider-result',
            authorizationEventId,
            { outcome: 'unknown', code: 'release-provider-result-unknown' },
          );
          input.store.appendStoreRecord(unknown);
          return {
            ok: false,
            phase: 'ambiguous',
            code: 'release-provider-handle-observation-invalid',
            record: unknown,
          };
        }
        if (remote && result.transaction !== undefined) {
          const unknown = buildStoreRecord(
            request,
            attempt,
            head,
            attemptId,
            'unknown-provider-result',
            authorizationEventId,
            { outcome: 'unknown', code: 'release-provider-result-unknown' },
          );
          input.store.appendStoreRecord(unknown);
          return {
            ok: false,
            phase: 'ambiguous',
            code: 'release-adapter-output-invalid',
            record: unknown,
          };
        }
        if (result.material === undefined) {
          if (!potentiallyIrreversible && result.transaction !== undefined) {
            try {
              await result.transaction.rollback();
            } finally {
              await result.transaction.dispose();
            }
          }
          const terminal = buildStoreRecord(
            request,
            attempt,
            head,
            attemptId,
            potentiallyIrreversible ? 'unknown-provider-result' : 'failure',
            authorizationEventId,
            potentiallyIrreversible
              ? { ...result, outcome: 'unknown', code: 'release-provider-result-unknown' }
              : { ...result, outcome: 'failure', code: 'release-adapter-output-invalid' },
          );
          input.store.appendStoreRecord(terminal);
          return {
            ok: false,
            phase: potentiallyIrreversible ? 'ambiguous' : 'validation',
            code: potentiallyIrreversible
              ? 'release-provider-result-unknown'
              : 'release-adapter-output-invalid',
            record: terminal,
          };
        }

        return await completeReleaseAttempt({
          input,
          request,
          authority,
          result,
          material: result.material,
          states,
          authorizationEventId,
          attempt,
          head,
          attemptId,
          potentiallyIrreversible,
        });
      });
    if (request.action_id !== 'release prepare' && request.action_id !== 'release export')
      return await execute();
    const plan = receipts.find((receipt) => receipt.kind === 'release-plan-receipt');
    if (plan === undefined || typeof plan.value['receipt_digest_sha256'] !== 'string')
      throw new Error(
        request.action_id === 'release export'
          ? 'release-export-capacity-unavailable'
          : 'release-prepare-capacity-unavailable',
      );
    const capacityBinding = {
      repository: request.repository_locator,
      candidate: {
        commit: request.candidate_locator.commit,
        tree: request.candidate_locator.tree,
      },
      plan_receipt_digest_sha256: plan.value['receipt_digest_sha256'],
    };
    return request.action_id === 'release export'
      ? await withProtectedReleaseExportCapacity(
          { ...capacityBinding, action_id: 'release export' },
          execute,
        )
      : await withProtectedReleasePrepareCapacity(
          { ...capacityBinding, action_id: 'release prepare' },
          execute,
        );
  } catch (error) {
    return {
      ok: false,
      phase: 'reconciliation',
      code: error instanceof Error ? error.message : 'release-state-store-unsafe',
    };
  }
}
