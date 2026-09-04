import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';
import {
  RELEASE_EXPORT_SPEC_DIGEST,
  RELEASE_EXPORT_SPEC_ID,
  type ProtectedReleaseExportBinding,
} from '../../src/services/release-export-artifact-store.js';
import {
  encodeReleaseExportProviderResult,
  encodeReleaseExportTranscript,
  type ReleaseExportTranscript,
  type ReleaseExportTranscriptLimits,
} from '../../src/services/release-export-transcript.js';
import {
  RELEASE_PACK_SPEC_DIGEST,
  RELEASE_PACK_SPEC_ID,
  finalizeCertificationManifest,
  reverifySinkArtifacts,
} from '../../src/services/release-prepare-kernel.js';
import type {
  ArtifactSinkCommitIdentity,
  CertificationPackageEntryManifest,
  OpaqueArtifactIdentity,
  ReleaseLifecycleStateV2,
  TrustedArtifactReader,
  TrustIdentity,
} from '../../src/services/release-lifecycle-execution.js';

const LIMITS: ReleaseExportTranscriptLimits = {
  maximum_transcript_bytes: 64 * 1024,
  maximum_provider_result_bytes: 64 * 1024,
  maximum_packages: 2,
};
const SINK = 'fixture-export-sink';
const REPOSITORY = { id: 'aarusso-nyx/devai', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const CANDIDATE = { commit: REPOSITORY.commit, tree: REPOSITORY.tree };
const DESTINATION = { kind: 'evidence-destination', exact_identifier: 'external/devai-1.5.0' };
const TRUST: TrustIdentity = {
  trust_root_id: 'fixture/trust-root',
  trust_store_digest_sha256: 'c'.repeat(64),
  key_id: 'fixture-key',
  signature_algorithm: 'ed25519',
};
const PLAN_DIGEST = 'd'.repeat(64);
const ATTEMPT_ID = 'RLA-0123456789abcdef';
const EXPECTED_INSTALLED = {
  name: '@aarusso-nyx/devai' as const,
  version: '1.5.0',
  archive_sha256: 'e'.repeat(64),
  content_manifest_sha256: 'f'.repeat(64),
};

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

function order(values: readonly OpaqueArtifactIdentity[]): OpaqueArtifactIdentity[] {
  return [...values].sort((left, right) =>
    Buffer.compare(
      Buffer.from(
        `${left.kind}\0${left.sink_id}\0${left.opaque_handle}\0${left.sha256}\0${left.size_bytes}`,
      ),
      Buffer.from(
        `${right.kind}\0${right.sink_id}\0${right.opaque_handle}\0${right.sha256}\0${right.size_bytes}`,
      ),
    ),
  );
}

function artifact(
  kind: OpaqueArtifactIdentity['kind'],
  handle: string,
  bytes: Buffer,
): OpaqueArtifactIdentity {
  return {
    kind,
    sink_id: SINK,
    opaque_handle: handle,
    sha256: sha256(bytes),
    size_bytes: bytes.byteLength,
  };
}

function opaqueKind(value: OpaqueArtifactIdentity | { readonly path: string } | null | undefined) {
  return value !== null && value !== undefined && 'kind' in value ? value.kind : undefined;
}

function sinkIdentity(
  transaction: string,
  handle: string,
  bytes: Buffer,
): ArtifactSinkCommitIdentity {
  return {
    sink_id: SINK,
    transaction_handle: transaction,
    committed_manifest_handle: handle,
    committed_manifest_sha256: sha256(bytes),
    committed_manifest_size_bytes: bytes.byteLength,
    commit_protocol: 'devai.artifact-sink.two-phase.v1',
  };
}

interface Fixture {
  readonly prepared: ReleaseLifecycleStateV2;
  readonly exported: ReleaseLifecycleStateV2;
  readonly bytes: Map<string, Buffer>;
  readonly reader: TrustedArtifactReader;
  readonly parent: ArtifactSinkCommitIdentity;
  readonly binding: ProtectedReleaseExportBinding;
  readonly finalManifest: Readonly<Record<string, unknown>>;
}

function fixture(): Fixture {
  const bytes = new Map<string, Buffer>();
  const packageIds = ['@fixture/a', '@fixture/b'];
  const preparedPackages = packageIds.map((packageId, index) => {
    const packageJson = Buffer.from(
      canonicalJson({ name: packageId, version: '1.5.0', fixture: index }),
      'utf8',
    );
    const certification: CertificationPackageEntryManifest = finalizeCertificationManifest({
      candidate: CANDIDATE,
      task_policy_digest_sha256: sha256(`task-policy:${packageId}`),
      package_id: packageId,
      package_version: '1.5.0',
      entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse',
      manifest_digest_contract: {
        domain: 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\0',
        payload:
          'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes',
        canonicalization: 'rfc8785-jcs',
        algorithm: 'sha256',
      },
      entries: [
        {
          path: 'package.json',
          mode: '100644',
          size_bytes: packageJson.byteLength,
          sha256: sha256(packageJson),
          immutable_blob_locator: {
            kind: 'git-object',
            repository: REPOSITORY.id,
            commit: CANDIDATE.commit,
            tree: CANDIDATE.tree,
            object_format: 'sha1',
            path: `packages/${packageId.slice(-1)}/package.json`,
            mode: '100644',
            object_id: `${index + 1}`.repeat(40),
            size_bytes: packageJson.byteLength,
            content_digest_sha256: sha256(packageJson),
          },
        },
      ],
    });
    const tarball = artifact(
      'package-tarball',
      `prepared-package-tarball-${packageId.slice(-1)}`,
      Buffer.from(`package-tarball:${packageId}`, 'utf8'),
    );
    const sbom = artifact(
      'package-sbom',
      `prepared-package-sbom-${packageId.slice(-1)}`,
      Buffer.from(`package-sbom:${packageId}`, 'utf8'),
    );
    const manifest = artifact(
      'package-manifest',
      `prepared-package-manifest-${packageId.slice(-1)}`,
      canonical({
        schemaVersion: '2.0.0',
        kind: 'release-prepared-package-manifest',
        candidate: CANDIDATE,
        package_id: packageId,
        package_version: '1.5.0',
        pack_spec_id: RELEASE_PACK_SPEC_ID,
        pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
        certification_manifest_digest_sha256: certification.manifest_digest_sha256,
        artifacts: {
          tarball: { sha256: tarball.sha256, size_bytes: tarball.size_bytes },
          sbom: { sha256: sbom.sha256, size_bytes: sbom.size_bytes },
        },
      }),
    );
    for (const [identity, value] of [
      [tarball, Buffer.from(`package-tarball:${packageId}`, 'utf8')],
      [sbom, Buffer.from(`package-sbom:${packageId}`, 'utf8')],
      [
        manifest,
        canonical({
          schemaVersion: '2.0.0',
          kind: 'release-prepared-package-manifest',
          candidate: CANDIDATE,
          package_id: packageId,
          package_version: '1.5.0',
          pack_spec_id: RELEASE_PACK_SPEC_ID,
          pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
          certification_manifest_digest_sha256: certification.manifest_digest_sha256,
          artifacts: {
            tarball: { sha256: tarball.sha256, size_bytes: tarball.size_bytes },
            sbom: { sha256: sbom.sha256, size_bytes: sbom.size_bytes },
          },
        }),
      ],
    ] as const)
      bytes.set(identity.opaque_handle, value);
    return { packageId, certification, manifest, tarball, sbom };
  });
  const parentArtifacts = order(
    preparedPackages.flatMap(({ manifest, tarball, sbom }) => [manifest, tarball, sbom]),
  );
  const parentManifest = canonical({
    schemaVersion: '1.0.0',
    kind: 'release-artifact-sink-commit-manifest',
    sink_id: SINK,
    transaction_handle: 'prepared-transaction',
    repository: REPOSITORY,
    candidate: CANDIDATE,
    pack_spec_id: RELEASE_PACK_SPEC_ID,
    pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
    artifacts: parentArtifacts,
  });
  const parent = sinkIdentity('prepared-transaction', 'prepared-commit', parentManifest);
  bytes.set(parent.committed_manifest_handle, parentManifest);
  const closureBytes = packageIds.map((packageId) =>
    canonical({ format: 'opaque-policy-closure-fixture', package_id: packageId }),
  );
  const closureIdentities = closureBytes.map((value, index) => {
    const packageId = packageIds[index];
    if (packageId === undefined) throw new Error('fixture package missing');
    const identity = artifact('evidence-manifest', `closure-${packageId.slice(-1)}`, value);
    bytes.set(identity.opaque_handle, value);
    return identity;
  });
  const closureInputs = closureIdentities.map((identity, index) => {
    const packageId = packageIds[index];
    if (packageId === undefined) throw new Error('fixture package missing');
    return {
      package_id: packageId,
      sha256: identity.sha256,
      size_bytes: identity.size_bytes,
      expected_installed_package: EXPECTED_INSTALLED,
      policy_resolution_digest_sha256: sha256(`resolution:${packageId}`),
    };
  });
  const binding: ProtectedReleaseExportBinding = {
    action_id: 'release export',
    repository: REPOSITORY,
    candidate: CANDIDATE,
    plan_receipt_digest_sha256: PLAN_DIGEST,
    parent_artifact_sink: parent,
    sink_id: SINK,
    destination: DESTINATION,
    trust: TRUST,
    attempt_id: ATTEMPT_ID,
    export_spec_digest_sha256: RELEASE_EXPORT_SPEC_DIGEST,
    closure_inputs: closureInputs,
  };
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
    parent: parentArtifacts,
    closures: closureInputs.map((entry, index) => {
      const evidence = closureIdentities[index];
      if (evidence === undefined) throw new Error('fixture closure missing');
      return {
        package_id: entry.package_id,
        evidence_manifest: evidence,
        expected_installed_package: entry.expected_installed_package,
        policy_resolution_digest_sha256: entry.policy_resolution_digest_sha256,
      };
    }),
    destination: DESTINATION,
    trust: TRUST,
  };
  const transcriptBytes = encodeReleaseExportTranscript(transcript, LIMITS);
  const providerIdentities = packageIds.map((packageId) => {
    const value = encodeReleaseExportProviderResult(
      { package_id: packageId, transcript: transcriptBytes, signature: 'AQ==' },
      LIMITS,
    );
    const identity = artifact('provider-result', `provider-${packageId.slice(-1)}`, value);
    bytes.set(identity.opaque_handle, value);
    return identity;
  });
  const finalArtifacts = order([...parentArtifacts, ...closureIdentities, ...providerIdentities]);
  const finalManifest = {
    schemaVersion: '1.0.0',
    kind: 'release-artifact-sink-commit-manifest',
    sink_id: SINK,
    transaction_handle: 'export-transaction',
    repository: REPOSITORY,
    candidate: CANDIDATE,
    export_spec_id: RELEASE_EXPORT_SPEC_ID,
    export_spec_digest_sha256: RELEASE_EXPORT_SPEC_DIGEST,
    parent_artifact_sink: parent,
    binding,
    artifacts: finalArtifacts,
  };
  const finalBytes = canonical(finalManifest);
  const final = sinkIdentity('export-transaction', 'export-commit', finalBytes);
  bytes.set(final.committed_manifest_handle, finalBytes);
  const packages = packageIds.map((packageId, index) => {
    const preparedPackage = preparedPackages[index];
    const evidence = closureIdentities[index];
    const provider = providerIdentities[index];
    if (preparedPackage === undefined || evidence === undefined || provider === undefined)
      throw new Error('fixture output artifact missing');
    return {
      package_id: packageId,
      manifest: null,
      tarball: null,
      sbom: null,
      package_manifest: preparedPackage.manifest,
      package_tarball: preparedPackage.tarball,
      package_sbom: preparedPackage.sbom,
      evidence_manifest: evidence,
      provider_result: provider,
      trust: TRUST,
      certification_manifest: preparedPackage.certification,
    };
  });
  const common = {
    schemaVersion: '2.1.0' as const,
    state_id: 'RLS-fixture',
    repository: REPOSITORY,
    candidate: { release_unit: '@fixture/release', version: '1.5.0', ...CANDIDATE },
    release_units: [{ release_unit: '@fixture/release', version: '1.5.0', packages }],
    inputs: [],
    prior_state: null,
    storage: { generation: 1, head_before: null },
    record_digest_sha256: '1'.repeat(64),
    bound_receipts: [
      {
        kind: 'release-plan-receipt',
        receipt_id: `RPL-${PLAN_DIGEST.slice(0, 16)}`,
        receipt_digest_sha256: PLAN_DIGEST,
        verdict: 'pass',
      },
    ],
  };
  const prepared = {
    ...common,
    state: 'prepared' as const,
    action_id: 'release prepare' as const,
    artifacts: parentArtifacts,
    artifact_sink: parent,
    release_units: [
      {
        release_unit: '@fixture/release',
        version: '1.5.0',
        packages: packages.map((entry) => ({
          ...entry,
          evidence_manifest: null,
          provider_result: null,
          trust: null,
        })),
      },
    ],
  } as unknown as ReleaseLifecycleStateV2;
  const exported = {
    ...common,
    state: 'exported' as const,
    action_id: 'release export' as const,
    artifacts: finalArtifacts,
    artifact_sink: final,
  } as unknown as ReleaseLifecycleStateV2;
  const reader: TrustedArtifactReader = {
    readArtifact: ({ sink_id, opaque_handle }) => {
      if (sink_id !== SINK) throw new Error('fixture cross-sink read');
      const value = bytes.get(opaque_handle);
      if (value === undefined) throw new Error('fixture object missing');
      return Buffer.from(value);
    },
  };
  return { prepared, exported, bytes, reader, parent, binding, finalManifest };
}

function withFinalManifest(
  value: Fixture,
  manifest: Readonly<Record<string, unknown>>,
): ReleaseLifecycleStateV2 {
  const bytes = canonical(manifest);
  const state = structuredClone(value.exported) as ReleaseLifecycleStateV2;
  const sink = state.artifact_sink;
  if (sink === undefined || sink === null) throw new Error('fixture export sink missing');
  value.bytes.set(sink.committed_manifest_handle, bytes);
  return {
    ...state,
    artifact_sink: {
      ...sink,
      committed_manifest_sha256: sha256(bytes),
      committed_manifest_size_bytes: bytes.byteLength,
    },
  };
}

describe('release export sink continuity', () => {
  it('accepts a canonical v2 five-kind export commit while retaining its exact pack-v4 prepared parent', async () => {
    const value = fixture();

    await expect(reverifySinkArtifacts(value.prepared, value.reader)).resolves.toBeUndefined();
    await expect(reverifySinkArtifacts(value.exported, value.reader)).resolves.toBeUndefined();
    expect(value.exported.artifacts).toHaveLength(10);
    for (const unit of value.exported.release_units) {
      for (const pkg of unit.packages) {
        expect([
          pkg.package_manifest?.kind,
          pkg.package_tarball?.kind,
          pkg.package_sbom?.kind,
          opaqueKind(pkg.evidence_manifest),
          opaqueKind(pkg.provider_result),
        ]).toEqual([
          'package-manifest',
          'package-tarball',
          'package-sbom',
          'evidence-manifest',
          'provider-result',
        ]);
      }
    }
    expect(value.parent.transaction_handle).toBe('prepared-transaction');
    expect(value.binding.parent_artifact_sink).toEqual(value.parent);
  });

  it('rejects a v2 exported state relabeled as a pack-v4 commit', async () => {
    const value = fixture();
    const relabeled = withFinalManifest(value, {
      schemaVersion: '1.0.0',
      kind: 'release-artifact-sink-commit-manifest',
      sink_id: SINK,
      transaction_handle: 'export-transaction',
      repository: REPOSITORY,
      candidate: CANDIDATE,
      pack_spec_id: RELEASE_PACK_SPEC_ID,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      artifacts: value.exported.artifacts,
    });

    await expect(reverifySinkArtifacts(relabeled, value.reader)).rejects.toThrow(
      'release-downstream-artifact-reverification-failed',
    );
  });

  it.each([
    ['prepared parent manifest', 'prepared-commit'],
    ['package-manifest', 'prepared-package-manifest-a'],
    ['package-tarball', 'prepared-package-tarball-a'],
    ['package-sbom', 'prepared-package-sbom-a'],
    ['evidence-manifest', 'closure-a'],
    ['provider-result', 'provider-a'],
    ['final export manifest', 'export-commit'],
  ] as const)(
    'rejects byte corruption in the %s continuity population',
    async (_target, handle) => {
      const value = fixture();
      value.bytes.set(handle, Buffer.from('corrupted continuity bytes', 'utf8'));

      await expect(reverifySinkArtifacts(value.exported, value.reader)).rejects.toThrow(
        'release-downstream-artifact-reverification-failed',
      );
    },
  );

  it('does not permit a prepared state to consume an export-only five-kind commit', async () => {
    const value = fixture();
    const prepared = {
      ...value.exported,
      state: 'prepared' as const,
      action_id: 'release prepare' as const,
    } as ReleaseLifecycleStateV2;

    await expect(reverifySinkArtifacts(prepared, value.reader)).rejects.toThrow(
      'release-downstream-artifact-reverification-failed',
    );
  });

  it('rejects a canonical provider result whose transcript binding differs from the final commit', async () => {
    const value = fixture();
    const altered = withFinalManifest(value, {
      ...value.finalManifest,
      binding: {
        ...value.binding,
        destination: { kind: 'evidence-destination', exact_identifier: 'external/other' },
      },
    });

    await expect(reverifySinkArtifacts(altered, value.reader)).rejects.toThrow(
      'release-downstream-artifact-reverification-failed',
    );
  });

  it('rejects a final state whose per-package five-kind projection no longer matches the final commit', async () => {
    const value = fixture();
    const state = structuredClone(value.exported) as ReleaseLifecycleStateV2;
    const unit = state.release_units[0];
    const packageEvidence = unit?.packages[0];
    if (
      unit === undefined ||
      packageEvidence === undefined ||
      packageEvidence.provider_result === null
    )
      throw new Error('fixture provider result missing');
    const altered = {
      ...state,
      release_units: [
        {
          ...unit,
          packages: [
            {
              ...packageEvidence,
              provider_result: {
                ...packageEvidence.provider_result,
                opaque_handle: 'provider-other',
              },
            },
            ...unit.packages.slice(1),
          ],
        },
      ],
    } as ReleaseLifecycleStateV2;

    await expect(reverifySinkArtifacts(altered, value.reader)).rejects.toThrow(
      'release-downstream-artifact-reverification-failed',
    );
  });

  it('rejects swapped package-manifest rows even when aggregate parent and transcript bytes remain unchanged', async () => {
    const value = fixture();
    const state = structuredClone(value.exported) as ReleaseLifecycleStateV2;
    const unit = state.release_units[0];
    const first = unit?.packages[0];
    const second = unit?.packages[1];
    if (
      unit === undefined ||
      first === undefined ||
      second === undefined ||
      first.package_manifest === null ||
      second.package_manifest === null
    )
      throw new Error('fixture prepared package manifests missing');
    const swapped = {
      ...state,
      release_units: [
        {
          ...unit,
          packages: [
            { ...first, package_manifest: second.package_manifest },
            { ...second, package_manifest: first.package_manifest },
          ],
        },
      ],
    } as ReleaseLifecycleStateV2;

    await expect(reverifySinkArtifacts(swapped, value.reader)).rejects.toThrow(
      'release-downstream-artifact-reverification-failed',
    );
  });
});
