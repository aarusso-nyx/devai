import { reverifySinkArtifacts } from './release-prepare-kernel.js';
import type { ReleaseExportTranscriptLimits } from './release-export-transcript.js';
import type {
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
  PersistedReleaseAction,
  VerifiedReceipt,
  StoreRecord,
  StoreHead,
  TrustedOfflineReceiptVerifier,
  TrustedArtifactReader,
  ExecuteReleaseResult,
} from './release-lifecycle-execution-types.js';
import {
  same,
  PRIOR_BY_STATE,
  STATE_BY_ACTION,
  verifiedPlanBindings,
  recordedPlanBindings,
} from './release-lifecycle-execution-support.js';
import { verifyReceiptDocument } from './release-lifecycle-execution-receipts.js';
import {
  headForCompletion,
  reduceStoreRecords,
  reduceReleaseStates,
} from './release-lifecycle-execution-records.js';
import { ReleaseLifecycleFileStore } from './release-lifecycle-execution-file-store.js';
import {
  assertStateMatchesRequest,
  assertReceiptContinuity,
} from './release-lifecycle-execution-state.js';

/** Store and state reconciled before an attempt: records, states and head agree and continue the request. */
type ReleaseStoreReconciliation =
  | Extract<ExecuteReleaseResult, { readonly ok: false }>
  | {
      readonly ok: true;
      readonly storeRecords: StoreRecord[];
      readonly states: ReleaseLifecycleStateV2[];
      readonly head: StoreHead | null;
      readonly verifiedPriorState: ReleaseLifecycleStateV2 | null;
    };

/**
 * Reconcile the store records, state records and head under the execution lock:
 * no ambiguous or orphan record, the head matches the last completion, the prior
 * state admits this action, receipts continue it, and exported artifacts and any
 * offline receipt re-verify. Any refusal is returned exactly as the executor reports it.
 */
export async function reconcileReleaseStore(
  input: {
    readonly store: ReleaseLifecycleFileStore;
    readonly offlineReceiptVerifier?: TrustedOfflineReceiptVerifier;
    readonly artifactReader?: TrustedArtifactReader;
    readonly exportLimits?: ReleaseExportTranscriptLimits;
  },
  request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction },
  receipts: readonly VerifiedReceipt[],
): Promise<ReleaseStoreReconciliation> {
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
  return { ok: true, storeRecords, states, head, verifiedPriorState };
}
