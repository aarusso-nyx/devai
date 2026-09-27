import { parsers } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';
import type {
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
  ReleaseAction,
  ReleasePlanInputResolver,
  VerifiedReceipt,
  ReceiptResolver,
  TrustedOfflineReceiptVerifier,
  PublicationSignatureVerifier,
} from './release-lifecycle-execution-types.js';
import {
  same,
  object,
  EFFECT_BY_ACTION,
  packageManifest,
  stateReference,
  offlineReleaseUnitsProjection,
  offlineArtifactProjection,
  verifiedPlanBindings,
  recordedPlanBindings,
} from './release-lifecycle-execution-support.js';
import {
  verifyReceiptDocument,
  readHistoricalPlanReceipt,
  verifyPublicationReceipt,
  observationIdentity,
} from './release-lifecycle-execution-receipts.js';
import {
  verifyStoreHeadIdentity,
  verifyReleaseStateIdentity,
  headForCompletion,
  reduceStoreRecords,
  reduceReleaseStates,
} from './release-lifecycle-execution-records.js';

export async function resumeReleaseLifecycleExecution(input: {
  readonly states: readonly unknown[];
  readonly store_records?: readonly unknown[];
  readonly store_head?: unknown;
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: ReleaseLifecycleStateV2['candidate'];
  readonly candidate_locator?: ReleaseLifecycleRequest['candidate_locator'];
  readonly receipt_documents?: readonly unknown[];
  readonly receipt_locators?: NonNullable<ReleaseLifecycleRequest['receipt_locators']>;
  readonly resolve_receipt?: ReceiptResolver;
  readonly resolve_plan_input?: ReleasePlanInputResolver;
  readonly offline_receipt_verifier?: TrustedOfflineReceiptVerifier;
  readonly publication_receipt?: unknown;
  readonly verify_signature?: PublicationSignatureVerifier;
}): Promise<Readonly<Record<string, unknown>>> {
  const stateReduction = reduceReleaseStates(input.states);
  const storeReduction = reduceStoreRecords(input.store_records ?? []);
  const head = stateReduction.head;
  const completions = storeReduction.records.filter(
    (record) => record.record_kind === 'completion',
  );
  const completionMismatch =
    storeReduction.records.length > 0 &&
    (completions.length !== input.states.length ||
      completions.some((record, index) => {
        const state = input.states[index];
        if (state === undefined) return true;
        try {
          const verified = verifyReleaseStateIdentity(state);
          return (
            record.completion?.state_id !== verified.state_id ||
            record.completion.state_digest_sha256 !== verified.record_digest_sha256
          );
        } catch {
          return true;
        }
      }));
  const lastStore = storeReduction.last;
  const storeIdentityMismatch =
    lastStore !== null &&
    (!same(lastStore['repository'], input.repository) ||
      object(lastStore['candidate'])['commit'] !== input.candidate.commit ||
      object(lastStore['candidate'])['tree'] !== input.candidate.tree);
  const identityMismatch =
    head !== null &&
    (!same(head.repository, input.repository) || !same(head.candidate, input.candidate));
  const locatorMismatch =
    input.candidate_locator !== undefined &&
    (input.candidate_locator.commit !== input.candidate.commit ||
      input.candidate_locator.tree !== input.candidate.tree ||
      input.candidate_locator.release_units[0]?.release_unit !== input.candidate.release_unit ||
      input.candidate_locator.release_units[0]?.version !== input.candidate.version);
  let headMismatch = false;
  const storeHeadProvided = Object.prototype.hasOwnProperty.call(input, 'store_head');
  if (storeReduction.records.length > 0 && !storeHeadProvided) headMismatch = true;
  if (storeHeadProvided) {
    try {
      const lastCompletion = completions.at(-1);
      if (input.store_head === null) {
        headMismatch = head !== null || lastCompletion !== undefined;
      } else {
        const observedHead = verifyStoreHeadIdentity(input.store_head);
        headMismatch =
          head === null ||
          lastCompletion === undefined ||
          !same(observedHead, headForCompletion(head, lastCompletion));
      }
    } catch {
      headMismatch = true;
    }
  }
  const verifiedReceipts: VerifiedReceipt[] = [];
  const historicalReceipts = new Set<VerifiedReceipt>();
  const inspectReceipt = (document: unknown): VerifiedReceipt => {
    const value = object(document);
    if (value['receipt_kind'] === 'release-plan-receipt' && value['schemaVersion'] === '1.0.0') {
      const receipt = readHistoricalPlanReceipt(value);
      historicalReceipts.add(receipt);
      return receipt;
    }
    return verifyReceiptDocument(value, input.resolve_plan_input);
  };
  let receiptInvalid = false;
  try {
    for (const document of input.receipt_documents ?? []) {
      verifiedReceipts.push(inspectReceipt(document));
    }
    for (const locator of input.receipt_locators ?? []) {
      if (input.resolve_receipt === undefined)
        throw new Error('release-receipt-provider-unavailable');
      const receipt = inspectReceipt(input.resolve_receipt(locator));
      if (
        receipt.kind !== locator.kind ||
        receipt.value['receipt_id'] !== locator.receipt_id ||
        receipt.value['receipt_digest_sha256'] !== locator.receipt_digest_sha256
      ) {
        throw new Error('release-receipt-identity-mismatch');
      }
      verifiedReceipts.push(receipt);
    }
  } catch {
    receiptInvalid = true;
  }
  const hasHistoricalPlans = historicalReceipts.size > 0;
  const blocked =
    !stateReduction.ok ||
    !storeReduction.ok ||
    completionMismatch ||
    headMismatch ||
    storeIdentityMismatch ||
    identityMismatch ||
    locatorMismatch ||
    receiptInvalid;
  const ambiguous = !blocked && storeReduction.ambiguous;
  const remoteFailure =
    !blocked &&
    !ambiguous &&
    storeReduction.failed &&
    lastStore !== null &&
    EFFECT_BY_ACTION[lastStore.action_id] === 'remote-write';
  let published: Readonly<Record<string, unknown>> = {
    observed: false,
    receipt: null,
    verified_against: null,
  };
  const derived: Readonly<Record<string, unknown>>[] = [];
  const seenReceiptIds = new Set<string>();
  const expectedPlanCandidates = (
    input.candidate_locator?.release_units.map((unit) => ({
      release_unit: unit.release_unit,
      version: unit.version,
      commit: input.candidate_locator?.commit,
      tree: input.candidate_locator?.tree,
    })) ?? [input.candidate]
  ).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en'));
  const observedPlanCandidates: unknown[] = [];
  for (const verified of verifiedReceipts) {
    const receipt = verified.value;
    const receiptId = String(receipt['receipt_id']);
    if (seenReceiptIds.has(receiptId)) {
      receiptInvalid = true;
      continue;
    }
    seenReceiptIds.add(receiptId);
    const repositoryMatches = same(receipt['repository'], input.repository);
    const candidateMatches = expectedPlanCandidates.some((candidate) =>
      same(receipt['candidate'], candidate),
    );
    if (hasHistoricalPlans) {
      if (!repositoryMatches || !candidateMatches) receiptInvalid = true;
      if (verified.kind === 'release-plan-receipt')
        observedPlanCandidates.push(receipt['candidate']);
      // Recognize intact historical data, without verifying a provider, deriving
      // a current state, or promoting a mixed v1/v2 receipt set into authority.
      continue;
    }
    if (verified.kind === 'release-plan-receipt' && repositoryMatches && candidateMatches) {
      observedPlanCandidates.push(receipt['candidate']);
      derived.push({
        state: 'planned',
        receipt_kind: verified.kind,
        receipt_id: receipt['receipt_id'],
        receipt_digest_sha256: receipt['receipt_digest_sha256'],
        verified: true,
      });
    } else if (verified.kind === 'release-plan-receipt') {
      receiptInvalid = true;
    }
    if (verified.kind === 'release-offline-verification-receipt' && repositoryMatches) {
      const exported = stateReduction.ok
        ? input.states
            .map((state) => {
              try {
                return verifyReleaseStateIdentity(state);
              } catch {
                return null;
              }
            })
            .find(
              (state) =>
                state?.state === 'exported' &&
                same(stateReference(state), receipt['verified_state']),
            )
        : undefined;
      if (
        exported !== undefined &&
        exported !== null &&
        same(receipt['candidate'], exported.candidate) &&
        same(receipt['release_units'], offlineReleaseUnitsProjection(exported)) &&
        same(receipt['artifacts'], offlineArtifactProjection(exported)) &&
        same(receipt['artifact_sink_commit'], exported.artifact_sink) &&
        input.offline_receipt_verifier !== undefined &&
        same(
          verifyReceiptDocument(
            await input.offline_receipt_verifier.verify({
              repository: input.repository,
              candidate_locator: input.candidate_locator ?? {
                commit: input.candidate.commit,
                tree: input.candidate.tree,
                release_units: [
                  {
                    release_unit: input.candidate.release_unit,
                    version: input.candidate.version,
                    package_roster:
                      exported.release_units[0]?.packages.map((pkg) => {
                        const identity = packageManifest(pkg);
                        return {
                          package_id: pkg.package_id,
                          manifest_path:
                            identity !== null && 'path' in identity
                              ? identity.path
                              : 'package.json',
                          manifest_digest_sha256:
                            pkg.certification_manifest?.entries.find(
                              (entry) => entry.path === 'package.json',
                            )?.sha256 ??
                            identity?.sha256 ??
                            '0'.repeat(64),
                        };
                      }) ?? [],
                  },
                ],
              },
              exported_state: exported,
              receipt,
            }),
          ).value,
          receipt,
        )
      ) {
        derived.push({
          state: 'offline_verified',
          receipt_kind: verified.kind,
          receipt_id: receipt['receipt_id'],
          receipt_digest_sha256: receipt['receipt_digest_sha256'],
          verified: true,
        });
      } else {
        receiptInvalid = true;
      }
    } else if (verified.kind === 'release-offline-verification-receipt') {
      receiptInvalid = true;
    }
  }
  if (
    (observedPlanCandidates.length > 0 || head !== null || storeReduction.records.length > 0) &&
    !same(
      (hasHistoricalPlans
        ? [
            ...new Map(
              observedPlanCandidates.map((candidate) => [canonicalJson(candidate), candidate]),
            ).values(),
          ]
        : observedPlanCandidates
      ).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en')),
      expectedPlanCandidates,
    )
  ) {
    receiptInvalid = true;
  }
  if (stateReduction.ok && head !== null && input.states[0] !== undefined) {
    const suppliedPlans = verifiedPlanBindings(verifiedReceipts);
    const requiredPlans = recordedPlanBindings(verifyReleaseStateIdentity(input.states[0]));
    if (
      hasHistoricalPlans
        ? requiredPlans.length === 0 ||
          requiredPlans.some(
            (required) => !suppliedPlans.some((supplied) => same(required, supplied)),
          )
        : !same(suppliedPlans, requiredPlans)
    )
      receiptInvalid = true;
  }
  if (
    !blocked &&
    !receiptInvalid &&
    !hasHistoricalPlans &&
    head !== null &&
    input.publication_receipt !== undefined &&
    input.verify_signature !== undefined
  ) {
    published =
      (await verifyPublicationReceipt(input.publication_receipt, head, input.verify_signature)) ??
      published;
  }
  const publishedObserved = published['observed'] === true;
  if (publishedObserved) {
    const receipt = object(published['receipt']);
    derived.push({
      state: 'published',
      receipt_kind: 'release-publication-receipt',
      receipt_id: receipt['receipt_id'],
      receipt_digest_sha256: receipt['receipt_digest_sha256'],
      verified: true,
    });
  }
  if (blocked || receiptInvalid || hasHistoricalPlans) derived.length = 0;
  const hasPlan = derived.some((entry) => entry['state'] === 'planned');
  const hasOffline = derived.some((entry) => entry['state'] === 'offline_verified');
  let nextAction: ReleaseAction | null;
  let nextOutcome: 'ready' | 'awaiting-external-receipt' | 'complete' | 'blocked' | 'ambiguous';
  let blockedReason:
    | 'broken-chain'
    | 'stale-head'
    | 'orphan-record'
    | 'unterminated-attempt'
    | 'unknown-provider-result'
    | 'authorization-consumed'
    | 'fresh-exact-authorization-required'
    | 'candidate-identity-mismatch'
    | 'receipt-identity-mismatch'
    | 'legacy-plan-non-authoritative'
    | null = null;
  let blockedRequirements: readonly 'fresh_exact_owner_authorization_required'[] = [];
  if (blocked || receiptInvalid) {
    nextAction = null;
    nextOutcome = 'blocked';
    blockedReason = receiptInvalid
      ? 'receipt-identity-mismatch'
      : storeIdentityMismatch || identityMismatch || locatorMismatch
        ? 'candidate-identity-mismatch'
        : completionMismatch
          ? 'orphan-record'
          : headMismatch
            ? 'stale-head'
            : !storeReduction.ok || !stateReduction.ok
              ? 'broken-chain'
              : 'receipt-identity-mismatch';
  } else if (hasHistoricalPlans) {
    nextAction = null;
    nextOutcome = 'blocked';
    blockedReason = 'legacy-plan-non-authoritative';
  } else if (ambiguous) {
    nextAction = null;
    nextOutcome = 'ambiguous';
  } else if (remoteFailure) {
    nextAction = lastStore.action_id;
    nextOutcome = 'blocked';
    blockedReason = 'fresh-exact-authorization-required';
    blockedRequirements = ['fresh_exact_owner_authorization_required'];
  } else if (publishedObserved) {
    nextAction = null;
    nextOutcome = 'complete';
  } else if (head === null) {
    nextAction = hasPlan ? 'release preflight' : 'release plan';
    nextOutcome = 'ready';
  } else if (head.state === 'preflight_passed') {
    nextAction = 'release certify';
    nextOutcome = 'ready';
  } else if (head.state === 'certified') {
    nextAction = 'release prepare';
    nextOutcome = 'ready';
  } else if (head.state === 'prepared') {
    nextAction = 'release export';
    nextOutcome = 'ready';
  } else if (head.state === 'exported') {
    nextAction = hasOffline ? 'release evidence-publish' : 'release offline-verify';
    nextOutcome = 'ready';
  } else if (head.state === 'evidence_published') {
    nextAction = 'release publish';
    nextOutcome = 'ready';
  } else {
    nextAction = 'release resume';
    nextOutcome = 'awaiting-external-receipt';
  }
  const draft = {
    schemaVersion: '1.1.0',
    observation_kind: 'release-lifecycle-observation',
    repository: input.repository,
    candidate: input.candidate,
    verification_kernel: {
      kernel_id: 'devai.kernel.release-lifecycle-observation.v1',
      policy_source: 'law/policy/release-lifecycle.json#/observation_kernel',
      schema_validation_alone_derives_published: false,
    },
    head: head === null ? null : stateReference(head),
    derived_states: derived,
    published,
    next_action: nextAction,
    next_outcome: nextOutcome,
    ...(nextOutcome === 'ambiguous' &&
    lastStore?.record_kind === 'unknown-provider-result' &&
    lastStore.action_id === 'release prepare' &&
    lastStore.unknown?.artifact_sink !== undefined
      ? { reconciliation_requirements: ['external_sink_commit_reconciliation_required'] }
      : {}),
    ...(nextOutcome === 'blocked'
      ? {
          blocked_reason: blockedReason,
          blocked_requirements: blockedRequirements,
        }
      : {}),
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
  const observation = observationIdentity(draft);
  return parsers.releaseLifecycleObservation.parse(observation);
}
