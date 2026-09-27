import { gunzipSync } from 'node:zlib';
import { decodeContainerArchive } from './container-archive.js';
import { canonicalJson } from '@devai-nyx/utils';
import type { PackageEvidence } from './release-lifecycle-execution.js';
import {
  type VerifiedPackage,
  certificationManifestDigest,
  same,
  sha256,
  RELEASE_PACK_SPEC_ID,
  RELEASE_PACK_SPEC_DIGEST,
} from './release-prepare-kernel-contract.js';
import { tar, deterministicGzip, spdxBytes } from './release-prepare-kernel-archive.js';

/** Rebind retained prepared bytes to their package row; digest checks alone do not prevent swaps. */
export function verifyPreparedPackageManifest(input: {
  readonly bytes: Buffer;
  readonly package: PackageEvidence;
  readonly version: string;
  readonly candidate: { readonly commit: string; readonly tree: string };
}): void {
  const pkg = input.package;
  const certification = pkg.certification_manifest;
  const tarball = pkg.package_tarball;
  const sbom = pkg.package_sbom;
  if (certification == null || tarball == null || sbom == null)
    throw new Error('release-downstream-artifact-reverification-failed');
  const { manifest_digest_sha256, ...draft } = certification;
  const expected = {
    schemaVersion: '2.0.0',
    kind: 'release-prepared-package-manifest',
    candidate: input.candidate,
    package_id: pkg.package_id,
    package_version: input.version,
    pack_spec_id: RELEASE_PACK_SPEC_ID,
    pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
    certification_manifest_digest_sha256: manifest_digest_sha256,
    artifacts: {
      tarball: { sha256: tarball.sha256, size_bytes: tarball.size_bytes },
      sbom: { sha256: sbom.sha256, size_bytes: sbom.size_bytes },
    },
  };
  if (
    certificationManifestDigest(draft) !== manifest_digest_sha256 ||
    certification.package_id !== pkg.package_id ||
    certification.package_version !== input.version ||
    !same(certification.candidate, input.candidate) ||
    !input.bytes.equals(Buffer.from(canonicalJson(expected), 'utf8'))
  )
    throw new Error('release-downstream-artifact-reverification-failed');
}

/** Verify retained package bytes without a source checkout or any sink write. */
export function verifyPreparedPackageArchive(input: {
  readonly package: PackageEvidence;
  readonly release_unit: string;
  readonly version: string;
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly manifest: Buffer;
  readonly tarball: Buffer;
  readonly sbom: Buffer;
  readonly maximum_archive_bytes: number;
}): readonly {
  readonly path: string;
  readonly mode: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}[] {
  const fail = (): never => {
    throw new Error('release-downstream-artifact-reverification-failed');
  };
  const maximum = input.maximum_archive_bytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1024 || input.tarball.length > maximum) fail();
  verifyPreparedPackageManifest({
    bytes: input.manifest,
    package: input.package,
    version: input.version,
    candidate: { commit: input.candidate.commit, tree: input.candidate.tree },
  });
  const certification = input.package.certification_manifest ?? fail();
  const tarball = input.package.package_tarball ?? fail();
  const sbom = input.package.package_sbom ?? fail();
  if (
    sha256(input.tarball) !== tarball.sha256 ||
    input.tarball.length !== tarball.size_bytes ||
    sha256(input.sbom) !== sbom.sha256 ||
    input.sbom.length !== sbom.size_bytes
  )
    fail();
  let unpacked: Buffer;
  try {
    unpacked = gunzipSync(input.tarball, { maxOutputLength: maximum });
  } catch {
    return fail();
  }
  const entries = decodeContainerArchive(unpacked, maximum).map((entry) => {
    if (!entry.path.startsWith('package/')) return fail();
    return {
      path: entry.path.slice('package/'.length),
      mode: entry.mode,
      sha256: sha256(entry.bytes),
      bytes: Buffer.from(entry.bytes),
    };
  });
  const expected = certification.entries.map(({ path, mode, sha256: digest, size_bytes }) => ({
    path,
    mode,
    sha256: digest,
    size_bytes,
  }));
  if (
    !same(
      entries.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        sha256: entry.sha256,
        size_bytes: entry.bytes.length,
      })),
      expected,
    )
  )
    fail();
  const verified: VerifiedPackage = {
    release_unit: input.release_unit,
    version: input.version,
    package_id: input.package.package_id,
    certification_manifest: certification,
    entries,
  };
  // These are pure byte comparisons, not calls to a build, packer, subprocess or sink.
  if (
    !unpacked.equals(tar(entries)) ||
    !input.tarball.equals(deterministicGzip(unpacked)) ||
    !input.sbom.equals(spdxBytes(verified))
  )
    fail();
  return entries;
}
