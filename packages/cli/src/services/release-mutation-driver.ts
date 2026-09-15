/** @deprecated Compatibility declarations only. Mutation machinery moved to bedel. */
import type { ProtectedMutationPackageObserver } from './release-mutation-observation.js';
export type { ProtectedMutationPackageObservation } from './release-mutation-observation.js';
import type { createProtectedReleaseHostAdapter } from '@devai-nyx/authority';
import type { PlannedTask } from './check-runner/types.js';
import type { ReleasePackageSnapshot } from './release-package-snapshot.js';
import type { ReleaseMutationArtifactLimitsV21 } from './release-mutation-artifacts.js';
import {
  type ReleaseMutationInputPlanV21,
  type ReleaseMutationPrerequisiteMember,
} from './release-mutation-inputs.js';
import { type ProtectedMutationProgram } from './release-mutation-program.js';
import type {
  ReleaseUnitMutationEvidenceClosure,
  UnitMutationEvidenceSink,
} from './release-unit-mutation-evidence.js';
export const PROTECTED_MUTATION_TASK_ARGV: readonly ['node', '/devai-host/run.mjs'] = [
  'node',
  '/devai-host/run.mjs',
] as const;
export function protectedMutationProgramTask(input: {
  readonly node_id: string;
  readonly task_key: string;
  readonly executable: Readonly<{
    path: string;
    sha256: string;
  }>;
  readonly input_digest: string;
}): PlannedTask {
  void input;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export interface ProtectedMutationExecutionRequest {
  readonly program: ProtectedMutationProgram;
  readonly package_name: string;
  readonly task: PlannedTask;
  readonly prerequisite_members: readonly ReleaseMutationPrerequisiteMember[];
}
export interface ProduceUnitMutationEvidenceInput {
  readonly input_plan: ReleaseMutationInputPlanV21;
  readonly package_snapshot: ReleasePackageSnapshot;
  readonly limits: ReleaseMutationArtifactLimitsV21;
  readonly task_policy_digests_sha256: readonly string[];
  readonly evidence_sink: UnitMutationEvidenceSink;
  readonly authority_owner: object;
  readonly sink_host: ReturnType<typeof createProtectedReleaseHostAdapter>;
  readonly executable: Readonly<{
    path: string;
    sha256: string;
  }>;
  readonly execute: (request: ProtectedMutationExecutionRequest) => unknown;
  readonly observe_package?: ProtectedMutationPackageObserver;
}
export function produceUnitMutationEvidenceV21(
  input: ProduceUnitMutationEvidenceInput,
): Promise<ReleaseUnitMutationEvidenceClosure> {
  void input;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
