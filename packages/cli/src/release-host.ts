import { assertCliInvocationIdle } from './cli-runtime.js';
import {
  installReleaseLifecycleCommandAdapters as installAdapters,
  type ReleaseLifecycleCommandAdapters,
} from './commands/release/lifecycle.js';

export { invokeDevaiCli, startDevaiCli, type CliInvocationResult } from './cli-runtime.js';
export {
  createProtectedReleaseHostRunner,
  type ProtectedReleaseHostRunnerControls,
  type ProtectedReleaseHostRunner,
  type ProtectedReleaseHostInvocation,
  type ProtectedReleaseInputFile,
} from './services/release-protected-host-runner.js';
export { bindReleaseHostPackageSnapshot } from './services/release-host-package-binding.js';
export {
  verifyReleasePackageSnapshot,
  type ReleasePackageSnapshot,
  type ReleasePackageIdentity,
} from './services/release-package-snapshot.js';
export {
  verifyReleaseCandidateSnapshot,
  type ReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from './services/release-candidate-snapshot.js';
export {
  resolveReleasePolicySnapshot,
  type ReleasePolicyExpectedIdentity,
  type VerifiedReleasePolicyResolution,
} from './services/release-policy-resolution.js';
export {
  createReleasePolicyClosure,
  verifyReleasePolicyClosure,
  type ReleasePolicyClosure,
  type ReleasePolicyClosureLimits,
} from './services/release-policy-closure.js';
export {
  encodeReleasePolicyClosure,
  decodeReleasePolicyClosure,
  type ReleasePolicyClosureTransportLimits,
} from './services/release-policy-closure-transport.js';
export {
  createContainerReleaseCertificationAdapters,
  type ContainerReleaseCertificationAdapters,
  type ContainerReleaseCertificationOptions,
  type ProtectedReleasePlanMaterial,
} from './services/release-certification-provider.js';
export type {
  ProtectedContainerControls,
  ProtectedContainerDependency,
} from './services/release-certification-container.js';
export type { ReleaseLifecycleCommandAdapters } from './commands/release/lifecycle.js';
export {
  bindMutationEvidenceV21PackageSnapshot,
  composeMutationEvidenceV21,
  finalizeMutationEvidenceV21,
  verifyMutationEvidenceV21,
  type MutationVerificationOptionsV21,
  type MutationVerifierProvenanceV21,
} from './services/mutation-evidence-v21.js';
export {
  createReleaseCertificationProvider,
  type CertificationEvidenceTransaction,
  type ImmutableCertificationTaskPolicy,
  type ProtectedCertificationProvider,
  type TrustedCertificationEvidenceSink,
} from './services/release-lifecycle-certification.js';
export {
  createReleasePrepareProvider,
  type ArtifactSinkCommitManifest,
  type ArtifactSinkCommitReceipt,
  type ArtifactSinkObject,
  type ArtifactSinkObjectReceipt,
  type CertificationOutputClosure,
  type CertificationOutputClosureBinding,
  type CertificationReceipt,
  type ImmutableReleaseContentSource,
  type TrustedArtifactSink,
  type TrustedArtifactSinkTransaction,
} from './services/release-prepare-kernel.js';
export type {
  ArtifactIdentity,
  ArtifactSinkCommitIdentity,
  AuthorizationAttemptBinding,
  AuthorizationBridge,
  AuthorizationConsumptionProof,
  AuthorizationResolution,
  CertificationOutputBlobHandle,
  CertificationPackageEntry,
  CertificationPackageEntryManifest,
  GitReleaseBlobLocator,
  OfflineVerificationProvider,
  OpaqueArtifactIdentity,
  PackageEvidence,
  PersistedReleaseAction,
  PublicationControls,
  PublicationSignatureVerifier,
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
  ReleaseProvider,
  ReleaseProviderResult,
  ReleaseStateMaterial,
  ReleaseUnitEvidence,
  TrustedArtifactReader,
  TrustedOfflineReceiptVerifier,
  TrustIdentity,
} from './services/release-lifecycle-execution.js';

/** Configure only from a trusted host, between invocations. No request selects code. */
export function installReleaseLifecycleCommandAdapters(
  adapters: ReleaseLifecycleCommandAdapters,
): () => void {
  assertCliInvocationIdle();
  const dispose = installAdapters(adapters);
  return () => {
    assertCliInvocationIdle();
    dispose();
  };
}
export {
  createReleaseCertificationEvidenceStore,
  type ReleaseCertificationEvidenceStoreOptions,
} from './services/release-evidence-store.js';
export {
  createReleaseArtifactStore,
  type ReleaseArtifactStoreOptions,
} from './services/release-artifact-store.js';
