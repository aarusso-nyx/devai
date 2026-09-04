import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProtectedReleaseHostAdapter, readExactGitTreeSync } from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { parseTaskDescriptor } from './check-runner/policy.js';
import { runCheckTasks } from './check-runner/runner.js';
import type {
  CheckRunnerOptions,
  CheckRunnerReport,
  TaskDescriptor,
  TaskPlan,
} from './check-runner/types.js';
import { canonicalContainerPath, type ContainerArchiveEntry } from './container-archive.js';
import {
  ProtectedCertificationContainer,
  type ProtectedContainerControls,
  type ProtectedContainerDependency,
} from './release-certification-container.js';
import { createProtectedCandidateGitMetadata } from './release-certification-git.js';
import { resolveProtectedGeneratedNamespaces } from './release-production-outputs.js';
import { buildReleasePlanReceipt, verifyResolvedReleasePlanReceipt } from './release-lifecycle.js';
import {
  isVerifiedReleasePolicyResolution,
  type VerifiedReleasePolicyResolution,
} from './release-policy-resolution.js';
import type {
  CertificationPackageEntry,
  GitReleaseBlobLocator,
  ReleaseLifecycleRequest,
  ReleaseProvider,
  ReleaseStateMaterial,
} from './release-lifecycle-execution.js';
import {
  createReleaseCertificationProvider,
  type CertificationEvidenceTransaction,
  type TrustedCertificationEvidenceSink,
} from './release-lifecycle-certification.js';
import {
  finalizeCertificationManifest,
  verifyGitCertificationSource,
  type CertificationOutputClosure,
  type ImmutableReleaseContentSource,
} from './release-prepare-kernel.js';

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
  readonly content_source: Pick<ImmutableReleaseContentSource, 'readGitObject' | 'readGitBlob'>;
  readonly evidence_sink: TrustedCertificationEvidenceSink;
}

export interface ContainerReleaseCertificationAdapters {
  readonly preflight_provider: ReleaseProvider;
  readonly certification_provider: (
    request: ReleaseLifecycleRequest,
  ) => Parameters<typeof createReleaseCertificationProvider>[0];
}

type Json = Readonly<Record<string, unknown>>;
const protectedPreflightProviders = new WeakSet<ReleaseProvider>();

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

const preflightObservations = new WeakMap<
  ReleaseProvider,
  { readonly request_digest: string; readonly observation: ProtectedPreflightObservation }
>();
const verifiedPreflightObservations = new WeakSet<object>();

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
function object(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('release-certification-plan-binding-invalid');
  return value as Json;
}
function snapshot<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
function outputPaths(plan: TaskPlan): Map<string, string> {
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

/**
 * Trusted installed-host composition. No candidate path, document, environment variable or CLI
 * argument can select this implementation, its engine/image, dependency bytes, sink or controls.
 * Each invocation uses a fresh check cache and fresh task namespaces. Preflight and certify use
 * identical container/toolchain identities; certify requires the genuine matching preflight.
 */
export function createContainerReleaseCertificationAdapters(
  input: ContainerReleaseCertificationOptions,
): ContainerReleaseCertificationAdapters {
  const root = realpathSync(input.repository_root);
  // Keep the opaque resolution from this runtime. JSON copying would erase its
  // provenance brand; all ordinary caller-owned plan data is still snapshotted.
  const plans = input.plans.map(({ resolution, ...plan }) => ({
    ...snapshot(plan),
    resolution,
  }));
  const environment = snapshot(input.environment);
  const toolchain = snapshot(input.toolchain);
  const controls = snapshot(input.controls);
  const container = new ProtectedCertificationContainer(controls, input.dependencies);
  if (
    !Number.isSafeInteger(input.timeout_ms) ||
    input.timeout_ms <= 0 ||
    toolchain.node !== controls.node_version ||
    [
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'PATH',
      'HOME',
      'TMPDIR',
      'DOCKER_HOST',
      'DOCKER_CONFIG',
    ].some((key) => Object.hasOwn(environment, key))
  ) {
    throw new Error('release-certification-container-controls-invalid');
  }
  const selected = plans.map((plan) => {
    if (!isVerifiedReleasePolicyResolution(plan.resolution))
      throw new Error('rpl-policy-resolution-mismatch');
    const verification = {
      repository_id: input.repository_id,
      intent_path: plan.intent_path,
      intent: plan.intent,
      release_verification_profile: plan.release_verification_profile,
      release_lifecycle_policy: plan.release_lifecycle_policy,
      action_registry: plan.action_registry,
      resolution: plan.resolution,
    };
    if (!verifyResolvedReleasePlanReceipt({ resolution: plan.resolution, receipt: plan.receipt }))
      throw new Error('release-certification-plan-binding-invalid');
    const receipt = buildReleasePlanReceipt(verification);
    if (receipt.verdict !== 'pass' || canonicalJson(receipt) !== canonicalJson(plan.receipt))
      throw new Error('release-certification-plan-binding-invalid');
    return { plan, receipt, intent: object(plan.intent), preflight: plan.preflight_receipt };
  });
  const bindingIdentity = {
    container: container.identity,
    candidate_git_metadata: 'verified-candidate-shallow-v1',
    toolchain,
    environment,
    plans: selected.map(({ plan, receipt }) => ({
      receipt_id: receipt.receipt_id,
      receipt_digest_sha256: receipt.receipt_digest_sha256,
      packages: plan.packages,
    })),
  };
  let active = false;

  function bindRequest(request: ReleaseLifecycleRequest): TaskDescriptor {
    if (
      request.repository_locator.id !== input.repository_id ||
      request.candidate_locator.release_units.length !== selected.length ||
      !['release preflight', 'release certify'].includes(request.action_id)
    )
      throw new Error('release-certification-plan-binding-invalid');
    for (const [index, unit] of request.candidate_locator.release_units.entries()) {
      const entry = selected[index];
      const receipt = entry?.receipt;
      if (
        entry === undefined ||
        receipt === undefined ||
        canonicalJson(receipt.repository) !== canonicalJson(request.repository_locator) ||
        receipt.candidate.release_unit !== unit.release_unit ||
        receipt.candidate.version !== unit.version ||
        canonicalJson(receipt.candidate.commit) !==
          canonicalJson(request.candidate_locator.commit) ||
        receipt.candidate.tree !== request.candidate_locator.tree ||
        !request.receipt_locators?.some(
          (locator) =>
            locator.kind === 'release-plan-receipt' &&
            locator.receipt_id === receipt.receipt_id &&
            locator.receipt_digest_sha256 === receipt.receipt_digest_sha256,
        ) ||
        canonicalJson(entry.plan.packages.map((pkg) => pkg.package_id)) !==
          canonicalJson(unit.package_roster.map((pkg) => pkg.package_id))
      )
        throw new Error('release-certification-plan-binding-invalid');
    }
    const entries = readExactGitTreeSync(
      root,
      request.candidate_locator.commit,
      request.candidate_locator.tree,
      'test-tasks.json',
    );
    if (
      entries.length !== 1 ||
      entries[0]?.path !== 'test-tasks.json' ||
      entries[0].mode === '120000'
    )
      throw new Error('release-task-policy-identity-mismatch');
    const descriptor = parseTaskDescriptor(
      JSON.parse(entries[0].bytes.toString('utf8')) as unknown,
    );
    return descriptor;
  }

  function optionsFor(
    request: ReleaseLifecycleRequest,
    descriptor: TaskDescriptor,
    index: number,
    stage: 'preflight' | 'certify',
  ): CheckRunnerOptions {
    const entry = selected[index];
    if (entry === undefined) throw new Error('release-certification-plan-binding-invalid');
    const base = object(entry.intent.base);
    if (typeof base.commit !== 'string')
      throw new Error('release-certification-plan-binding-invalid');
    const exactSource = readExactGitTreeSync(
      root,
      request.candidate_locator.commit,
      request.candidate_locator.tree,
      '.',
    ).map((entry): ContainerArchiveEntry => {
      if (entry.mode === '120000') throw new Error('release-certification-source-mode-unsupported');
      return { path: entry.path, mode: entry.mode, bytes: entry.bytes };
    });
    const namespaces = resolveProtectedGeneratedNamespaces(descriptor, exactSource);
    return {
      repoRoot: root,
      target: 'release',
      operation: 'plan',
      baseCommit: base.commit,
      descriptorDocument: descriptor,
      releaseIntent: entry.plan.intent,
      releaseProfile: entry.plan.release_verification_profile,
      releaseStage: stage,
      ...(stage === 'certify' ? { preflightReceipt: entry.preflight } : {}),
      releaseCandidate: request.candidate_locator,
      toolchain,
      environment,
      timeoutMs: input.timeout_ms,
      cacheRoot: resolve(root, '.devai/state/check-cache/protected', randomUUID()),
      protectedExecutionIdentity: { ...bindingIdentity, generated_namespaces: namespaces },
      resolveExecutable: (name) => {
        const executable = controls.executables[name];
        if (executable === undefined)
          throw new Error('release-certification-container-toolchain-mismatch');
        return { ...executable };
      },
    };
  }

  async function sourcesFor(request: ReleaseLifecycleRequest) {
    const entries = readExactGitTreeSync(
      root,
      request.candidate_locator.commit,
      request.candidate_locator.tree,
      '.',
    );
    const source: ContainerArchiveEntry[] = [];
    const locators = new Map<string, GitReleaseBlobLocator>();
    for (const entry of entries) {
      if (entry.mode === '120000') throw new Error('release-certification-source-mode-unsupported');
      const locator: GitReleaseBlobLocator = {
        kind: 'git-object',
        repository: request.repository_locator.id,
        commit: request.candidate_locator.commit,
        tree: request.candidate_locator.tree,
        object_format: request.candidate_locator.commit.length === 40 ? 'sha1' : 'sha256',
        path: entry.path,
        mode: entry.mode,
        object_id: entry.object_id,
        size_bytes: entry.bytes.length,
        content_digest_sha256: digest(entry.bytes),
      };
      const bytes = await verifyGitCertificationSource(input.content_source, request, locator);
      source.push({ path: entry.path, mode: entry.mode, bytes });
      locators.set(entry.path, locator);
    }
    const gitMetadata = await createProtectedCandidateGitMetadata({
      request,
      source,
      locators,
      content_source: input.content_source,
      maximum_bytes: controls.maximum_archive_bytes,
    });
    return { source, gitMetadata, locators };
  }

  function execute(
    request: ReleaseLifecycleRequest,
    options: CheckRunnerOptions,
    source: readonly ContainerArchiveEntry[],
    gitMetadata: readonly ContainerArchiveEntry[],
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
    let taskIndex = 0;
    const report = container.runBound(binding, () => {
      container.verifyRuntime();
      return runCheckTasks({
        ...options,
        operation: 'run',
        executeTask: (argv, cwd, timeout, taskEnvironment) => {
          const task = planned.tasks[taskIndex++];
          if (
            task === undefined ||
            canonicalJson(argv) !== canonicalJson(task.argv) ||
            realpathSync(cwd) !== realpathSync(resolve(root, task.cwd))
          )
            throw new Error('release-task-policy-identity-mismatch');
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
          const result = container.execute({
            task,
            timeout_ms: timeout,
            environment: taskEnvironment,
            source: gitView === undefined ? source : [...source, ...gitMetadata],
            prior_outputs: outputs,
            declared_outputs: [...expected],
            declared_namespaces: namespaces.filter((entry) => entry.task_node === task.nodeId),
          });
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
      });
    });
    if (
      report.exitCode !== 0 ||
      report.execution?.length !== planned.tasks.length ||
      report.execution.some((task) => task.outcome !== 'PASS' || task.disposition !== 'executed') ||
      canonicalJson(report.plan.taskPolicy) !== canonicalJson(planned.taskPolicy)
    )
      throw new Error('release-certification-task-failed');
    return {
      report,
      outputs,
      producers,
      namespaces: namespaces.filter((entry) =>
        planned.tasks.some((task) => task.nodeId === entry.task_node),
      ),
      binding,
    };
  }

  function material(
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
  }

  const preflight_provider: ReleaseProvider = async (request) => {
    if (active) return { outcome: 'failure', code: 'release-certification-provider-in-use' };
    active = true;
    preflightObservations.delete(preflight_provider);
    try {
      if (request.action_id !== 'release preflight')
        throw new Error('release-certification-plan-binding-invalid');
      const descriptor = bindRequest(request);
      const source = await sourcesFor(request);
      const runs = selected.map((_entry, index) =>
        execute(
          request,
          optionsFor(request, descriptor, index, 'preflight'),
          source.source,
          source.gitMetadata,
        ),
      );
      const reports = runs.map((run) => run.report);
      for (const [index, report] of reports.entries()) {
        if (report.preflightReceipt === undefined)
          throw new Error('release-certification-preflight-required');
        const entry = selected[index];
        if (entry !== undefined) entry.preflight = snapshot(report.preflightReceipt.value);
      }
      const stateMaterial = material(request, reports, source.locators);
      const captured: ReturnType<ProtectedPreflightObservation['read']> = snapshot({
        request,
        execution_identity: bindingIdentity,
        runs: runs.map((run) => ({
          binding: run.binding,
          preflight_receipt: object(run.report.preflightReceipt?.value),
          output_census: [...run.outputs.values()]
            .sort((a, b) => compare(a.path, b.path))
            .map((output) => {
              const producer = run.producers.get(output.path);
              if (producer === undefined)
                throw new Error('release-certification-output-closure-invalid');
              return {
                path: output.path,
                mode: output.mode,
                sha256: digest(output.bytes),
                size_bytes: output.bytes.length,
                task_node: producer,
              };
            }),
        })),
      });
      // Keep only identities after verified execution/quiescence. This does not retain
      // raw reports, certify their semantics, or discharge any production mutation gate.
      const observation: ProtectedPreflightObservation = Object.freeze({
        read: () => snapshot(captured),
      });
      verifiedPreflightObservations.add(observation);
      preflightObservations.set(preflight_provider, {
        request_digest: canonicalSha256(request),
        observation,
      });
      return { outcome: 'success', material: stateMaterial };
    } catch (error) {
      return {
        outcome: 'failure',
        // Native/tool diagnostics are not ledger codes and can expose host paths.
        // Keep the original failure terminal instead of making its record fail
        // schema validation and leaving only an ambiguous attempt behind.
        code:
          error instanceof Error && /^release-[a-z0-9-]+$/u.test(error.message)
            ? error.message
            : 'release-certification-task-failed',
      };
    } finally {
      active = false;
    }
  };

  protectedPreflightProviders.add(preflight_provider);
  return {
    preflight_provider,
    certification_provider(request) {
      const descriptor = bindRequest(request);
      // A task's PASS and hashed output paths are not semantic mutation evidence.
      // Until the protected v2.1 producer/verifier bridge is installed here, refuse
      // required mutation before any task/container/sink effect, never certify the
      // ordinary Vitest nodes currently used by the declarative roster.
      if (selected.some((entry) => object(entry.receipt.determination).mutation !== 'none'))
        throw new Error('release-certification-mutation-evidence-unavailable');
      const options = selected.map((_entry, index) =>
        optionsFor(request, descriptor, index, 'certify'),
      );
      const policies = options.map((option, index) => ({
        release_unit: request.candidate_locator.release_units[index]?.release_unit ?? '',
        ...runCheckTasks(option).plan,
      }));
      return {
        content_source: input.content_source,
        evidence_sink: input.evidence_sink,
        task_policies: policies.map((policy) => ({
          release_unit: policy.release_unit,
          task_policy_digest_sha256: policy.taskPolicyDigest,
          document: policy.taskPolicy,
        })),
        provider: {
          kind: 'protected-certification-provider-v3',
          async certify(call) {
            if (active) throw new Error('release-certification-provider-in-use');
            active = true;
            try {
              bindRequest(call.request);
              if (canonicalJson(call.request) !== canonicalJson(request))
                throw new Error('release-certification-plan-binding-invalid');
              const source = await sourcesFor(request);
              const runs = options.map((option) =>
                execute(request, option, source.source, source.gitMetadata),
              );
              if (
                runs.some(
                  (run, index) =>
                    run.report.plan.taskPolicyDigest !== policies[index]?.taskPolicyDigest ||
                    canonicalJson(run.report.plan.taskPolicy) !==
                      canonicalJson(call.task_policies[index]?.document),
                )
              )
                throw new Error('release-task-policy-identity-mismatch');
              const prepared = runs.flatMap((run, unitIndex) => {
                const unit = request.candidate_locator.release_units[unitIndex];
                const entry = selected[unitIndex];
                if (unit === undefined || entry === undefined)
                  throw new Error('release-certification-plan-binding-invalid');
                const declared = outputPaths(run.report.plan);
                const executionOnly = new Set(
                  run.report.plan.tasks.flatMap((task) =>
                    task.outputContract.execution_only_paths === true
                      ? [...outputPaths({ ...run.report.plan, tasks: [task] }).keys()]
                      : [],
                  ),
                );
                const mapped = new Set<string>();
                const packages = entry.plan.packages.map((pkg, pkgIndex) => {
                  const requested = unit.package_roster[pkgIndex];
                  if (requested === undefined || !requested.manifest_path.endsWith('package.json'))
                    throw new Error('release-certification-plan-binding-invalid');
                  const prefix = requested.manifest_path.slice(0, -'package.json'.length);
                  const paths = [
                    ...pkg.source_entries,
                    ...pkg.generated_entries.map((value) => value.path),
                  ];
                  if (
                    !pkg.source_entries.includes('package.json') ||
                    paths.some((path) => !canonicalContainerPath(path)) ||
                    new Set(paths).size !== paths.length
                  )
                    throw new Error('release-certification-output-closure-invalid');
                  const projected = run.namespaces.filter(
                    (namespace) =>
                      namespace.package_manifest === requested.manifest_path &&
                      namespace.package_id === pkg.package_id,
                  );
                  const generatedMapping = [
                    ...pkg.generated_entries,
                    ...projected.flatMap((namespace) =>
                      [...run.outputs.keys()]
                        .filter((path) => path.startsWith(`${namespace.prefix}/`))
                        .map((path) => ({
                          path: path.slice(prefix.length),
                          task_node: namespace.task_node,
                        })),
                    ),
                  ];
                  const generated = generatedMapping
                    .map((value) => {
                      const path = `${prefix}${value.path}`;
                      const output = run.outputs.get(path);
                      if (
                        output === undefined ||
                        (declared.get(path) ?? run.producers.get(path)) !== value.task_node ||
                        mapped.has(path) ||
                        pkg.source_entries.includes(value.path)
                      )
                        throw new Error('release-certification-output-closure-invalid');
                      mapped.add(path);
                      return { ...output, path: value.path };
                    })
                    .sort((left, right) => compare(left.path, right.path));
                  const sourceEntries: CertificationPackageEntry[] = pkg.source_entries.map(
                    (path) => {
                      const locator = source.locators.get(`${prefix}${path}`);
                      if (locator === undefined)
                        throw new Error('release-prepare-git-locator-invalid');
                      return {
                        path,
                        mode: locator.mode,
                        sha256: locator.content_digest_sha256,
                        size_bytes: locator.size_bytes,
                        immutable_blob_locator: locator,
                      };
                    },
                  );
                  return {
                    unitIndex,
                    pkgIndex,
                    package_id: pkg.package_id,
                    version: unit.version,
                    sourceEntries,
                    generated,
                    binding: {
                      repository: request.repository_locator,
                      candidate: {
                        commit: request.candidate_locator.commit,
                        tree: request.candidate_locator.tree,
                      },
                      task_policy_digest_sha256: run.report.plan.taskPolicyDigest,
                      package_id: pkg.package_id,
                    },
                  };
                });
                if (
                  [...run.outputs.keys()].some(
                    (path) =>
                      !mapped.has(path) &&
                      !executionOnly.has(path) &&
                      !run.namespaces.some(
                        (namespace) =>
                          namespace.execution_only && path.startsWith(`${namespace.prefix}/`),
                      ),
                  )
                )
                  throw new Error('release-certification-output-closure-invalid');
                return packages;
              });
              const first = runs[0];
              if (first === undefined)
                throw new Error('release-certification-plan-binding-invalid');
              const sinkHost = createProtectedReleaseHostAdapter(first.binding);
              const transaction = await sinkHost.invokeSink(
                () => call.evidence_sink.begin(prepared.map((pkg) => pkg.binding)),
                call.evidence_sink.authority_owner,
              );
              let committing = false;
              let closures: readonly CertificationOutputClosure[];
              const drafts: Parameters<CertificationEvidenceTransaction['commit']>[0][number][] =
                [];
              try {
                for (const pkg of prepared) {
                  const outputs = [];
                  for (const output of pkg.generated) {
                    const handle = await sinkHost.invokeSink(
                      () =>
                        transaction.put({
                          bytes: Buffer.from(output.bytes),
                          sha256: digest(output.bytes),
                          size_bytes: output.bytes.length,
                        }),
                      call.evidence_sink.authority_owner,
                    );
                    if (
                      handle.sha256 !== digest(output.bytes) ||
                      handle.size_bytes !== output.bytes.length ||
                      handle.evidence_sink_id !== transaction.evidence_sink_id
                    )
                      throw new Error('release-certification-output-closure-invalid');
                    outputs.push({
                      path: output.path,
                      mode: output.mode,
                      output_blob_handle: handle,
                    });
                  }
                  drafts.push({ ...pkg.binding, outputs });
                }
                committing = true;
                closures = await sinkHost.invokeSink(
                  () => transaction.commit(drafts),
                  call.evidence_sink.authority_owner,
                );
                if (
                  canonicalJson(
                    closures.map((closure) => ({
                      ...closure,
                      outputs: closure.outputs.map(
                        ({ certification_evidence_receipt: _receipt, ...output }) => output,
                      ),
                    })),
                  ) !== canonicalJson(drafts)
                )
                  throw new Error('release-certification-output-closure-invalid');
              } catch (error) {
                if (!committing)
                  await sinkHost.invokeSink(
                    () => transaction.abort(),
                    call.evidence_sink.authority_owner,
                  );
                throw error;
              }
              const result = material(
                request,
                runs.map((run) => run.report),
                source.locators,
              );
              const release_units = result.release_units.map((unit, unitIndex) => ({
                ...unit,
                packages: unit.packages.map((pkg, pkgIndex) => {
                  const draft = prepared.find(
                    (entry) => entry.unitIndex === unitIndex && entry.pkgIndex === pkgIndex,
                  );
                  const closure = closures.find(
                    ({ outputs: _outputs, ...binding }) =>
                      draft !== undefined &&
                      canonicalJson(binding) === canonicalJson(draft.binding),
                  );
                  if (draft === undefined || closure === undefined)
                    throw new Error('release-certification-output-closure-invalid');
                  const generated: CertificationPackageEntry[] = closure.outputs.map((output) => ({
                    path: output.path,
                    mode: output.mode,
                    sha256: output.output_blob_handle.sha256,
                    size_bytes: output.output_blob_handle.size_bytes,
                    immutable_blob_locator: {
                      kind: 'generated-output',
                      output_blob_sha256: output.output_blob_handle.sha256,
                      output_blob_handle: output.output_blob_handle,
                      certification_evidence_receipt: output.certification_evidence_receipt,
                    },
                  }));
                  return {
                    ...pkg,
                    certification_manifest: finalizeCertificationManifest({
                      candidate: draft.binding.candidate,
                      task_policy_digest_sha256: draft.binding.task_policy_digest_sha256,
                      package_id: draft.package_id,
                      package_version: draft.version,
                      entry_order: 'ascending-utf-8-byte-collation-by-path;duplicates-refuse',
                      manifest_digest_contract: {
                        domain: 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\0',
                        payload:
                          'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes',
                        canonicalization: 'rfc8785-jcs',
                        algorithm: 'sha256',
                      },
                      entries: [...draft.sourceEntries, ...generated].sort((left, right) =>
                        compare(left.path, right.path),
                      ),
                    }),
                  };
                }),
              }));
              return { outcome: 'success', material: { ...result, release_units } };
            } finally {
              active = false;
            }
          },
        },
      };
    },
  };
}
