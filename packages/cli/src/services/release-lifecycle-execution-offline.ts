import { parsers } from '@devai-nyx/schemas';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { createResolvedReleasePlanInputResolver } from './release-policy-resolution.js';
import { verifyReleasePolicyClosure } from './release-policy-closure.js';
import {
  reverifySinkArtifacts,
  verifyPortableReleaseMutationEvidence,
  type ReleaseMutationPlanReaders,
} from './release-prepare-kernel.js';
import { captureReleaseExportTranscriptLimits } from './release-export-transcript-v2.js';
import type { ReleaseExportTranscriptLimits } from './release-export-transcript.js';
import type {
  ReleaseLifecycleRequest,
  VerifiedReleaseOfflineContext,
  OfflineContextCapture,
  ReleaseLifecycleStateV2,
  VerifiedReceipt,
  ReleaseStateMaterial,
  TrustedArtifactReader,
  OfflineVerificationProvider,
  OfflineVerificationResult,
} from './release-lifecycle-execution-types.js';
import {
  same,
  object,
  without,
  validateReleaseLifecycleRequest,
  stateReference,
  offlineReleaseUnitsProjection,
  offlineArtifactProjection,
  verifiedPlanBindings,
  recordedPlanBindings,
} from './release-lifecycle-execution-support.js';
import { verifyReceiptDocument } from './release-lifecycle-execution-receipts.js';
import { verifyReleaseStateIdentity } from './release-lifecycle-execution-records.js';
import { assertMaterialBijection } from './release-lifecycle-execution-state.js';

const offlineContexts = new WeakMap<VerifiedReleaseOfflineContext, OfflineContextCapture>();
export function readVerifiedReleaseOfflineContext(
  context: VerifiedReleaseOfflineContext | undefined,
  request: ReleaseLifecycleRequest,
  state: ReleaseLifecycleStateV2,
): OfflineContextCapture {
  const captured = context === undefined ? undefined : offlineContexts.get(context);
  if (captured === undefined || !same(captured.request, request) || !same(captured.state, state))
    throw new Error('release-offline-verification-context-invalid');
  return JSON.parse(canonicalJson(captured)) as OfflineContextCapture;
}

/** Emit current mutation evidence only from this invocation's verified inputs. */
export function createVerifiedReleaseMutationCheck(
  context: VerifiedReleaseOfflineContext | undefined,
  request: ReleaseLifecycleRequest,
  state: ReleaseLifecycleStateV2,
): Readonly<Record<string, unknown>> {
  const capture = readVerifiedReleaseOfflineContext(context, request, state);
  return unitMutationOfflineCheck(capture.plan_receipts, state);
}

function unitMutationOfflineCheck(
  plans: readonly Readonly<Record<string, unknown>>[],
  state: ReleaseLifecycleStateV2,
): Readonly<Record<string, unknown>> {
  if (state.schemaVersion !== '2.1.0') throw new Error('release-offline-receipt-binding-invalid');
  const units = state.release_units.map((unit) => {
    const plan = plans.find(
      (entry) => object(entry['candidate'])['release_unit'] === unit.release_unit,
    );
    if (plan === undefined) throw new Error('release-offline-receipt-binding-invalid');
    return {
      release_unit: unit.release_unit,
      version: unit.version,
      plan_receipt_digest_sha256: plan['receipt_digest_sha256'],
      requirement: 'none',
      mutation_evidence: null,
    };
  });
  const projection = {
    check_id: 'mutation-semantics',
    evidence_kind: 'devai.release-unit-mutation-check.v1',
    status: units.every((unit) => unit.requirement === 'none') ? 'not-applicable' : 'pass',
    units,
  };
  return {
    ...projection,
    result_digest_sha256: canonicalSha256({
      repository: state.repository,
      candidate: state.candidate,
      ...projection,
    }),
  };
}

/** Pure offline verification boundary. It emits a receipt and never opens a store. */
export async function executeOfflineVerification(input: {
  readonly request: unknown;
  readonly exported_state: unknown;
  readonly provider?: OfflineVerificationProvider;
  readonly artifactReader?: TrustedArtifactReader;
  readonly policyClosures?: readonly Parameters<typeof verifyReleasePolicyClosure>[0][];
  readonly exportLimits?: ReleaseExportTranscriptLimits;
}): Promise<OfflineVerificationResult> {
  let request: ReleaseLifecycleRequest;
  let state: ReleaseLifecycleStateV2;
  let mutationPlan: ReleaseMutationPlanReaders;
  let planReceipts: readonly Readonly<Record<string, unknown>>[] = [];
  let exportLimits: ReleaseExportTranscriptLimits | undefined;
  try {
    exportLimits =
      input.exportLimits === undefined
        ? undefined
        : captureReleaseExportTranscriptLimits(input.exportLimits);
    request = validateReleaseLifecycleRequest(input.request, 'release offline-verify');
    state = verifyReleaseStateIdentity(input.exported_state);
    if (state.state !== 'exported') throw new Error('release-offline-state-mismatch');
    if (
      !same(state.repository, request.repository_locator) ||
      state.candidate.commit !== request.candidate_locator.commit ||
      state.candidate.tree !== request.candidate_locator.tree
    ) {
      throw new Error('release-request-identity-mismatch');
    }
    const closures = input.policyClosures;
    if (
      closures === undefined ||
      closures.length !== request.candidate_locator.release_units.length
    )
      throw new Error('rpl-policy-resolution-mismatch');
    const resolutions = closures.map((closure) => verifyReleasePolicyClosure(closure));
    const checkedPlans: VerifiedReceipt[] = closures.map((closure, index) => {
      const resolution = resolutions[index];
      if (resolution === undefined) throw new Error('rpl-policy-resolution-mismatch');
      if (!same(resolution.repository, request.repository_locator))
        throw new Error('rpl-policy-resolution-mismatch');
      return verifyReceiptDocument(
        closure.closure.plan,
        createResolvedReleasePlanInputResolver(resolution),
      );
    });
    mutationPlan = {
      resolve_plan_input: createResolvedReleasePlanInputResolver(resolutions),
      resolve_receipt: (locator) => {
        const value = checkedPlans.find(
          (entry) =>
            entry.value['receipt_id'] === locator.receipt_id &&
            entry.value['receipt_digest_sha256'] === locator.receipt_digest_sha256,
        )?.value;
        if (value === undefined) throw new Error('release-receipt-identity-mismatch');
        return JSON.parse(canonicalJson(value)) as unknown;
      },
    };
    planReceipts = checkedPlans.map(({ value }) => value);
    const supplied = checkedPlans
      .map(({ value }) => ({
        candidate: value['candidate'],
        receipt_id: value['receipt_id'],
        receipt_digest_sha256: value['receipt_digest_sha256'],
      }))
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), 'en'));
    const expected = request.candidate_locator.release_units
      .map((unit) => {
        const plan = checkedPlans.find(
          ({ value }) => object(value['candidate'])['release_unit'] === unit.release_unit,
        );
        const locator = request.receipt_locators?.find(
          (item) => item.receipt_id === plan?.value['receipt_id'],
        );
        if (locator === undefined) throw new Error('rpl-policy-resolution-mismatch');
        return {
          candidate: {
            release_unit: unit.release_unit,
            version: unit.version,
            commit: request.candidate_locator.commit,
            tree: request.candidate_locator.tree,
          },
          receipt_id: locator.receipt_id,
          receipt_digest_sha256: locator.receipt_digest_sha256,
        };
      })
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), 'en'));
    if (!same(supplied, expected)) throw new Error('rpl-policy-resolution-mismatch');
    if (!same(recordedPlanBindings(state), verifiedPlanBindings(checkedPlans)))
      throw new Error('release-receipt-identity-mismatch');
    assertMaterialBijection(request, 'release export', {
      release_units: state.release_units,
      inputs: [],
      evidence: {
        manifest_digest_sha256: '0'.repeat(64),
        receipt_digests: [],
        independently_checkable: true,
      },
      artifacts: state['artifacts'] as ReleaseStateMaterial['artifacts'],
      artifact_sink: state.artifact_sink,
    });
    await reverifySinkArtifacts(state, input.artifactReader, exportLimits);
  } catch (error) {
    return {
      ok: false,
      phase: 'validation',
      code: error instanceof Error ? error.message : 'release-offline-input-invalid',
    };
  }
  try {
    await verifyPortableReleaseMutationEvidence(
      request,
      state,
      input.artifactReader,
      mutationPlan,
      exportLimits,
    );
  } catch (error) {
    return {
      ok: false,
      phase: 'validation',
      code:
        error instanceof Error ? error.message : 'release-certification-generated-output-untrusted',
    };
  }
  if (input.provider === undefined) {
    return { ok: false, phase: 'provider', code: 'release-offline-verifier-provider-unavailable' };
  }
  let raw: unknown;
  try {
    const context: VerifiedReleaseOfflineContext = Object.freeze({
      kind: 'verified-release-offline-context',
    });
    offlineContexts.set(
      context,
      JSON.parse(
        canonicalJson({ request, state, plan_receipts: planReceipts }),
      ) as OfflineContextCapture,
    );
    try {
      raw = await input.provider(request, state, context);
    } finally {
      offlineContexts.delete(context);
    }
  } catch {
    return { ok: false, phase: 'provider', code: 'release-offline-verifier-failed' };
  }
  const parsed =
    parsers.releaseOfflineVerificationReceipt.safeParse<Readonly<Record<string, unknown>>>(raw);
  if (!parsed.ok)
    return { ok: false, phase: 'validation', code: 'release-offline-receipt-invalid' };
  const receipt = parsed.value;
  const digest = canonicalSha256(without(receipt, ['receipt_id', 'receipt_digest_sha256']));
  const expectedState = stateReference(state);
  const trust = request.destination?.trust;
  const releaseUnits = receipt['release_units'];
  const mutationCheck = object((receipt['checks'] as readonly unknown[])[8]);
  if (mutationCheck['evidence_kind'] === 'devai.release-unit-mutation-check.v1') {
    try {
      if (!same(mutationCheck, unitMutationOfflineCheck(planReceipts, state))) {
        return { ok: false, phase: 'validation', code: 'release-offline-receipt-binding-invalid' };
      }
    } catch {
      return { ok: false, phase: 'validation', code: 'release-offline-receipt-binding-invalid' };
    }
  }
  const trustMatches =
    trust !== undefined &&
    Array.isArray(releaseUnits) &&
    releaseUnits.every((unit) => {
      const packages = object(unit)['packages'];
      return Array.isArray(packages) && packages.every((pkg) => same(object(pkg)['trust'], trust));
    });
  if (
    receipt['schemaVersion'] !== state.schemaVersion ||
    receipt['receipt_digest_sha256'] !== digest ||
    receipt['receipt_id'] !== `ROV-${digest.slice(0, 16)}` ||
    receipt['verdict'] !== 'pass' ||
    receipt['state_observed'] !== 'offline_verified' ||
    !same(receipt['repository'], state.repository) ||
    !same(receipt['candidate'], state.candidate) ||
    !same(receipt['verified_state'], expectedState) ||
    !same(releaseUnits, offlineReleaseUnitsProjection(state)) ||
    !same(receipt['artifacts'], offlineArtifactProjection(state)) ||
    !same(receipt['artifact_sink_commit'], state.artifact_sink) ||
    !trustMatches
  ) {
    return { ok: false, phase: 'validation', code: 'release-offline-receipt-binding-invalid' };
  }
  return { ok: true, receipt };
}
