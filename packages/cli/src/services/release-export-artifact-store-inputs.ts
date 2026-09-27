import { createProtectedExportSinkAdapter } from '@devai-nyx/authority';
import { createDurableReleaseContentStore } from './release-content-store.js';
import {
  verifyReleaseStateIdentity,
  type OpaqueArtifactIdentity,
  type TrustedArtifactReader,
} from './release-lifecycle-execution.js';
import { assertBoundReleaseHostPackageSnapshot } from './release-host-package-binding.js';
import type { ReleasePolicyExpectedIdentity } from './release-policy-resolution.js';
import { RELEASE_EXPORT_SPEC_ID, RELEASE_EXPORT_SPEC_DIGEST } from './release-export-transcript.js';
import {
  RELEASE_EXPORT_SPEC_V3_ID,
  RELEASE_EXPORT_SPEC_V3_DIGEST,
} from './release-export-transcript-v2.js';
import {
  RELEASE_EXPORT_SPEC_V4_DIGEST,
  RELEASE_EXPORT_SPEC_V4_ID,
} from './release-export-transcript-v3.js';
import type {
  ProtectedReleaseExportBinding,
  ReadInput,
  ReleaseExportArtifactObjectReceipt,
  ReleaseExportArtifactStoreOptions,
} from './release-export-artifact-store-types.js';
import {
  closed,
  copy,
  fail,
  object,
  order,
  same,
} from './release-export-artifact-store-support.js';

/**
 * Validate the export store options and capture the binding, physical store, prepared
 * state, packages, parents, limits and export spec they select, creating the export sink
 * adapter for that binding.
 */
export function captureExportStoreInputs(options: ReleaseExportArtifactStoreOptions) {
  const binding = copy(options.binding);
  const forward = binding.export_spec_digest_sha256 === RELEASE_EXPORT_SPEC_V4_DIGEST;
  const current = forward || binding.export_spec_digest_sha256 === RELEASE_EXPORT_SPEC_V3_DIGEST;
  closed(options, [
    'root',
    'sink_id',
    'repository_roots',
    'max_blob_bytes',
    'binding',
    'prepared_state',
    'parent_reader',
    'implementation',
    'closures',
    'closure_limits',
    'transport_limits',
    'transcript_limits',
    ...(current ? ['mutation_evidence'] : []),
    ...(forward ? ['certification_evidence'] : []),
  ]);
  assertBoundReleaseHostPackageSnapshot(options.implementation);
  const implementation = options.implementation;
  const adapter = createProtectedExportSinkAdapter(binding);
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
  const mutationEvidence = current ? (options.mutation_evidence ?? fail()) : undefined;
  const certificationEvidence = forward ? (options.certification_evidence ?? fail()) : undefined;
  const physical = copy({
    root: options.root,
    sink_id: options.sink_id,
    repository_roots: options.repository_roots,
    max_blob_bytes: options.max_blob_bytes,
  });
  const state = verifyReleaseStateIdentity(copy(options.prepared_state));
  const limits = copy(options.closure_limits);
  closed(limits, [
    'maximum_archive_bytes',
    'maximum_unpacked_bytes',
    'maximum_git_bytes',
    'maximum_git_entries',
  ]);
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) fail();
  const transport = copy(options.transport_limits);
  const transcriptLimits = copy(options.transcript_limits);
  closed(transcriptLimits, [
    'maximum_transcript_bytes',
    'maximum_provider_result_bytes',
    'maximum_packages',
  ]);
  if (
    Object.values(transcriptLimits).some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff,
    )
  )
    fail();
  const effectiveTranscriptLimits = {
    ...transcriptLimits,
    maximum_provider_result_bytes: Math.min(
      transcriptLimits.maximum_provider_result_bytes,
      physical.max_blob_bytes,
    ),
  };
  const readParent = options.parent_reader.readArtifact.bind(options.parent_reader);
  if (
    state.schemaVersion !== '2.1.0' ||
    state.state !== 'prepared' ||
    state.action_id !== 'release prepare' ||
    !same(state.repository, binding.repository) ||
    !same({ commit: state.candidate.commit, tree: state.candidate.tree }, binding.candidate) ||
    !same(state.artifact_sink, binding.parent_artifact_sink) ||
    physical.sink_id !== binding.sink_id ||
    binding.export_spec_digest_sha256 !== specDigest
  )
    fail();
  const plans = state['bound_receipts'];
  if (!Array.isArray(plans)) fail();
  const boundPlans = plans.filter(
    (entry: unknown) => object(entry)['kind'] === 'release-plan-receipt',
  );
  if (
    boundPlans.length !== 1 ||
    !same(boundPlans[0], {
      kind: 'release-plan-receipt',
      receipt_id: `RPL-${binding.plan_receipt_digest_sha256.slice(0, 16)}`,
      receipt_digest_sha256: binding.plan_receipt_digest_sha256,
      verdict: 'pass',
    })
  )
    fail();
  const packages = state.release_units
    .flatMap((unit) =>
      unit.packages.map((pkg) => ({
        unit: unit.release_unit,
        version: unit.version,
        pkg,
      })),
    )
    .sort((a, b) => Buffer.compare(Buffer.from(a.pkg.package_id), Buffer.from(b.pkg.package_id)));
  if (
    packages.length === 0 ||
    packages.length > transcriptLimits.maximum_packages ||
    new Set(packages.map(({ pkg }) => pkg.package_id)).size !== packages.length
  )
    fail();
  const parent: OpaqueArtifactIdentity[] = [];
  for (const { pkg } of packages) {
    if (pkg.evidence_manifest !== null || pkg.provider_result !== null || pkg.trust !== null)
      fail();
    for (const [kind, entry] of [
      ['package-manifest', pkg.package_manifest],
      ['package-tarball', pkg.package_tarball],
      ['package-sbom', pkg.package_sbom],
    ] as const) {
      if (entry == null || entry.kind !== kind || entry.sink_id !== binding.sink_id) fail();
      parent.push(entry);
    }
  }
  const parents = order(parent);
  if (
    new Set(parents.map((entry) => entry.opaque_handle)).size !== parents.length ||
    !same(state['artifacts'], parents)
  )
    fail();
  const parentIdentities = new Map(parents.map((entry) => [entry.opaque_handle, entry]));
  return {
    binding,
    physical,
    parentIdentities,
    readParent,
    mutationEvidence,
    state,
    certificationEvidence,
    packages,
    transport,
    implementation,
    limits,
    current,
    specId: specId as typeof specId,
    specDigest: specDigest as typeof specDigest,
    parents,
    forward,
    effectiveTranscriptLimits,
    adapter,
  };
}

/** Everything the export store closures read, named once. */
export type ExportStoreScope = ReturnType<typeof captureExportStoreInputs> & {
  readonly closures: readonly {
    readonly package_id: string;
    readonly bytes: Buffer;
    readonly expected: ReleasePolicyExpectedIdentity;
  }[];
  readonly readObject: (receipt: ReleaseExportArtifactObjectReceipt) => Buffer;
  readonly transcriptFor: (receipts: readonly ReleaseExportArtifactObjectReceipt[]) => Buffer;
  readonly manifestFor: (
    transaction: string,
    receipts: readonly ReleaseExportArtifactObjectReceipt[],
  ) => Buffer;
  readonly verifyParent: (withMutation?: boolean) => Promise<void>;
  readonly checkedParentReader: TrustedArtifactReader;
  readonly split: (handle: string) => { transaction: string; id: string; sha256: string };
  readonly directoryFor: (transaction: string) => string;
  readonly store: ReturnType<typeof createDurableReleaseContentStore>;
  readonly reservationPath: string;
  readonly reservation: (transaction: string) => {
    binding: ProtectedReleaseExportBinding;
    transaction_handle: string;
    prepared_state_id: string;
    prepared_state_digest_sha256: string;
  };
  readonly assertAbsent: (path: string) => void;
  readonly receiptFor: (handle: string) => ReleaseExportArtifactObjectReceipt;
  readonly readCommitted: (input: ReadInput) => Promise<Buffer>;
  readonly owner: object;
};
