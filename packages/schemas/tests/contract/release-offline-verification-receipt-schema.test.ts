import { createHash } from 'node:crypto';
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

interface CurrentReceipt {
  schemaVersion: string;
  canonicalization: { kernel_id: string };
  artifacts: unknown[];
  artifact_sink_commit?: unknown;
  release_units?: unknown[];
  verification_kernel: {
    kernel_id: string;
    supported_canonicalization_kernels: string[];
    v3_sink_handle_closure?: string;
    v3_sink_handle_errors?: string[];
  };
}

const sha = (letter: string) => letter.repeat(64);

function canonicalizeJcs(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJcs).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJcs(record[key])}`)
    .join(',')}}`;
}

function receiptDigest(receipt: Record<string, unknown>): string {
  const projection = structuredClone(receipt);
  delete projection.receipt_id;
  delete projection.receipt_digest_sha256;
  return createHash('sha256').update(canonicalizeJcs(projection), 'utf8').digest('hex');
}
const artifact = (kind: string, handle: string, digest: string) => ({
  kind,
  sink_id: 'trusted-sink',
  opaque_handle: handle,
  sha256: sha(digest),
  size_bytes: 1,
});

function currentReceipt(): CurrentReceipt {
  const receipt = structuredClone(receiptSchema.examples[0]) as CurrentReceipt;
  const packageManifest = artifact('package-manifest', 'package-manifest-1', 'a');
  const tarball = artifact('package-tarball', 'tarball-1', 'b');
  const packageSbom = artifact('package-sbom', 'package-sbom-1', 'c');
  const evidenceManifest = artifact('evidence-manifest', 'evidence-manifest-1', 'd');
  const providerResult = artifact('provider-result', 'provider-result-1', 'e');

  receipt.schemaVersion = '2.1.0';
  receipt.canonicalization.kernel_id =
    'devai.kernel.release-offline-verification-receipt-canonicalization.v3';
  receipt.artifacts = [packageManifest, tarball, packageSbom, evidenceManifest, providerResult];
  receipt.artifact_sink_commit = {
    sink_id: 'trusted-sink',
    transaction_handle: 'transaction-1',
    committed_manifest_handle: 'committed-manifest-1',
    committed_manifest_sha256: sha('f'),
    committed_manifest_size_bytes: 1,
    commit_protocol: 'devai.artifact-sink.two-phase.v1',
  };
  receipt.release_units = [
    {
      release_unit: '@aarusso-nyx/devai',
      version: '1.5.0',
      packages: [
        {
          package_id: '@aarusso-nyx/devai',
          package_manifest: packageManifest,
          package_tarball: tarball,
          package_sbom: packageSbom,
          evidence_manifest: evidenceManifest,
          provider_result: providerResult,
          trust: {
            trust_root_id: 'devai-release',
            trust_store_digest_sha256: sha('1'),
            key_id: 'devai:release',
            signature_algorithm: 'ed25519',
          },
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
  return receipt;
}

describe('release offline verification receipt schema', () => {
  it('preserves the pathname receipt as a read-only legacy form', () => {
    const validate = getValidator('release-offline-verification-receipt.schema.json');
    expect(validate(receiptSchema.examples[0]), JSON.stringify(validate.errors)).toBe(true);
  });

  it('recomputes the non-circular example identity from the exact JCS projection', () => {
    const example = structuredClone(receiptSchema.examples[0]) as Record<string, unknown>;
    const digest = receiptDigest(example);
    expect(digest).toBe(example.receipt_digest_sha256);
    expect(example.receipt_id).toBe(`ROV-${digest.slice(0, 16)}`);

    const alteredDerivedFields = structuredClone(example);
    alteredDerivedFields.receipt_id = 'ROV-0000000000000000';
    alteredDerivedFields.receipt_digest_sha256 = sha('0');
    expect(receiptDigest(alteredDerivedFields)).toBe(digest);

    const alteredCoveredField = structuredClone(example) as Record<string, unknown>;
    alteredCoveredField.verdict = 'fail';
    expect(receiptDigest(alteredCoveredField)).not.toBe(digest);
  });

  it('accepts only the current opaque-handle receipt form', () => {
    const validate = getValidator('release-offline-verification-receipt.schema.json');
    const receipt = currentReceipt();
    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a current receipt with a pathname artifact or no committed sink identity', () => {
    const validate = getValidator('release-offline-verification-receipt.schema.json');
    const pathname = currentReceipt();
    pathname.artifacts[0] = {
      kind: 'package-manifest',
      path: 'dist/manifest.json',
      sha256: sha('a'),
      size_bytes: 1,
    };
    expect(validate(pathname)).toBe(false);

    const missingCommit = currentReceipt();
    delete missingCommit.artifact_sink_commit;
    expect(validate(missingCommit)).toBe(false);

    const missingPackageArtifact = currentReceipt();
    const units = missingPackageArtifact.release_units as Array<{
      packages: Array<Record<string, unknown>>;
    }>;
    delete units[0]?.packages[0]?.provider_result;
    expect(validate(missingPackageArtifact)).toBe(false);

    const substitutedKind = currentReceipt();
    const substitutedUnits = substitutedKind.release_units as Array<{
      packages: Array<{ package_manifest: { kind: string } }>;
    }>;
    const firstPackage = substitutedUnits[0]?.packages[0];
    expect(firstPackage).toBeDefined();
    if (firstPackage === undefined) return;
    firstPackage.package_manifest.kind = 'package-sbom';
    expect(validate(substitutedKind)).toBe(false);
  });
});
