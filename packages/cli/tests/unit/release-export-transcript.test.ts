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
import {
  RELEASE_EXPORT_PROVIDER_RESULT_V2_FORMAT,
  RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
  encodeReleaseExportProviderResultV2,
  encodeReleaseExportTranscriptV2,
  verifyReleaseExportProviderResultSetV2,
  verifyReleaseExportProviderResultV2,
  verifyReleaseExportTranscriptV2,
  type ReleaseExportTranscriptV2,
  type ReleaseUnitMutationPortable,
} from '../../src/services/release-export-transcript-v2.js';
import { fixture as unitMutationFixture } from '../helpers/release-unit-mutation-evidence-fixture.js';

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
    [
      'an installed archive identity',
      (value: ReleaseExportTranscript) => ({
        ...value,
        closures: value.closures.map((closure, index) =>
          index === 0
            ? {
                ...closure,
                expected_installed_package: {
                  ...closure.expected_installed_package,
                  archive_sha256: DIGEST('other archive'),
                },
              }
            : closure,
        ),
      }),
    ],
    [
      'an installed content-manifest identity',
      (value: ReleaseExportTranscript) => ({
        ...value,
        closures: value.closures.map((closure, index) =>
          index === 0
            ? {
                ...closure,
                expected_installed_package: {
                  ...closure.expected_installed_package,
                  content_manifest_sha256: DIGEST('other content manifest'),
                },
              }
            : closure,
        ),
      }),
    ],
    [
      'the prepared parent commit identity',
      (value: ReleaseExportTranscript) => ({
        ...value,
        binding: {
          ...value.binding,
          parent_artifact_sink: {
            ...value.binding.parent_artifact_sink,
            committed_manifest_sha256: DIGEST('other commit'),
          },
        },
      }),
    ],
    [
      'a prepared parent artifact identity',
      (value: ReleaseExportTranscript) => ({
        ...value,
        parent: value.parent.map((parent, index) =>
          index === 0 ? { ...parent, sha256: DIGEST('other parent') } : parent,
        ),
      }),
    ],
    [
      'the lifecycle attempt identity',
      (value: ReleaseExportTranscript) => ({
        ...value,
        binding: { ...value.binding, attempt_id: 'RLA-fedcba9876543210' },
      }),
    ],
    [
      'the repository and candidate identity',
      (value: ReleaseExportTranscript) => ({
        ...value,
        binding: {
          ...value.binding,
          repository: { ...value.binding.repository, commit: 'c'.repeat(40) },
          candidate: { ...value.binding.candidate, commit: 'c'.repeat(40) },
        },
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

  it('rejects nested unknown keys, symbols, and accessors without invoking an accessor', () => {
    const value = transcript();
    refusal(() =>
      encodeReleaseExportTranscript(
        {
          ...value,
          closures: [
            { ...value.closures[0], unexpected: true },
            ...(value.closures.slice(1) as ReleaseExportTranscript['closures']),
          ],
        } as ReleaseExportTranscript,
        LIMITS,
      ),
    );
    refusal(() =>
      encodeReleaseExportTranscript(
        {
          ...value,
          parent: [
            { ...value.parent[0], [Symbol('unexpected')]: true },
            ...(value.parent.slice(1) as ReleaseExportTranscript['parent']),
          ],
        } as ReleaseExportTranscript,
        LIMITS,
      ),
    );
    let accesses = 0;
    const binding = { ...value.binding } as Record<string, unknown>;
    Object.defineProperty(binding, 'attempt_id', {
      enumerable: true,
      get: () => {
        accesses += 1;
        return 'RLA-0123456789abcdef';
      },
    });
    refusal(() =>
      encodeReleaseExportTranscript(
        { ...value, binding } as unknown as ReleaseExportTranscript,
        LIMITS,
      ),
    );
    expect(accesses).toBe(0);
  });

  it('refuses an array with an inherited serializer before invoking it', () => {
    const value = transcript();
    let serializations = 0;
    const parent = [...value.parent];
    Object.setPrototypeOf(parent, {
      toJSON: () => {
        serializations += 1;
        return [];
      },
    });

    refusal(() =>
      encodeReleaseExportTranscript(
        { ...value, parent: parent as unknown as ReleaseExportTranscript['parent'] },
        LIMITS,
      ),
    );
    expect(serializations).toBe(0);
  });

  it('retains distinct handles for byte-identical artifacts and refuses shared handles', () => {
    const value = transcript();
    const equalBytes = {
      ...value,
      parent: value.parent.map((parent, index) =>
        index === 1 ? { ...parent, sha256: value.parent[0]?.sha256 ?? '' } : parent,
      ),
    };
    const equalBytesTranscript = encodeReleaseExportTranscript(equalBytes, LIMITS);
    expect(
      verifyReleaseExportTranscript(equalBytesTranscript, equalBytes, LIMITS).parent,
    ).toHaveLength(6);
    refusal(() =>
      encodeReleaseExportTranscript(
        {
          ...value,
          parent: value.parent.map((parent, index) =>
            index === 1
              ? { ...parent, opaque_handle: value.parent[0]?.opaque_handle ?? '' }
              : parent,
          ),
        },
        LIMITS,
      ),
    );
  });

  it('rejects incomplete or type-confused parent and closure populations', () => {
    const value = transcript();
    refusal(() =>
      encodeReleaseExportTranscript({ ...value, parent: value.parent.slice(1) }, LIMITS),
    );
    refusal(() =>
      encodeReleaseExportTranscript(
        {
          ...value,
          parent: [
            artifact('package-manifest', 'manifest-a', 'manifest-a'),
            artifact('package-manifest', 'manifest-b', 'manifest-b'),
            artifact('package-manifest', 'manifest-c', 'manifest-c'),
            artifact('package-sbom', 'sbom-a', 'sbom-a'),
            artifact('package-tarball', 'tarball-a', 'tarball-a'),
            artifact('package-tarball', 'tarball-b', 'tarball-b'),
          ],
        },
        LIMITS,
      ),
    );
    refusal(() =>
      encodeReleaseExportTranscript({ ...value, closures: value.closures.slice(1) }, LIMITS),
    );
    const secondClosure = value.closures[1];
    if (secondClosure === undefined) throw new Error('fixture closure missing');
    const extraClosure = {
      ...secondClosure,
      package_id: '@fixture/c',
      evidence_manifest: artifact('evidence-manifest', 'closure-c', 'closure-c'),
    };
    const extraPopulation: ReleaseExportTranscript = {
      ...value,
      parent: [
        ...value.parent,
        artifact('package-manifest', 'manifest-c', 'manifest-c'),
        artifact('package-sbom', 'sbom-c', 'sbom-c'),
        artifact('package-tarball', 'tarball-c', 'tarball-c'),
      ].sort((left, right) => {
        const key = (entry: OpaqueArtifactIdentity) =>
          `${entry.kind}\0${entry.sink_id}\0${entry.opaque_handle}\0${entry.sha256}\0${entry.size_bytes}`;
        return Buffer.compare(Buffer.from(key(left)), Buffer.from(key(right)));
      }),
      closures: [...value.closures, extraClosure],
    };
    const extraBytes = encodeReleaseExportTranscript(extraPopulation, {
      ...LIMITS,
      maximum_packages: 3,
    });
    refusal(() =>
      verifyReleaseExportTranscript(extraBytes, value, { ...LIMITS, maximum_packages: 3 }),
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
    refusal(() => verifyReleaseExportTranscript(Buffer.from([0xc3]), value, LIMITS));
    refusal(() => verifyReleaseExportProviderResult(Buffer.from([0xc3]), input, LIMITS));
    refusal(() => verifyReleaseExportProviderResult(encoded, input, LIMITS));
    refusal(() => verifyReleaseExportTranscript(bytes, value, LIMITS));
  });
});

describe('release export transcript v2 mutation carrier', () => {
  async function forwardFixture() {
    const base = transcript();
    const unit = await unitMutationFixture({
      packages: [{ packageName: '@fixture/internal', workspace: 'packages/internal' }],
      binding: {
        repository_id: base.binding.repository.id,
        candidate_commit: base.binding.candidate.commit,
        candidate_tree: base.binding.candidate.tree,
        release_unit: '@fixture/unit',
        release_plan_receipt_digest_sha256: base.binding.plan_receipt_digest_sha256,
      },
    });
    const closure = Buffer.from(canonicalJson(unit.closure));
    const receipt = Buffer.from(canonicalJson(unit.closure.receipt));
    const document = (path: string, value: Buffer) => ({
      path,
      sha256: DIGEST(value),
      size_bytes: value.length,
      bytes_base64: value.toString('base64'),
    });
    const portable: ReleaseUnitMutationPortable = {
      version: 'devai.release-unit-mutation-portable-json.v1',
      closure: {
        sha256: DIGEST(closure),
        size_bytes: closure.length,
        bytes_base64: closure.toString('base64'),
      },
      receipt: {
        sha256: DIGEST(receipt),
        size_bytes: receipt.length,
        bytes_base64: receipt.toString('base64'),
      },
      output_contract: document(
        unit.closure.output_contract.path,
        unit.read(unit.closure.output_contract),
      ),
      members: unit.closure.members.map((member) => document(member.path, unit.read(member))),
    };
    const mutationEvidence = {
      carrier_package_id: '@fixture/a',
      binding: unit.binding,
      closure: { sha256: DIGEST(closure), size_bytes: closure.length },
      receipt: {
        sha256: DIGEST(receipt),
        size_bytes: receipt.length,
        receipt_digest_sha256: unit.closure.receipt.receipt_digest_sha256,
      },
      output_contract: unit.closure.output_contract,
      members: unit.closure.members,
      member_projection_digest_sha256:
        unit.closure.receipt.referent.member_projection_digest_sha256,
    };
    const value: ReleaseExportTranscriptV2 = {
      ...base,
      version: RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
      closures: base.closures.map((row) => ({ ...row, release_unit: '@fixture/unit' })),
      mutation_units: [{ release_unit: '@fixture/unit', mutation_evidence: mutationEvidence }],
    };
    const encoded = encodeReleaseExportTranscriptV2(value, LIMITS);
    return { encoded, portable, value };
  }

  it('emits and verifies the exact v2 projection and elected portable carrier', async () => {
    const value = await forwardFixture();
    expect(verifyReleaseExportTranscriptV2(value.encoded, value.value, LIMITS)).toEqual(
      value.value,
    );
    const provider = encodeReleaseExportProviderResultV2(
      {
        package_id: '@fixture/a',
        transcript: value.encoded,
        signature: 'AQ==',
        mutation_evidence: value.portable,
      },
      LIMITS,
    );
    expect(
      verifyReleaseExportProviderResultV2(
        provider,
        { package_id: '@fixture/a', transcript: value.encoded, signature: 'AQ==' },
        LIMITS,
      ),
    ).toMatchObject({
      version: RELEASE_EXPORT_PROVIDER_RESULT_V2_FORMAT,
      mutation_evidence: value.portable,
    });
    const noncarrier = encodeReleaseExportProviderResultV2(
      {
        package_id: '@fixture/b',
        transcript: value.encoded,
        signature: 'AQ==',
        mutation_evidence: null,
      },
      LIMITS,
    );
    expect(
      verifyReleaseExportProviderResultSetV2(
        [provider, noncarrier],
        { transcript: value.encoded, signature: 'AQ==' },
        LIMITS,
      ),
    ).toHaveLength(2);
  });

  it('refuses carrier election, incomplete sets, and malformed embedded canonical bytes', async () => {
    const value = await forwardFixture();
    refusal(() =>
      encodeReleaseExportProviderResultV2(
        {
          package_id: '@fixture/b',
          transcript: value.encoded,
          signature: 'AQ==',
          mutation_evidence: value.portable,
        },
        LIMITS,
      ),
    );
    const carrier = encodeReleaseExportProviderResultV2(
      {
        package_id: '@fixture/a',
        transcript: value.encoded,
        signature: 'AQ==',
        mutation_evidence: value.portable,
      },
      LIMITS,
    );
    refusal(() =>
      verifyReleaseExportProviderResultSetV2(
        [carrier],
        { transcript: value.encoded, signature: 'AQ==' },
        LIMITS,
      ),
    );
    const altered = structuredClone(value.portable) as ReleaseUnitMutationPortable;
    const closure = altered.closure as { bytes_base64: string };
    closure.bytes_base64 = `${closure.bytes_base64}\n`;
    refusal(() =>
      encodeReleaseExportProviderResultV2(
        {
          package_id: '@fixture/a',
          transcript: value.encoded,
          signature: 'AQ==',
          mutation_evidence: altered,
        },
        LIMITS,
      ),
    );
    refusal(() =>
      verifyReleaseExportTranscriptV2(Buffer.from(`${value.encoded}\n`), value.value, LIMITS),
    );
  });

  it('requires an explicit null carrier population for mutation-none units', () => {
    const base = transcript();
    const value: ReleaseExportTranscriptV2 = {
      ...base,
      version: RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
      closures: base.closures.map((row) => ({ ...row, release_unit: '@fixture/unit' })),
      mutation_units: [{ release_unit: '@fixture/unit', mutation_evidence: null }],
    };
    const encoded = encodeReleaseExportTranscriptV2(value, LIMITS);
    const results = base.closures.map((row) =>
      encodeReleaseExportProviderResultV2(
        {
          package_id: row.package_id,
          transcript: encoded,
          signature: 'AQ==',
          mutation_evidence: null,
        },
        LIMITS,
      ),
    );

    expect(
      verifyReleaseExportProviderResultSetV2(
        results,
        { transcript: encoded, signature: 'AQ==' },
        LIMITS,
      ),
    ).toHaveLength(2);
    refusal(() =>
      encodeReleaseExportTranscriptV2(
        { ...value, version: RELEASE_EXPORT_TRANSCRIPT_FORMAT } as ReleaseExportTranscriptV2,
        LIMITS,
      ),
    );
    refusal(() => verifyReleaseExportTranscript(encoded, transcript(), LIMITS));
  });

  it('refuses extra or missing carrier members and altered closure, receipt, and projection identities', async () => {
    const value = await forwardFixture();
    const [portableMember] = value.portable.members;
    if (portableMember === undefined) throw new Error('fixture member missing');
    for (const mutationEvidence of [
      { ...value.portable, members: value.portable.members.slice(1) },
      {
        ...value.portable,
        members: [...value.portable.members, portableMember],
      },
      {
        ...value.portable,
        closure: { ...value.portable.closure, sha256: DIGEST('substituted-closure') },
      },
      {
        ...value.portable,
        receipt: { ...value.portable.receipt, sha256: DIGEST('substituted-receipt') },
      },
    ]) {
      refusal(() =>
        encodeReleaseExportProviderResultV2(
          {
            package_id: '@fixture/a',
            transcript: value.encoded,
            signature: 'AQ==',
            mutation_evidence: mutationEvidence,
          },
          LIMITS,
        ),
      );
    }

    const [unit] = value.value.mutation_units;
    const evidence = unit?.mutation_evidence;
    if (evidence === undefined || evidence === null) throw new Error('fixture evidence missing');
    const [first] = evidence.members;
    if (first === undefined) throw new Error('fixture projection member missing');
    const sha256 = DIGEST('substituted-projection-member');
    const members = [
      { ...first, sha256, opaque_handle: `sha256:${sha256}` },
      ...evidence.members.slice(1),
    ];
    const projected: ReleaseExportTranscriptV2 = {
      ...value.value,
      mutation_units: [
        {
          release_unit: '@fixture/unit',
          mutation_evidence: {
            ...evidence,
            members,
            member_projection_digest_sha256: DIGEST(canonicalJson(members)),
          },
        },
      ],
    };
    const transcriptWithSubstitutedProjection = encodeReleaseExportTranscriptV2(projected, LIMITS);
    refusal(() =>
      encodeReleaseExportProviderResultV2(
        {
          package_id: '@fixture/a',
          transcript: transcriptWithSubstitutedProjection,
          signature: 'AQ==',
          mutation_evidence: value.portable,
        },
        LIMITS,
      ),
    );
  });

  it('refuses duplicate package carriers, noncanonical resources, malformed UTF-8, and bounded oversized results', async () => {
    const value = await forwardFixture();
    const carrier = encodeReleaseExportProviderResultV2(
      {
        package_id: '@fixture/a',
        transcript: value.encoded,
        signature: 'AQ==',
        mutation_evidence: value.portable,
      },
      LIMITS,
    );
    const noncarrier = encodeReleaseExportProviderResultV2(
      {
        package_id: '@fixture/b',
        transcript: value.encoded,
        signature: 'AQ==',
        mutation_evidence: null,
      },
      LIMITS,
    );
    refusal(() =>
      verifyReleaseExportProviderResultSetV2(
        [carrier, carrier],
        { transcript: value.encoded, signature: 'AQ==' },
        LIMITS,
      ),
    );
    const altered = JSON.parse(noncarrier.toString('utf8')) as Record<string, unknown>;
    altered['transcript'] = `${altered['transcript'] as string}\n`;
    refusal(() =>
      verifyReleaseExportProviderResultV2(
        Buffer.from(canonicalJson(altered)),
        { package_id: '@fixture/b', transcript: value.encoded, signature: 'AQ==' },
        LIMITS,
      ),
    );
    refusal(() =>
      verifyReleaseExportProviderResultV2(
        Buffer.from([0xc3]),
        { package_id: '@fixture/a', transcript: value.encoded, signature: 'AQ==' },
        LIMITS,
      ),
    );
    refusal(() =>
      encodeReleaseExportProviderResultV2(
        {
          package_id: '@fixture/a',
          transcript: value.encoded,
          signature: 'AQ==',
          mutation_evidence: value.portable,
        },
        { ...LIMITS, maximum_provider_result_bytes: 1 },
      ),
    );
  });

  it('refuses proxied forward binding, parent, and mutation-unit inputs before any proxy trap runs', async () => {
    const { value } = await forwardFixture();
    const [unit] = value.mutation_units;
    if (unit === undefined) throw new Error('fixture unit missing');
    const cases: readonly {
      readonly target: object;
      readonly apply: (proxy: object) => ReleaseExportTranscriptV2;
    }[] = [
      {
        target: value.binding,
        apply: (proxy) => ({ ...value, binding: proxy as ReleaseExportTranscriptV2['binding'] }),
      },
      {
        target: value.parent,
        apply: (proxy) => ({ ...value, parent: proxy as ReleaseExportTranscriptV2['parent'] }),
      },
      {
        target: unit,
        apply: (proxy) => ({
          ...value,
          mutation_units: [proxy as ReleaseExportTranscriptV2['mutation_units'][number]],
        }),
      },
    ];
    for (const { target, apply } of cases) {
      let reads = 0;
      const proxy = new Proxy(target, {
        get(object, key, receiver) {
          reads += 1;
          return Reflect.get(object, key, receiver);
        },
      });
      refusal(() => encodeReleaseExportTranscriptV2(apply(proxy), LIMITS));
      expect(reads).toBe(0);
    }
  });
});
