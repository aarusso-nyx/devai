/** @deprecated Compatibility declarations only. Mutation machinery moved to bedel. */
import { createProtectedReleaseHostAdapter } from '@devai-nyx/authority';
import { type ReleaseMutationPackageArtifactsV21 } from './release-mutation-artifacts.js';
import { type ReleaseMutationInputPlanV21 } from './release-mutation-inputs.js';
import { type MutationVerificationOptionsV21 } from './mutation-evidence-v21.js';
import {
  type ReleaseUnitMutationEvidenceClosure,
  type UnitMutationEvidenceSink,
} from './release-unit-mutation-evidence.js';
type PackageArtifacts = {
  readonly packageName: string;
  readonly disposition: 'executed' | 'reused';
  readonly origin: unknown;
  readonly artifacts: ReleaseMutationPackageArtifactsV21;
};
export interface ReleaseMutationRetentionInputV21 {
  readonly plan: ReleaseMutationInputPlanV21;
  readonly packages: readonly PackageArtifacts[];
  readonly task_policy_digests_sha256: readonly string[];
  readonly evidence_sink: UnitMutationEvidenceSink;
  readonly authority_owner: object;
  readonly sink_host: ReturnType<typeof createProtectedReleaseHostAdapter>;
  readonly resolve_reuse_origin?: MutationVerificationOptionsV21['resolveReuseOrigin'];
}
export function retainReleaseMutationEvidenceV21(
  input: ReleaseMutationRetentionInputV21,
): Promise<ReleaseUnitMutationEvidenceClosure> {
  void input;
  throw new Error('MUTATION_OFFLOADED_TO_BEDEL: use bedel');
}
export {};
