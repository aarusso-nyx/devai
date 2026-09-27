import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import type {
  ReleaseLifecycleRequest,
  ReleaseProviderResult,
  ReleaseLifecycleStateV2,
  PersistedReleaseAction,
  PersistedReleaseState,
  StoreRecord,
  StoreRecordReference,
  StoreReduction,
  StoreHead,
  StateReduction,
} from './release-lifecycle-execution-types.js';
import {
  same,
  object,
  without,
  EFFECT_BY_ACTION,
  PRIOR_BY_STATE,
  STATE_BY_ACTION,
  HEAD_CANONICALIZATION,
  STORE_CANONICALIZATION,
  computeReleaseRequestDigest,
  stateReference,
  recordedPlanBindings,
} from './release-lifecycle-execution-support.js';

export function finalizeReleaseStateV2(
  draft: Omit<ReleaseLifecycleStateV2, 'state_id' | 'record_digest_sha256'>,
): ReleaseLifecycleStateV2 {
  const digest = canonicalSha256(draft);
  const state = {
    ...draft,
    state_id: `RLS-${digest.slice(0, 16)}`,
    record_digest_sha256: digest,
  };
  return parsers.releaseLifecycleState.parse<ReleaseLifecycleStateV2>(state);
}

export function verifyReleaseStateIdentity(value: unknown, write = false): ReleaseLifecycleStateV2 {
  const parsed = parsers.releaseLifecycleState.safeParse<ReleaseLifecycleStateV2>(value);
  if (!parsed.ok) throw new Error('release-state-schema-invalid');
  const state = parsed.value;
  if (write && state.schemaVersion !== '2.0.0' && state.schemaVersion !== '2.1.0') {
    throw new Error('release-state-v1-write-refused');
  }
  const projection = without(
    state,
    state.schemaVersion === '2.0.0' || state.schemaVersion === '2.1.0'
      ? ['state_id', 'record_digest_sha256']
      : ['record_digest_sha256'],
  );
  const digest = canonicalSha256(projection);
  if (state.record_digest_sha256 !== digest) {
    throw new Error('release-state-id-or-digest-mismatch');
  }
  if (
    (state.schemaVersion === '2.0.0' || state.schemaVersion === '2.1.0') &&
    state.state_id !== `RLS-${digest.slice(0, 16)}`
  ) {
    throw new Error('release-state-id-or-digest-mismatch');
  }
  return state;
}

export function storeRecordReference(record: StoreRecord): StoreRecordReference {
  return {
    sequence: record.sequence,
    record_id: record.record_id,
    record_digest_sha256: record.record_digest_sha256,
  };
}

export function finalizeStoreRecord(
  draft: Omit<StoreRecord, 'record_id' | 'record_digest_sha256'>,
): StoreRecord {
  const digest = canonicalSha256(draft);
  const record = {
    ...draft,
    record_id: `RLE-${digest.slice(0, 16)}`,
    record_digest_sha256: digest,
  };
  return parsers.releaseLifecycleStoreRecord.parse<StoreRecord>(record);
}

export function verifyStoreRecordIdentity(value: unknown): StoreRecord {
  const parsed = parsers.releaseLifecycleStoreRecord.safeParse<StoreRecord>(value);
  if (!parsed.ok) throw new Error('release-state-store-record-invalid');
  const record = parsed.value;
  const digest = canonicalSha256(without(record, ['record_id', 'record_digest_sha256']));
  if (record.record_digest_sha256 !== digest || record.record_id !== `RLE-${digest.slice(0, 16)}`) {
    throw new Error('release-state-store-record-identity-invalid');
  }
  return record;
}

export function reduceStoreRecords(values: readonly unknown[]): StoreReduction {
  const records: StoreRecord[] = [];
  const errors = new Set<string>();
  let prior: StoreRecord | null = null;
  let repositoryDigest: string | undefined;
  let candidateDigest: string | undefined;
  let completedHead: StoreHead | null = null;
  let completedState: PersistedReleaseState | null = null;
  let terminalUnknown = false;
  for (const value of values) {
    let record: StoreRecord;
    try {
      record = verifyStoreRecordIdentity(value);
    } catch (error) {
      errors.add(error instanceof Error ? error.message : 'release-state-store-record-invalid');
      continue;
    }
    records.push(record);
    if (record.sequence !== records.length - 1) errors.add('release-state-store-sequence-invalid');
    const expectedPrior = prior === null ? null : storeRecordReference(prior);
    if (canonicalSha256(record.predecessor_record) !== canonicalSha256(expectedPrior)) {
      errors.add('release-state-store-broken-chain');
    }
    if (!same(record.observed_head_before, completedHead)) {
      errors.add('release-state-head-mismatch');
    }
    if (terminalUnknown) errors.add('release-provider-result-unknown');
    repositoryDigest ??= canonicalSha256(record['repository']);
    candidateDigest ??= canonicalSha256(record['candidate']);
    if (repositoryDigest !== canonicalSha256(record['repository']))
      errors.add('release-state-store-repository-mismatch');
    if (candidateDigest !== canonicalSha256(record['candidate']))
      errors.add('release-state-store-candidate-mismatch');

    const remote = EFFECT_BY_ACTION[record.action_id] === 'remote-write';
    const observedProvider =
      remote ||
      (record.action_id === 'release export' &&
        record.provider_dispatch.status !== 'not-dispatched');
    if (record.record_kind === 'attempt') {
      if (prior === null) {
        if (record.predecessor_record !== null) errors.add('release-store-opening-attempt-invalid');
      } else if (
        prior.record_kind === 'attempt' ||
        prior.record_kind === 'unknown-provider-result'
      ) {
        errors.add('release-store-attempt-predecessor-invalid');
      }
      if (
        prior?.record_kind === 'failure' &&
        remote &&
        record.authorization_event_id === prior.authorization_event_id
      ) {
        errors.add('fresh-exact-authorization-required');
      }
      const expectedAttempt = deriveAttemptId({
        request_digest_sha256: record.request_digest_sha256,
        action_id: record.action_id,
        sequence: record.sequence,
        predecessor_record: record.predecessor_record,
      });
      if (record.attempt_id !== expectedAttempt)
        errors.add('release-store-opening-attempt-invalid');
      if (
        record.provider_handle !== null ||
        record.provider_dispatch.status !== 'not-dispatched' ||
        record.provider_dispatch.handle_observed
      ) {
        errors.add('release-provider-handle-observation-invalid');
      }
      if (PRIOR_BY_STATE[STATE_BY_ACTION[record.action_id]] !== completedState) {
        errors.add('release-state-transition-invalid');
      }
      if (remote !== (record.authorization_event_id !== null)) {
        errors.add('release-authorization-attempt-binding-invalid');
      }
    } else {
      if (
        prior === null ||
        prior.record_kind !== 'attempt' ||
        record.predecessor_record === null ||
        !same(record.predecessor_record, storeRecordReference(prior)) ||
        record.attempt_id !== prior.attempt_id ||
        record.action_id !== prior.action_id ||
        record.request_digest_sha256 !== prior.request_digest_sha256 ||
        record.authorization_event_id !== prior.authorization_event_id ||
        !same(record.repository, prior.repository) ||
        !same(record.candidate, prior.candidate)
      ) {
        errors.add('release-store-terminal-attempt-link-invalid');
      }
      if (!same(record.observed_head_before, prior?.observed_head_before ?? null)) {
        errors.add('release-state-head-mismatch');
      }
      if (
        record.record_kind === 'completion' &&
        (record.completion?.state !== STATE_BY_ACTION[record.action_id] ||
          (observedProvider &&
            (record.provider_dispatch.status !== 'dispatched' ||
              !record.provider_dispatch.handle_observed ||
              record.provider_handle === null)))
      ) {
        errors.add('release-store-terminal-attempt-link-invalid');
      }
      if (
        record.record_kind === 'failure' &&
        observedProvider &&
        record.provider_dispatch.status !== 'failed-before-dispatch'
      ) {
        errors.add('release-store-terminal-attempt-link-invalid');
      }
      if (
        record.record_kind === 'unknown-provider-result' &&
        record.provider_dispatch.status !== (observedProvider ? 'unknown' : 'not-dispatched')
      ) {
        errors.add('release-store-completion-unknown-conflict');
      }
      if (record.record_kind === 'completion' && record.completion !== null) {
        const generation = (record.observed_head_before?.generation ?? -1) + 1;
        completedHead = finalizeStoreHead({
          schemaVersion: '2.0.0',
          canonicalization: HEAD_CANONICALIZATION,
          repository: record['repository'] as ReleaseLifecycleRequest['repository_locator'],
          candidate: {
            commit: String(object(record['candidate'])['commit']),
            tree: String(object(record['candidate'])['tree']),
          },
          generation,
          state_id: record.completion.state_id,
          state_digest_sha256: record.completion.state_digest_sha256,
          completion_record: { ...storeRecordReference(record), attempt_id: record.attempt_id },
        });
        completedState = record.completion.state;
      }
      if (record.record_kind === 'unknown-provider-result') terminalUnknown = true;
    }
    prior = record;
  }
  const pending = prior?.record_kind === 'attempt';
  const unknown = records.some((record) => record.record_kind === 'unknown-provider-result');
  return {
    ok: errors.size === 0,
    records,
    last: prior,
    errors: [...errors],
    ambiguous: pending || unknown,
    failed: prior?.record_kind === 'failure',
    completed_head: completedHead,
  };
}

export function finalizeStoreHead(draft: Omit<StoreHead, 'head_digest_sha256'>): StoreHead {
  const head = { ...draft, head_digest_sha256: canonicalSha256(draft) };
  return parsers.releaseLifecycleStoreHead.parse<StoreHead>(head);
}

export function verifyStoreHeadIdentity(value: unknown): StoreHead {
  const parsed = parsers.releaseLifecycleStoreHead.safeParse<StoreHead>(value);
  if (!parsed.ok) throw new Error('release-state-head-invalid');
  const head = parsed.value;
  if (head.head_digest_sha256 !== canonicalSha256(without(head, ['head_digest_sha256']))) {
    throw new Error('release-state-head-invalid');
  }
  return head;
}

export function headForCompletion(
  state: ReleaseLifecycleStateV2,
  completion: StoreRecord,
): StoreHead {
  if (
    completion.record_kind !== 'completion' ||
    completion.attempt_id === '' ||
    completion.completion?.state_id !== state.state_id ||
    completion.completion.state_digest_sha256 !== state.record_digest_sha256
  ) {
    throw new Error('release-store-head-completion-mismatch');
  }
  return finalizeStoreHead({
    schemaVersion: '2.0.0',
    canonicalization: HEAD_CANONICALIZATION,
    repository: state.repository,
    candidate: { commit: state.candidate.commit, tree: state.candidate.tree },
    generation: state.storage.generation,
    state_id: state.state_id,
    state_digest_sha256: state.record_digest_sha256,
    completion_record: {
      ...storeRecordReference(completion),
      attempt_id: completion.attempt_id,
    },
  });
}

function requestStoreCandidate(
  request: ReleaseLifecycleRequest,
): Readonly<Record<string, unknown>> {
  return {
    commit: request.candidate_locator.commit,
    tree: request.candidate_locator.tree,
    release_units: request.candidate_locator.release_units.map((unit) => ({
      release_unit: unit.release_unit,
      version: unit.version,
      packages: unit.package_roster.map((pkg) => ({ package_id: pkg.package_id })),
    })),
  };
}

export function deriveAttemptId(input: {
  readonly request_digest_sha256: string;
  readonly action_id: PersistedReleaseAction;
  readonly sequence: number;
  readonly predecessor_record: StoreRecordReference | null;
}): string {
  return `RLA-${canonicalSha256(input).slice(0, 16)}`;
}

export function buildStoreRecord(
  request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction },
  prior: StoreRecord | null,
  observedHeadBefore: StoreHead | null,
  attemptId: string,
  kind: StoreRecord['record_kind'],
  authorizationEventId: string | null,
  result?: ReleaseProviderResult,
  state?: ReleaseLifecycleStateV2,
): StoreRecord {
  const sequence = prior === null ? 0 : prior.sequence + 1;
  const handle = result?.provider_handle ?? null;
  const remote = EFFECT_BY_ACTION[request.action_id] === 'remote-write';
  const observedProvider =
    remote ||
    (request.action_id === 'release export' &&
      (handle !== null || result?.dispatch_status !== undefined));
  return finalizeStoreRecord({
    schemaVersion: '1.0.0',
    record_kind: kind,
    canonicalization: STORE_CANONICALIZATION,
    sequence,
    repository: request.repository_locator,
    candidate: requestStoreCandidate(request),
    predecessor_record: prior === null ? null : storeRecordReference(prior),
    observed_head_before: observedHeadBefore,
    attempt_id: attemptId,
    action_id: request.action_id,
    request_digest_sha256: computeReleaseRequestDigest(request),
    authorization_event_id: authorizationEventId,
    provider_handle: handle,
    provider_dispatch:
      kind === 'attempt'
        ? { status: 'not-dispatched', handle_observed: false }
        : kind === 'unknown-provider-result' && observedProvider
          ? { status: 'unknown', handle_observed: handle !== null }
          : observedProvider
            ? {
                status: result?.dispatch_status ?? 'dispatched',
                handle_observed: handle !== null,
              }
            : { status: 'not-dispatched', handle_observed: false },
    completion:
      kind === 'completion' && state !== undefined
        ? {
            state_id: state.state_id,
            state_digest_sha256: state.record_digest_sha256,
            state: state.state,
          }
        : null,
    failure:
      kind === 'failure'
        ? { code: result?.code ?? 'release-provider-failed', retryable: false }
        : null,
    unknown:
      kind === 'unknown-provider-result'
        ? {
            code: 'release-provider-result-unknown',
            redispatch_permitted: false,
            ...(request.action_id === 'release prepare' && result?.material?.artifact_sink != null
              ? {
                  artifact_sink: result.material.artifact_sink,
                  artifacts: result.material.artifacts,
                }
              : {}),
          }
        : null,
  } as never);
}

export function reduceReleaseStates(values: readonly unknown[]): StateReduction {
  const errors = new Set<string>();
  let prior: ReleaseLifecycleStateV2 | null = null;
  let initialPlans: readonly unknown[] | undefined;
  for (const [index, value] of values.entries()) {
    let state: ReleaseLifecycleStateV2;
    try {
      state = verifyReleaseStateIdentity(value);
    } catch (error) {
      errors.add(error instanceof Error ? error.message : 'release-state-schema-invalid');
      continue;
    }
    const plans = recordedPlanBindings(state);
    if (initialPlans === undefined) initialPlans = plans;
    else if (plans.length > 0 && !same(plans, initialPlans))
      errors.add('release-receipt-identity-mismatch');
    if (prior !== null) {
      if (!same(state.repository, prior.repository) || !same(state.candidate, prior.candidate)) {
        errors.add('release-state-identity-mismatch');
      }
      if (!same(state.prior_state, stateReference(prior)))
        errors.add('release-state-predecessor-mismatch');
      const stateGeneration =
        state.schemaVersion === '2.0.0' || state.schemaVersion === '2.1.0'
          ? state.storage.generation
          : index;
      const priorGeneration =
        prior.schemaVersion === '2.0.0' || prior.schemaVersion === '2.1.0'
          ? prior.storage.generation
          : index - 1;
      if (
        stateGeneration !== priorGeneration + 1 ||
        ((state.schemaVersion === '2.0.0' || state.schemaVersion === '2.1.0') &&
          !same(state.storage.head_before, {
            generation: priorGeneration,
            record_digest_sha256: prior.record_digest_sha256,
          }))
      ) {
        errors.add('release-state-head-mismatch');
      }
    } else if (state.state !== 'preflight_passed') {
      errors.add('release-state-transition-invalid');
    }
    if (PRIOR_BY_STATE[state.state] !== (prior?.state ?? null))
      errors.add('release-state-transition-invalid');
    prior = state;
  }
  return { ok: errors.size === 0, head: prior, errors: [...errors] };
}
