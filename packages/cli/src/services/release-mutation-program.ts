/** @deprecated Compatibility declarations only. Mutation machinery moved to bedel. */
import type { ContainerArchiveEntry } from './container-archive.js';
import type { ReleasePackageSnapshot } from './release-package-snapshot.js';
import { type ReleaseMutationInputPlanV21 } from './release-mutation-inputs.js';
import type { ReleaseMutationArtifactLimitsV21 } from './release-mutation-artifacts.js';
export interface ProtectedMutationProgramPackage {
  readonly package: ReleaseMutationInputPlanV21['packages'][number];
  readonly limits: ReleaseMutationArtifactLimitsV21;
}
export interface ProtectedMutationProgram {
  readonly kind: 'protected-mutation-program-v1';
  readonly identity_sha256: string;
}
export interface CapturedProtectedMutationProgram {
  readonly identity_sha256: string;
  readonly files: readonly ContainerArchiveEntry[];
  readonly argv: readonly string[];
  readonly maximum_observation_bytes: number;
  readonly maximum_raw_report_bytes: number;
}
export function createProtectedMutationProgram(input: {
  readonly package_snapshot: ReleasePackageSnapshot;
  readonly input_plan: ReleaseMutationInputPlanV21;
  readonly package_name: string;
  readonly limits: ReleaseMutationArtifactLimitsV21;
}): ProtectedMutationProgram {
  void input;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export function captureProtectedMutationProgramPackage(
  program: ProtectedMutationProgram,
): ProtectedMutationProgramPackage {
  void program;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export function assertProtectedMutationProgramExecution(
  program: ProtectedMutationProgram,
  input: {
    readonly container_identity: Readonly<Record<string, unknown>>;
    readonly environment: Readonly<Record<string, string>>;
    readonly source: readonly ContainerArchiveEntry[];
    readonly prior_outputs: ReadonlyMap<string, ContainerArchiveEntry>;
  },
): void {
  void program;
  void input;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export function captureProtectedMutationProgram(
  program: ProtectedMutationProgram,
): CapturedProtectedMutationProgram {
  void program;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
