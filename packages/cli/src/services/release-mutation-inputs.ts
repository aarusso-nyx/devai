/** @deprecated Compatibility declarations only. Mutation machinery moved to bedel. */
import {
  type ReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from './release-candidate-snapshot.js';
import { type VerifiedReleasePolicyResolution } from './release-policy-resolution.js';
import {
  type ProtectedContainerControls,
  type ProtectedContainerDependency,
} from './release-certification-container.js';
import { type ProtectedMutationPrerequisiteClosure } from './release-certification-provider.js';
import type { ReleaseProvider } from './release-lifecycle-execution.js';
import type { ReleaseMutationPackageInputsV21 } from './release-mutation-artifacts.js';
type Json = Readonly<Record<string, unknown>>;
export interface ReleaseMutationSourceMemberV21 {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly object_id: string;
  readonly size: number;
  readonly sha256: string;
}
export interface ReleaseMutationPrerequisiteMember {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly size: number;
  readonly sha256: string;
  readonly producer_task_node: string;
}
export interface ReleaseMutationInputPackageV21 {
  readonly id: string;
  readonly input_digest: string;
  readonly expected: ReleaseMutationPackageInputsV21;
  readonly selected_source: readonly ReleaseMutationSourceMemberV21[];
  readonly selected_tests: readonly ReleaseMutationSourceMemberV21[];
  readonly mutation_targets: readonly ReleaseMutationSourceMemberV21[];
  readonly mutation_target_population_digest: string;
  readonly mutation_target_projection_digest: string;
  readonly workspace_dependencies: readonly string[];
  readonly prerequisite_nodes: readonly string[];
  readonly execution_configuration?: {
    readonly task_node: string;
    readonly vitest_config: ReleaseMutationSourceMemberV21;
    readonly typescript_config: ReleaseMutationSourceMemberV21;
    readonly typescript_closure: readonly ReleaseMutationSourceMemberV21[];
  };
  readonly reuse: {
    readonly eligible: boolean;
    readonly unresolved: readonly string[];
  };
}
export interface ReleaseMutationInputPlanV21 {
  readonly repository: ReleaseCandidateSnapshot['repository'];
  readonly release_unit: string;
  readonly release_plan_receipt_digest: string;
  readonly release_profile_digest: string;
  readonly mutation_policy_digest: string;
  readonly template_id: 'devai.protected-mutation-stryker.v1';
  readonly execution_template_version: '1.1.0' | '1.2.0';
  readonly execution_coverage: Readonly<{
    kind: ReleaseMutationExecutionCoverageV21['kind'];
    repository: ReleaseCandidateSnapshot['repository'];
    release_unit: string;
    target_version: string;
    release_plan_receipt_digest: string;
    release_profile_digest: string;
    policy_resolution_digest: string;
    expected_package_inputs_digest: string;
  }>;
  readonly packages: readonly ReleaseMutationInputPackageV21[];
  readonly toolchain_fixture_validation: Json;
  readonly grants: {
    readonly execution: false;
    readonly certification: false;
    readonly reuse: false;
  };
  readonly readProof: () => ReadonlyMap<string, ReleaseGitObject>;
}
export type ReleaseMutationExecutionCoverageV21 =
  | {
      readonly kind: 'plan-determined';
    }
  | {
      readonly kind: 'owner-approved-complete-devai-roster';
      readonly repository: ReleaseCandidateSnapshot['repository'];
      readonly release_unit: '@aarusso-nyx/devai';
      readonly target_version: '1.5.0';
      readonly release_plan_receipt_digest: string;
      readonly release_profile_digest: string;
      readonly policy_resolution_digest: string;
    };
export interface ReleaseMutationInputControlsV21 {
  readonly execution_coverage: ReleaseMutationExecutionCoverageV21;
  readonly fixture_provider?: ReleaseProvider;
  readonly prerequisite_closure?: ProtectedMutationPrerequisiteClosure;
  readonly container: ProtectedContainerControls;
  readonly dependencies: readonly ProtectedContainerDependency[];
  readonly environment: Readonly<Record<string, string>>;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly maximum_source_bytes: number;
  readonly maximum_source_entries: number;
}
export interface ReleaseMutationInputExecutionContext {
  readonly container_identity: Readonly<Record<string, unknown>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly repository: ReleaseCandidateSnapshot['repository'];
  readonly candidate_files: readonly {
    readonly path: string;
    readonly mode: string;
    readonly object_id: string;
  }[];
  readonly prerequisite_outputs?: readonly ReleaseMutationPrerequisiteMember[];
}
export function isDerivedReleaseMutationInputPlanV21(
  value: unknown,
): value is ReleaseMutationInputPlanV21 {
  void value;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export function assertReleaseMutationInputPackageIdentity(
  plan: ReleaseMutationInputPlanV21,
  identity: unknown,
): void {
  void plan;
  void identity;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export function captureReleaseMutationInputExecutionContext(
  plan: ReleaseMutationInputPlanV21,
): ReleaseMutationInputExecutionContext {
  void plan;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export function assertReleaseMutationInputProjectionV21(
  plan: ReleaseMutationInputPlanV21,
  packageName: string,
  alleged: unknown,
): void {
  void plan;
  void packageName;
  void alleged;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export function buildReleaseMutationInputPlanV21(input: {
  readonly candidate: ReleaseCandidateSnapshot;
  readonly resolution: VerifiedReleasePolicyResolution;
  readonly plan_receipt: unknown;
  readonly controls: ReleaseMutationInputControlsV21;
}): ReleaseMutationInputPlanV21 {
  void input;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export {};
