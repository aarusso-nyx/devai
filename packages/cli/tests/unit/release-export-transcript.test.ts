import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';
import {
  RELEASE_EXPORT_PROVIDER_RESULT_FORMAT,
  RELEASE_EXPORT_TRANSCRIPT_FORMAT,
  encodeReleaseExportProviderResult,
  encodeReleaseExportTranscript,
  verifyReleaseExportProviderResult,
  verifyReleaseExportTranscript,
  type ReleaseExportTranscript,
  type ReleaseExportTranscriptLimits,
} from '../../src/services/release-export-transcript.js';
import type { OpaqueArtifactIdentity } from '../../src/services/release-lifecycle-execution.js';

const DIGEST = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const LIMITS: ReleaseExportTranscriptLimits = {
  maximum_transcript_bytes: 64 * 1024,
  maximum_provider_result_bytes: 64 * 1024,
  maximum_packages: 2,
};

function artifact(kind: OpaqueArtifactIdentity['kind'], handle: string, value: string) {
  return {
    kind,
    sink_id: 'fixture-sink',
    opaque_handle: handle,
    sha256: DIGEST(value),
    size_bytes: Buffer.byteLength(value),
  };
}

function transcript(): ReleaseExportTranscript {
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
    version: RELEASE_EXPORT_TRANSCRIPT_FORMAT,
    binding: {
      action_id: 'release export',
      repository: { id: 'aarusso-nyx/devai', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
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
        evidence_manifest: artifact('evidence-manifest', 'closure-a', 'closure-a'),
        expected_installed_package: expectedInstalledPackage,
        policy_resolution_digest_sha256: DIGEST('resolution-a'),
      },
      {
        package_id: '@fixture/b',
        evidence_manifest: artifact('evidence-manifest', 'closure-b', 'closure-b'),
        expected_installed_package: expectedInstalledPackage,
        policy_resolution_digest_sha256: DIGEST('resolution-b'),
      },
    ],
    destination,
    trust,
  };
}

function refusal(run: () => unknown): void {
  expect(run).toThrow(/^release-export-transcript-invalid$/u);
}

describe('release export transcript transport', () => {
  it('retains the complete acyclic canonical preimage and every package closure identity', () => {
    const value = transcript();
    const bytes = encodeReleaseExportTranscript(value, LIMITS);
    const verified = verifyReleaseExportTranscript(bytes, value, LIMITS);

    expect(bytes.toString('utf8')).toBe(canonicalJson(value));
    expect(verified).toEqual(value);
    expect(verified.parent).toHaveLength(6);
    expect(verified.closures).toEqual(value.closures);
    expect(verified.binding.destination).toEqual(verified.destination);
    expect(verified.binding.trust).toEqual(verified.trust);
  });

  it.each([
    [
      'a substituted evidence-manifest identity',
      (value: ReleaseExportTranscript) => ({
        ...value,
        closures: value.closures.map((closure, index) =>
          index === 0
            ? {
                ...closure,
                evidence_manifest: { ...closure.evidence_manifest, opaque_handle: 'other-closure' },
              }
            : closure,
        ),
      }),
    ],
    [
      'a substituted policy resolution digest',
      (value: ReleaseExportTranscript) => ({
        ...value,
        closures: value.closures.map((closure, index) =>
          index === 0
            ? { ...closure, policy_resolution_digest_sha256: DIGEST('substituted') }
            : closure,
        ),
      }),
    ],
  ])(
    'refuses bytes that differ from the independently expected transcript: %s',
    (_label, alter) => {
      const value = transcript();
      const altered = alter(value);
      const bytes = encodeReleaseExportTranscript(altered, LIMITS);
      refusal(() => verifyReleaseExportTranscript(bytes, value, LIMITS));
    },
  );

  it('requires the duplicate destination and trust bindings to be exactly equal', () => {
    const value = transcript();
    refusal(() =>
      encodeReleaseExportTranscript(
        { ...value, destination: { ...value.destination, exact_identifier: 's3://other' } },
        LIMITS,
      ),
    );
    refusal(() =>
      encodeReleaseExportTranscript(
        { ...value, trust: { ...value.trust, trust_root_id: 'other/trust' } },
        LIMITS,
      ),
    );
  });

  it('rejects noncanonical encodings, ordering changes, duplicate handles, and type confusion', () => {
    const value = transcript();
    const bytes = encodeReleaseExportTranscript(value, LIMITS);
    refusal(() => verifyReleaseExportTranscript(Buffer.from(`${bytes}\n`), value, LIMITS));
    refusal(() =>
      encodeReleaseExportTranscript({ ...value, parent: [...value.parent].reverse() }, LIMITS),
    );
    refusal(() =>
      encodeReleaseExportTranscript({ ...value, closures: [...value.closures].reverse() }, LIMITS),
    );
    refusal(() =>
      encodeReleaseExportTranscript(
        {
          ...value,
          closures: value.closures.map((closure, index) =>
            index === 1
              ? {
                  ...closure,
                  evidence_manifest: {
                    ...closure.evidence_manifest,
                    opaque_handle: 'closure-a',
                  },
                }
              : closure,
          ),
        },
        LIMITS,
      ),
    );
    refusal(() =>
      encodeReleaseExportTranscript(
        {
          ...value,
          binding: {
            ...value.binding,
            destination: { ...value.binding.destination, kind: 'path' },
          },
        },
        LIMITS,
      ),
    );
    const confused = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    confused['extra'] = true;
    refusal(() =>
      encodeReleaseExportTranscript(confused as unknown as ReleaseExportTranscript, LIMITS),
    );
  });

  it('bounds every package population and both retained transport byte sequences', () => {
    const value = transcript();
    refusal(() => encodeReleaseExportTranscript(value, { ...LIMITS, maximum_packages: 1 }));
    refusal(() => encodeReleaseExportTranscript(value, { ...LIMITS, maximum_transcript_bytes: 1 }));

    const encoded = encodeReleaseExportTranscript(value, LIMITS);
    refusal(() =>
      encodeReleaseExportProviderResult(
        { package_id: '@fixture/a', transcript: encoded, signature: 'AQ==' },
        { ...LIMITS, maximum_provider_result_bytes: 1 },
      ),
    );
    refusal(() =>
      encodeReleaseExportTranscript(value, { ...LIMITS, maximum_packages: Number.NaN }),
    );
  });

  it('binds each provider result to one complete transcript, package closure, signature, and trust', () => {
    const value = transcript();
    const encoded = encodeReleaseExportTranscript(value, LIMITS);
    const input = { package_id: '@fixture/a', transcript: encoded, signature: 'AQ==' };
    const bytes = encodeReleaseExportProviderResult(input, LIMITS);
    const result = verifyReleaseExportProviderResult(bytes, input, LIMITS);

    expect(result).toMatchObject({
      version: RELEASE_EXPORT_PROVIDER_RESULT_FORMAT,
      package_id: '@fixture/a',
      evidence_manifest: value.closures[0]?.evidence_manifest,
      transcript: encoded.toString('utf8'),
      transcript_sha256: DIGEST(encoded),
      signature: 'AQ==',
      trust: value.trust,
    });
    refusal(() =>
      encodeReleaseExportProviderResult({ ...input, package_id: '@fixture/missing' }, LIMITS),
    );
    refusal(() => encodeReleaseExportProviderResult({ ...input, signature: 'not-base64' }, LIMITS));
    refusal(() =>
      verifyReleaseExportProviderResult(
        bytes,
        { ...input, transcript: Buffer.from(`${encoded.toString('utf8')}\n`) },
        LIMITS,
      ),
    );
    const altered = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    altered['signature'] = 'Ag==';
    refusal(() =>
      verifyReleaseExportProviderResult(Buffer.from(canonicalJson(altered)), input, LIMITS),
    );
  });
});
