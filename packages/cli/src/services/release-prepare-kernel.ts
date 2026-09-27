import { canonicalJson } from '@devai-nyx/utils';
import { readProtectedReleasePrepareCapacity } from '@devai-nyx/authority';

import type {
  ArtifactSinkCommitIdentity,
  OpaqueArtifactIdentity,
  PackageEvidence,
  ReleaseLifecycleStateV2,
  ReleaseProvider,
  ReleaseProviderResult,
  ReleaseStateMaterial,
} from './release-lifecycle-execution.js';
import {
  type VerifiedPackage,
  same,
  utf8Compare,
  type ImmutableReleaseContentSource,
  sha256,
  safeOpaqueIdentity,
  type ReleaseMutationPlanReaders,
  type ArtifactSinkObject,
  RELEASE_PACK_SPEC_ID,
  RELEASE_PACK_SPEC_DIGEST,
  type ArtifactSinkObjectReceipt,
  type TrustedArtifactSinkTransaction,
  record,
  type TrustedArtifactSink,
  RELEASE_PACK_SPEC_CANONICAL_BYTES,
  verifyReceiptBytes,
  type ArtifactSinkCommitManifest,
  COMMIT_PROTOCOL,
  type ArtifactSinkCommitReceipt,
} from './release-prepare-kernel-contract.js';
import { packPackage, sinkObject } from './release-prepare-kernel-archive.js';

import {
  verifyCertificationMutationEvidence,
  verifyPackage,
} from './release-prepare-kernel-package.js';

export { reverifySinkArtifacts } from './release-prepare-kernel-sink-artifacts.js';
export {
  verifyPreparedPackageManifest,
  verifyPreparedPackageArchive,
} from './release-prepare-kernel-prepared.js';
export {
  verifyCertificationMaterial,
  verifyCertificationMutationEvidence,
  verifyPortableReleaseMutationEvidence,
} from './release-prepare-kernel-package.js';
export {
  finalizeCertificationManifest,
  finalizeCertificationReceipt,
  verifyCertificationManifest,
  verifyGitCertificationSource,
  verifyCertificationOutputClosure,
} from './release-prepare-kernel-certification.js';
export {
  type CertificationReceipt,
  type ImmutableReleaseContentSource,
  type CertificationOutputClosureBinding,
  type CertificationOutputClosure,
  type ArtifactSinkObject,
  type ArtifactSinkObjectReceipt,
  type ArtifactSinkCommitManifest,
  type ArtifactSinkCommitReceipt,
  type TrustedArtifactSinkTransaction,
  type TrustedArtifactSink,
  type ReleaseMutationPlanReaders,
  type ReleaseUnitMutationEvidenceReader,
  RELEASE_PACK_SPEC_V3_ID,
  RELEASE_PACK_SPEC_V3_CANONICAL_BYTES,
  RELEASE_PACK_SPEC_V3_DIGEST,
  RELEASE_PACK_SPEC_ID,
  RELEASE_PACK_SPEC_CANONICAL_BYTES,
  RELEASE_PACK_SPEC_DIGEST,
} from './release-prepare-kernel-contract.js';

function toOpaqueIdentity(receipt: ArtifactSinkObjectReceipt): OpaqueArtifactIdentity {
  if (receipt.kind === 'committed-manifest') {
    throw new Error('release-artifact-sink-protocol-invalid');
  }
  return {
    kind: receipt.kind,
    sink_id: receipt.sink_id,
    opaque_handle: receipt.opaque_handle,
    sha256: receipt.sha256,
    size_bytes: receipt.size_bytes,
  };
}

function assertObjectReceipt(
  receipt: ArtifactSinkObjectReceipt,
  artifact: ArtifactSinkObject,
  transaction: TrustedArtifactSinkTransaction,
): void {
  if (
    record(receipt) === undefined ||
    receipt.sink_id !== transaction.sink_id ||
    receipt.transaction_handle !== transaction.transaction_handle ||
    !safeOpaqueIdentity(receipt.sink_id) ||
    !safeOpaqueIdentity(receipt.opaque_handle) ||
    !same(receipt, {
      sink_id: transaction.sink_id,
      transaction_handle: transaction.transaction_handle,
      opaque_handle: receipt.opaque_handle,
      kind: artifact.kind,
      logical_name: artifact.logical_name,
      sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
      pack_spec_id: RELEASE_PACK_SPEC_ID,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
    })
  ) {
    throw new Error('release-artifact-sink-protocol-invalid');
  }
}

async function abort(transaction: TrustedArtifactSinkTransaction): Promise<void> {
  try {
    await transaction.abort();
  } catch {
    throw new Error('release-artifact-sink-abort-failed');
  }
}

export function createReleasePrepareProvider(
  input: ReleaseMutationPlanReaders & {
    readonly certified_state: ReleaseLifecycleStateV2;
    readonly content_source: ImmutableReleaseContentSource;
    readonly artifact_sink: TrustedArtifactSink;
  },
): ReleaseProvider {
  const certifiedState = JSON.parse(
    canonicalJson(input.certified_state),
  ) as ReleaseLifecycleStateV2;
  return async (request): Promise<ReleaseProviderResult> => {
    if (
      input.artifact_sink === undefined ||
      input.artifact_sink === null ||
      typeof input.artifact_sink.begin !== 'function'
    ) {
      return { outcome: 'failure', code: 'release-artifact-sink-unavailable' };
    }
    if (
      certifiedState.state !== 'certified' ||
      !same(certifiedState.repository, request.repository_locator) ||
      certifiedState.candidate.commit !== request.candidate_locator.commit ||
      certifiedState.candidate.tree !== request.candidate_locator.tree
    ) {
      return { outcome: 'failure', code: 'release-prepare-certification-manifest-invalid' };
    }
    let transaction: TrustedArtifactSinkTransaction | undefined;
    let committed = false;
    try {
      if (sha256(RELEASE_PACK_SPEC_CANONICAL_BYTES) !== RELEASE_PACK_SPEC_DIGEST) {
        throw new Error('release-prepare-pack-spec-digest-mismatch');
      }
      await verifyCertificationMutationEvidence(
        request,
        certifiedState,
        input.content_source,
        input,
      );
      const verified: VerifiedPackage[] = [];
      for (const [unitIndex, unit] of request.candidate_locator.release_units.entries()) {
        for (const packageIndex of unit.package_roster.keys()) {
          verified.push(
            await verifyPackage(
              input.content_source,
              request,
              certifiedState,
              unitIndex,
              packageIndex,
            ),
          );
        }
      }
      const packed = verified.map(packPackage);
      const logicalNames = packed.flatMap((pkg) =>
        pkg.objects.map((artifact) => artifact.logical_name),
      );
      if (new Set(logicalNames).size !== logicalNames.length) {
        throw new Error('release-prepare-package-entry-coverage-invalid');
      }
      const plan = request.receipt_locators?.find(
        (receipt) => receipt.kind === 'release-plan-receipt',
      );
      if (plan === undefined) throw new Error('release-prepare-capacity-unavailable');
      const capacity = readProtectedReleasePrepareCapacity({
        action_id: 'release prepare',
        repository: request.repository_locator,
        candidate: {
          commit: request.candidate_locator.commit,
          tree: request.candidate_locator.tree,
        },
        plan_receipt_digest_sha256: plan.receipt_digest_sha256,
      });
      const required = 3 * packed.length + 33;
      if (
        !Number.isSafeInteger(required) ||
        capacity.remaining_batches < required ||
        capacity.remaining_targets < required
      )
        throw new Error('release-prepare-capacity-insufficient');
      const opened = await input.artifact_sink.begin({
        repository: request.repository_locator,
        candidate: {
          commit: request.candidate_locator.commit,
          tree: request.candidate_locator.tree,
        },
        pack_spec_id: RELEASE_PACK_SPEC_ID,
        pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      });
      const openedRecord = record(opened);
      if (openedRecord !== undefined && typeof openedRecord['abort'] === 'function')
        transaction = opened;
      if (
        transaction === undefined ||
        !safeOpaqueIdentity(transaction.sink_id) ||
        !safeOpaqueIdentity(transaction.transaction_handle) ||
        typeof transaction.put !== 'function' ||
        typeof transaction.readArtifact !== 'function' ||
        typeof transaction.commit !== 'function' ||
        typeof transaction.abort !== 'function'
      ) {
        throw new Error('release-artifact-sink-protocol-invalid');
      }
      const receipts: ArtifactSinkObjectReceipt[] = [];
      for (const pkg of packed) {
        for (const artifact of pkg.objects) {
          const receipt = await transaction.put(artifact);
          assertObjectReceipt(receipt, artifact, transaction);
          await verifyReceiptBytes(transaction, receipt);
          receipts.push(receipt);
        }
      }
      const artifacts = receipts
        .map(toOpaqueIdentity)
        .sort((left, right) =>
          utf8Compare(
            `${left.kind}\0${left.sink_id}\0${left.opaque_handle}\0${left.sha256}\0${String(left.size_bytes)}`,
            `${right.kind}\0${right.sink_id}\0${right.opaque_handle}\0${right.sha256}\0${String(right.size_bytes)}`,
          ),
        );
      const commitManifest: ArtifactSinkCommitManifest = {
        schemaVersion: '1.0.0',
        kind: 'release-artifact-sink-commit-manifest',
        sink_id: transaction.sink_id,
        transaction_handle: transaction.transaction_handle,
        repository: request.repository_locator,
        candidate: {
          commit: request.candidate_locator.commit,
          tree: request.candidate_locator.tree,
        },
        pack_spec_id: RELEASE_PACK_SPEC_ID,
        pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
        artifacts,
      };
      const commitManifestObject = sinkObject(
        'committed-manifest',
        'release-artifact-sink-commit-manifest.json',
        Buffer.from(canonicalJson(commitManifest), 'utf8'),
      );
      const commitManifestReceipt = await transaction.put(commitManifestObject);
      assertObjectReceipt(commitManifestReceipt, commitManifestObject, transaction);
      await verifyReceiptBytes(transaction, commitManifestReceipt);
      const artifactSink: ArtifactSinkCommitIdentity = {
        sink_id: transaction.sink_id,
        transaction_handle: transaction.transaction_handle,
        committed_manifest_handle: commitManifestReceipt.opaque_handle,
        committed_manifest_sha256: commitManifestReceipt.sha256,
        committed_manifest_size_bytes: commitManifestReceipt.size_bytes,
        commit_protocol: COMMIT_PROTOCOL,
      };
      const byLogicalName = new Map(receipts.map((receipt) => [receipt.logical_name, receipt]));
      const releaseUnits = request.candidate_locator.release_units.map((unit) => ({
        release_unit: unit.release_unit,
        version: unit.version,
        packages: unit.package_roster.map((requestedPackage) => {
          const packageValue = packed.find(
            (candidate) =>
              candidate.verified.release_unit === unit.release_unit &&
              candidate.verified.package_id === requestedPackage.package_id,
          );
          if (packageValue === undefined) throw new Error('release-release-unit-bijection-invalid');
          const identity = (
            kind: 'package-manifest' | 'package-tarball' | 'package-sbom',
          ): OpaqueArtifactIdentity => {
            const artifact = packageValue.objects.find((candidate) => candidate.kind === kind);
            const receipt =
              artifact === undefined ? undefined : byLogicalName.get(artifact.logical_name);
            if (receipt === undefined) throw new Error('release-artifact-sink-protocol-invalid');
            return toOpaqueIdentity(receipt);
          };
          return {
            package_id: requestedPackage.package_id,
            package_manifest: identity('package-manifest'),
            package_tarball: identity('package-tarball'),
            package_sbom: identity('package-sbom'),
            evidence_manifest: null,
            provider_result: null,
            trust: null,
            certification_manifest: packageValue.verified.certification_manifest,
          } satisfies PackageEvidence;
        }),
      }));
      const material: ReleaseStateMaterial = {
        release_units: releaseUnits,
        inputs: certifiedState['inputs'] as ReleaseStateMaterial['inputs'],
        evidence: {
          manifest_digest_sha256: commitManifestReceipt.sha256,
          receipt_digests: [
            ...(certifiedState['evidence'] as ReleaseStateMaterial['evidence']).receipt_digests,
          ],
          independently_checkable: true,
        },
        artifacts,
        artifact_sink: artifactSink,
      };
      let open = true;
      return {
        outcome: 'success',
        material,
        transaction: {
          commit: async () => {
            if (!open || transaction === undefined)
              throw new Error('release-artifact-sink-protocol-invalid');
            // Once atomic commit is attempted, its outcome may be externally uncertain. Never
            // issue an abort that could destroy the only inspectable record of that attempt.
            open = false;
            let receipt: ArtifactSinkCommitReceipt;
            try {
              receipt = await transaction.commit(commitManifestReceipt);
              if (
                record(receipt) === undefined ||
                receipt.committed !== true ||
                !same(receipt, { committed: true, ...artifactSink })
              ) {
                throw new Error('release-artifact-sink-verification-failed');
              }
              await verifyReceiptBytes(transaction, commitManifestReceipt);
              for (const artifactReceipt of receipts)
                await verifyReceiptBytes(transaction, artifactReceipt);
              committed = true;
            } catch {
              throw new Error('release-artifact-sink-commit-unknown');
            }
          },
          rollback: async () => {
            if (transaction !== undefined && !committed && open) {
              open = false;
              await abort(transaction);
            }
          },
          dispose: async () => {
            if (transaction !== undefined && !committed && open) {
              open = false;
              await abort(transaction);
            }
          },
        },
      };
    } catch (error) {
      if (transaction !== undefined && !committed) {
        try {
          await abort(transaction);
        } catch (abortError) {
          return {
            outcome: 'failure',
            code:
              abortError instanceof Error
                ? abortError.message
                : 'release-artifact-sink-abort-failed',
          };
        }
      }
      return {
        outcome: 'failure',
        code:
          error instanceof Error ? error.message : 'release-prepare-certification-manifest-invalid',
      };
    }
  };
}
