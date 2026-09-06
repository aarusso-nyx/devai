import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const receiptSchema = JSON.parse(
  readFileSync(
    resolve(ROOT, 'law/schemas/release-offline-verification-receipt.schema.json'),
    'utf8',
  ),
) as { examples: unknown[] };

const sha = (letter: string) => letter.repeat(64);
const git = '0123456789012345678901234567890123456789';

type Artifact = {
  kind: string;
  sink_id: string;
  opaque_handle: string;
  sha256: string;
  size_bytes: number;
};

type PackageEvidence = ReturnType<typeof packageArtifacts> & {
  package_id: string;
  trust: Record<string, unknown>;
};

interface ReceiptFixture {
  schemaVersion: string;
  canonicalization: { kernel_id: string };
  verified_state: unknown;
  artifacts: Artifact[];
  artifact_sink_commit: unknown;
  release_units: Array<{
    release_unit: string;
    version: string;
    packages: PackageEvidence[];
  }>;
  verification_kernel: {
    kernel_id: string;
    supported_canonicalization_kernels: string[];
    v3_sink_handle_closure: string;
    v3_sink_handle_errors: string[];
  };
}

function first<T>(values: readonly T[], context: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`${context} must not be empty`);
  return value;
}

const artifact = (kind: string, suffix: string): Artifact => ({
  kind,
  sink_id: 'trusted-sink',
  opaque_handle: `${kind}-${suffix}`,
  sha256: sha(suffix),
  size_bytes: 1,
});

function packageArtifacts() {
  return {
    package_manifest: artifact('package-manifest', 'a'),
    package_tarball: artifact('package-tarball', 'b'),
    package_sbom: artifact('package-sbom', 'c'),
    evidence_manifest: artifact('evidence-manifest', 'd'),
    provider_result: artifact('provider-result', 'e'),
  };
}

function projection(artifacts: Artifact[]) {
  return artifacts
    .map(({ kind, sink_id, opaque_handle, sha256, size_bytes }) => ({
      kind,
      sink_id,
      opaque_handle,
      sha256,
      size_bytes,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function firstImmutableBlobLocator(value: unknown): Record<string, unknown> {
  const state = value as {
    release_units?: Array<{
      packages?: Array<{
        certification_manifest?: {
          entries?: Array<{ immutable_blob_locator?: Record<string, unknown> }>;
        };
      }>;
    }>;
  };
  const locator =
    state.release_units?.[0]?.packages?.[0]?.certification_manifest?.entries?.[0]
      ?.immutable_blob_locator;
  if (!locator) {
    throw new Error('fixture is missing its first immutable blob locator');
  }
  return locator;
}

function fixtures() {
  const artifacts = packageArtifacts();
  const aggregate = Object.values(artifacts);
  const certificate = {
    candidate: { commit: git, tree: git },
    task_policy_digest_sha256: sha('f'),
    package_id: 'pkg',
    package_version: '1.0.0',
    entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse',
    manifest_digest_contract: {
      domain: 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\u0000',
      payload:
        'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes',
      canonicalization: 'rfc8785-jcs',
      algorithm: 'sha256',
    },
    entries: [
      {
        path: 'index.js',
        mode: '100644',
        size_bytes: 1,
        sha256: sha('1'),
        immutable_blob_locator: {
          kind: 'git-object',
          repository: 'devai',
          commit: git,
          tree: git,
          object_format: 'sha1',
          path: 'index.js',
          mode: '100644',
          object_id: git,
          size_bytes: 1,
          content_digest_sha256: sha('1'),
        },
      },
    ],
    manifest_digest_sha256: sha('2'),
  };
  const trust = {
    trust_root_id: 'devai-release',
    trust_store_digest_sha256: sha('3'),
    key_id: 'devai:release',
    signature_algorithm: 'ed25519',
  };
  const state = {
    schemaVersion: '2.1.0',
    canonicalization: {
      kernel_id: 'devai.kernel.release-lifecycle-state.v2',
      encoding: 'utf-8',
      json_form: 'rfc8785-jcs',
      digest_algorithm: 'sha256',
      projection_excludes: ['state_id', 'record_digest_sha256'],
      id_derivation: 'RLS-hyphen-plus-first-16-lowercase-hex-of-record_digest_sha256',
    },
    state_id: 'RLS-0123456789abcdef',
    state: 'exported',
    action_id: 'release export',
    effect: 'local-write',
    prior_state: {
      state: 'prepared',
      state_id: 'RLS-fedcba9876543210',
      record_digest_sha256: sha('4'),
    },
    bound_receipts: [],
    repository: { id: 'devai', commit: git, tree: git },
    candidate: { release_unit: 'unit', version: '1.0.0', commit: git, tree: git },
    release_units: [
      {
        release_unit: 'unit',
        version: '1.0.0',
        packages: [
          {
            package_id: 'pkg',
            ...artifacts,
            trust,
            certification_manifest: certificate,
          },
        ],
      },
    ],
    inputs: [{ kind: 'task-policy', path: 'law/policy/task.json', sha256: sha('5') }],
    evidence: {
      manifest_digest_sha256: sha('2'),
      receipt_digests: [],
      independently_checkable: true,
    },
    artifacts: structuredClone(aggregate),
    artifact_sink: {
      sink_id: 'trusted-sink',
      transaction_handle: 'transaction-1',
      committed_manifest_handle: 'committed-manifest-1',
      committed_manifest_sha256: sha('6'),
      committed_manifest_size_bytes: 1,
      commit_protocol: 'devai.artifact-sink.two-phase.v1',
    },
    actor: { kind: 'human', role: 'architect', declaration_source: 'cli-flag' },
    consent: { write: true, allow_publish: false, experimental: false },
    authorization_event_id: null,
    publication_expectation: null,
    storage: { generation: 2, head_before: { generation: 1, record_digest_sha256: sha('4') } },
    recorded_at: '2026-09-03T00:00:00Z',
    record_digest_sha256: sha('7'),
  };
  const receipt = structuredClone(
    first(receiptSchema.examples, 'receipt schema examples'),
  ) as ReceiptFixture;
  receipt.schemaVersion = '2.1.0';
  receipt.canonicalization.kernel_id =
    'devai.kernel.release-offline-verification-receipt-canonicalization.v3';
  receipt.verified_state = {
    state: 'exported',
    state_id: state.state_id,
    record_digest_sha256: state.record_digest_sha256,
  };
  receipt.artifacts = structuredClone(aggregate);
  receipt.artifact_sink_commit = structuredClone(state.artifact_sink);
  receipt.release_units = [
    {
      release_unit: 'unit',
      version: '1.0.0',
      packages: [
        {
          package_id: 'pkg',
          ...structuredClone(artifacts),
          trust: structuredClone(trust),
        },
      ],
    },
  ];
  receipt.verification_kernel.kernel_id = 'devai.kernel.offline-verification-receipt.v3';
  receipt.verification_kernel.supported_canonicalization_kernels = [
    'devai.kernel.release-offline-verification-receipt-canonicalization.v1',
    'devai.kernel.release-offline-verification-receipt-canonicalization.v2',
    'devai.kernel.release-offline-verification-receipt-canonicalization.v3',
  ];
  receipt.verification_kernel.v3_sink_handle_closure =
    'for-a-v2.1-receipt-resolve-every-aggregate-and-per-package-opaque-handle-through-the-external-sink-rehash-byte-digest-and-size-require-sorted-duplicate-free-one-to-one-equality-by-kind-sink_id-opaque_handle-sha256-size_bytes-with-the-exported-state-and-evidence-publish-input-and-verify-artifact-sink-commit-and-external-trust-inputs';
  receipt.verification_kernel.v3_sink_handle_errors = [
    'rov-v3-opaque-artifact-closure-invalid',
    'rov-v3-artifact-sink-commit-mismatch',
    'rov-v3-external-sink-reverification-failed',
    'rov-v3-evidence-publish-continuity-invalid',
  ];
  return { state, receipt, aggregate };
}

describe('release v3 artifact projection schemas', () => {
  it('accepts one byte-identical current state-to-receipt artifact projection', () => {
    const validateState = getValidator('release-lifecycle-state.schema.json');
    const validateReceipt = getValidator('release-offline-verification-receipt.schema.json');
    const { state, receipt, aggregate } = fixtures();

    expect(validateState(state), JSON.stringify(validateState.errors)).toBe(true);
    expect(validateReceipt(receipt), JSON.stringify(validateReceipt.errors)).toBe(true);
    expect(JSON.stringify(receipt.artifacts)).toBe(JSON.stringify(state.artifacts));
    expect(projection(aggregate)).toEqual(
      projection(
        Object.values(
          first(first(state.release_units, 'state release units').packages, 'state packages'),
        ).filter(
          (value): value is Artifact =>
            typeof value === 'object' && value !== null && 'kind' in value,
        ),
      ),
    );
  });

  it('rejects every mislabelled package kind plus duplicate and omission mutations', () => {
    const validateState = getValidator('release-lifecycle-state.schema.json');
    const validateReceipt = getValidator('release-offline-verification-receipt.schema.json');
    const fields = [
      ['package_manifest', 'package-tarball'],
      ['package_tarball', 'package-sbom'],
      ['package_sbom', 'evidence-manifest'],
      ['evidence_manifest', 'provider-result'],
      ['provider_result', 'package-manifest'],
    ] as const;

    for (const [field, wrongKind] of fields) {
      const { state, receipt } = fixtures();
      first(first(state.release_units, 'state release units').packages, 'state packages')[
        field
      ].kind = wrongKind;
      first(first(receipt.release_units, 'receipt release units').packages, 'receipt packages')[
        field
      ].kind = wrongKind;
      expect(validateState(state)).toBe(false);
      expect(validateReceipt(receipt)).toBe(false);
    }

    const duplicate = fixtures();
    duplicate.state.artifacts.push(
      structuredClone(first(duplicate.state.artifacts, 'state aggregate artifacts')),
    );
    duplicate.receipt.artifacts.push(
      structuredClone(first(duplicate.receipt.artifacts, 'receipt aggregate artifacts')),
    );
    expect(validateState(duplicate.state)).toBe(false);
    expect(validateReceipt(duplicate.receipt)).toBe(false);

    const omission = fixtures();
    omission.state.artifacts.pop();
    omission.receipt.artifacts.pop();
    expect(projection(omission.state.artifacts)).not.toEqual(projection(omission.aggregate));
    expect(projection(omission.receipt.artifacts)).not.toEqual(projection(omission.aggregate));
  });

  it('requires complete declared Git source locators for both supported object formats', () => {
    const validateState = getValidator('release-lifecycle-state.schema.json');
    const valid = fixtures();
    const locator = firstImmutableBlobLocator(valid.state);
    expect(validateState(valid.state), JSON.stringify(validateState.errors)).toBe(true);

    const missingMembership = structuredClone(valid.state);
    delete firstImmutableBlobLocator(missingMembership).path;
    expect(validateState(missingMembership)).toBe(false);

    const wrongSha1Length = structuredClone(valid.state);
    firstImmutableBlobLocator(wrongSha1Length).object_id = 'a'.repeat(64);
    expect(validateState(wrongSha1Length)).toBe(false);

    const sha256 = structuredClone(valid.state);
    const sha256Locator = firstImmutableBlobLocator(sha256);
    sha256Locator.object_format = 'sha256';
    sha256Locator.commit = 'a'.repeat(64);
    sha256Locator.tree = 'b'.repeat(64);
    sha256Locator.object_id = 'c'.repeat(64);
    expect(validateState(sha256), JSON.stringify(validateState.errors)).toBe(true);

    expect(locator).toMatchObject({
      repository: 'devai',
      path: 'index.js',
      mode: '100644',
      size_bytes: 1,
    });
  });
});
