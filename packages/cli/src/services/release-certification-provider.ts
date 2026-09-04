import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProtectedReleaseHostAdapter, readExactGitTreeSync } from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { parseTaskDescriptor } from './check-runner/policy.js';
import {
  PROTECTED_MUTATION_PRODUCER,
  readProtectedCompletedTaskResults,
  runCheckTasks,
  runCheckTasksAsync,
} from './check-runner/runner.js';
import {
  createCertifiedEvidenceCarrier,
  finalizeCertifiedEvidenceNamespaceCensus,
} from './release-certified-evidence-carrier.js';
import { produceUnitMutationEvidenceV21 } from './release-mutation-driver.js';
import type { ReleaseMutationArtifactLimitsV21 } from './release-mutation-artifacts.js';
import type { ReleaseMutationInputPlanV21 } from './release-mutation-inputs.js';
import type {
  ReleaseUnitMutationEvidenceClosure,
  UnitMutationEvidenceSink,
} from './release-unit-mutation-evidence.js';
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
import {
  attachProtectedToolchainFixtureCustody,
  assertProtectedToolchainFixtureCompatibility,
  bindProtectedToolchainFixtureContext,
  createProtectedToolchainFixtureContext,
  issueProtectedToolchainFixtureCompatibility,
  observeProtectedToolchainFixtureInputs,
  recordProtectedToolchainFixtureBinding,
  type ProtectedToolchainFixtureContext,
  type ProtectedToolchainFixtureCompatibility,
} from './release-toolchain-fixture-compatibility.js';
import type { ReleaseCandidateSnapshot } from './release-candidate-snapshot.js';
import type { ReleasePackageSnapshot } from './release-package-snapshot.js';
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
   * Protected semantic mutation production. The host owns the candidate snapshot,
   * verified resolution and measured bounds; this provider owns only the container
   * scope. Absent controls keep required mutation refusing rather than passing.
   */
  readonly mutation_driver?: {
    readonly package_snapshot: ReleasePackageSnapshot;
    readonly limits: ReleaseMutationArtifactLimitsV21;
    /** Derives the plan for this exact run's discharged prerequisite closure. */
    readonly buildInputPlan: (
      prerequisites: ProtectedMutationPrerequisiteClosure,
    ) => ReleaseMutationInputPlanV21;
  };
}

export interface ContainerReleaseCertificationAdapters {
  readonly preflight_provider: ReleaseProvider;
  readonly certification_provider: (
    request: ReleaseLifecycleRequest,
  ) => Parameters<typeof createReleaseCertificationProvider>[0];
}

type Json = Readonly<Record<string, unknown>>;
const protectedPreflightProviders = new WeakSet<ReleaseProvider>();
const fixtureProviderCompatibility = new WeakMap<
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

const mutationPrerequisites = new WeakMap<object, CapturedMutationPrerequisiteClosure>();
const pendingMutationPrerequisites = new WeakMap<
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

const fixtureDiagnosticCustodies = new WeakMap<
  ReleaseProvider,
  { readonly request_digest: string; readonly custody: ProtectedFixtureDiagnosticCustody }
>();
const verifiedFixtureDiagnosticCustodies = new WeakSet<object>();

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

interface CapturedDiagnosticRun {
  readonly binding: Json;
  readonly task_node: string;
  readonly process: ReturnType<
    ProtectedFixtureDiagnosticCustody['read']
  >['runs'][number]['process'];
  readonly outputs: readonly ContainerArchiveEntry[];
}

const RUNTIME_IDENTITY_KEYS = [
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
function outputPaths(plan: Pick<TaskPlan, 'tasks'>): Map<string, string> {
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
  return createContainerReleaseAdapters(input);
}

/** Private diagnostic lane: no evidence store is accepted and no certify surface escapes. */
export function createContainerReleasePreflightProvider(
  input: Omit<ContainerReleaseCertificationOptions, 'evidence_sink'>,
): ReleaseProvider {
  if ('evidence_sink' in input)
    throw new Error('release-certification-diagnostic-controls-invalid');
  return createContainerReleaseAdapters(input).preflight_provider;
}

function createContainerReleaseAdapters(
  input: Omit<ContainerReleaseCertificationOptions, 'evidence_sink'> & {
    readonly evidence_sink?: TrustedCertificationEvidenceSink;
  },
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
  const diagnosticOutputs = snapshot(
    input.diagnostic_outputs === undefined ? [] : input.diagnostic_outputs,
  );
  if (
    !Array.isArray(diagnosticOutputs) ||
    diagnosticOutputs.some(
      (entry, index) =>
        entry === null ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        Object.keys(entry).some((key) => key !== 'task_node' && key !== 'paths') ||
        typeof entry.task_node !== 'string' ||
        entry.task_node.length === 0 ||
        (index > 0 &&
          compare(diagnosticOutputs[index - 1]?.task_node ?? '', entry.task_node) >= 0) ||
        !Array.isArray(entry.paths) ||
        entry.paths.length === 0 ||
        entry.paths.some(
          (path: unknown, pathIndex: number) =>
            typeof path !== 'string' ||
            !canonicalContainerPath(path) ||
            (pathIndex > 0 && compare(entry.paths[pathIndex - 1] ?? '', path) >= 0),
        ),
    )
  )
    throw new Error('release-certification-diagnostic-controls-invalid');
  const validatedDiagnosticOutputs: NonNullable<
    ContainerReleaseCertificationOptions['diagnostic_outputs']
  > = diagnosticOutputs;
  const diagnosticsByTask = new Map(
    validatedDiagnosticOutputs.map((entry) => [entry.task_node, entry.paths]),
  );
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
  if (input.fixture_context !== undefined && input.toolchain_fixture !== undefined)
    throw new Error('release-toolchain-fixture-compatibility-invalid');
  const fixtureResolution = selected[0]?.plan.resolution;
  let fixtureContext = input.fixture_context;
  if (input.toolchain_fixture !== undefined) {
    if (selected.length !== 1 || fixtureResolution === undefined)
      throw new Error('release-toolchain-fixture-compatibility-invalid');
    fixtureContext = createProtectedToolchainFixtureContext({
      ...input.toolchain_fixture,
      fixture_resolution: fixtureResolution,
      controls,
      dependencies: input.dependencies ?? [],
      environment,
      toolchain,
    });
  }
  const fixtureIdentity =
    fixtureContext === undefined
      ? undefined
      : bindProtectedToolchainFixtureContext(fixtureContext, {
          container: container.identity,
          environment,
          toolchain,
          resolutions: selected.map(({ plan }) => plan.resolution),
          receipts: selected.map(({ receipt }) => ({
            receipt_id: receipt.receipt_id,
            receipt_digest_sha256: receipt.receipt_digest_sha256,
          })),
          diagnostic_outputs: diagnosticOutputs,
        });
  const bindingIdentity = {
    container: container.identity,
    candidate_git_metadata: 'verified-candidate-shallow-v1',
    toolchain,
    environment,
    ...(diagnosticOutputs.length === 0 ? {} : { diagnostic_outputs: diagnosticOutputs }),
    ...(fixtureIdentity === undefined ? {} : { fixture_input_identity: fixtureIdentity }),
    plans: selected.map(({ plan, receipt }) => ({
      receipt_id: receipt.receipt_id,
      receipt_digest_sha256: receipt.receipt_digest_sha256,
      packages: plan.packages,
    })),
  };
  const runtimeIdentity: Json = snapshot(
    Object.fromEntries(
      RUNTIME_IDENTITY_KEYS.filter((key) => Object.hasOwn(container.identity, key)).map((key) => [
        key,
        container.identity[key],
      ]),
    ),
  );
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

  async function execute(
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
    let taskIndex = 0;
    // A container authorization scope is synchronous. Never retain its private
    // host capability across an await between DAG tasks or evidence operations.
    container.runBound(binding, () => container.verifyRuntime());
    const executionOptions: CheckRunnerOptions = {
      ...options,
      operation: 'run',
      // Only a certify run with the protected producer installed may plan required
      // mutation. Preflight and any driverless certify keep the existing refusal.
      ...(request.action_id === 'release certify' && input.mutation_driver !== undefined
        ? { resolveProtectedMutationProducer: () => PROTECTED_MUTATION_PRODUCER }
        : {}),
      executeTask: (argv, cwd, timeout, taskEnvironment) => {
        if (
          fixtureContext !== undefined &&
          canonicalJson(taskEnvironment) !== canonicalJson(environment)
        )
          throw new Error('release-toolchain-fixture-compatibility-invalid');
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
    fixtureProviderCompatibility.delete(preflight_provider);
    preflightObservations.delete(preflight_provider);
    fixtureDiagnosticCustodies.delete(preflight_provider);
    const diagnosticRuns: CapturedDiagnosticRun[] = [];
    const retainDiagnostics = (outcome: 'success' | 'failure'): void => {
      if (diagnosticRuns.length === 0) return;
      const bytesByRun = diagnosticRuns.map(
        (run) =>
          new Map(run.outputs.map((output) => [output.path, Buffer.from(output.bytes)] as const)),
      );
      const captured: ReturnType<ProtectedFixtureDiagnosticCustody['read']> = snapshot({
        request,
        execution_identity: bindingIdentity,
        runtime_identity: runtimeIdentity,
        ...(fixtureIdentity === undefined ? {} : { fixture_input_identity: fixtureIdentity }),
        outcome,
        runs: diagnosticRuns.map((run) => ({
          binding: run.binding,
          task_node: run.task_node,
          process: run.process,
          output_census: run.outputs
            .map((output) => ({
              path: output.path,
              mode: output.mode,
              sha256: digest(output.bytes),
              size_bytes: output.bytes.length,
              task_node: run.task_node,
            }))
            .sort((a, b) => compare(a.path, b.path)),
        })),
      });
      const custody: ProtectedFixtureDiagnosticCustody = Object.freeze({
        read: () => snapshot(captured),
        readOutput: (member: {
          readonly run_index: number;
          readonly path: string;
          readonly sha256: string;
        }): Buffer => {
          if (
            member === null ||
            typeof member !== 'object' ||
            !Number.isSafeInteger(member.run_index) ||
            member.run_index < 0 ||
            typeof member.path !== 'string' ||
            !canonicalContainerPath(member.path)
          )
            throw new Error('release-certification-diagnostic-output-unavailable');
          const expected = captured.runs[member.run_index]?.output_census.find(
            (output) => output.path === member.path,
          );
          const bytes = bytesByRun[member.run_index]?.get(member.path);
          if (expected === undefined || expected.sha256 !== member.sha256 || bytes === undefined)
            throw new Error('release-certification-diagnostic-output-unavailable');
          return Buffer.from(bytes);
        },
      });
      verifiedFixtureDiagnosticCustodies.add(custody);
      if (fixtureContext !== undefined && outcome === 'success')
        attachProtectedToolchainFixtureCustody(fixtureContext, custody);
      fixtureDiagnosticCustodies.set(preflight_provider, {
        request_digest: canonicalSha256(request),
        custody,
      });
    };
    try {
      if (request.action_id !== 'release preflight')
        throw new Error('release-certification-plan-binding-invalid');
      const descriptor = bindRequest(request);
      const source = await sourcesFor(request);
      const options = selected.map((_entry, index) =>
        optionsFor(request, descriptor, index, 'preflight'),
      );
      if (diagnosticOutputs.length !== 0) {
        const tasks = options.flatMap((option) => runCheckTasks(option).plan.tasks);
        for (const diagnostic of validatedDiagnosticOutputs) {
          const matched = tasks.filter((task) => task.nodeId === diagnostic.task_node);
          if (
            matched.length === 0 ||
            matched.some((task) => {
              const paths = outputPaths({ tasks: [task] });
              return diagnostic.paths.some((path) => !paths.has(path));
            })
          )
            throw new Error('release-certification-diagnostic-controls-invalid');
        }
      }
      if (fixtureContext !== undefined)
        observeProtectedToolchainFixtureInputs(fixtureContext, {
          request,
          source: source.source,
          descriptor,
          tasks: options.flatMap((option) => runCheckTasks(option).plan.tasks),
        });
      const runs: Awaited<ReturnType<typeof execute>>[] = [];
      for (const option of options)
        runs.push(
          await execute(request, option, source.source, source.gitMetadata, diagnosticRuns),
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
      retainDiagnostics('success');
      if (input.toolchain_fixture !== undefined)
        fixtureProviderCompatibility.set(
          preflight_provider,
          issueProtectedToolchainFixtureCompatibility(
            takeProtectedFixtureDiagnosticCustody(preflight_provider, request),
          ),
        );
      return { outcome: 'success', material: stateMaterial };
    } catch (error) {
      fixtureProviderCompatibility.delete(preflight_provider);
      preflightObservations.delete(preflight_provider);
      try {
        retainDiagnostics('failure');
      } catch {
        // Invalid/consumed fixture context must not replace the original terminal
        // failure with a rejected promise or expose a partially attached custody.
        fixtureDiagnosticCustodies.delete(preflight_provider);
      }
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
  const adapters: ContainerReleaseCertificationAdapters = {
    preflight_provider,
    certification_provider(request) {
      pendingMutationPrerequisites.delete(adapters.certification_provider);
      if (input.evidence_sink === undefined)
        throw new Error('release-certification-evidence-sink-unavailable');
      const descriptor = bindRequest(request);
      // A task's PASS and hashed output paths are never semantic mutation evidence.
      // Required mutation is certifiable only through the protected producer below;
      // without its host controls this still refuses before any task, container or
      // sink effect rather than certifying ordinary Vitest nodes.
      if (
        input.mutation_driver === undefined &&
        selected.some((entry) => object(entry.receipt.determination).mutation !== 'none')
      )
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
              const runs: Awaited<ReturnType<typeof execute>>[] = [];
              for (const option of options)
                runs.push(await execute(request, option, source.source, source.gitMetadata));
              if (
                runs.some(
                  (run, index) =>
                    run.report.plan.taskPolicyDigest !== policies[index]?.taskPolicyDigest ||
                    canonicalJson(run.report.plan.taskPolicy) !==
                      canonicalJson(call.task_policies[index]?.document),
                )
              )
                throw new Error('release-task-policy-identity-mismatch');
              if (runs.every((run) => run.mutation_prerequisites !== undefined))
                pendingMutationPrerequisites.set(adapters.certification_provider, {
                  request_digest: canonicalSha256(request),
                  closures: runs.map((run) => {
                    if (run.mutation_prerequisites === undefined)
                      throw new Error('release-certification-prerequisite-proof-invalid');
                    return run.mutation_prerequisites;
                  }),
                });
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
              // Produce semantic mutation evidence before opening the certification
              // transaction: a failed or incomplete production must leave no committed
              // certification behind, and it is never replaced by a task exit code.
              const mutationClosures = new Map<number, ReleaseUnitMutationEvidenceClosure>();
              for (const [unitIndex, entry] of selected.entries()) {
                if (object(entry.receipt.determination).mutation === 'none') continue;
                const driver = input.mutation_driver;
                const run = runs[unitIndex];
                if (driver === undefined || run === undefined)
                  throw new Error('release-certification-mutation-evidence-unavailable');
                const prerequisites = run.mutation_prerequisites;
                if (prerequisites === undefined)
                  throw new Error('release-certification-prerequisite-proof-invalid');
                const authorityOwner = call.evidence_sink.authority_owner;
                const nodeExecutable = input.controls.executables.node;
                if (
                  authorityOwner === undefined ||
                  nodeExecutable === undefined ||
                  typeof call.evidence_sink.beginUnitMutationEvidence !== 'function'
                )
                  throw new Error('release-certification-mutation-evidence-unavailable');
                const unitSink = call.evidence_sink as unknown as UnitMutationEvidenceSink;
                const inputPlan = driver.buildInputPlan(prerequisites);
                mutationClosures.set(
                  unitIndex,
                  await produceUnitMutationEvidenceV21({
                    input_plan: inputPlan,
                    package_snapshot: driver.package_snapshot,
                    limits: driver.limits,
                    task_policy_digests_sha256: [run.report.plan.taskPolicyDigest],
                    evidence_sink: unitSink,
                    authority_owner: authorityOwner,
                    sink_host: sinkHost,
                    executable: nodeExecutable,
                    execute: (produced) => {
                      const prior = new Map<string, ContainerArchiveEntry>();
                      for (const member of produced.prerequisite_members) {
                        const output = run.outputs.get(member.path);
                        if (output === undefined)
                          throw new Error('release-certification-prerequisite-proof-invalid');
                        prior.set(member.path, output);
                      }
                      return container.runBound(run.binding, () =>
                        container.execute({
                          task: produced.task,
                          timeout_ms: input.timeout_ms,
                          environment,
                          source: source.source,
                          prior_outputs: prior,
                          declared_outputs: [],
                          mutation_program: produced.program,
                        }),
                      );
                    },
                  }),
                );
              }
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
                // Retain one complete carrier per release unit inside this same
                // transaction, from the live protected population, before commit.
                // Digest-only census: generated bytes and raw streams never enter it.
                const carrierMaximum = call.evidence_sink.certified_evidence_carrier_maximum_bytes;
                if (
                  typeof transaction.putCertifiedEvidenceCarrier !== 'function' ||
                  carrierMaximum === undefined ||
                  !Number.isSafeInteger(carrierMaximum) ||
                  carrierMaximum < 1
                )
                  throw new Error('release-certification-evidence-carrier-unavailable');
                for (const [unitIndex, run] of runs.entries()) {
                  const unit = request.candidate_locator.release_units[unitIndex];
                  const receipt = run.report.receipt?.value;
                  if (unit === undefined || receipt === undefined)
                    throw new Error('release-certification-evidence-carrier-unavailable');
                  const derivation = {
                    repository: request.repository_locator,
                    candidate: {
                      commit: request.candidate_locator.commit,
                      tree: request.candidate_locator.tree,
                    },
                    task_policy_digest_sha256: run.report.plan.taskPolicyDigest,
                  };
                  const census = finalizeCertifiedEvidenceNamespaceCensus({
                    release_unit: unit.release_unit,
                    derivation,
                    entries: [...run.outputs.values()].map((output) => {
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
                  });
                  const bytes = createCertifiedEvidenceCarrier({
                    release_unit: unit.release_unit,
                    derivation,
                    candidate_receipt: receipt,
                    task_policy: run.report.plan.taskPolicy,
                    task_results: readProtectedCompletedTaskResults(run.report),
                    namespace_census: census,
                    maximum_bytes: carrierMaximum,
                  });
                  const identity = await sinkHost.invokeSink(
                    () =>
                      transaction.putCertifiedEvidenceCarrier?.({
                        release_unit: unit.release_unit,
                        bytes,
                        sha256: digest(bytes),
                        size_bytes: bytes.length,
                      }),
                    call.evidence_sink.authority_owner,
                  );
                  if (
                    identity === undefined ||
                    identity.release_unit !== unit.release_unit ||
                    identity.sha256 !== digest(bytes) ||
                    identity.size_bytes !== bytes.length ||
                    identity.evidence_sink_id !== transaction.evidence_sink_id
                  )
                    throw new Error('release-certification-evidence-carrier-unavailable');
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
                // Present only where the plan actually required mutation; the kernel
                // refuses a closure on a not-required unit and a missing one otherwise.
                ...(mutationClosures.has(unitIndex)
                  ? { mutation_evidence: mutationClosures.get(unitIndex) }
                  : {}),
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
  return adapters;
}
