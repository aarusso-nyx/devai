import { join } from 'node:path';
import type { ArtifactSinkCommitReceipt } from './release-prepare-kernel.js';
import {
  encodeReleaseExportTranscript,
  verifyReleaseExportProviderResult,
  type ReleaseExportProviderResult,
  type ReleaseExportTranscript,
} from './release-export-transcript.js';
import {
  RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
  encodeReleaseExportTranscriptV2,
  verifyReleaseExportProviderResultV2,
  verifyReleaseExportProviderResultSetV2,
} from './release-export-transcript-v2.js';
import {
  encodeReleaseExportTranscriptV3,
  verifyReleaseExportProviderResultV3,
  verifyReleaseExportProviderResultSetV3,
  RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT,
} from './release-export-transcript-v3.js';
import type {
  ProtectedReleaseExportBindingV3,
  ReadInput,
  ReleaseExportArtifactCommitManifest,
  ReleaseExportArtifactObjectReceipt,
} from './release-export-artifact-store-types.js';
import {
  bytes,
  closed,
  fail,
  identity,
  order,
  parse,
  same,
} from './release-export-artifact-store-support.js';
import type { ExportStoreScope } from './release-export-artifact-store-inputs.js';

/** Transcript builder: the canonical export transcript over the committed object receipts. */
export function transcriptBuilder(
  scope: Pick<
    ExportStoreScope,
    | 'binding'
    | 'parents'
    | 'closures'
    | 'readObject'
    | 'current'
    | 'forward'
    | 'effectiveTranscriptLimits'
  >,
) {
  const { binding, parents, closures, readObject, current, forward, effectiveTranscriptLimits } =
    scope;
  return (receipts: readonly ReleaseExportArtifactObjectReceipt[]): Buffer => {
    const transcript: ReleaseExportTranscript = {
      version: 'devai.release-export-transcript-json.v1',
      binding: {
        action_id: binding.action_id,
        repository: binding.repository,
        candidate: binding.candidate,
        plan_receipt_digest_sha256: binding.plan_receipt_digest_sha256,
        parent_artifact_sink: binding.parent_artifact_sink,
        sink_id: binding.sink_id,
        destination: binding.destination,
        trust: binding.trust,
        attempt_id: binding.attempt_id,
      },
      parent: parents,
      closures: binding.closure_inputs.map((entry) => {
        const matches = receipts.filter(
          (r) => r.kind === 'evidence-manifest' && r.package_id === entry.package_id,
        );
        const receipt = matches[0];
        if (
          matches.length !== 1 ||
          receipt === undefined ||
          receipt.sha256 !== entry.sha256 ||
          receipt.size_bytes !== entry.size_bytes
        )
          return fail();
        const closureBytes = closures.find((c) => c.package_id === entry.package_id)?.bytes;
        if (closureBytes === undefined || !readObject(receipt).equals(closureBytes)) fail();
        return {
          package_id: entry.package_id,
          evidence_manifest: identity(receipt),
          expected_installed_package: entry.expected_installed_package,
          policy_resolution_digest_sha256: entry.policy_resolution_digest_sha256,
        };
      }),
      destination: binding.destination,
      trust: binding.trust,
    };
    if (current) {
      if (!('mutation_units' in binding)) fail();
      const shared = {
        ...transcript,
        closures: transcript.closures.map((entry, index) => ({
          ...entry,
          release_unit:
            (binding as ProtectedReleaseExportBindingV3).closure_inputs[index]?.release_unit ??
            fail(),
        })),
        mutation_units: binding.mutation_units,
      };
      if (forward) {
        if (!('certification_units' in binding)) fail();
        return encodeReleaseExportTranscriptV3(
          {
            ...shared,
            version: RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT,
            certification_units: binding.certification_units,
          },
          effectiveTranscriptLimits,
        );
      }
      return encodeReleaseExportTranscriptV2(
        { ...shared, version: RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT },
        effectiveTranscriptLimits,
      );
    }
    return encodeReleaseExportTranscript(transcript, effectiveTranscriptLimits);
  };
}

/** Manifest builder: the export commit manifest of one transaction and its receipts. */
export function manifestBuilder(
  scope: Pick<
    ExportStoreScope,
    | 'transcriptFor'
    | 'packages'
    | 'readObject'
    | 'forward'
    | 'current'
    | 'effectiveTranscriptLimits'
    | 'parents'
    | 'binding'
    | 'specId'
    | 'specDigest'
  >,
) {
  const {
    transcriptFor,
    packages,
    readObject,
    forward,
    current,
    effectiveTranscriptLimits,
    parents,
    binding,
    specId,
    specDigest,
  } = scope;
  return (transaction: string, receipts: readonly ReleaseExportArtifactObjectReceipt[]) => {
    const transcript = transcriptFor(receipts);
    let signature: string | undefined;
    for (const { pkg } of packages) {
      const matches = receipts.filter(
        (r) => r.kind === 'provider-result' && r.package_id === pkg.package_id,
      );
      const receipt = matches[0];
      if (matches.length !== 1 || receipt === undefined) fail();
      const value = readObject(receipt);
      const result = parse<ReleaseExportProviderResult>(value);
      signature ??= result.signature;
      (forward
        ? verifyReleaseExportProviderResultV3
        : current
          ? verifyReleaseExportProviderResultV2
          : verifyReleaseExportProviderResult)(
        value,
        { package_id: pkg.package_id, transcript, signature },
        effectiveTranscriptLimits,
      );
    }
    if (current)
      (forward ? verifyReleaseExportProviderResultSetV3 : verifyReleaseExportProviderResultSetV2)(
        receipts.filter((entry) => entry.kind === 'provider-result').map(readObject),
        { transcript, signature: signature ?? fail() },
        effectiveTranscriptLimits,
      );
    const added = receipts.filter((r) => r.kind !== 'committed-manifest');
    if (added.length !== packages.length * 2) fail();
    const artifacts = order([...parents, ...added.map(identity)]);
    if (new Set(artifacts.map((entry) => entry.opaque_handle)).size !== artifacts.length) fail();
    const manifest: ReleaseExportArtifactCommitManifest = {
      schemaVersion: '1.0.0',
      kind: 'release-artifact-sink-commit-manifest',
      sink_id: binding.sink_id,
      transaction_handle: transaction,
      repository: binding.repository,
      candidate: binding.candidate,
      export_spec_id: specId,
      export_spec_digest_sha256: specDigest,
      parent_artifact_sink: binding.parent_artifact_sink,
      binding,
      artifacts,
    };
    return bytes(manifest);
  };
}

/** Committed object reader: re-verifies the parent, reservation, receipts and manifest before returning bytes. */
export function readCommittedFor(
  scope: Pick<
    ExportStoreScope,
    | 'binding'
    | 'verifyParent'
    | 'parentIdentities'
    | 'checkedParentReader'
    | 'split'
    | 'directoryFor'
    | 'store'
    | 'reservationPath'
    | 'reservation'
    | 'assertAbsent'
    | 'receiptFor'
    | 'readObject'
    | 'manifestFor'
  >,
) {
  const {
    binding,
    verifyParent,
    parentIdentities,
    checkedParentReader,
    split,
    directoryFor,
    store,
    reservationPath,
    reservation,
    assertAbsent,
    receiptFor,
    readObject,
    manifestFor,
  } = scope;
  return async (input: ReadInput): Promise<Buffer> => {
    closed(input, ['sink_id', 'opaque_handle']);
    if (input.sink_id !== binding.sink_id) fail();
    await verifyParent(false);
    if (
      input.opaque_handle === binding.parent_artifact_sink.committed_manifest_handle ||
      parentIdentities.has(input.opaque_handle)
    )
      return checkedParentReader.readArtifact(input);
    const { transaction } = split(input.opaque_handle);
    const directory = directoryFor(transaction);
    if (
      !same(parse(store.read(reservationPath)), reservation(transaction)) ||
      !same(parse(store.read(join(directory, 'begin.json'))), reservation(transaction))
    )
      fail();
    assertAbsent(join(directory, 'abort.json'));
    const marker = parse<ArtifactSinkCommitReceipt>(store.read(join(directory, 'commit.json')));
    const manifestReceipt = receiptFor(marker.committed_manifest_handle);
    if (
      manifestReceipt.kind !== 'committed-manifest' ||
      manifestReceipt.transaction_handle !== transaction ||
      !same(marker, {
        committed: true,
        sink_id: binding.sink_id,
        transaction_handle: transaction,
        committed_manifest_handle: manifestReceipt.opaque_handle,
        committed_manifest_sha256: manifestReceipt.sha256,
        committed_manifest_size_bytes: manifestReceipt.size_bytes,
        commit_protocol: 'devai.artifact-sink.two-phase.v1',
      })
    )
      fail();
    const manifest = parse<ReleaseExportArtifactCommitManifest>(readObject(manifestReceipt));
    if (!Array.isArray(manifest.artifacts)) fail();
    const receipts = manifest.artifacts
      .filter((entry) => !parentIdentities.has(entry.opaque_handle))
      .map((entry) => {
        const receipt = receiptFor(entry.opaque_handle);
        if (receipt.transaction_handle !== transaction || !same(entry, identity(receipt))) fail();
        readObject(receipt);
        return receipt;
      });
    if (!readObject(manifestReceipt).equals(manifestFor(transaction, receipts))) fail();
    const all = [...receipts, manifestReceipt];
    const files = new Set(all.map((entry) => `${split(entry.opaque_handle).id}.json`));
    const stored = store.list(join(directory, 'receipts'));
    if (
      files.size !== all.length ||
      stored.length !== files.size ||
      stored.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !files.has(entry.name))
    )
      fail();
    const requested = all.find((entry) => entry.opaque_handle === input.opaque_handle);
    if (requested === undefined) fail();
    store.checkRoot();
    return readObject(requested);
  };
}
