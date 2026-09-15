/** @deprecated Compatibility declarations only. Mutation machinery moved to bedel. */
import { type ProtectedMutationProgram } from './release-mutation-program.js';
import { type ReleaseMutationPackageArtifactsV21 } from './release-mutation-artifacts.js';
export function normalizeProtectedMutationExecutionV21(input: {
  readonly program: ProtectedMutationProgram;
  readonly execution: unknown;
}): ReleaseMutationPackageArtifactsV21 {
  void input;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export function captureProducedMutationPackageV21(
  value: unknown,
): ReleaseMutationPackageArtifactsV21 {
  void value;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
