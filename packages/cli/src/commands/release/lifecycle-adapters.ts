import {
  executeOfflineVerification,
  type AuthorizationBridge,
  type OfflineVerificationProvider,
  type PersistedReleaseAction,
  type PublicationControls,
  type PublicationSignatureVerifier,
  type ReleaseLifecycleRequest,
  type ReleaseProvider,
  type TrustedArtifactReader,
  type TrustedOfflineReceiptVerifier,
} from '../../services/release-lifecycle-execution.js';
import {
  isVerifiedReleasePolicyResolution,
  type VerifiedReleasePolicyResolution,
} from '../../services/release-policy-resolution.js';
import { createReleaseCertificationProvider } from '../../services/release-lifecycle-certification.js';
import type {
  ImmutableReleaseContentSource,
  TrustedArtifactSink,
} from '../../services/release-prepare-kernel.js';
import type { ReleaseExportTranscriptLimits } from '../../services/release-export-transcript.js';

export interface ReleaseLifecycleCommandAdapters {
  readonly policy_resolution?: (input: {
    readonly repository_id: string;
    readonly candidate: { readonly commit: string; readonly tree: string };
    readonly release_unit: string;
  }) => VerifiedReleasePolicyResolution | undefined;
  readonly preflight_provider?: (request: ReleaseLifecycleRequest) => ReleaseProvider | undefined;
  readonly certification_provider?: (
    request: ReleaseLifecycleRequest,
  ) => Parameters<typeof createReleaseCertificationProvider>[0] | undefined;
  readonly provider: (
    action: PersistedReleaseAction,
    request: ReleaseLifecycleRequest,
  ) => ReleaseProvider | undefined;
  readonly offline_verification_provider: (
    request: ReleaseLifecycleRequest,
  ) => OfflineVerificationProvider | undefined;
  readonly offline_policy_closures?: (
    request: ReleaseLifecycleRequest,
  ) => Parameters<typeof executeOfflineVerification>[0]['policyClosures'];
  readonly authorization: (request: ReleaseLifecycleRequest) => AuthorizationBridge | undefined;
  readonly offline_receipt_verifier: (
    request: ReleaseLifecycleRequest,
  ) => TrustedOfflineReceiptVerifier | undefined;
  readonly publication_controls: (
    request: ReleaseLifecycleRequest,
  ) => PublicationControls | undefined;
  readonly publication_signature_verifier?: (
    request: ReleaseLifecycleRequest,
  ) => PublicationSignatureVerifier | undefined;
  readonly prepare_content_source?: (
    request: ReleaseLifecycleRequest,
  ) => ImmutableReleaseContentSource | undefined;
  readonly artifact_sink?: (request: ReleaseLifecycleRequest) => TrustedArtifactSink | undefined;
  readonly artifact_reader?: (
    request: ReleaseLifecycleRequest,
  ) => TrustedArtifactReader | undefined;
  /** Protected host transport bounds, never inferred from candidate or bundle bytes. */
  readonly export_limits?: (
    request: ReleaseLifecycleRequest,
  ) => ReleaseExportTranscriptLimits | undefined;
}

export let commandAdapters: ReleaseLifecycleCommandAdapters | undefined;

/** Installed only by the trusted host composition root; CLI requests cannot select code. */
export function installReleaseLifecycleCommandAdapters(
  adapters: ReleaseLifecycleCommandAdapters,
): () => void {
  if (commandAdapters !== undefined) throw new Error('release-command-adapters-already-installed');
  const installed = Object.freeze({ ...adapters });
  commandAdapters = installed;
  return () => {
    if (commandAdapters === installed) commandAdapters = undefined;
  };
}

export function resolvePolicyFor(input: {
  readonly repository_id: string;
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly release_unit: string;
}): VerifiedReleasePolicyResolution {
  const resolution = commandAdapters?.policy_resolution?.(input);
  if (!isVerifiedReleasePolicyResolution(resolution))
    throw new Error('rpl-policy-source-unresolved');
  if (
    resolution.repository.id !== input.repository_id ||
    resolution.repository.commit !== input.candidate.commit ||
    resolution.repository.tree !== input.candidate.tree ||
    resolution.release_unit !== input.release_unit
  )
    throw new Error('rpl-policy-resolution-mismatch');
  return resolution;
}

export function requestPolicy(
  request: ReleaseLifecycleRequest,
): readonly VerifiedReleasePolicyResolution[] {
  return request.candidate_locator.release_units.map((unit) =>
    resolvePolicyFor({
      repository_id: request.repository_locator.id,
      candidate: {
        commit: request.candidate_locator.commit,
        tree: request.candidate_locator.tree,
      },
      release_unit: unit.release_unit,
    }),
  );
}
