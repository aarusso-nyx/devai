import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import type {
  ReleaseLifecycleStateRecord,
  ReleaseIdentity,
  ReleaseCandidateIdentity,
  ReleasePublicationReceipt,
  ReleaseDerivedReceipt,
  ReleaseLifecycleObservation,
  PublicationSignatureVerifier,
} from './types.js';
import {
  same,
  computePublicationSignedPayloadDigest,
  computePublicationReceiptDigest,
} from './receipts.js';
import { reference, reduceReleaseLifecycle } from './reducer.js';

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
  // Mirror the policy's pure resume mapping; describing a next action never executes it.
  const observed =
    input.published['observed'] === true
      ? 'published'
      : input.head?.state === 'exported' &&
          input.derived.some((receipt) => receipt.state === 'offline_verified')
        ? 'offline_verified'
        : (input.head?.state ??
          (input.derived.some((receipt) => receipt.state === 'planned') ? 'planned' : 'none'));
  const nextActions = {
    none: 'release plan',
    planned: 'release preflight',
    preflight_passed: 'release certify',
    certified: 'release prepare',
    prepared: 'release export',
    exported: 'release offline-verify',
    offline_verified: 'release evidence-publish',
    evidence_published: 'release publish',
    publication_dispatched: 'release resume',
    published: null,
  } as const;
  return {
    schemaVersion: '1.1.0',
    next_action: nextActions[observed],
    next_outcome:
      observed === 'published'
        ? 'complete'
        : observed === 'publication_dispatched'
          ? 'awaiting-external-receipt'
          : 'ready',
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
