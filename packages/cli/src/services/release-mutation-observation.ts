import type { ReleaseMutationPackageArtifactsV21 } from './release-mutation-artifacts.js';

/** Defensive observation for an explicitly installed host retention control.
 * These bytes do not grant replay custody, reuse authority, or readiness. */
export interface ProtectedMutationPackageObservation {
  readonly kind: 'protected-mutation-package-observation-v1';
  readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
  readonly package_name: string;
  readonly program_identity_sha256: string;
  readonly input_digest: string;
  readonly task_policy_digests_sha256: readonly string[];
  readonly artifacts: ReleaseMutationPackageArtifactsV21;
}

export type ProtectedMutationPackageObserver = (
  observation: ProtectedMutationPackageObservation,
) => void | Promise<void>;
