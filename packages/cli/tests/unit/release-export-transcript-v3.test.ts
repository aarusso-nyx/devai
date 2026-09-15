import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import type { OpaqueArtifactIdentity } from '../../src/services/release-lifecycle-execution.js';
import type { ReleaseExportTranscriptLimits } from '../../src/services/release-export-transcript.js';
import { RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT } from '../../src/services/release-export-transcript-v2.js';
import {
  createCertifiedEvidenceCarrier,
  finalizeCertifiedEvidenceNamespaceCensus,
} from '../../src/services/release-certified-evidence-carrier.js';
import {
  encodeReleaseExportProviderResultV3,
  encodeReleaseExportTranscriptV3,
  verifyReleaseExportProviderResultSetV3,
  verifyReleaseExportProviderResultV3,
  verifyReleaseExportTranscriptV3,
  RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT,
  type ReleaseExportTranscriptV3,
  type ReleaseUnitCertifiedEvidencePortable,
} from '../../src/services/release-export-transcript-v3.js';

const DIGEST = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const LIMITS: ReleaseExportTranscriptLimits = {
  maximum_transcript_bytes: 64 * 1024,
  maximum_provider_result_bytes: 128 * 1024,
  maximum_packages: 2,
};
const UNIT = '@fixture/unit';
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function artifact(kind: OpaqueArtifactIdentity['kind'], handle: string, value: string) {
  return {
    kind,
    sink_id: 'fixture-sink',
    opaque_handle: handle,
    sha256: DIGEST(value),
    size_bytes: Buffer.byteLength(value),
  };
}

const taskPolicy = { schemaVersion: '1.2.0', tasks: [{ nodeId: 'build', taskKey: 'build@1' }] };
const derivation = {
  repository: { id: 'aarusso-nyx/devai', commit: COMMIT, tree: TREE },
  candidate: { commit: COMMIT, tree: TREE },
  task_policy_digest_sha256: canonicalSha256(taskPolicy),
};
const taskResult = {
  schemaVersion: '1.0.0' as const,
  nodeId: 'build',
  taskKey: 'build@1',
  status: 'PASS' as const,
  inputDigest: DIGEST('input'),
  dependencyResultDigests: {},
  outputDigests: { 'dist/a.js': DIGEST('a') },
  startedAt: '2026-09-04T00:00:00.000Z',
  finishedAt: '2026-09-04T00:00:01.000Z',
};
const candidateReceipt = {
  schemaVersion: '1.1.0',
  repository: derivation.repository,
  profile: 'rc',
  taskPolicyDigest: derivation.task_policy_digest_sha256,
  createdAt: '2026-09-04T00:00:02.000Z',
  tasks: [{ nodeId: 'build', taskKey: 'build@1', resultDigest: canonicalSha256(taskResult) }],
};
const census = finalizeCertifiedEvidenceNamespaceCensus({
  release_unit: UNIT,
  derivation,
  entries: [
    { path: 'dist/a.js', mode: '100644', sha256: DIGEST('a'), size_bytes: 1, task_node: 'build' },
  ],
});
const carrierBytes = createCertifiedEvidenceCarrier({
  release_unit: UNIT,
  derivation,
  candidate_receipt: candidateReceipt,
  task_policy: taskPolicy,
  task_results: [taskResult],
  namespace_census: census,
  maximum_bytes: LIMITS.maximum_provider_result_bytes,
});

const certificationUnit = {
  release_unit: UNIT,
  carrier_package_id: '@fixture/a',
  carrier: { sha256: DIGEST(carrierBytes), size_bytes: carrierBytes.length },
  derivation_binding_digest_sha256: canonicalSha256(derivation),
  candidate_receipt: {
    sha256: canonicalSha256(candidateReceipt),
    size_bytes: Buffer.byteLength(canonicalJson(candidateReceipt)),
  },
  task_policy: {
    sha256: canonicalSha256(taskPolicy),
    size_bytes: Buffer.byteLength(canonicalJson(taskPolicy)),
  },
  task_results: [
    {
      sha256: canonicalSha256(taskResult),
      size_bytes: Buffer.byteLength(canonicalJson(taskResult)),
    },
  ],
  namespace_census: {
    sha256: canonicalSha256(census),
    size_bytes: Buffer.byteLength(canonicalJson(census)),
  },
  census_member_projection_digest_sha256: canonicalSha256(census.entries),
  census_member_count: 1,
};

const portable: ReleaseUnitCertifiedEvidencePortable = {
  version: 'devai.release-certified-evidence-portable-json.v1',
  release_unit: UNIT,
  sha256: DIGEST(carrierBytes),
  size_bytes: carrierBytes.length,
  bytes_base64: carrierBytes.toString('base64'),
};

function transcript(): ReleaseExportTranscriptV3 {
  const destination = {
    kind: 'evidence-destination',
    exact_identifier: 's3://trusted evidence/çandidate',
  } as const;
  const trust = {
    trust_root_id: 'fixture/trust',
    trust_store_digest_sha256: DIGEST('trust'),
    key_id: 'fixture-key',
    signature_algorithm: 'ed25519' as const,
  };
  const expectedInstalledPackage = {
    name: '@aarusso-nyx/devai' as const,
    version: '1.5.0',
    archive_sha256: DIGEST('archive'),
    content_manifest_sha256: DIGEST('manifest'),
  };
  return {
    version: RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT,
    binding: {
      action_id: 'release export',
      repository: derivation.repository,
      candidate: { commit: COMMIT, tree: TREE },
      plan_receipt_digest_sha256: DIGEST('plan'),
      parent_artifact_sink: {
        sink_id: 'fixture-sink',
        transaction_handle: 'transaction-1',
        committed_manifest_handle: 'commit-1',
        committed_manifest_sha256: DIGEST('commit'),
        committed_manifest_size_bytes: 1,
        commit_protocol: 'devai.artifact-sink.two-phase.v1',
      },
      sink_id: 'fixture-sink',
      destination,
      trust,
      attempt_id: 'RLA-0123456789abcdef',
    },
    parent: [
      artifact('package-manifest', 'manifest-a', 'manifest-a'),
      artifact('package-manifest', 'manifest-b', 'manifest-b'),
      artifact('package-sbom', 'sbom-a', 'sbom-a'),
      artifact('package-sbom', 'sbom-b', 'sbom-b'),
      artifact('package-tarball', 'tarball-a', 'tarball-a'),
      artifact('package-tarball', 'tarball-b', 'tarball-b'),
    ],
    closures: [
      {
        package_id: '@fixture/a',
        release_unit: UNIT,
        evidence_manifest: artifact('evidence-manifest', 'closure-a', 'closure-a'),
        expected_installed_package: expectedInstalledPackage,
        policy_resolution_digest_sha256: DIGEST('resolution-a'),
      },
      {
        package_id: '@fixture/b',
        release_unit: UNIT,
        evidence_manifest: artifact('evidence-manifest', 'closure-b', 'closure-b'),
        expected_installed_package: expectedInstalledPackage,
        policy_resolution_digest_sha256: DIGEST('resolution-b'),
      },
    ],
    mutation_units: [{ release_unit: UNIT, mutation_evidence: null }],
    certification_units: [certificationUnit],
    destination,
    trust,
  };
}

function refusal(run: () => unknown): void {
  expect(run).toThrow(/^release-export-transcript-invalid$/u);
}

describe('release export transcript v3 and provider result v3', () => {
  it('binds every certification identity into the one canonical signing preimage', () => {
    const value = transcript();
    const encoded = encodeReleaseExportTranscriptV3(value, LIMITS);
    expect(encoded.toString('utf8')).toBe(canonicalJson(value));
    expect(verifyReleaseExportTranscriptV3(encoded, value, LIMITS)).toEqual(value);
    const text = encoded.toString('utf8');
    for (const identity of [
      certificationUnit.carrier.sha256,
      certificationUnit.derivation_binding_digest_sha256,
      certificationUnit.candidate_receipt.sha256,
      certificationUnit.task_policy.sha256,
      certificationUnit.namespace_census.sha256,
      certificationUnit.census_member_projection_digest_sha256,
      certificationUnit.task_results[0]?.sha256 ?? '',
    ])
      expect(text).toContain(identity);
    // Digest-only: no generated bytes or raw streams enter the preimage.
    expect(text).not.toContain(carrierBytes.toString('base64'));
  });

  it('carries the exact carrier in the elected provider result and nowhere else', () => {
    const value = transcript();
    const encoded = encodeReleaseExportTranscriptV3(value, LIMITS);
    const results = value.closures.map((row) =>
      encodeReleaseExportProviderResultV3(
        {
          package_id: row.package_id,
          transcript: encoded,
          signature: 'AQ==',
          mutation_evidence: null,
          certification_evidence: row.package_id === '@fixture/a' ? portable : null,
        },
        LIMITS,
      ),
    );
    const set = verifyReleaseExportProviderResultSetV3(
      results,
      { transcript: encoded, signature: 'AQ==' },
      LIMITS,
    );
    expect(set).toHaveLength(2);
    expect(set.filter((row) => row.certification_evidence !== null)).toHaveLength(1);
    expect(
      verifyReleaseExportProviderResultV3(
        results[0] as Buffer,
        { package_id: '@fixture/a', transcript: encoded, signature: 'AQ==' },
        LIMITS,
      ).certification_evidence?.sha256,
    ).toBe(DIGEST(carrierBytes));
  });

  it('refuses a missing, duplicated, extra or misplaced carrier', () => {
    const value = transcript();
    const encoded = encodeReleaseExportTranscriptV3(value, LIMITS);
    // The elected package must carry it.
    refusal(() =>
      encodeReleaseExportProviderResultV3(
        {
          package_id: '@fixture/a',
          transcript: encoded,
          signature: 'AQ==',
          mutation_evidence: null,
          certification_evidence: null,
        },
        LIMITS,
      ),
    );
    // A non-elected package must not.
    refusal(() =>
      encodeReleaseExportProviderResultV3(
        {
          package_id: '@fixture/b',
          transcript: encoded,
          signature: 'AQ==',
          mutation_evidence: null,
          certification_evidence: portable,
        },
        LIMITS,
      ),
    );
    // An incomplete set is not a complete export.
    const carrier = encodeReleaseExportProviderResultV3(
      {
        package_id: '@fixture/a',
        transcript: encoded,
        signature: 'AQ==',
        mutation_evidence: null,
        certification_evidence: portable,
      },
      LIMITS,
    );
    refusal(() =>
      verifyReleaseExportProviderResultSetV3(
        [carrier],
        { transcript: encoded, signature: 'AQ==' },
        LIMITS,
      ),
    );
    refusal(() =>
      verifyReleaseExportProviderResultSetV3(
        [carrier, carrier],
        { transcript: encoded, signature: 'AQ==' },
        LIMITS,
      ),
    );
  });

  it('refuses altered carrier bytes and drifted signed identities', () => {
    const value = transcript();
    const encoded = encodeReleaseExportTranscriptV3(value, LIMITS);
    for (const altered of [
      { ...portable, sha256: DIGEST('other') },
      { ...portable, size_bytes: portable.size_bytes + 1 },
      { ...portable, release_unit: '@fixture/other' },
      { ...portable, bytes_base64: Buffer.from('{}', 'utf8').toString('base64') },
    ])
      refusal(() =>
        encodeReleaseExportProviderResultV3(
          {
            package_id: '@fixture/a',
            transcript: encoded,
            signature: 'AQ==',
            mutation_evidence: null,
            certification_evidence: altered,
          },
          LIMITS,
        ),
      );
    for (const drift of [
      { ...certificationUnit, census_member_count: 2 },
      { ...certificationUnit, census_member_projection_digest_sha256: DIGEST('drift') },
      { ...certificationUnit, derivation_binding_digest_sha256: DIGEST('drift') },
      { ...certificationUnit, task_results: [{ sha256: DIGEST('drift'), size_bytes: 10 }] },
    ]) {
      const drifted = encodeReleaseExportTranscriptV3(
        { ...value, certification_units: [drift] },
        LIMITS,
      );
      refusal(() =>
        encodeReleaseExportProviderResultV3(
          {
            package_id: '@fixture/a',
            transcript: drifted,
            signature: 'AQ==',
            mutation_evidence: null,
            certification_evidence: portable,
          },
          LIMITS,
        ),
      );
    }
  });

  it('refuses a wrong carrier election, an incomplete unit population and a non-v3 version', () => {
    const value = transcript();
    refusal(() =>
      encodeReleaseExportTranscriptV3(
        {
          ...value,
          certification_units: [{ ...certificationUnit, carrier_package_id: '@fixture/b' }],
        },
        LIMITS,
      ),
    );
    refusal(() => encodeReleaseExportTranscriptV3({ ...value, certification_units: [] }, LIMITS));
    refusal(() =>
      encodeReleaseExportTranscriptV3(
        { ...value, certification_units: [certificationUnit, certificationUnit] },
        LIMITS,
      ),
    );
    refusal(() =>
      encodeReleaseExportTranscriptV3(
        {
          ...value,
          version: RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
        } as unknown as ReleaseExportTranscriptV3,
        LIMITS,
      ),
    );
  });

  it('refuses a v4 transcript under any non-Ed25519 signing identity', () => {
    const value = transcript();
    for (const algorithm of ['ecdsa-p256-sha256', 'rsa-pss-sha256'] as const) {
      const trust = { ...value.trust, signature_algorithm: algorithm };
      refusal(() =>
        encodeReleaseExportTranscriptV3(
          { ...value, trust, binding: { ...value.binding, trust } },
          LIMITS,
        ),
      );
    }
  });
});
