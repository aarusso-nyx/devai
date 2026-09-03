import { assertCliInvocationIdle } from './cli-runtime.js';
import {
  installReleaseLifecycleCommandAdapters as installAdapters,
  type ReleaseLifecycleCommandAdapters,
} from './commands/release/lifecycle.js';

export { invokeDevaiCli, startDevaiCli, type CliInvocationResult } from './cli-runtime.js';
export type { ReleaseLifecycleCommandAdapters } from './commands/release/lifecycle.js';
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
