import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { runCheckTasks, runCheckTasksAsync } from './check-runner/runner.js';
import type {
  CheckRunnerOptions,
  CheckRunnerReport,
  TaskDescriptor,
} from './check-runner/types.js';
import type { ContainerArchiveEntry } from './container-archive.js';
import { resolveProtectedGeneratedNamespaces } from './release-production-outputs.js';
import { recordProtectedToolchainFixtureBinding } from './release-toolchain-fixture-compatibility.js';
import { isVerifiedReleasePolicyResolution } from './release-policy-resolution.js';
import type {
  GitReleaseBlobLocator,
  ReleaseLifecycleRequest,
  ReleaseStateMaterial,
} from './release-lifecycle-execution.js';
import {
  compare,
  digest,
  mutationPrerequisites,
  outputPaths,
  snapshot,
  type CapturedDiagnosticRun,
  type ContainerReleaseCertificationAdapters,
  type ProtectedMutationPrerequisiteClosure,
} from './release-certification-provider-state.js';
import {
  captureContainerReleaseInputs,
  type ContainerReleaseAdapterInput,
} from './release-certification-provider-inputs.js';

/** Every value the container release adapter closures read, named once. */
export type ContainerReleaseScope = ReturnType<typeof captureContainerReleaseInputs> & {
  readonly input: ContainerReleaseAdapterInput;
  readonly activity: { active: boolean };
  readonly adapters: ContainerReleaseCertificationAdapters;
  readonly bindRequest: (request: ReleaseLifecycleRequest) => TaskDescriptor;
  readonly optionsFor: (
    request: ReleaseLifecycleRequest,
    descriptor: TaskDescriptor,
    index: number,
    stage: 'preflight' | 'certify',
  ) => CheckRunnerOptions;
  readonly sourcesFor: (request: ReleaseLifecycleRequest) => Promise<{
    source: ContainerArchiveEntry[];
    gitMetadata: readonly ContainerArchiveEntry[];
    locators: Map<string, GitReleaseBlobLocator>;
  }>;
  readonly execute: ReturnType<typeof containerTaskExecutor>;
  readonly material: ReturnType<typeof releaseStateMaterializer>;
};

/** Executor of one planned task population inside the certification container. */
export function containerTaskExecutor(
  scope: Pick<
    ContainerReleaseScope,
    | 'selected'
    | 'fixtureContext'
    | 'container'
    | 'environment'
    | 'root'
    | 'diagnosticsByTask'
    | 'toolchain'
  >,
) {
  const { selected, fixtureContext, container, environment, root, diagnosticsByTask, toolchain } =
    scope;
  return async function execute(
    request: ReleaseLifecycleRequest,
    options: CheckRunnerOptions,
    source: readonly ContainerArchiveEntry[],
    gitMetadata: readonly ContainerArchiveEntry[],
    diagnosticRuns?: CapturedDiagnosticRun[],
  ) {
    const planned = runCheckTasks(options).plan;
    const descriptor = options.descriptorDocument;
    if (descriptor === undefined) throw new Error('release-task-policy-identity-mismatch');
    const namespaces = resolveProtectedGeneratedNamespaces(descriptor, source);
    if (
      canonicalJson(options.protectedExecutionIdentity?.generated_namespaces) !==
      canonicalJson(namespaces)
    )
      throw new Error('release-task-policy-identity-mismatch');
    const outputs = new Map<string, ContainerArchiveEntry>();
    const producers = new Map<string, string>();
    const capturedPaths = new Map<string, readonly string[]>();
    const sourceByPath = new Map(source.map((entry) => [entry.path, entry]));
    const expected = new Set<string>();
    const boundPlan = selected.find(
      (entry) => canonicalJson(entry.plan.intent) === canonicalJson(options.releaseIntent),
    );
    if (boundPlan === undefined) throw new Error('release-certification-plan-binding-invalid');
    const binding = {
      action_id: request.action_id as 'release preflight' | 'release certify',
      repository: request.repository_locator,
      task_policy_digest_sha256: planned.taskPolicyDigest,
      plan_receipt_digest_sha256: boundPlan.receipt.receipt_digest_sha256,
      helper_identity_sha256: canonicalSha256({
        bindingIdentity: options.protectedExecutionIdentity,
        candidate_git_metadata_digest_sha256: canonicalSha256(
          gitMetadata.map(({ path, bytes }) => ({ path, sha256: digest(bytes) })),
        ),
        stage: options.releaseStage,
        selected_tasks: planned.tasks.map((task) => ({
          node_id: task.nodeId,
          task_key: task.taskKey,
          argv: task.argv,
          cwd: task.cwd,
          executable: task.executable,
        })),
        task_policy_digest_sha256: planned.taskPolicyDigest,
      }),
    };
    if (fixtureContext !== undefined && diagnosticRuns !== undefined)
      recordProtectedToolchainFixtureBinding(fixtureContext, binding);
    const tasksByNode = new Map(planned.tasks.map((task) => [task.nodeId, task]));
    const executedNodes = new Set<string>();
    // A container authorization scope is synchronous. Never retain its private
    // host capability across an await between DAG tasks or evidence operations.
    container.runBound(binding, () => container.verifyRuntime());
    const executionOptions: CheckRunnerOptions = {
      ...options,
      operation: 'run',
      executeTask: (argv, cwd, timeout, taskEnvironment, taskIdentity) => {
        if (
          fixtureContext !== undefined &&
          canonicalJson(taskEnvironment) !== canonicalJson(environment)
        )
          throw new Error('release-toolchain-fixture-compatibility-invalid');
        const task = tasksByNode.get(taskIdentity.nodeId);
        if (
          task === undefined ||
          task.taskKey !== taskIdentity.taskKey ||
          executedNodes.has(task.nodeId) ||
          canonicalJson(argv) !== canonicalJson(task.argv) ||
          realpathSync(cwd) !== realpathSync(resolve(root, task.cwd))
        )
          throw new Error('release-task-policy-identity-mismatch');
        executedNodes.add(task.nodeId);
        const paths = outputPaths({ ...planned, tasks: [task] });
        const gitView = task.outputContract.git_view;
        if (gitView !== undefined && gitView !== 'candidate-local-shallow-v1')
          throw new Error('release-certification-git-view-unsupported');
        if (task.outputContract.kind === 'tracked-files') {
          const tracked = task.outputContract.paths;
          if (
            !Array.isArray(tracked) ||
            tracked.some((path) => typeof path !== 'string' || !sourceByPath.has(path))
          )
            throw new Error('release-certification-output-closure-invalid');
        }
        for (const path of paths.keys()) expected.add(path);
        const diagnosticPaths =
          diagnosticRuns === undefined ? undefined : diagnosticsByTask.get(task.nodeId);
        const result = container.runBound(binding, () =>
          container.execute({
            task,
            timeout_ms: timeout,
            environment: taskEnvironment,
            source: gitView === undefined ? source : [...source, ...gitMetadata],
            prior_outputs: outputs,
            declared_outputs: [...expected],
            declared_namespaces: namespaces.filter((entry) => entry.task_node === task.nodeId),
            ...(diagnosticPaths === undefined
              ? {}
              : {
                  diagnostic_output_paths: diagnosticPaths,
                }),
          }),
        );
        if (diagnosticRuns !== undefined && diagnosticsByTask.has(task.nodeId)) {
          if (result.diagnostic_outputs === undefined)
            throw new Error('release-certification-diagnostic-output-unavailable');
          // The container has already proved shutdown, isolation and full archive
          // integrity. Retain bytes separately BEFORE the runner handles a task failure.
          diagnosticRuns.push({
            binding: snapshot(binding),
            task_node: task.nodeId,
            process: {
              status: result.result.status,
              signal: result.result.signal,
              errorAbsent: result.result.errorCode === undefined,
            },
            outputs: result.diagnostic_outputs.map((output) => ({
              ...output,
              bytes: Buffer.from(output.bytes),
            })),
          });
        }
        const produced: string[] = [];
        for (const output of result.outputs) {
          if (!outputs.has(output.path)) {
            producers.set(output.path, task.nodeId);
            produced.push(output.path);
          }
          outputs.set(output.path, output);
          expected.add(output.path);
        }
        capturedPaths.set(task.nodeId, produced.sort(compare));
        return result.result;
      },
      capturedTaskOutputPaths: (task) => capturedPaths.get(task.nodeId) ?? [],
      readTaskOutput: (path) => {
        const output =
          outputs.get(path) ??
          (planned.tasks.some(
            (task) =>
              task.outputContract.kind === 'tracked-files' &&
              Array.isArray(task.outputContract.paths) &&
              task.outputContract.paths.includes(path),
          )
            ? sourceByPath.get(path)
            : undefined);
        if (output === undefined) throw new Error('release-certification-output-closure-invalid');
        return Buffer.from(output.bytes);
      },
    };
    const report =
      request.action_id === 'release certify'
        ? await runCheckTasksAsync(executionOptions)
        : runCheckTasks(executionOptions);
    if (
      report.exitCode !== 0 ||
      report.execution?.length !== planned.tasks.length ||
      report.execution.some((task) => task.outcome !== 'PASS' || task.disposition !== 'executed') ||
      canonicalJson(report.plan.taskPolicy) !== canonicalJson(planned.taskPolicy)
    )
      throw new Error('release-certification-task-failed');
    let mutationPrerequisiteClosure: ProtectedMutationPrerequisiteClosure | undefined;
    if (request.action_id === 'release certify' && fixtureContext === undefined) {
      const resolution = boundPlan.plan.resolution;
      if (!isVerifiedReleasePolicyResolution(resolution))
        throw new Error('release-certification-prerequisite-proof-invalid');
      mutationPrerequisiteClosure = Object.freeze({
        kind: 'protected-mutation-prerequisite-closure-v1' as const,
      });
      mutationPrerequisites.set(mutationPrerequisiteClosure, {
        binding: snapshot({
          repository: request.repository_locator,
          release_unit: resolution.release_unit,
          release_plan_receipt_digest: boundPlan.receipt.receipt_digest_sha256,
          release_profile_digest: canonicalSha256(
            resolution.readInput('release-verification-profile'),
          ),
          container_identity: container.identity,
          environment,
          toolchain,
        }),
        task_policy_digest: planned.taskPolicyDigest,
        tasks: planned.tasks.map((task) => ({
          node_id: task.nodeId,
          output_contract: snapshot(task.outputContract),
        })),
        outputs: [...outputs.values()]
          .sort((a, b) => compare(a.path, b.path))
          .map((entry) => {
            const producer = producers.get(entry.path);
            if (producer === undefined)
              throw new Error('release-certification-prerequisite-proof-invalid');
            const bytes = Buffer.from(entry.bytes);
            return {
              path: entry.path,
              mode: entry.mode,
              bytes,
              producer_task_node: producer,
              size: bytes.length,
              sha256: digest(bytes),
            };
          }),
      });
    }
    return {
      report,
      outputs,
      producers,
      mutation_prerequisites: mutationPrerequisiteClosure,
      namespaces: namespaces.filter((entry) =>
        planned.tasks.some((task) => task.nodeId === entry.task_node),
      ),
      binding,
    };
  };
}

/** Release state material of the certified reports and blob locators. */
export function releaseStateMaterializer(scope: Pick<ContainerReleaseScope, 'selected'>) {
  const { selected } = scope;
  return function material(
    request: ReleaseLifecycleRequest,
    reports: readonly CheckRunnerReport[],
    locators: ReadonlyMap<string, GitReleaseBlobLocator>,
  ): ReleaseStateMaterial {
    return {
      release_units: request.candidate_locator.release_units.map((unit) => ({
        release_unit: unit.release_unit,
        version: unit.version,
        packages: unit.package_roster.map((pkg) => {
          const source = locators.get(pkg.manifest_path);
          if (source === undefined || source.content_digest_sha256 !== pkg.manifest_digest_sha256)
            throw new Error('release-package-manifest-identity-mismatch');
          return {
            package_id: pkg.package_id,
            manifest: {
              path: pkg.manifest_path,
              sha256: source.content_digest_sha256,
              size_bytes: source.size_bytes,
            },
            tarball: null,
            sbom: null,
            evidence_manifest: null,
            provider_result: null,
            trust: null,
          };
        }),
      })),
      inputs: reports.map((report, index) => ({
        kind: 'task-policy',
        path: `task-policy/protected/${String(index)}`,
        sha256: report.plan.taskPolicyDigest,
      })),
      evidence: {
        manifest_digest_sha256: canonicalSha256(reports),
        receipt_digests: [
          ...new Set([
            ...selected.map((entry) => entry.receipt.receipt_digest_sha256),
            ...reports.flatMap((report) =>
              [report.preflightReceipt?.digest, report.receipt?.digest].filter(
                (value): value is string => value !== undefined,
              ),
            ),
          ]),
        ].sort(compare),
        independently_checkable: true,
      },
      artifacts: [],
    };
  };
}
