import { createHash } from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import type { ProtectedMutationPackageObserver } from './release-mutation-observation.js';
import type { ReleaseMutationArtifactLimitsV21 } from './release-mutation-artifacts.js';
import type { ReleaseMutationInputPlanV21 } from './release-mutation-inputs.js';
import type { TaskPlan } from './check-runner/types.js';
import { canonicalContainerPath, type ContainerArchiveEntry } from './container-archive.js';
import type {
  ProtectedContainerControls,
  ProtectedContainerDependency,
} from './release-certification-container.js';
import {
  assertProtectedToolchainFixtureCompatibility,
  type ProtectedToolchainFixtureContext,
  type ProtectedToolchainFixtureCompatibility,
} from './release-toolchain-fixture-compatibility.js';
import type { ReleaseCandidateSnapshot } from './release-candidate-snapshot.js';
import type { ReleasePackageSnapshot } from './release-package-snapshot.js';
import type { VerifiedReleasePolicyResolution } from './release-policy-resolution.js';
import type { ReleaseLifecycleRequest, ReleaseProvider } from './release-lifecycle-execution.js';
import {
  createReleaseCertificationProvider,
  type TrustedCertificationEvidenceSink,
} from './release-lifecycle-certification.js';
import type { ImmutableReleaseContentSource } from './release-prepare-kernel.js';

export interface ProtectedReleasePlanMaterial {
  readonly receipt: unknown;
  /** Current execution requires the host's genuine, package/candidate-bound policy resolution. */
  readonly resolution?: VerifiedReleasePolicyResolution;
  readonly intent_path: string;
  readonly intent: unknown;
  readonly release_verification_profile: unknown;
  readonly release_lifecycle_policy: unknown;
  readonly action_registry: unknown;
  /** Protected mapping, included in every task key alongside the independently verified plan identity. */
  readonly packages: readonly {
    readonly package_id: string;
    readonly source_entries: readonly string[];
    readonly generated_entries: readonly { readonly path: string; readonly task_node: string }[];
  }[];
  /** Optional persisted genuine receipt; the supported runner re-verifies all identities. */
  readonly preflight_receipt?: unknown;
}

export interface ContainerReleaseCertificationOptions {
  readonly repository_root: string;
  readonly repository_id: string;
  readonly plans: readonly ProtectedReleasePlanMaterial[];
  readonly controls: ProtectedContainerControls;
  readonly dependencies?: readonly ProtectedContainerDependency[];
  /** Explicit public task values only. Ambient process environment is never inherited. */
  readonly environment: Readonly<Record<string, string>>;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly timeout_ms: number;
  /** Host-only, preflight-only diagnostic capture; never selected by candidate documents. */
  readonly diagnostic_outputs?: readonly {
    readonly task_node: string;
    readonly paths: readonly string[];
  }[];
  /** Private source-owned fixture context; a candidate cannot construct this brand. */
  readonly fixture_context?: ProtectedToolchainFixtureContext;
  /** Fixed diagnostic construction on the existing host broker; never a CLI/request input. */
  readonly toolchain_fixture?: {
    readonly candidate: ReleaseCandidateSnapshot;
    readonly installed_package: ReleasePackageSnapshot;
    readonly production_resolution: VerifiedReleasePolicyResolution;
  };
  readonly content_source: Pick<ImmutableReleaseContentSource, 'readGitObject' | 'readGitBlob'>;
  readonly evidence_sink: TrustedCertificationEvidenceSink;
  /**
   * @deprecated Ignored. Mutation execution has moved to bedel.
   */
  readonly mutation_driver?: {
    readonly package_snapshot: ReleasePackageSnapshot;
    readonly observe_package?: ProtectedMutationPackageObserver;
    readonly limits: ReleaseMutationArtifactLimitsV21;
    /** Derives the plan for this exact run's discharged prerequisite closure. */
    readonly buildInputPlan: (
      prerequisites: ProtectedMutationPrerequisiteClosure,
    ) => ReleaseMutationInputPlanV21;
  };
}

export interface ContainerReleaseCertificationAdapters {
  readonly preflight_provider: ReleaseProvider;
  /** Reconstructs policy bytes without executing tasks or changing prerequisite proof state. */
  readonly read_task_policies: (
    request: ReleaseLifecycleRequest,
  ) => Parameters<typeof createReleaseCertificationProvider>[0]['task_policies'];
  readonly certification_provider: (
    request: ReleaseLifecycleRequest,
  ) => Parameters<typeof createReleaseCertificationProvider>[0];
}

export type Json = Readonly<Record<string, unknown>>;
export const protectedPreflightProviders = new WeakSet<ReleaseProvider>();
export const fixtureProviderCompatibility = new WeakMap<
  ReleaseProvider,
  ProtectedToolchainFixtureCompatibility
>();

/** Process-local proof of this provider's completed DAG, never serialized evidence. */
export interface ProtectedMutationPrerequisiteClosure {
  readonly kind: 'protected-mutation-prerequisite-closure-v1';
}

export interface ProtectedMutationPrerequisiteBinding {
  readonly repository: ReleaseCandidateSnapshot['repository'];
  readonly release_unit: string;
  readonly release_plan_receipt_digest: string;
  readonly release_profile_digest: string;
  readonly container_identity: Json;
  readonly environment: Readonly<Record<string, string>>;
  readonly toolchain: Readonly<Record<string, string>>;
}

export interface CapturedMutationPrerequisiteClosure {
  readonly binding: ProtectedMutationPrerequisiteBinding;
  readonly task_policy_digest: string;
  readonly tasks: readonly { readonly node_id: string; readonly output_contract: Json }[];
  readonly outputs: readonly (ContainerArchiveEntry & {
    readonly producer_task_node: string;
    readonly size: number;
    readonly sha256: string;
  })[];
}

export const mutationPrerequisites = new WeakMap<object, CapturedMutationPrerequisiteClosure>();
export const pendingMutationPrerequisites = new WeakMap<
  ContainerReleaseCertificationAdapters['certification_provider'],
  {
    readonly request_digest: string;
    readonly closures: readonly ProtectedMutationPrerequisiteClosure[];
  }
>();

/** Internal one-shot handoff only; absent from the public host barrel and lifecycle material. */
export function takeProtectedMutationPrerequisites(
  provider: ContainerReleaseCertificationAdapters['certification_provider'],
  expectedRequest: ReleaseLifecycleRequest,
): readonly ProtectedMutationPrerequisiteClosure[] {
  const pending = pendingMutationPrerequisites.get(provider);
  pendingMutationPrerequisites.delete(provider);
  if (pending === undefined || pending.request_digest !== canonicalSha256(expectedRequest))
    throw new Error('release-certification-prerequisite-proof-invalid');
  return [...pending.closures];
}

/** Only a token issued below after actual DAG verification can discharge a prerequisite. */
export function captureProtectedMutationPrerequisites(
  value: ProtectedMutationPrerequisiteClosure,
  expected: ProtectedMutationPrerequisiteBinding,
): CapturedMutationPrerequisiteClosure {
  const captured = mutationPrerequisites.get(value);
  if (captured === undefined || canonicalJson(captured.binding) !== canonicalJson(expected))
    throw new Error('release-certification-prerequisite-proof-invalid');
  return {
    binding: snapshot(captured.binding),
    task_policy_digest: captured.task_policy_digest,
    tasks: snapshot(captured.tasks),
    outputs: captured.outputs.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) })),
  };
}

/** Internal producer seam only. A lookalike provider or serialized result carries no credit. */
export function assertProtectedFixtureProviderCompatibility(
  provider: ReleaseProvider,
  input: Parameters<typeof assertProtectedToolchainFixtureCompatibility>[1],
): void {
  const compatibility = fixtureProviderCompatibility.get(provider);
  if (!protectedPreflightProviders.has(provider) || compatibility === undefined)
    throw new Error('release-toolchain-fixture-compatibility-invalid');
  assertProtectedToolchainFixtureCompatibility(compatibility, input);
}

/** Package-private execution observation, never a mutation grant or transferable receipt. */
export interface ProtectedPreflightObservation {
  readonly read: () => {
    readonly request: ReleaseLifecycleRequest;
    readonly execution_identity: Json;
    readonly runs: readonly {
      readonly binding: Json;
      readonly preflight_receipt: Json;
      readonly output_census: readonly {
        readonly path: string;
        readonly mode: string;
        readonly sha256: string;
        readonly size_bytes: number;
        readonly task_node: string;
      }[];
    }[];
  };
}

/** Private raw custody, including failed tasks; not a semantic verdict or execution grant. */
export interface ProtectedFixtureDiagnosticCustody {
  readonly read: () => {
    readonly request: ReleaseLifecycleRequest;
    readonly execution_identity: Json;
    readonly runtime_identity: Json;
    readonly fixture_input_identity?: Json;
    readonly outcome: 'success' | 'failure';
    readonly runs: readonly {
      readonly binding: Json;
      readonly task_node: string;
      readonly process: {
        readonly status: number | null;
        readonly signal: string | null;
        readonly errorAbsent: boolean;
      };
      readonly output_census: readonly {
        readonly path: string;
        readonly mode: string;
        readonly sha256: string;
        readonly size_bytes: number;
        readonly task_node: string;
      }[];
    }[];
  };
  readonly readOutput: (member: {
    readonly run_index: number;
    readonly path: string;
    readonly sha256: string;
  }) => Buffer;
}

export const fixtureDiagnosticCustodies = new WeakMap<
  ReleaseProvider,
  { readonly request_digest: string; readonly custody: ProtectedFixtureDiagnosticCustody }
>();
export const verifiedFixtureDiagnosticCustodies = new WeakSet<object>();

export function isVerifiedProtectedFixtureDiagnosticCustody(
  value: unknown,
): value is ProtectedFixtureDiagnosticCustody {
  return (
    value !== null && typeof value === 'object' && verifiedFixtureDiagnosticCustodies.has(value)
  );
}

/** Deliberately absent from the public host barrel; wrong requests consume the pending slot. */
export function takeProtectedFixtureDiagnosticCustody(
  provider: ReleaseProvider,
  expectedRequest: ReleaseLifecycleRequest,
): ProtectedFixtureDiagnosticCustody {
  const pending = fixtureDiagnosticCustodies.get(provider);
  fixtureDiagnosticCustodies.delete(provider);
  if (pending === undefined || pending.request_digest !== canonicalSha256(expectedRequest))
    throw new Error('release-certification-diagnostic-custody-unavailable');
  return pending.custody;
}

export interface CapturedDiagnosticRun {
  readonly binding: Json;
  readonly task_node: string;
  readonly process: ReturnType<
    ProtectedFixtureDiagnosticCustody['read']
  >['runs'][number]['process'];
  readonly outputs: readonly ContainerArchiveEntry[];
}

export const RUNTIME_IDENTITY_KEYS = [
  'protocol',
  'image',
  'local_image',
  'engine_version',
  'node_version',
  'docker_binary_sha256',
  'executables',
  'network',
  'rootfs',
  'capabilities',
  'privilege_escalation',
  'pids_limit',
  'memory_bytes',
  'cpus',
] as const;

export const preflightObservations = new WeakMap<
  ReleaseProvider,
  { readonly request_digest: string; readonly observation: ProtectedPreflightObservation }
>();
export const verifiedPreflightObservations = new WeakSet<object>();

export function isVerifiedProtectedPreflightObservation(
  value: unknown,
): value is ProtectedPreflightObservation {
  return value !== null && typeof value === 'object' && verifiedPreflightObservations.has(value);
}

/** Internal fixed-fixture composition only; deliberately absent from the public host barrel. */
export function takeProtectedPreflightObservation(
  provider: ReleaseProvider,
  expectedRequest: ReleaseLifecycleRequest,
): ProtectedPreflightObservation {
  const pending = preflightObservations.get(provider);
  preflightObservations.delete(provider);
  if (pending === undefined || pending.request_digest !== canonicalSha256(expectedRequest))
    throw new Error('release-certification-preflight-observation-unavailable');
  return pending.observation;
}

export function isProtectedReleasePreflightProvider(
  provider: ReleaseProvider | undefined,
): boolean {
  return provider !== undefined && protectedPreflightProviders.has(provider);
}
export function object(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('release-certification-plan-binding-invalid');
  return value as Json;
}
export function snapshot<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
export function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
export function outputPaths(plan: Pick<TaskPlan, 'tasks'>): Map<string, string> {
  const result = new Map<string, string>();
  for (const task of plan.tasks) {
    const paths = task.outputContract.paths ?? [];
    if (
      !Array.isArray(paths) ||
      paths.some((path) => typeof path !== 'string' || !canonicalContainerPath(path))
    )
      throw new Error('release-certification-output-closure-invalid');
    if (
      task.outputContract.execution_only_paths !== undefined &&
      task.outputContract.execution_only_paths !== true
    )
      throw new Error('release-certification-output-closure-invalid');
    if (task.outputContract.kind === 'tracked-files') continue;
    for (const path of paths as string[]) {
      if (result.has(path)) throw new Error('release-certification-output-closure-invalid');
      result.set(path, task.nodeId);
    }
  }
  return result;
}
