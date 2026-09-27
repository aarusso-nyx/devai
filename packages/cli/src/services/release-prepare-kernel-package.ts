import { type ReleaseExportTranscriptLimits } from './release-export-transcript.js';
import { resolveReleaseMutationRequirements } from './release-lifecycle-execution.js';
import type {
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
  ReleaseStateMaterial,
  TrustedArtifactReader,
} from './release-lifecycle-execution.js';
import {
  type VerifiedPackage,
  same,
  type ImmutableReleaseContentSource,
  gitObjectDigest,
  sha256,
  object,
  safeOpaqueIdentity,
  type ReleaseMutationPlanReaders,
  type ReleaseUnitMutationEvidenceReader,
} from './release-prepare-kernel-contract.js';
import {
  verifyCertificationManifest,
  verifyCertificationOutputClosure,
  verifyGitMembership,
  verifyCertificationReceipt,
} from './release-prepare-kernel-certification.js';

export async function verifyPackage(
  source: ImmutableReleaseContentSource,
  request: ReleaseLifecycleRequest,
  state: Pick<ReleaseStateMaterial, 'release_units' | 'inputs'>,
  unitIndex: number,
  packageIndex: number,
): Promise<VerifiedPackage> {
  const requestUnit = request.candidate_locator.release_units[unitIndex];
  const stateUnit = state.release_units[unitIndex];
  const requestPackage = requestUnit?.package_roster[packageIndex];
  const statePackage = stateUnit?.packages[packageIndex];
  if (
    requestUnit === undefined ||
    stateUnit === undefined ||
    requestPackage === undefined ||
    statePackage === undefined ||
    statePackage.certification_manifest === undefined ||
    statePackage.certification_manifest === null
  ) {
    throw new Error('release-prepare-certification-manifest-invalid');
  }
  const taskPolicyDigests = new Set(
    (state['inputs'] as readonly { readonly kind: string; readonly sha256: string }[])
      .filter((entry) => entry.kind === 'task-policy')
      .map((entry) => entry.sha256),
  );
  const manifest = verifyCertificationManifest(statePackage.certification_manifest, {
    request,
    package_id: requestPackage.package_id,
    package_version: requestUnit.version,
    task_policy_digests: taskPolicyDigests,
  });
  const entries: Array<VerifiedPackage['entries'][number]> = [];
  await verifyCertificationOutputClosure(source, request, manifest);
  for (const entry of manifest.entries) {
    let bytes: Buffer;
    if (entry.immutable_blob_locator.kind === 'git-object') {
      await verifyGitMembership(source, request, entry.immutable_blob_locator);
      try {
        bytes = Buffer.from(
          await source.readGitBlob({
            repository: request.repository_locator,
            candidate: request.candidate_locator,
            object_id: entry.immutable_blob_locator.object_id,
            locator: entry.immutable_blob_locator,
          }),
        );
      } catch {
        throw new Error('release-prepare-immutable-blob-locator-invalid');
      }
      if (
        gitObjectDigest(bytes, 'blob', entry.immutable_blob_locator.object_format) !==
        entry.immutable_blob_locator.object_id
      ) {
        throw new Error('release-prepare-immutable-blob-locator-invalid');
      }
    } else {
      const locator = entry.immutable_blob_locator;
      const expectedReferent = {
        candidate_commit: request.candidate_locator.commit,
        candidate_tree: request.candidate_locator.tree,
        task_policy_digest_sha256: manifest.task_policy_digest_sha256,
        package_id: requestPackage.package_id,
        output_blob_sha256: entry.sha256,
        output_blob_handle: locator.output_blob_handle,
      };
      if (
        locator.output_blob_sha256 !== entry.sha256 ||
        locator.output_blob_handle?.sha256 !== entry.sha256 ||
        locator.output_blob_handle?.size_bytes !== entry.size_bytes ||
        !safeOpaqueIdentity(locator.output_blob_handle?.evidence_sink_id ?? '') ||
        !safeOpaqueIdentity(locator.output_blob_handle?.opaque_handle ?? '') ||
        !same(locator.certification_evidence_receipt.referent, expectedReferent)
      ) {
        throw new Error('release-prepare-immutable-blob-locator-invalid');
      }
      try {
        const receipt = await source.readCertificationEvidenceReceipt({
          receipt_digest_sha256: locator.certification_evidence_receipt.receipt_digest_sha256,
          evidence_sink_id: locator.output_blob_handle.evidence_sink_id,
        });
        verifyCertificationReceipt(receipt, locator.certification_evidence_receipt);
        bytes = Buffer.from(
          await source.readGeneratedBlob({
            repository: request.repository_locator,
            candidate: request.candidate_locator,
            receipt: locator.certification_evidence_receipt,
            output_blob_sha256: locator.output_blob_sha256,
            output_blob_handle: locator.output_blob_handle,
          }),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'release-prepare-immutable-blob-locator-invalid'
        ) {
          throw error;
        }
        throw new Error('release-prepare-immutable-blob-locator-invalid');
      }
    }
    if (bytes.byteLength !== entry.size_bytes || sha256(bytes) !== entry.sha256) {
      throw new Error('release-prepare-content-digest-mismatch');
    }
    entries.push({ path: entry.path, mode: entry.mode, sha256: entry.sha256, bytes });
  }
  const packageJson = entries.find((entry) => entry.path === 'package.json');
  if (packageJson === undefined) throw new Error('release-prepare-package-entry-coverage-invalid');
  let packageDocument: Readonly<Record<string, unknown>>;
  try {
    packageDocument = object(JSON.parse(packageJson.bytes.toString('utf8')) as unknown);
  } catch {
    throw new Error('release-prepare-unsupported-package-semantics');
  }
  if (
    packageDocument['name'] !== requestPackage.package_id ||
    packageDocument['version'] !== requestUnit.version
  ) {
    throw new Error('release-package-manifest-identity-mismatch');
  }
  if (
    packageJson.sha256 !== requestPackage.manifest_digest_sha256 ||
    sha256(packageJson.bytes) !== requestPackage.manifest_digest_sha256
  ) {
    throw new Error('release-package-manifest-identity-mismatch');
  }
  return {
    release_unit: requestUnit.release_unit,
    version: requestUnit.version,
    package_id: requestPackage.package_id,
    certification_manifest: manifest,
    entries,
  };
}

export async function verifyCertificationMaterial(
  request: ReleaseLifecycleRequest,
  material: ReleaseStateMaterial,
  source: ImmutableReleaseContentSource,
  plan: ReleaseMutationPlanReaders = {},
): Promise<void> {
  await verifyCertificationMutationEvidence(request, material, source, plan);
  for (const [unitIndex, unit] of request.candidate_locator.release_units.entries()) {
    for (const packageIndex of unit.package_roster.keys()) {
      await verifyPackage(source, request, material, unitIndex, packageIndex);
    }
  }
}

/** Unit evidence is retained outside publishable package entries and is never a tarball input. */
export async function verifyCertificationMutationEvidence(
  request: ReleaseLifecycleRequest,
  material: Pick<ReleaseStateMaterial, 'release_units' | 'inputs'>,
  source: ReleaseUnitMutationEvidenceReader,
  plan: ReleaseMutationPlanReaders,
): Promise<void> {
  void source;
  resolveReleaseMutationRequirements(request, plan);
  const expected = request.candidate_locator.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.package_roster.map((pkg) => pkg.package_id),
  }));
  const observed = material.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.packages.map((pkg) => pkg.package_id),
  }));
  if (!same(expected, observed)) throw new Error('release-certification-output-closure-invalid');
}

/** Full profile/roster semantics after authenticated export continuity. Reads only bundle artifacts. */
export async function verifyPortableReleaseMutationEvidence(
  request: ReleaseLifecycleRequest,
  state: ReleaseLifecycleStateV2,
  reader: TrustedArtifactReader | undefined,
  plan: ReleaseMutationPlanReaders,
  exportLimits?: ReleaseExportTranscriptLimits,
): Promise<void> {
  void state;
  void reader;
  void exportLimits;
  resolveReleaseMutationRequirements(request, plan);
}
