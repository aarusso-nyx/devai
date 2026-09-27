import { canonicalJson } from '@devai-nyx/utils';
import {
  RELEASE_EXPORT_SPEC_ID,
  RELEASE_EXPORT_SPEC_DIGEST,
  RELEASE_EXPORT_TRANSCRIPT_FORMAT,
  encodeReleaseExportTranscript,
  verifyReleaseExportProviderResult,
  type ReleaseExportTranscriptLimits,
} from './release-export-transcript.js';
import {
  RELEASE_EXPORT_SPEC_V3_ID,
  RELEASE_EXPORT_SPEC_V3_DIGEST,
  RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
  encodeReleaseExportTranscriptV2,
  verifyReleaseExportProviderResultV2,
  verifyReleaseExportProviderResultSetV2,
} from './release-export-transcript-v2.js';
import {
  RELEASE_EXPORT_SPEC_V4_ID,
  RELEASE_EXPORT_SPEC_V4_DIGEST,
  RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT,
  encodeReleaseExportTranscriptV3,
  verifyReleaseExportProviderResultV3,
  verifyReleaseExportProviderResultSetV3,
} from './release-export-transcript-v3.js';
import type { ReleaseExportMutationUnitProjection } from './release-export-mutation-contract.js';
import type { ReleaseExportArtifactCommitManifest } from './release-export-artifact-store.js';
import type {
  ReleaseLifecycleStateV2,
  TrustedArtifactReader,
} from './release-lifecycle-execution.js';
import {
  same,
  utf8Compare,
  sha256,
  object,
  RELEASE_PACK_SPEC_ID,
  RELEASE_PACK_SPEC_DIGEST,
  verifyReceiptBytes,
  COMMIT_PROTOCOL,
  opaqueIdentity,
  artifactProjectionKey,
} from './release-prepare-kernel-contract.js';
import { verifyPreparedPackageManifest } from './release-prepare-kernel-prepared.js';

/** Byte and membership continuity only; neither a signature nor a policy verdict. */
export async function reverifyExportContinuity(
  state: ReleaseLifecycleStateV2,
  manifest: Readonly<Record<string, unknown>>,
  manifestBytes: Buffer,
  reader: TrustedArtifactReader,
  observed: ReadonlyMap<string, Buffer>,
  exportLimits?: ReleaseExportTranscriptLimits,
): Promise<void> {
  const fail = (): never => {
    throw new Error('release-downstream-artifact-reverification-failed');
  };
  const parse = (value: Buffer): Readonly<Record<string, unknown>> => {
    const parsed = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)));
    if (!value.equals(Buffer.from(canonicalJson(parsed), 'utf8'))) fail();
    return parsed;
  };
  const exported = manifest as unknown as ReleaseExportArtifactCommitManifest;
  const forward = exported.export_spec_id === RELEASE_EXPORT_SPEC_V4_ID;
  const current = forward || exported.export_spec_id === RELEASE_EXPORT_SPEC_V3_ID;
  const specId = forward
    ? RELEASE_EXPORT_SPEC_V4_ID
    : current
      ? RELEASE_EXPORT_SPEC_V3_ID
      : RELEASE_EXPORT_SPEC_ID;
  const specDigest = forward
    ? RELEASE_EXPORT_SPEC_V4_DIGEST
    : current
      ? RELEASE_EXPORT_SPEC_V3_DIGEST
      : RELEASE_EXPORT_SPEC_DIGEST;
  const sink = state.artifact_sink;
  const binding = exported.binding;
  const parent = exported.parent_artifact_sink;
  if (sink == null) return fail();
  if (
    !same(parse(manifestBytes), manifest) ||
    !same(manifest, {
      schemaVersion: '1.0.0',
      kind: 'release-artifact-sink-commit-manifest',
      sink_id: sink.sink_id,
      transaction_handle: sink.transaction_handle,
      repository: state.repository,
      candidate: { commit: state.candidate.commit, tree: state.candidate.tree },
      export_spec_id: specId,
      export_spec_digest_sha256: specDigest,
      parent_artifact_sink: parent,
      binding,
      artifacts: state['artifacts'],
    }) ||
    parent.sink_id !== sink.sink_id ||
    parent.transaction_handle === sink.transaction_handle ||
    parent.committed_manifest_handle === sink.committed_manifest_handle ||
    sink.commit_protocol !== COMMIT_PROTOCOL ||
    !same(binding.parent_artifact_sink, parent) ||
    !same(binding.repository, state.repository) ||
    !same(binding.candidate, exported.candidate) ||
    binding.sink_id !== sink.sink_id ||
    binding.export_spec_digest_sha256 !== specDigest
  )
    fail();
  const planBindings = (state['bound_receipts'] as readonly Record<string, unknown>[]).filter(
    (entry) => entry['kind'] === 'release-plan-receipt',
  );
  // Later actions bind their own required receipts (notably offline verification), not a
  // fabricated copy of the export plan receipt. Their exact sink/parent chain remains pinned.
  if (
    (state.state === 'exported' || planBindings.length > 0) &&
    !same(planBindings, [
      {
        kind: 'release-plan-receipt',
        receipt_id: `RPL-${binding.plan_receipt_digest_sha256.slice(0, 16)}`,
        receipt_digest_sha256: binding.plan_receipt_digest_sha256,
        verdict: 'pass',
      },
    ])
  )
    fail();
  const packages = state.release_units
    .flatMap((unit) => unit.packages)
    .sort((a, b) => utf8Compare(a.package_id, b.package_id));
  if (
    packages.length === 0 ||
    new Set(packages.map((pkg) => pkg.package_id)).size !== packages.length ||
    !Array.isArray(binding.closure_inputs) ||
    binding.closure_inputs.length !== packages.length
  )
    fail();
  const parents = packages
    .flatMap((pkg) => [pkg.package_manifest, pkg.package_tarball, pkg.package_sbom])
    .map(opaqueIdentity)
    .sort((a, b) => utf8Compare(artifactProjectionKey(a), artifactProjectionKey(b)));
  const providerSizes = packages.map((pkg) => opaqueIdentity(pkg.provider_result).size_bytes);
  // Bounds derive from the already-pinned artifact sizes, never from embedded transcript text.
  // The protected reader/host separately imposes its absolute storage/transport limits.
  const legacyLimits = {
    maximum_transcript_bytes: Math.max(...providerSizes),
    maximum_provider_result_bytes: Math.max(...providerSizes),
    maximum_packages: packages.length,
  };
  const limits = current ? (exportLimits ?? fail()) : legacyLimits;
  if (providerSizes.some((size) => size > limits.maximum_provider_result_bytes)) fail();
  const { export_spec_digest_sha256, closure_inputs } = binding;
  const transcriptBinding = {
    action_id: binding.action_id,
    repository: binding.repository,
    candidate: binding.candidate,
    plan_receipt_digest_sha256: binding.plan_receipt_digest_sha256,
    parent_artifact_sink: binding.parent_artifact_sink,
    sink_id: binding.sink_id,
    destination: binding.destination,
    trust: binding.trust,
    attempt_id: binding.attempt_id,
  };
  if (export_spec_digest_sha256 !== specDigest) fail();
  const commonTranscript = {
    version: RELEASE_EXPORT_TRANSCRIPT_FORMAT,
    binding: transcriptBinding,
    parent: parents,
    closures: packages.map((pkg, index) => {
      const closure = closure_inputs[index];
      const evidence = opaqueIdentity(pkg.evidence_manifest);
      if (
        closure === undefined ||
        !same(pkg.trust, binding.trust) ||
        !same(closure, {
          package_id: pkg.package_id,
          ...(current
            ? {
                release_unit:
                  state.release_units.find((unit) =>
                    unit.packages.some((entry) => entry.package_id === pkg.package_id),
                  )?.release_unit ?? fail(),
              }
            : {}),
          sha256: evidence.sha256,
          size_bytes: evidence.size_bytes,
          expected_installed_package: closure.expected_installed_package,
          policy_resolution_digest_sha256: closure.policy_resolution_digest_sha256,
        })
      )
        return fail();
      return {
        package_id: pkg.package_id,
        evidence_manifest: evidence,
        expected_installed_package: closure.expected_installed_package,
        policy_resolution_digest_sha256: closure.policy_resolution_digest_sha256,
      };
    }),
    destination: binding.destination,
    trust: binding.trust,
  };
  let transcript: Buffer;
  if (current) {
    if (!('mutation_units' in binding)) return fail();
    const units: ReleaseExportMutationUnitProjection[] = state.release_units
      .map((unit) => {
        const closure = unit.mutation_evidence;
        if (closure == null) return { release_unit: unit.release_unit, mutation_evidence: null };
        const {
          member_projection_digest_sha256,
          output_contract_digest_sha256: _control,
          ...unitBinding
        } = closure.receipt.referent;
        const closureBytes = Buffer.from(canonicalJson(closure));
        const receiptBytes = Buffer.from(canonicalJson(closure.receipt));
        return {
          release_unit: unit.release_unit,
          mutation_evidence: {
            carrier_package_id:
              unit.packages.map((pkg) => pkg.package_id).sort(utf8Compare)[0] ?? fail(),
            binding: unitBinding,
            closure: { sha256: sha256(closureBytes), size_bytes: closureBytes.length },
            receipt: {
              sha256: sha256(receiptBytes),
              size_bytes: receiptBytes.length,
              receipt_digest_sha256: closure.receipt.receipt_digest_sha256,
            },
            output_contract: closure.output_contract,
            members: closure.members,
            member_projection_digest_sha256,
          },
        };
      })
      .sort((a, b) => utf8Compare(a.release_unit, b.release_unit));
    if (!same(units, binding.mutation_units)) fail();
    const shared = {
      ...commonTranscript,
      mutation_units: units,
      closures: commonTranscript.closures.map((entry) => ({
        ...entry,
        release_unit:
          state.release_units.find((unit) =>
            unit.packages.some((pkg) => pkg.package_id === entry.package_id),
          )?.release_unit ?? fail(),
      })),
    };
    transcript = forward
      ? encodeReleaseExportTranscriptV3(
          {
            ...shared,
            version: RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT,
            certification_units:
              'certification_units' in binding ? binding.certification_units : fail(),
          },
          limits,
        )
      : encodeReleaseExportTranscriptV2(
          { ...shared, version: RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT },
          limits,
        );
  } else {
    if ('mutation_units' in binding) fail();
    transcript = encodeReleaseExportTranscript(
      { ...commonTranscript, version: RELEASE_EXPORT_TRANSCRIPT_FORMAT },
      limits,
    );
  }
  // Transcript validation above closes every parent identity before it reaches the reader.
  if (
    observed.has(parent.committed_manifest_handle) ||
    observed.has(sink.committed_manifest_handle)
  )
    fail();
  const parentBytes = await verifyReceiptBytes(
    reader,
    {
      sink_id: parent.sink_id,
      opaque_handle: parent.committed_manifest_handle,
      sha256: parent.committed_manifest_sha256,
      size_bytes: parent.committed_manifest_size_bytes,
    },
    'release-downstream-artifact-reverification-failed',
  );
  if (
    !same(parse(parentBytes), {
      schemaVersion: '1.0.0',
      kind: 'release-artifact-sink-commit-manifest',
      sink_id: parent.sink_id,
      transaction_handle: parent.transaction_handle,
      repository: state.repository,
      candidate: exported.candidate,
      pack_spec_id: RELEASE_PACK_SPEC_ID,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      artifacts: parents,
    })
  )
    fail();
  for (const unit of state.release_units) {
    for (const pkg of unit.packages) {
      const identity = opaqueIdentity(pkg.package_manifest);
      const value = observed.get(identity.opaque_handle);
      if (value === undefined) return fail();
      verifyPreparedPackageManifest({
        bytes: value,
        package: pkg,
        version: unit.version,
        candidate: exported.candidate,
      });
    }
  }
  let signature: string | undefined;
  for (const pkg of packages) {
    const identity = opaqueIdentity(pkg.provider_result);
    const value = observed.get(identity.opaque_handle);
    if (value === undefined) return fail();
    const result = parse(value);
    if (typeof result['signature'] !== 'string') fail();
    signature ??= result['signature'] as string;
    (forward
      ? verifyReleaseExportProviderResultV3
      : current
        ? verifyReleaseExportProviderResultV2
        : verifyReleaseExportProviderResult)(
      value,
      { package_id: pkg.package_id, transcript, signature },
      limits,
    );
  }
  if (current)
    (forward ? verifyReleaseExportProviderResultSetV3 : verifyReleaseExportProviderResultSetV2)(
      packages.map(
        (pkg) => observed.get(opaqueIdentity(pkg.provider_result).opaque_handle) ?? fail(),
      ),
      { transcript, signature: signature ?? fail() },
      limits,
    );
}
