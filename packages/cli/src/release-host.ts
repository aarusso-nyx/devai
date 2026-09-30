import { assertCliInvocationIdle } from './cli-runtime.js';
import { createAuthorityHostBroker as createCliAuthorityHostBroker } from './authority/broker.js';
import { canonicalRegistry as cliCanonicalRegistry } from './define-command.js';
import {
  installReleaseLifecycleCommandAdapters as installAdapters,
  type ReleaseLifecycleCommandAdapters,
} from './commands/release/lifecycle.js';

export { invokeDevaiCli, startDevaiCli, type CliInvocationResult } from './cli-runtime.js';
export {
  createProtectedReleaseHostRunner,
  type ProtectedReleaseHostRunnerControls,
  type ProtectedReleaseHostOfflineControls,
  type ProtectedReleaseHostEvidencePublicationControls,
  type ProtectedReleaseHostPublicationControls,
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
  ReleaseProviderInvocationContext,
  ReleaseProviderResult,
  ReleaseStateMaterial,
  ReleaseUnitEvidence,
  TrustedArtifactReader,
  TrustedOfflineReceiptVerifier,
  TrustIdentity,
} from './services/release-lifecycle-execution.js';
export { assertReleaseProviderInvocationContext } from './services/release-lifecycle-execution.js';

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
export {
  createReleaseExportArtifactStore,
  type ReleaseExportArtifactStoreOptions,
  type ReleaseExportArtifactObject,
  type ReleaseExportArtifactObjectReceipt,
  type ReleaseExportArtifactCommitManifest,
  type TrustedExportArtifactSink,
  type TrustedExportArtifactSinkTransaction,
  type ProtectedReleaseExportBinding,
} from './services/release-export-artifact-store.js';
export {
  createReleaseExportProvider,
  type ReleaseExportProviderOptions,
} from './services/release-export-provider.js';
export {
  encodeReleaseExportTranscript,
  verifyReleaseExportTranscript,
  encodeReleaseExportProviderResult,
  verifyReleaseExportProviderResult,
  type ReleaseExportTranscript,
  type ReleaseExportTranscriptLimits,
  type ReleaseExportProviderResultInput,
  type ReleaseExportProviderResult,
} from './services/release-export-transcript.js';

export {
  createReleaseOfflineVerifierProvider,
  type ReleaseOfflineProviderControls,
  type ProtectedOfflineDagControl,
} from './services/release-offline-provider.js';

export type {
  ProtectedMutationPackageObservation,
  ProtectedMutationPackageObserver,
} from './services/release-mutation-observation.js';

/**
 * One registered action as the installed authority broker reads it. The entry is passed
 * back to `createAuthorityHostBroker` exactly as `canonicalRegistry` returned it; its
 * remaining fields are the registry contract and are opaque to a host.
 */
export interface AuthorityHostRegistryEntry {
  readonly name: string;
  readonly [field: string]: unknown;
}

/** The request under which the installed broker decides one governed invocation. */
export interface AuthorityHostBrokerInput {
  readonly entry: AuthorityHostRegistryEntry;
  readonly entries: readonly AuthorityHostRegistryEntry[];
  readonly argv: readonly string[];
  readonly role: 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
  readonly declaration: Readonly<
    | { as_role: 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor' }
    | { authority_session: string }
  >;
  readonly repository_root: string;
  readonly package_version: string;
  readonly bootstrap_policy: boolean;
}

/** One host effect the broker authorizes before `apply` runs, or refuses with a code. */
export interface AuthorityHostEffect {
  readonly kind: string;
  readonly symbol: string;
  readonly arguments: readonly unknown[];
}

/** The installed authority broker a host drives: one effect scope, disposed once. */
export interface AuthorityHostBroker {
  readonly scope: {
    readonly action_id: string;
    readonly apply_effect: (request: AuthorityHostEffect, apply: () => unknown) => unknown;
  };
  readonly dispose: () => void;
}

/**
 * The canonical action registry of the installed package (ADR-AUT-0003), so a host that
 * rehearses adopter path authority on the packed tarball decides under registered entries.
 */
export function canonicalRegistry(): readonly AuthorityHostRegistryEntry[] {
  return cliCanonicalRegistry() as unknown as readonly AuthorityHostRegistryEntry[];
}

/**
 * The authority broker of the installed package: the same broker the CLI builds for one
 * governed invocation, bound to the repository's materialized authority policy and its
 * adopter extension. It decides; it grants nothing the policy does not.
 */
export function createAuthorityHostBroker(input: AuthorityHostBrokerInput): AuthorityHostBroker {
  return createCliAuthorityHostBroker(
    input as unknown as Parameters<typeof createCliAuthorityHostBroker>[0],
  ) as unknown as AuthorityHostBroker;
}
