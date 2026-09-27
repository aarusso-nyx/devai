import type { ReleaseExportTranscriptLimits } from './release-export-transcript.js';
import { isProtectedReleaseCertificationProvider } from './release-lifecycle-certification.js';
import { isProtectedReleasePreflightProvider } from './release-certification-provider.js';
import type {
  ReleaseLifecycleRequest,
  ReleaseProviderResult,
  ReleaseLifecycleStateV2,
  PersistedReleaseAction,
  ReleasePlanInputResolver,
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
import { same } from './release-lifecycle-execution-support.js';
import { buildStoreRecord } from './release-lifecycle-execution-records.js';
import { ReleaseLifecycleFileStore } from './release-lifecycle-execution-file-store.js';
import {
  assertPublicationControls,
  verifyGrantResolution,
  verifyConsumptionProof,
} from './release-lifecycle-execution-authorization.js';
import { buildState } from './release-lifecycle-execution-state.js';

/** Inputs of one persisted lifecycle action; every authority and producer effect is injected. */
export interface ReleaseLifecycleExecutionInput {
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
}

/** A validated request of one persisted lifecycle action. */
type PersistedReleaseRequest = ReleaseLifecycleRequest & {
  readonly action_id: PersistedReleaseAction;
};

/** The verified grant a remote attempt resolved before dispatch. */
export type ReleaseGrantProof = {
  readonly grant: Readonly<Record<string, unknown>>;
  readonly grant_event_id: string;
  readonly ledger_head: AuthorizationLedgerHead;
  readonly ledger: Readonly<Record<string, unknown>>;
  readonly events: readonly Readonly<Record<string, unknown>>[];
};

/**
 * The provider, authorization, offline verifier and publication controls the action
 * requires before any store read; the first missing one is the refusal.
 */
export function releaseActionPreconditionFailure(
  input: ReleaseLifecycleExecutionInput,
  request: PersistedReleaseRequest,
  remote: boolean,
): ExecuteReleaseResult | undefined {
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
  return undefined;
}

/**
 * Re-resolve the remote grant, require the proof the attempt was bound to, and consume
 * it durably; a failure is appended as a failed-before-dispatch record and returned.
 */
export async function consumeAttemptAuthorization(args: {
  readonly input: ReleaseLifecycleExecutionInput;
  readonly request: PersistedReleaseRequest;
  readonly authority: TrustedReleaseAuthority;
  readonly binding: AuthorizationAttemptBinding;
  readonly grantProof: ReleaseGrantProof | undefined;
  readonly authorizationEventId: string;
  readonly attempt: StoreRecord;
  readonly head: StoreHead | null;
  readonly attemptId: string;
}): Promise<ExecuteReleaseResult | undefined> {
  const {
    input,
    request,
    authority,
    binding,
    grantProof,
    authorizationEventId,
    attempt,
    head,
    attemptId,
  } = args;
  try {
    const refreshed = await input.authorization?.resolve(binding);
    if (refreshed === undefined || grantProof === undefined)
      throw new Error('release-authorization-consumption-not-durable');
    const refreshedProof = verifyGrantResolution(refreshed, binding, authority, input.recorded_at);
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
    if (consumption === undefined) throw new Error('release-authorization-consumption-not-durable');
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
        error instanceof Error ? error.message : 'release-authorization-consumption-not-durable',
      record: failure,
    };
  }
  return undefined;
}

/**
 * Build the next state and completion record from a successful provider result, commit
 * the provider transaction, and append completion, state and head; each failure keeps
 * the executor's record kind, rollback rule and refusal.
 */
export async function completeReleaseAttempt(args: {
  readonly input: ReleaseLifecycleExecutionInput;
  readonly request: PersistedReleaseRequest;
  readonly authority: TrustedReleaseAuthority;
  readonly result: ReleaseProviderResult;
  readonly material: NonNullable<ReleaseProviderResult['material']>;
  readonly states: readonly ReleaseLifecycleStateV2[];
  readonly authorizationEventId: string | null;
  readonly attempt: StoreRecord;
  readonly head: StoreHead | null;
  readonly attemptId: string;
  readonly potentiallyIrreversible: boolean;
}): Promise<ExecuteReleaseResult> {
  const {
    input,
    request,
    authority,
    result,
    material,
    states,
    authorizationEventId,
    attempt,
    head,
    attemptId,
    potentiallyIrreversible,
  } = args;
  let state: ReleaseLifecycleStateV2;
  let completion: StoreRecord;
  try {
    state = buildState(
      request,
      material,
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
}
