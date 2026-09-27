import { parsers } from '@devai-nyx/schemas';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { verifyResolvedReleasePlanReceipt } from './release-lifecycle.js';
import { resolutionForReleasePlanInputResolver } from './release-policy-resolution.js';
import type {
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
  ReleasePlanInputResolver,
  VerifiedReceipt,
  ReceiptResolver,
  ReleaseMutationRequirement,
  PublicationSignatureVerifier,
  TrustIdentity,
} from './release-lifecycle-execution-types.js';
import {
  same,
  object,
  without,
  validateReleaseLifecycleRequest,
  stateReference,
} from './release-lifecycle-execution-support.js';

function verifyPlanReceiptSemantics(
  receipt: Readonly<Record<string, unknown>>,
  resolveInput: ReleasePlanInputResolver | undefined,
): void {
  if (receipt['schemaVersion'] !== '2.0.0') throw new Error('rpl-legacy-plan-non-authoritative');
  const resolution = resolutionForReleasePlanInputResolver(resolveInput, receipt);
  if (resolution === undefined || !verifyResolvedReleasePlanReceipt({ receipt, resolution })) {
    throw new Error('rpl-semantic-verification-not-performed');
  }
}

export function verifyReceiptDocument(
  valueInput: unknown,
  resolvePlanInput?: ReleasePlanInputResolver,
): VerifiedReceipt {
  const value = object(valueInput);
  const kind = value['receipt_kind'];
  if (kind !== 'release-plan-receipt' && kind !== 'release-offline-verification-receipt') {
    throw new Error('release-receipt-identity-mismatch');
  }
  if (kind === 'release-plan-receipt' && value['schemaVersion'] === '1.0.0')
    throw new Error('rpl-legacy-plan-non-authoritative');
  if (kind === 'release-plan-receipt' && value['schemaVersion'] !== '2.0.0')
    throw new Error('release-receipt-identity-mismatch');
  const resolution = resolutionForReleasePlanInputResolver(resolvePlanInput, value);
  if (kind === 'release-plan-receipt') {
    if (resolution === undefined) throw new Error('rpl-semantic-verification-not-performed');
    resolution.tools.parse('release-plan-receipt-v2.schema.json', value);
  }
  const parsed =
    kind === 'release-plan-receipt'
      ? { ok: true as const, value }
      : parsers.releaseOfflineVerificationReceipt.safeParse<Readonly<Record<string, unknown>>>(
          value,
        );
  if (!parsed.ok) throw new Error('release-receipt-identity-mismatch');
  const receipt = parsed.value;
  const digest = canonicalSha256(without(receipt, ['receipt_id', 'receipt_digest_sha256']));
  const prefix = kind === 'release-plan-receipt' ? 'RPL' : 'ROV';
  if (
    receipt['receipt_digest_sha256'] !== digest ||
    receipt['receipt_id'] !== `${prefix}-${digest.slice(0, 16)}` ||
    receipt['verdict'] !== 'pass'
  ) {
    throw new Error(
      receipt['verdict'] === 'pass'
        ? 'release-receipt-identity-mismatch'
        : 'release-receipt-verdict-invalid',
    );
  }
  if (kind === 'release-plan-receipt') verifyPlanReceiptSemantics(receipt, resolvePlanInput);
  return { kind, value: receipt };
}

/** Integrity-only historical inspection. Never called by a current execution gate. */
export function readHistoricalPlanReceipt(value: unknown): VerifiedReceipt {
  const parsed = parsers.releasePlanReceipt.safeParse<Readonly<Record<string, unknown>>>(value);
  if (!parsed.ok) throw new Error('release-receipt-identity-mismatch');
  const receipt = parsed.value;
  const digest = canonicalSha256(without(receipt, ['receipt_id', 'receipt_digest_sha256']));
  if (
    receipt['schemaVersion'] !== '1.0.0' ||
    receipt['receipt_digest_sha256'] !== digest ||
    receipt['receipt_id'] !== `RPL-${digest.slice(0, 16)}`
  )
    throw new Error('release-receipt-identity-mismatch');
  return { kind: 'release-plan-receipt', value: receipt };
}

export function verifyBoundReceipts(
  request: ReleaseLifecycleRequest,
  resolver?: ReceiptResolver,
  resolvePlanInput?: ReleasePlanInputResolver,
): readonly VerifiedReceipt[] {
  const locators = request.receipt_locators ?? [];
  if (locators.length === 0) return [];
  if (resolver === undefined) throw new Error('release-receipt-provider-unavailable');
  const verified: VerifiedReceipt[] = [];
  for (const locator of locators) {
    const receipt = verifyReceiptDocument(resolver(locator), resolvePlanInput);
    const value = receipt.value;
    if (
      receipt.kind !== locator.kind ||
      value['receipt_id'] !== locator.receipt_id ||
      value['receipt_digest_sha256'] !== locator.receipt_digest_sha256
    ) {
      throw new Error('release-receipt-identity-mismatch');
    }
    const repository = object(value['repository']);
    const candidate = object(value['candidate']);
    const candidateMatch = request.candidate_locator.release_units.some(
      (unit) =>
        candidate['release_unit'] === unit.release_unit && candidate['version'] === unit.version,
    );
    if (
      !same(repository, request.repository_locator) ||
      candidate['commit'] !== request.candidate_locator.commit ||
      candidate['tree'] !== request.candidate_locator.tree ||
      !candidateMatch
    ) {
      throw new Error('release-receipt-identity-mismatch');
    }
    verified.push(receipt);
  }
  const planCandidates = verified
    .filter((receipt) => receipt.kind === 'release-plan-receipt')
    .map((receipt) => receipt.value['candidate'])
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en'));
  if (
    planCandidates.length > 0 &&
    !same(
      planCandidates,
      request.candidate_locator.release_units
        .map((unit) => ({
          release_unit: unit.release_unit,
          version: unit.version,
          commit: request.candidate_locator.commit,
          tree: request.candidate_locator.tree,
        }))
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en')),
    )
  ) {
    throw new Error('release-receipt-identity-mismatch');
  }
  return verified;
}

/** Derive evidence requirements from replayed, candidate-bound plans, never supplied evidence.
 * Task-policy identities are bound separately by the protected certification provider. */
export function resolveReleaseMutationRequirements(
  requestInput: ReleaseLifecycleRequest,
  input: {
    readonly resolve_receipt?: ReceiptResolver;
    readonly resolve_plan_input?: ReleasePlanInputResolver;
  },
): readonly ReleaseMutationRequirement[] {
  const request = validateReleaseLifecycleRequest(JSON.parse(canonicalJson(requestInput)));
  const resolveReceipt = input.resolve_receipt;
  const receipts = verifyBoundReceipts(
    request,
    resolveReceipt === undefined
      ? undefined
      : (locator) => JSON.parse(canonicalJson(resolveReceipt(locator))) as unknown,
    input.resolve_plan_input,
  );
  if (
    receipts.length === 0 ||
    receipts.length !== request.candidate_locator.release_units.length ||
    receipts.some((receipt) => receipt.kind !== 'release-plan-receipt')
  )
    throw new Error('release-receipt-identity-mismatch');
  return Object.freeze(
    request.candidate_locator.release_units.map((unit) => {
      const receipt = receipts.find(
        (entry) => object(entry.value['candidate'])['release_unit'] === unit.release_unit,
      )?.value;
      if (receipt === undefined) throw new Error('release-receipt-identity-mismatch');
      return Object.freeze({ release_unit: unit.release_unit, binding: null });
    }),
  );
}

export function observationIdentity(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const digest = canonicalSha256(value);
  return {
    ...value,
    observation_id: `RLO-${digest.slice(0, 16)}`,
    observation_digest_sha256: digest,
  };
}

export async function verifyPublicationReceipt(
  receiptInput: unknown,
  state: ReleaseLifecycleStateV2,
  verifySignature: PublicationSignatureVerifier,
): Promise<Readonly<Record<string, unknown>> | null> {
  const parsed =
    parsers.releasePublicationReceipt.safeParse<Readonly<Record<string, unknown>>>(receiptInput);
  if (!parsed.ok || state.state !== 'publication_dispatched') return null;
  const receipt = parsed.value;
  const trustWithSignature = object(receipt['trust']);
  const trust: TrustIdentity = {
    trust_root_id: String(trustWithSignature['trust_root_id']),
    trust_store_digest_sha256: String(trustWithSignature['trust_store_digest_sha256']),
    key_id: String(trustWithSignature['key_id']),
    signature_algorithm: trustWithSignature[
      'signature_algorithm'
    ] as TrustIdentity['signature_algorithm'],
  };
  const receiptProjection = without(receipt, ['receipt_id', 'receipt_digest_sha256']);
  const signedTrust = without(object(receiptProjection['trust']), [
    'signature',
    'signed_payload_digest_sha256',
  ]);
  const signedDigest = canonicalSha256({ ...receiptProjection, trust: signedTrust });
  const wholeDigest = canonicalSha256(without(receipt, ['receipt_digest_sha256']));
  const expectation = object(state['publication_expectation']);
  const expectedWorkflow = object(expectation['workflow']);
  const receiptWorkflow = object(receipt['workflow']);
  const workflowProjection = {
    repository: receiptWorkflow['repository'],
    workflow_path: receiptWorkflow['workflow_path'],
    workflow_sha: receiptWorkflow['workflow_sha'],
    protected_environment: receiptWorkflow['protected_environment'],
    protected: receiptWorkflow['protected'],
  };
  if (
    receipt['outcome'] !== 'published' ||
    receipt['attests_state'] !== 'published' ||
    receipt['receipt_id'] !== `RPU-${signedDigest.slice(0, 16)}` ||
    receipt['receipt_digest_sha256'] !== wholeDigest ||
    trustWithSignature['signed_payload_digest_sha256'] !== signedDigest ||
    !same(receipt['repository'], state.repository) ||
    !same(receipt['candidate'], state.candidate) ||
    !same(receipt['dispatched_state'], stateReference(state)) ||
    !same(receipt['artifacts'], state['artifacts']) ||
    !same(receipt['publication'], expectation['destination']) ||
    !same(workflowProjection, expectedWorkflow) ||
    !same(trust, expectation['trust']) ||
    typeof trustWithSignature['signature'] !== 'string' ||
    !(await verifySignature({
      signed_payload_digest_sha256: signedDigest,
      signature: trustWithSignature['signature'],
      trust,
    }))
  ) {
    return null;
  }
  return {
    observed: true,
    receipt: {
      kind: 'release-publication-receipt',
      receipt_id: receipt['receipt_id'],
      receipt_digest_sha256: receipt['receipt_digest_sha256'],
      ...trust,
      signature_verified: true,
    },
    verified_against: {
      ...stateReference(state),
      candidate_identity_verified: true,
      artifact_identity_verified: true,
      destination_identity_verified: true,
      workflow_identity_verified: true,
      trust_identity_verified: true,
    },
  };
}
