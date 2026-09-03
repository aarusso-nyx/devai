import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import {
  executeAuthorizedEffect,
  type EffectAuthorizationEvent,
  type EffectAuthorizationEventResolver,
  type EffectAuthorizationGrantRequest,
  type EffectAuthorizationLedger,
} from '@devai-nyx/authority';

export type PersistedReleaseState =
  | 'preflight_passed'
  | 'certified'
  | 'prepared'
  | 'exported'
  | 'evidence_published'
  | 'publication_dispatched';
export type DerivedReleaseState = 'planned' | 'offline_verified' | 'published';

export interface ReleaseIdentity {
  readonly id: string;
  readonly commit: string;
  readonly tree: string;
}

export interface ReleaseCandidateIdentity {
  readonly release_unit: string;
  readonly version: string;
  readonly commit: string;
  readonly tree: string;
}

export interface ReleaseArtifactIdentity {
  readonly kind: 'package-tarball' | 'evidence-bundle' | 'manifest' | 'attestation';
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export interface ReleaseStateReference {
  readonly state: PersistedReleaseState;
  readonly state_id: string;
  readonly record_digest_sha256: string;
}

export interface ReleaseLifecycleStateRecord extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly state_id: string;
  readonly state: PersistedReleaseState;
  readonly action_id:
    | 'release preflight'
    | 'release certify'
    | 'release prepare'
    | 'release export'
    | 'release evidence-publish'
    | 'release publish';
  readonly effect: 'harness-write' | 'local-write' | 'remote-write';
  readonly prior_state: ReleaseStateReference | null;
  readonly repository: ReleaseIdentity;
  readonly candidate: ReleaseCandidateIdentity;
  readonly artifacts: readonly ReleaseArtifactIdentity[];
  readonly authorization_event_id: string | null;
  readonly publication_expectation: PublicationExpectation | null;
  readonly record_digest_sha256: string;
}

export interface PublicationExpectation {
  readonly authorization_event_id: string;
  readonly destination: {
    readonly system_id: string;
    readonly exact_identifier: string;
    readonly operation: 'publish';
  };
  readonly workflow: {
    readonly repository: string;
    readonly workflow_path: string;
    readonly workflow_sha: string;
    readonly protected_environment: string;
    readonly protected: true;
  };
  readonly trust: {
    readonly trust_root_id: string;
    readonly trust_store_digest_sha256: string;
    readonly key_id: string;
    readonly signature_algorithm: 'ed25519' | 'ecdsa-p256-sha256' | 'rsa-pss-sha256';
  };
}

export interface ReleasePlanReceipt extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly receipt_kind: 'release-plan-receipt';
  readonly receipt_id: string;
  readonly state_observed: 'planned' | null;
  readonly verdict: 'pass' | 'block';
  readonly repository: ReleaseIdentity;
  readonly candidate: ReleaseCandidateIdentity;
  readonly receipt_digest_sha256: string;
}

export interface ReleaseOfflineVerificationReceipt extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly receipt_kind: 'release-offline-verification-receipt';
  readonly receipt_id: string;
  readonly verdict: 'pass' | 'fail';
  readonly state_observed: 'offline_verified' | null;
  readonly repository: ReleaseIdentity;
  readonly candidate: ReleaseCandidateIdentity;
  readonly verified_state: ReleaseStateReference;
  readonly artifacts: readonly ReleaseArtifactIdentity[];
  readonly receipt_digest_sha256: string;
}

export interface ReleasePublicationReceipt extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly receipt_kind: 'release-publication-receipt';
  readonly receipt_id: string;
  readonly attests_state: 'published' | null;
  readonly outcome: 'published' | 'failed';
  readonly repository: ReleaseIdentity;
  readonly candidate: ReleaseCandidateIdentity;
  readonly dispatched_state: ReleaseStateReference & { readonly state: 'publication_dispatched' };
  readonly artifacts: readonly ReleaseArtifactIdentity[];
  readonly publication: PublicationExpectation['destination'];
  readonly workflow: PublicationExpectation['workflow'] & {
    readonly run_id: string;
    readonly run_attempt: number;
    readonly candidate_product_execution: false;
  };
  readonly trust: PublicationExpectation['trust'] & {
    readonly signature: string;
    readonly signed_payload_digest_sha256: string;
  };
  readonly receipt_digest_sha256: string;
}

export interface ReleaseDerivedReceipt {
  readonly state: DerivedReleaseState;
  readonly receipt_kind:
    'release-plan-receipt' | 'release-offline-verification-receipt' | 'release-publication-receipt';
  readonly receipt_id: string;
  readonly receipt_digest_sha256: string;
  readonly verified: true;
}

export interface ReleaseLifecycleObservation extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '1.0.0';
  readonly observation_kind: 'release-lifecycle-observation';
  readonly observation_id: string;
  readonly repository: ReleaseIdentity;
  readonly candidate: ReleaseCandidateIdentity;
  readonly head: ReleaseStateReference | null;
  readonly derived_states: readonly ReleaseDerivedReceipt[];
  readonly published: Readonly<Record<string, unknown>>;
  readonly observation_digest_sha256: string;
}

export type ReleaseLifecycleError =
  | 'release-state-schema-invalid'
  | 'release-state-record-digest-mismatch'
  | 'release-state-id-duplicate'
  | 'release-state-transition-invalid'
  | 'release-state-prior-mismatch'
  | 'release-state-repository-mismatch'
  | 'release-state-candidate-mismatch';

export type ReleaseLifecycleReduction =
  | {
      readonly ok: true;
      readonly records: readonly ReleaseLifecycleStateRecord[];
      readonly head: ReleaseLifecycleStateRecord | null;
    }
  | { readonly ok: false; readonly errors: readonly ReleaseLifecycleError[] };

const TRANSITIONS: Readonly<
  Record<
    PersistedReleaseState,
    Readonly<{
      action: ReleaseLifecycleStateRecord['action_id'];
      prior: PersistedReleaseState | null;
    }>
  >
> = {
  preflight_passed: { action: 'release preflight', prior: null },
  certified: { action: 'release certify', prior: 'preflight_passed' },
  prepared: { action: 'release prepare', prior: 'certified' },
  exported: { action: 'release export', prior: 'prepared' },
  evidence_published: { action: 'release evidence-publish', prior: 'exported' },
  publication_dispatched: { action: 'release publish', prior: 'evidence_published' },
};

function omitTopLevel(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('canonical release document must be an object');
  }
  const excluded = new Set(keys);
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>).filter(
      ([key]) => !excluded.has(key),
    ),
  );
}

function same(left: unknown, right: unknown): boolean {
  return canonicalSha256(left) === canonicalSha256(right);
}

export function computeReleaseStateRecordDigest(record: unknown): string {
  return canonicalSha256(omitTopLevel(record, ['record_digest_sha256']));
}

export function finalizeReleaseLifecycleState(
  draft: Omit<ReleaseLifecycleStateRecord, 'record_digest_sha256'>,
): ReleaseLifecycleStateRecord {
  const record = {
    ...draft,
    record_digest_sha256: canonicalSha256(draft),
  };
  return parsers.releaseLifecycleState.parse<ReleaseLifecycleStateRecord>(record);
}

function reference(record: ReleaseLifecycleStateRecord): ReleaseStateReference {
  return {
    state: record.state,
    state_id: record.state_id,
    record_digest_sha256: record.record_digest_sha256,
  };
}

export function reduceReleaseLifecycle(
  recordsInput: readonly unknown[],
): ReleaseLifecycleReduction {
  const errors = new Set<ReleaseLifecycleError>();
  const records: ReleaseLifecycleStateRecord[] = [];
  const stateIds = new Set<string>();
  let head: ReleaseLifecycleStateRecord | null = null;
  let identity: { repository: ReleaseIdentity; candidate: ReleaseCandidateIdentity } | undefined;

  for (const input of recordsInput) {
    const parsed = parsers.releaseLifecycleState.safeParse<ReleaseLifecycleStateRecord>(input);
    if (!parsed.ok) {
      errors.add('release-state-schema-invalid');
      continue;
    }
    const record = parsed.value;
    records.push(record);
    if (computeReleaseStateRecordDigest(record) !== record.record_digest_sha256) {
      errors.add('release-state-record-digest-mismatch');
    }
    if (stateIds.has(record.state_id)) errors.add('release-state-id-duplicate');
    stateIds.add(record.state_id);

    const transition = TRANSITIONS[record.state];
    const observedPriorState = head === null ? null : head.state;
    if (record.action_id !== transition.action || transition.prior !== observedPriorState) {
      errors.add('release-state-transition-invalid');
    }
    const expectedPrior = head === null ? null : reference(head);
    if (!same(record.prior_state, expectedPrior)) errors.add('release-state-prior-mismatch');

    identity ??= { repository: record.repository, candidate: record.candidate };
    if (!same(record.repository, identity.repository))
      errors.add('release-state-repository-mismatch');
    if (!same(record.candidate, identity.candidate)) errors.add('release-state-candidate-mismatch');
    head = record;
  }

  return errors.size === 0 ? { ok: true, records, head } : { ok: false, errors: [...errors] };
}

export function computeReleaseReadReceiptDigest(receipt: unknown): string {
  return canonicalSha256(omitTopLevel(receipt, ['receipt_id', 'receipt_digest_sha256']));
}

export function finalizeReleasePlanReceipt(
  draft: Omit<ReleasePlanReceipt, 'receipt_id' | 'receipt_digest_sha256'>,
): ReleasePlanReceipt {
  const digest = canonicalSha256(draft);
  return parsers.releasePlanReceipt.parse<ReleasePlanReceipt>({
    ...draft,
    receipt_id: `RPL-${digest.slice(0, 16)}`,
    receipt_digest_sha256: digest,
  });
}

export function finalizeReleaseOfflineVerificationReceipt(
  draft: Omit<ReleaseOfflineVerificationReceipt, 'receipt_id' | 'receipt_digest_sha256'>,
): ReleaseOfflineVerificationReceipt {
  const digest = canonicalSha256(draft);
  return parsers.releaseOfflineVerificationReceipt.parse<ReleaseOfflineVerificationReceipt>({
    ...draft,
    receipt_id: `ROV-${digest.slice(0, 16)}`,
    receipt_digest_sha256: digest,
  });
}

export function verifyReleasePlanReceiptIdentity(
  receiptInput: unknown,
): receiptInput is ReleasePlanReceipt {
  const parsed = parsers.releasePlanReceipt.safeParse<ReleasePlanReceipt>(receiptInput);
  if (!parsed.ok) return false;
  const digest = computeReleaseReadReceiptDigest(parsed.value);
  return (
    parsed.value.receipt_digest_sha256 === digest &&
    parsed.value.receipt_id === `RPL-${digest.slice(0, 16)}`
  );
}

export function verifyReleaseOfflineReceiptIdentity(
  receiptInput: unknown,
): receiptInput is ReleaseOfflineVerificationReceipt {
  const parsed =
    parsers.releaseOfflineVerificationReceipt.safeParse<ReleaseOfflineVerificationReceipt>(
      receiptInput,
    );
  if (!parsed.ok) return false;
  const digest = computeReleaseReadReceiptDigest(parsed.value);
  return (
    parsed.value.receipt_digest_sha256 === digest &&
    parsed.value.receipt_id === `ROV-${digest.slice(0, 16)}`
  );
}

export function computePublicationSignedPayloadDigest(receipt: ReleasePublicationReceipt): string {
  const projection = omitTopLevel(receipt, ['receipt_id', 'receipt_digest_sha256']);
  const trust = { ...(projection['trust'] as Readonly<Record<string, unknown>>) };
  delete trust['signature'];
  delete trust['signed_payload_digest_sha256'];
  return canonicalSha256({ ...projection, trust });
}

export function computePublicationReceiptDigest(receipt: ReleasePublicationReceipt): string {
  return canonicalSha256(omitTopLevel(receipt, ['receipt_digest_sha256']));
}

export type PublicationSignatureVerifier = (input: {
  readonly signed_payload_digest_sha256: string;
  readonly signature: string;
  readonly trust: PublicationExpectation['trust'];
}) => boolean | Promise<boolean>;

function publicationReceiptMatchesState(
  receipt: ReleasePublicationReceipt,
  state: ReleaseLifecycleStateRecord,
): boolean {
  const expectation = state.publication_expectation;
  return (
    state.state === 'publication_dispatched' &&
    expectation !== null &&
    same(receipt.repository, state.repository) &&
    same(receipt.candidate, state.candidate) &&
    same(receipt.dispatched_state, reference(state)) &&
    same(receipt.artifacts, state.artifacts) &&
    same(receipt.publication, expectation.destination) &&
    same(
      {
        repository: receipt.workflow.repository,
        workflow_path: receipt.workflow.workflow_path,
        workflow_sha: receipt.workflow.workflow_sha,
        protected_environment: receipt.workflow.protected_environment,
        protected: receipt.workflow.protected,
      },
      expectation.workflow,
    ) &&
    same(
      {
        trust_root_id: receipt.trust.trust_root_id,
        trust_store_digest_sha256: receipt.trust.trust_store_digest_sha256,
        key_id: receipt.trust.key_id,
        signature_algorithm: receipt.trust.signature_algorithm,
      },
      expectation.trust,
    )
  );
}

function observationDraft(input: {
  readonly repository: ReleaseIdentity;
  readonly candidate: ReleaseCandidateIdentity;
  readonly head: ReleaseLifecycleStateRecord | null;
  readonly derived: readonly ReleaseDerivedReceipt[];
  readonly published: Readonly<Record<string, unknown>>;
}): Omit<ReleaseLifecycleObservation, 'observation_id' | 'observation_digest_sha256'> {
  return {
    schemaVersion: '1.0.0',
    observation_kind: 'release-lifecycle-observation',
    repository: input.repository,
    candidate: input.candidate,
    verification_kernel: {
      kernel_id: 'devai.kernel.release-lifecycle-observation.v1',
      policy_source: 'law/policy/release-lifecycle.json#/observation_kernel',
      schema_validation_alone_derives_published: false,
    },
    head: input.head === null ? null : reference(input.head),
    derived_states: input.derived,
    published: input.published,
    emitted_by: {
      action_id: 'release resume',
      effect: 'read',
      output_channel: 'stdout',
      persists_repository_state: false,
      appends_state_record: false,
      writes_receipt_file: false,
    },
    grants: {
      authority: false,
      publication_authority: false,
      lifecycle_transition: false,
      appends_published_state: false,
    },
    determinism: {
      deterministic: true,
      derived_from_bound_inputs_only: true,
      contains_wall_clock_time: false,
    },
  };
}

function finalizeObservation(
  draft: Omit<ReleaseLifecycleObservation, 'observation_id' | 'observation_digest_sha256'>,
): ReleaseLifecycleObservation {
  const digest = canonicalSha256(draft);
  return parsers.releaseLifecycleObservation.parse<ReleaseLifecycleObservation>({
    ...draft,
    observation_id: `RLO-${digest.slice(0, 16)}`,
    observation_digest_sha256: digest,
  });
}

/** Pure reconciliation: it never appends state and never executes a next action. */
export async function resumeReleaseLifecycle(input: {
  readonly records: readonly unknown[];
  readonly repository: ReleaseIdentity;
  readonly candidate: ReleaseCandidateIdentity;
  readonly derived_receipts?: readonly ReleaseDerivedReceipt[];
  readonly publication_receipt?: unknown;
  readonly verifySignature: PublicationSignatureVerifier;
}): Promise<ReleaseLifecycleObservation> {
  const reduction = reduceReleaseLifecycle(input.records);
  if (!reduction.ok) {
    throw new Error(`RELEASE_LIFECYCLE_CHAIN_INVALID:${reduction.errors.join(',')}`);
  }
  const head = reduction.head;
  if (
    head !== null &&
    (!same(head.repository, input.repository) || !same(head.candidate, input.candidate))
  ) {
    throw new Error('RELEASE_LIFECYCLE_OBSERVATION_IDENTITY_MISMATCH');
  }
  const derived = [...(input.derived_receipts ?? [])];
  let published: Readonly<Record<string, unknown>> = {
    observed: false,
    receipt: null,
    verified_against: null,
  };

  const parsed = parsers.releasePublicationReceipt.safeParse<ReleasePublicationReceipt>(
    input.publication_receipt,
  );
  if (head !== null && parsed.ok && parsed.value.outcome === 'published') {
    const receipt = parsed.value;
    const signedDigest = computePublicationSignedPayloadDigest(receipt);
    const wholeDigest = computePublicationReceiptDigest(receipt);
    const identityValid =
      receipt.trust.signed_payload_digest_sha256 === signedDigest &&
      receipt.receipt_id === `RPU-${signedDigest.slice(0, 16)}` &&
      receipt.receipt_digest_sha256 === wholeDigest;
    const bindingValid = publicationReceiptMatchesState(receipt, head);
    const signatureValid =
      identityValid &&
      bindingValid &&
      (await input.verifySignature({
        signed_payload_digest_sha256: signedDigest,
        signature: receipt.trust.signature,
        trust: {
          trust_root_id: receipt.trust.trust_root_id,
          trust_store_digest_sha256: receipt.trust.trust_store_digest_sha256,
          key_id: receipt.trust.key_id,
          signature_algorithm: receipt.trust.signature_algorithm,
        },
      }));
    if (signatureValid) {
      derived.push({
        state: 'published',
        receipt_kind: 'release-publication-receipt',
        receipt_id: receipt.receipt_id,
        receipt_digest_sha256: receipt.receipt_digest_sha256,
        verified: true,
      });
      published = {
        observed: true,
        receipt: {
          kind: 'release-publication-receipt',
          receipt_id: receipt.receipt_id,
          receipt_digest_sha256: receipt.receipt_digest_sha256,
          trust_root_id: receipt.trust.trust_root_id,
          trust_store_digest_sha256: receipt.trust.trust_store_digest_sha256,
          key_id: receipt.trust.key_id,
          signature_algorithm: receipt.trust.signature_algorithm,
          signature_verified: true,
        },
        verified_against: {
          ...reference(head),
          candidate_identity_verified: true,
          artifact_identity_verified: true,
          destination_identity_verified: true,
          workflow_identity_verified: true,
          trust_identity_verified: true,
        },
      };
    }
  }
  return finalizeObservation(
    observationDraft({
      repository: input.repository,
      candidate: input.candidate,
      head,
      derived,
      published,
    }),
  );
}

export type ReleaseTransitionResult<T> =
  | {
      readonly ok: true;
      readonly state: ReleaseLifecycleStateRecord;
      readonly adapter_result: T;
    }
  | {
      readonly ok: false;
      readonly phase: 'validation' | 'authorization' | 'adapter' | 'append';
      readonly code: string;
      readonly cause?: unknown;
    };

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
    if (!reduction.ok) {
      return {
        ok: false,
        phase: 'validation',
        code: reduction.errors.join(','),
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
