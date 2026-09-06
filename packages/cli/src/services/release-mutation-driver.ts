import type {
  ProtectedMutationPackageObservation,
  ProtectedMutationPackageObserver,
} from './release-mutation-observation.js';
export type { ProtectedMutationPackageObservation } from './release-mutation-observation.js';
import { canonicalJson } from '@devai-nyx/utils';
import type { createProtectedReleaseHostAdapter } from '@devai-nyx/authority';
import type { PlannedTask } from './check-runner/types.js';
import type { ReleasePackageSnapshot } from './release-package-snapshot.js';
import type { ReleaseMutationArtifactLimitsV21 } from './release-mutation-artifacts.js';
import {
  captureReleaseMutationInputExecutionContext,
  type ReleaseMutationInputPlanV21,
  type ReleaseMutationPrerequisiteMember,
} from './release-mutation-inputs.js';
import {
  captureProtectedMutationProgram,
  captureProtectedMutationProgramPackage,
  createProtectedMutationProgram,
  type ProtectedMutationProgram,
} from './release-mutation-program.js';
import {
  captureProducedMutationPackageV21,
  normalizeProtectedMutationExecutionV21,
} from './release-mutation-production.js';
import { retainReleaseMutationEvidenceV21 } from './release-mutation-retention.js';
import type {
  ReleaseUnitMutationEvidenceClosure,
  UnitMutationEvidenceSink,
} from './release-unit-mutation-evidence.js';

const INVALID = 'release-certification-mutation-program-invalid';

/** The exact argv the protected container requires for a mutation program task. */
export const PROTECTED_MUTATION_TASK_ARGV = ['node', '/devai-host/run.mjs'] as const;

function refuse(): never {
  throw new Error(INVALID);
}

/**
 * Builds the one synthesized task the protected container accepts for a mutation
 * program. It carries no candidate argv, cwd or output contract: the program is
 * transported as a separate protected volume and both result channels are captured
 * by the trusted PID 1.
 */
export function protectedMutationProgramTask(input: {
  readonly node_id: string;
  readonly task_key: string;
  readonly executable: Readonly<{ path: string; sha256: string }>;
  readonly input_digest: string;
}): PlannedTask {
  return {
    nodeId: input.node_id,
    taskKey: input.task_key,
    argv: [...PROTECTED_MUTATION_TASK_ARGV],
    executable: { path: input.executable.path, sha256: input.executable.sha256 },
    cwd: '.',
    inputDigest: input.input_digest,
    inputPaths: [],
    matchedChangedPaths: [],
    outputContract: { kind: 'none' },
    cacheState: 'execute',
    reason: 'protected-mutation-program',
  } as unknown as PlannedTask;
}

export interface ProtectedMutationExecutionRequest {
  readonly program: ProtectedMutationProgram;
  readonly package_name: string;
  readonly task: PlannedTask;
  /**
   * The exact predecessor outputs this program's execution context expects, in the
   * order the sink recorded them. The caller supplies their bytes from its own
   * verified run; the container independently rechecks every identity.
   */
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
  readonly executable: Readonly<{ path: string; sha256: string }>;
  /** Runs one protected program in the host's own container scope and returns its result. */
  readonly execute: (request: ProtectedMutationExecutionRequest) => unknown;
  /** Await durable host retention before advancing; refusal prevents aggregate completion. */
  readonly observe_package?: ProtectedMutationPackageObserver;
}

/**
 * Produces this release unit's semantic mutation evidence from the already verified
 * input plan, then retains it through the protected sink.
 *
 * This composes the existing protected machinery and adds no runner: the program is
 * built by `createProtectedMutationProgram`, executed by the caller's container scope,
 * normalized by `normalizeProtectedMutationExecutionV21`, and finalized, composed and
 * committed by `retainReleaseMutationEvidenceV21`. Nothing here fabricates a passing
 * result: a package that does not execute, or whose observation and raw report do not
 * agree, refuses before any sink transaction opens.
 */
export async function produceUnitMutationEvidenceV21(
  input: ProduceUnitMutationEvidenceInput,
): Promise<ReleaseUnitMutationEvidenceClosure> {
  const plan = input.input_plan;
  const observePackage = input.observe_package;
  const execute = input.execute;
  const packageSnapshot = input.package_snapshot;
  const evidenceSink = input.evidence_sink;
  const authorityOwner = input.authority_owner;
  const sinkHost = input.sink_host;
  const executable = { ...input.executable };
  const taskPolicyDigests = [...input.task_policy_digests_sha256];
  if (
    plan === null ||
    typeof plan !== 'object' ||
    !Array.isArray(plan.packages) ||
    plan.packages.length === 0 ||
    typeof execute !== 'function' ||
    (observePackage !== undefined && typeof observePackage !== 'function')
  )
    refuse();
  const limits = JSON.parse(canonicalJson(input.limits)) as ReleaseMutationArtifactLimitsV21;
  const context = captureReleaseMutationInputExecutionContext(plan);
  const produced: {
    readonly packageName: string;
    readonly disposition: 'executed';
    readonly origin: null;
    readonly artifacts: ReturnType<typeof normalizeProtectedMutationExecutionV21>;
  }[] = [];
  const seen = new Set<string>();
  for (const entry of plan.packages) {
    const packageName = entry.expected.packageName;
    if (typeof packageName !== 'string' || packageName.length === 0 || seen.has(packageName))
      refuse();
    seen.add(packageName);
    const program = createProtectedMutationProgram({
      package_snapshot: packageSnapshot,
      input_plan: plan,
      package_name: packageName,
      limits,
    });
    // Filter the derived context exactly as the program's own execution context does,
    // so the caller cannot widen or narrow the predecessor population.
    const captured = captureProtectedMutationProgramPackage(program);
    const prerequisiteMembers = (context.prerequisite_outputs ?? []).filter((member) =>
      captured.package.prerequisite_nodes.includes(member.producer_task_node),
    );
    const execution = execute({
      program,
      package_name: packageName,
      prerequisite_members: prerequisiteMembers,
      task: protectedMutationProgramTask({
        node_id: `mutation:${packageName}`,
        task_key: `mutation:${packageName}@${entry.input_digest}`,
        executable,
        input_digest: entry.input_digest,
      }),
    });
    const artifacts = normalizeProtectedMutationExecutionV21({ program, execution });
    if (observePackage !== undefined) {
      const observation: ProtectedMutationPackageObservation = {
        kind: 'protected-mutation-package-observation-v1',
        repository: JSON.parse(canonicalJson(context.repository)),
        package_name: packageName,
        program_identity_sha256: captureProtectedMutationProgram(program).identity_sha256,
        input_digest: entry.input_digest,
        task_policy_digests_sha256: [...taskPolicyDigests],
        artifacts: captureProducedMutationPackageV21(artifacts),
      };
      // The observer receives no live artifact buffers or authority-bearing objects.
      if ((await observePackage(observation)) !== undefined) refuse();
    }
    produced.push({
      packageName,
      disposition: 'executed',
      origin: null,
      // Normalization re-derives every identity from the private execution capture.
      artifacts,
    });
  }
  if (produced.length !== plan.packages.length) refuse();
  return await retainReleaseMutationEvidenceV21({
    plan,
    packages: produced,
    task_policy_digests_sha256: [...taskPolicyDigests],
    evidence_sink: evidenceSink,
    authority_owner: authorityOwner,
    sink_host: sinkHost,
  });
}
