import {
  RELEASE_EXPORT_SPEC_ID,
  RELEASE_EXPORT_SPEC_DIGEST,
  type ReleaseExportTranscriptLimits,
} from './release-export-transcript.js';
import {
  RELEASE_EXPORT_SPEC_V3_ID,
  RELEASE_EXPORT_SPEC_V3_DIGEST,
  captureReleaseExportTranscriptLimits,
} from './release-export-transcript-v2.js';
import {
  RELEASE_EXPORT_SPEC_V4_ID,
  RELEASE_EXPORT_SPEC_V4_DIGEST,
} from './release-export-transcript-v3.js';
import type {
  ReleaseLifecycleStateV2,
  TrustedArtifactReader,
} from './release-lifecycle-execution.js';
import {
  same,
  utf8Compare,
  object,
  RELEASE_PACK_SPEC_ID,
  RELEASE_PACK_SPEC_DIGEST,
  verifyReceiptBytes,
  opaqueIdentity,
  artifactProjectionKey,
} from './release-prepare-kernel-contract.js';
import { reverifyExportContinuity } from './release-prepare-kernel-export-continuity.js';

export async function reverifySinkArtifacts(
  state: ReleaseLifecycleStateV2,
  reader: TrustedArtifactReader | undefined,
  exportLimits?: ReleaseExportTranscriptLimits,
): Promise<void> {
  const protectedExportLimits =
    exportLimits === undefined ? undefined : captureReleaseExportTranscriptLimits(exportLimits);
  if (state.schemaVersion !== '2.1.0') return;
  const sink = state.artifact_sink;
  if (reader === undefined || sink === undefined || sink === null) {
    throw new Error('release-downstream-artifact-reverification-failed');
  }
  const manifestBytes = await verifyReceiptBytes(
    reader,
    {
      sink_id: sink.sink_id,
      opaque_handle: sink.committed_manifest_handle,
      sha256: sink.committed_manifest_sha256,
      size_bytes: sink.committed_manifest_size_bytes,
    },
    'release-downstream-artifact-reverification-failed',
  );
  let commitManifest: Readonly<Record<string, unknown>>;
  try {
    commitManifest = object(JSON.parse(manifestBytes.toString('utf8')) as unknown);
  } catch {
    throw new Error('release-downstream-artifact-reverification-failed');
  }
  const members = commitManifest['artifacts'];
  const isExport = ['exported', 'evidence_published', 'publication_dispatched'].includes(
    state.state,
  );
  if (
    isExport &&
    commitManifest['export_spec_id'] === RELEASE_EXPORT_SPEC_V3_ID &&
    protectedExportLimits === undefined
  )
    throw new Error('release-downstream-artifact-reverification-failed');
  if (
    commitManifest['schemaVersion'] !== '1.0.0' ||
    commitManifest['kind'] !== 'release-artifact-sink-commit-manifest' ||
    commitManifest['sink_id'] !== sink.sink_id ||
    commitManifest['transaction_handle'] !== sink.transaction_handle ||
    (isExport
      ? !(
          (commitManifest['export_spec_id'] === RELEASE_EXPORT_SPEC_ID &&
            commitManifest['export_spec_digest_sha256'] === RELEASE_EXPORT_SPEC_DIGEST) ||
          (commitManifest['export_spec_id'] === RELEASE_EXPORT_SPEC_V3_ID &&
            commitManifest['export_spec_digest_sha256'] === RELEASE_EXPORT_SPEC_V3_DIGEST) ||
          (commitManifest['export_spec_id'] === RELEASE_EXPORT_SPEC_V4_ID &&
            commitManifest['export_spec_digest_sha256'] === RELEASE_EXPORT_SPEC_V4_DIGEST)
        )
      : commitManifest['pack_spec_id'] !== RELEASE_PACK_SPEC_ID ||
        commitManifest['pack_spec_digest_sha256'] !== RELEASE_PACK_SPEC_DIGEST) ||
    !same(commitManifest['repository'], state.repository) ||
    !same(commitManifest['candidate'], {
      commit: state.candidate.commit,
      tree: state.candidate.tree,
    }) ||
    !Array.isArray(members)
  ) {
    throw new Error('release-downstream-artifact-reverification-failed');
  }
  const expected = (state['artifacts'] as readonly unknown[]).map(opaqueIdentity);
  const normalizedMembers = members.map(opaqueIdentity);
  const sortedExpected = [...expected].sort((left, right) =>
    utf8Compare(artifactProjectionKey(left), artifactProjectionKey(right)),
  );
  const packageProjection = state.release_units.flatMap((unit) =>
    unit.packages.flatMap((pkg) =>
      [
        ['package-manifest', pkg.package_manifest],
        ['package-tarball', pkg.package_tarball],
        ['package-sbom', pkg.package_sbom],
        ['evidence-manifest', pkg.evidence_manifest],
        ['provider-result', pkg.provider_result],
      ].flatMap(([expectedKind, identity]) => {
        if (identity === null || identity === undefined) {
          if (isExport) throw new Error('release-downstream-artifact-reverification-failed');
          return [];
        }
        const normalized = opaqueIdentity(identity);
        if (normalized.kind !== expectedKind || normalized.sink_id !== sink.sink_id) {
          throw new Error('release-downstream-artifact-reverification-failed');
        }
        return [normalized];
      }),
    ),
  );
  const sortedPackageProjection = [...packageProjection].sort((left, right) =>
    utf8Compare(artifactProjectionKey(left), artifactProjectionKey(right)),
  );
  if (
    new Set(expected.map(artifactProjectionKey)).size !== expected.length ||
    new Set(expected.map((artifact) => artifact.opaque_handle)).size !== expected.length ||
    expected.some((artifact) => artifact.opaque_handle === sink.committed_manifest_handle) ||
    (!isExport &&
      expected.some((artifact) =>
        ['evidence-manifest', 'provider-result'].includes(artifact.kind),
      )) ||
    expected.some((artifact) => artifact.sink_id !== sink.sink_id) ||
    !same(expected, sortedExpected) ||
    !same(normalizedMembers, expected) ||
    !same(sortedPackageProjection, expected)
  ) {
    throw new Error('release-downstream-artifact-reverification-failed');
  }
  const observed = new Map<string, Buffer>();
  for (const identity of expected) {
    if (
      isExport &&
      commitManifest['export_spec_id'] === RELEASE_EXPORT_SPEC_V3_ID &&
      identity.kind === 'provider-result' &&
      (protectedExportLimits === undefined ||
        identity.size_bytes > protectedExportLimits.maximum_provider_result_bytes)
    )
      throw new Error('release-downstream-artifact-reverification-failed');
    if (identity.sink_id !== sink.sink_id) {
      throw new Error('release-downstream-artifact-reverification-failed');
    }
    const verified = await verifyReceiptBytes(
      reader,
      identity,
      'release-downstream-artifact-reverification-failed',
    );
    // Hash large parent tarballs/closures independently; retain only small manifests/results
    // for the subsequent package association and aggregate transcript continuity checks.
    if (isExport && ['package-manifest', 'provider-result'].includes(identity.kind))
      observed.set(identity.opaque_handle, verified);
  }
  if (isExport) {
    try {
      await reverifyExportContinuity(
        state,
        commitManifest,
        manifestBytes,
        reader,
        observed,
        protectedExportLimits,
      );
    } catch {
      throw new Error('release-downstream-artifact-reverification-failed');
    }
  }
}
