import type { CliInvocationResult } from '../cli-runtime.js';
import type { ReleaseLifecycleCommandAdapters } from '../commands/release/lifecycle.js';
import type { ReleaseCandidateSnapshot } from './release-candidate-snapshot.js';
import type { ReleasePackageSnapshot } from './release-package-snapshot.js';
import {
  resolveReleasePolicySnapshot,
  type ReleasePolicyExpectedIdentity,
} from './release-policy-resolution.js';
import type { ReleasePolicyClosure } from './release-policy-closure.js';
import type { ReleaseExportProviderOptions } from './release-export-provider.js';
import type {
  ContainerReleaseCertificationOptions,
  ContainerReleaseCertificationAdapters,
} from './release-certification-provider.js';
import type { ProtectedMutationPackageObserver } from './release-mutation-observation.js';
import type { ReleaseMutationArtifactLimitsV21 } from './release-mutation-artifacts.js';
import type {
  ReleaseMutationInputControlsV21,
  ReleaseMutationInputPlanV21,
} from './release-mutation-inputs.js';
import type { ReleaseCertificationEvidenceStoreOptions } from './release-evidence-store.js';
import type { ReleaseArtifactStoreOptions } from './release-artifact-store.js';
import type {
  PublicationSignatureVerifier,
  ReleaseLifecycleRequest,
} from './release-lifecycle-execution.js';

/** A locator and raw-byte identity approved by the operator before it is read. */
export interface ProtectedReleaseInputFile {
  readonly path: string;
  readonly sha256: string;
}

export interface ProtectedReleaseHostLaneControls {
  readonly candidate: ReleaseCandidateSnapshot;
  readonly expected: ReleasePolicyExpectedIdentity;
  readonly repository_root: string;
  readonly repository_identity: {
    readonly authority_repository_id: string;
    readonly read_expected_release_repository_id: () => string;
  };
  /** Must be the registered .devai/state/release-lifecycle namespace or a descendant. */
  readonly state_root: string;
  readonly maximum_input_bytes: number;
  readonly unit: {
    readonly intent: unknown;
    readonly packages: readonly {
      readonly manifest_path: string;
      readonly source_entries: readonly string[];
      readonly generated_entries: readonly { readonly path: string; readonly task_node: string }[];
    }[];
    /** Genuine prior protected result for a restarted certification process; independently reverified. */
    readonly preflight_receipt?: unknown;
  };
  readonly execution: Pick<
    ContainerReleaseCertificationOptions,
    'controls' | 'dependencies' | 'environment' | 'toolchain' | 'timeout_ms'
  >;
}

export interface ProtectedReleaseHostRunnerControls extends ProtectedReleaseHostLaneControls {
  /** Use the exact object returned by bootstrapReleaseHost, never a source-mode snapshot. */
  readonly installed_package: ReleasePackageSnapshot;
  readonly producer?: Parameters<typeof resolveReleasePolicySnapshot>[0]['producer'];
  /** A fixed diagnostic preflight lane, prebound in this same process. No store or signer. */
  readonly toolchain_fixture?: ProtectedReleaseHostLaneControls;
  readonly mutation_inputs?: Pick<
    ReleaseMutationInputControlsV21,
    'execution_coverage' | 'maximum_source_bytes' | 'maximum_source_entries'
  >;
  /** Externally protected, measured artifact bounds. This runner supplies no default. */
  readonly mutation_limits?: ReleaseMutationArtifactLimitsV21;
  /** Explicit host retention observer; never a candidate request or a reuse provider. */
  readonly observe_mutation_package?: ProtectedMutationPackageObserver;
  readonly certification_store: ReleaseCertificationEvidenceStoreOptions;
  readonly artifact_store: Omit<ReleaseArtifactStoreOptions, 'binding'>;
  readonly publication_signature_verifier: PublicationSignatureVerifier;
  /** Protected host choices only; absent stages have no ambient fallback. */
  readonly later_stages: {
    readonly export: 'unavailable' | ProtectedReleaseHostExportControls;
    readonly offline_verify: 'unavailable' | ProtectedReleaseHostOfflineControls;
    readonly evidence_publish?: 'unavailable' | ProtectedReleaseHostEvidencePublicationControls;
    readonly publish?: 'unavailable' | ProtectedReleaseHostPublicationControls;
  };
}

export type ProtectedReleaseHostExportControls = Pick<
  ReleaseExportProviderOptions,
  'provider' | 'destination' | 'trust' | 'signer'
> &
  Pick<
    ReleaseExportProviderOptions['store'],
    'closure_limits' | 'transport_limits' | 'transcript_limits'
  >;

/** Installed control callbacks only; request files cannot select an offline verifier. */
export interface ProtectedReleaseHostOfflineControls {
  readonly provider: NonNullable<
    ReturnType<ReleaseLifecycleCommandAdapters['offline_verification_provider']>
  >;
  readonly policy_closures: NonNullable<ReleaseLifecycleCommandAdapters['offline_policy_closures']>;
}

/** External effects remain unavailable unless installed controls explicitly supply every gate. */
export interface ProtectedReleaseHostEvidencePublicationControls {
  readonly provider: NonNullable<ReturnType<ReleaseLifecycleCommandAdapters['provider']>>;
  readonly authorization: ReleaseLifecycleCommandAdapters['authorization'];
  readonly offline_receipt_verifier: ReleaseLifecycleCommandAdapters['offline_receipt_verifier'];
}
export interface ProtectedReleaseHostPublicationControls {
  readonly provider: NonNullable<ReturnType<ReleaseLifecycleCommandAdapters['provider']>>;
  readonly authorization: ReleaseLifecycleCommandAdapters['authorization'];
  readonly publication_controls: ReleaseLifecycleCommandAdapters['publication_controls'];
}

interface InvocationAuthority {
  /** No role is inferred by this runner; the normal CLI checks this explicit declaration. */
  readonly as_role: 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
  readonly write: boolean;
}

export type ProtectedReleaseHostInvocation =
  | { readonly action: 'release plan'; readonly intent: ProtectedReleaseInputFile }
  | (InvocationAuthority & {
      readonly action:
        'release preflight' | 'release certify' | 'release prepare' | 'release export';
      readonly request: ProtectedReleaseInputFile;
    })
  | (InvocationAuthority & {
      readonly action: 'release evidence-publish' | 'release publish';
      readonly request: ProtectedReleaseInputFile;
      readonly allow_publish: boolean;
    })
  | {
      readonly action: 'release offline-verify';
      readonly request: ProtectedReleaseInputFile;
      readonly exported_state: ProtectedReleaseInputFile;
    }
  | {
      readonly action: 'release resume';
      readonly request: ProtectedReleaseInputFile;
      readonly receipts: ProtectedReleaseInputFile;
      readonly publication_receipt?: ProtectedReleaseInputFile;
    };

export interface ProtectedReleaseHostRunner {
  /** Copies, not live provider state. These methods do not persist receipts or advance the lifecycle. */
  readonly readPlan: () => Readonly<Record<string, unknown>>;
  readonly readPolicyClosure: () => ReleasePolicyClosure;
  /** Independently reconstructed certification policies; never reads an exported carrier. */
  readonly readCertificationTaskPolicies: (
    request: ReleaseLifecycleRequest,
  ) => ReturnType<ContainerReleaseCertificationAdapters['read_task_policies']>;
  readonly readFixturePlan: () => Readonly<Record<string, unknown>>;
  /** Serial diagnostic projection only, not a derived-plan brand or execution grant. */
  readonly readMutationInputPlan: () => Omit<ReleaseMutationInputPlanV21, 'readProof'>;
  readonly invoke: (input: ProtectedReleaseHostInvocation) => Promise<CliInvocationResult>;
}
