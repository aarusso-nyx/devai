import {
  withProtectedReleasePrepareCapacity,
  withProtectedReleaseExportCapacity,
} from '@devai-nyx/authority';

import { canonicalJson } from '@devai-nyx/utils';
import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';

import { reverifySinkArtifacts } from './release-prepare-kernel.js';

import type { ReleaseExportTranscriptLimits } from './release-export-transcript.js';
import { isProtectedReleaseCertificationProvider } from './release-lifecycle-certification.js';
import { isProtectedReleasePreflightProvider } from './release-certification-provider.js';

import type {
  ReleaseProviderInvocationContext,
  ReleaseLifecycleRequest,
  ReleaseProviderResult,
  ReleaseLifecycleStateV2,
  PersistedReleaseAction,
  ReleasePlanInputResolver,
  VerifiedReceipt,
  ReceiptResolver,
  StoreRecord,
  StoreHead,
  AuthorizationAttemptBinding,
  TrustedReleaseAuthority,
  PublicationControls,
  AuthorizationLedgerHead,
  ReleaseProvider,
  AuthorizationBridge,
  TrustedOfflineReceiptVerifier,
  TrustedArtifactReader,
  ExecuteReleaseResult,
} from './release-lifecycle-execution-types.js';
import {
  same,
  validateReleaseLifecycleRequest,
  EFFECT_BY_ACTION,
  PRIOR_BY_STATE,
  STATE_BY_ACTION,
  computeReleaseRequestDigest,
  primaryCandidate,
  verifiedPlanBindings,
  recordedPlanBindings,
} from './release-lifecycle-execution-support.js';
import {
  verifyBoundReceipts,
  verifyReceiptDocument,
} from './release-lifecycle-execution-receipts.js';
import {
  headForCompletion,
  reduceStoreRecords,
  reduceReleaseStates,
  deriveAttemptId,
  storeRecordReference,
  buildStoreRecord,
} from './release-lifecycle-execution-records.js';
import { ReleaseLifecycleFileStore } from './release-lifecycle-execution-file-store.js';
import {
  assertTrustedAuthority,
  assertPublicationControls,
  authorizationDestination,
  verifyGrantResolution,
  verifyConsumptionProof,
} from './release-lifecycle-execution-authorization.js';
import {
  assertStateMatchesRequest,
  assertReceiptContinuity,
  buildState,
} from './release-lifecycle-execution-state.js';
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

function immutableProviderData<T>(value: T): T {
  const snapshot = JSON.parse(canonicalJson(value)) as T;
  const freeze = (entry: unknown): void => {
    if (entry !== null && typeof entry === 'object') {
      for (const child of Object.values(entry)) freeze(child);
      Object.freeze(entry);
    }
  };
  freeze(snapshot);
  return snapshot;
}

function captureExportProviderResult(value: unknown): ReleaseProviderResult {
  const invalid = () => new Error('release-adapter-output-invalid');
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([
    'outcome',
    'dispatch_status',
    'provider_handle',
    'material',
    'code',
    'transaction',
  ]);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    Object.values(descriptors).some((entry) => !entry.enumerable || !('value' in entry)) ||
    !['success', 'failure', 'unknown'].includes(descriptors['outcome']?.value as string)
  )
    throw invalid();
  // Capture disposition before any state validation or cleanup decision.
  return Object.freeze(
    Object.fromEntries(Object.entries(descriptors).map(([key, entry]) => [key, entry.value])),
  ) as unknown as ReleaseProviderResult;
}

/**
 * Execute exactly one persisted lifecycle action. All authority and producer
 * effects are injected. The core owns identities, append ordering, and state.
 */
export async function executeReleaseLifecycleAction(input: {
  readonly request: unknown;
  readonly action: PersistedReleaseAction;
  readonly store: ReleaseLifecycleFileStore;
  readonly provider?: ReleaseProvider;
  readonly authorization?: AuthorizationBridge;
  readonly authority?: TrustedReleaseAuthority;
  readonly publication_controls?: PublicationControls;
  readonly resolveReceipt?: ReceiptResolver;
  readonly resolvePlanInput?: ReleasePlanInputResolver;
  readonly offlineReceiptVerifier?: TrustedOfflineReceiptVerifier;
  readonly artifactReader?: TrustedArtifactReader;
  readonly exportLimits?: ReleaseExportTranscriptLimits;
  readonly recorded_at: string;
}): Promise<ExecuteReleaseResult> {
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
  if (
    request.action_id === 'release certify' &&
    !isProtectedReleaseCertificationProvider(input.provider)
  ) {
    return { ok: false, phase: 'provider', code: 'release-certification-provider-unavailable' };
  }
  if (
    request.action_id === 'release preflight' &&
    !isProtectedReleasePreflightProvider(input.provider)
  ) {
    return { ok: false, phase: 'provider', code: 'release-certification-provider-unavailable' };
  }
  if (!remote && input.provider === undefined) {
    return { ok: false, phase: 'provider', code: 'release-provider-unavailable' };
  }
  if (remote && input.authorization === undefined) {
    return {
      ok: false,
      phase: 'authorization',
      code: 'release-authorization-provider-unavailable',
    };
  }
  if (
    request.action_id === 'release evidence-publish' &&
    input.offlineReceiptVerifier === undefined
  ) {
    return {
      ok: false,
      phase: 'validation',
      code: 'release-offline-verifier-provider-unavailable',
    };
  }
  if (request.action_id === 'release publish') {
    try {
      assertPublicationControls(request, input.publication_controls);
    } catch (error) {
      return {
        ok: false,
        phase: 'validation',
        code: error instanceof Error ? error.message : 'rpd-workflow-expectation-invalid',
      };
    }
  }
  try {
    const execute = () =>
      input.store.withExecutionLock<ExecuteReleaseResult>(async () => {
        let storeRecords: StoreRecord[];
        let states: ReleaseLifecycleStateV2[];
        let head: StoreHead | null;
        let verifiedPriorState: ReleaseLifecycleStateV2 | null;
        try {
          storeRecords = input.store.readStoreRecords();
          states = input.store.readStateRecords();
          head = input.store.readHead();
          const reduced = reduceStoreRecords(storeRecords);
          if (!reduced.ok || reduced.ambiguous) {
            return {
              ok: false,
              phase: 'reconciliation',
              code: reduced.ambiguous
                ? 'release-provider-result-unknown'
                : (reduced.errors[0] ?? 'release-state-store-unsafe'),
            };
          }
          const stateReduction = reduceReleaseStates(states);
          if (!stateReduction.ok) {
            return {
              ok: false,
              phase: 'reconciliation',
              code: stateReduction.errors[0] ?? 'release-state-store-unsafe',
            };
          }
          const stateHead = stateReduction.head;
          verifiedPriorState = stateHead;
          if (stateHead !== null) assertStateMatchesRequest(request, stateHead);
          const initialState = states[0];
          const currentPlans = verifiedPlanBindings(receipts);
          if (
            initialState !== undefined &&
            currentPlans.length > 0 &&
            !same(currentPlans, recordedPlanBindings(initialState))
          )
            throw new Error('release-receipt-identity-mismatch');
          const completions = storeRecords.filter((record) => record.record_kind === 'completion');
          if (
            completions.length !== states.length ||
            completions.some((record, index) => {
              const state = states[index];
              return (
                state === undefined ||
                record.completion?.state_id !== state.state_id ||
                record.completion.state_digest_sha256 !== state.record_digest_sha256
              );
            })
          ) {
            return {
              ok: false,
              phase: 'reconciliation',
              code: 'release-state-store-orphan-record',
            };
          }
          const expectedHead =
            stateHead === null
              ? null
              : headForCompletion(stateHead, completions[completions.length - 1] as StoreRecord);
          if (!same(head, expectedHead))
            return { ok: false, phase: 'reconciliation', code: 'release-state-head-mismatch' };
          if (!same(reduced.completed_head, head)) {
            return { ok: false, phase: 'reconciliation', code: 'release-state-head-mismatch' };
          }
          const expectedPrior = PRIOR_BY_STATE[STATE_BY_ACTION[request.action_id]];
          if (expectedPrior !== (stateHead?.state ?? null)) {
            return { ok: false, phase: 'validation', code: 'release-state-transition-invalid' };
          }
          assertReceiptContinuity(request, receipts, stateHead);
          if (
            stateHead !== null &&
            (request.action_id === 'release export' ||
              request.action_id === 'release evidence-publish' ||
              request.action_id === 'release publish')
          ) {
            await reverifySinkArtifacts(stateHead, input.artifactReader, input.exportLimits);
          }
          if (request.action_id === 'release evidence-publish') {
            const offline = receipts.find(
              (receipt) => receipt.kind === 'release-offline-verification-receipt',
            );
            if (stateHead === null || offline === undefined) {
              throw new Error('release-offline-receipt-binding-invalid');
            }
            const verifiedDocument = await input.offlineReceiptVerifier?.verify({
              repository: request.repository_locator,
              candidate_locator: request.candidate_locator,
              exported_state: stateHead,
              receipt: offline.value,
            });
            if (
              verifiedDocument === undefined ||
              !same(verifyReceiptDocument(verifiedDocument).value, offline.value)
            ) {
              throw new Error('rov-semantic-verification-not-performed');
            }
          }
        } catch (error) {
          return {
            ok: false,
            phase: 'reconciliation',
            code: error instanceof Error ? error.message : 'release-state-store-unsafe',
          };
        }

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
        let grantProof:
          | {
              readonly grant: Readonly<Record<string, unknown>>;
              readonly grant_event_id: string;
              readonly ledger_head: AuthorizationLedgerHead;
              readonly ledger: Readonly<Record<string, unknown>>;
              readonly events: readonly Readonly<Record<string, unknown>>[];
            }
          | undefined;
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
          try {
            const refreshed = await input.authorization?.resolve(binding);
            if (refreshed === undefined || grantProof === undefined)
              throw new Error('release-authorization-consumption-not-durable');
            const refreshedProof = verifyGrantResolution(
              refreshed,
              binding,
              authority,
              input.recorded_at,
            );
            if (
              refreshedProof.grant_event_id !== grantProof.grant_event_id ||
              !same(refreshedProof.ledger_head, grantProof.ledger_head) ||
              !same(refreshedProof.grant, grantProof.grant)
            ) {
              throw new Error('release-authorization-attempt-binding-invalid');
            }
            const consumption = await input.authorization?.consume({
              ...binding,
              grant_event_id: authorizationEventId,
            });
            if (consumption === undefined)
              throw new Error('release-authorization-consumption-not-durable');
            verifyConsumptionProof(
              consumption,
              binding,
              grantProof.grant,
              authorizationEventId,
              grantProof.ledger_head,
              grantProof.ledger,
              grantProof.events,
            );
          } catch (error) {
            const failure = buildStoreRecord(
              request,
              attempt,
              head,
              attemptId,
              'failure',
              authorizationEventId,
              {
                outcome: 'failure',
                dispatch_status: 'failed-before-dispatch',
                code: 'release-authorization-consumption-failed',
              },
            );
            input.store.appendStoreRecord(failure);
            return {
              ok: false,
              phase: 'authorization',
              code:
                error instanceof Error
                  ? error.message
                  : 'release-authorization-consumption-not-durable',
              record: failure,
            };
          }
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

        let state: ReleaseLifecycleStateV2;
        let completion: StoreRecord;
        try {
          state = buildState(
            request,
            result.material,
            states.at(-1) ?? null,
            authorizationEventId,
            authority,
            input.publication_controls,
            input.recorded_at,
          );
          completion = buildStoreRecord(
            request,
            attempt,
            head,
            attemptId,
            'completion',
            authorizationEventId,
            result,
            state,
          );
        } catch (error) {
          if (!potentiallyIrreversible) {
            try {
              await result.transaction?.rollback();
            } finally {
              await result.transaction?.dispose();
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
              : error instanceof Error
                ? error.message
                : 'release-adapter-output-invalid',
            record: terminal,
          };
        }
        try {
          await result.transaction?.commit();
        } catch {
          if (request.action_id !== 'release prepare' && request.action_id !== 'release export') {
            try {
              await result.transaction?.rollback();
            } finally {
              await result.transaction?.dispose();
            }
            const failure = buildStoreRecord(
              request,
              attempt,
              head,
              attemptId,
              'failure',
              authorizationEventId,
              {
                outcome: 'failure',
                dispatch_status: 'failed-before-dispatch',
                code: 'release-provider-commit-failed',
              },
            );
            input.store.appendStoreRecord(failure);
            return {
              ok: false,
              phase: 'provider',
              code: 'release-provider-commit-failed',
              record: failure,
            };
          }
          // A dispatched commit is not proven absent merely because its response was lost.
          // Preserve its transaction and all opaque handles for external reconciliation.
          const failure = buildStoreRecord(
            request,
            attempt,
            head,
            attemptId,
            'unknown-provider-result',
            authorizationEventId,
            {
              ...result,
              outcome: 'unknown',
              dispatch_status: 'unknown',
              code: 'release-provider-result-unknown',
            },
          );
          input.store.appendStoreRecord(failure);
          return {
            ok: false,
            phase: 'ambiguous',
            code: 'release-artifact-sink-commit-unknown',
            record: failure,
          };
        }
        try {
          input.store.appendStoreRecord(completion);
          input.store.appendStateAndAdvanceHead(state, completion, head);
        } catch (error) {
          // The sink has committed. An append failure cannot authorize rollback or abort.
          if (request.action_id !== 'release prepare' && request.action_id !== 'release export') {
            try {
              await result.transaction?.rollback();
            } finally {
              await result.transaction?.dispose();
            }
          }
          return {
            ok: false,
            phase: 'append',
            code: error instanceof Error ? error.message : 'release-state-store-unsafe',
            record: completion,
          };
        }
        await result.transaction?.dispose();
        return { ok: true, state, completion };
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
