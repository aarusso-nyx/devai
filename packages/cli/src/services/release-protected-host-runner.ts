import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import {
  createProtectedReleaseRepositoryContext,
  withProtectedReleaseRepositoryContext,
} from '@devai-nyx/authority';
import {
  assertCliInvocationIdle,
  invokeDevaiCli,
  type CliInvocationResult,
} from '../cli-runtime.js';
import { installReleaseLifecycleCommandAdapters } from '../commands/release/lifecycle.js';
import { assertBoundReleaseHostPackageSnapshot } from './release-host-package-binding.js';
import {
  isVerifiedReleaseCandidateSnapshot,
  type ReleaseCandidateSnapshot,
} from './release-candidate-snapshot.js';
import type { ReleasePackageSnapshot } from './release-package-snapshot.js';
import {
  createResolvedReleasePlanInputResolver,
  resolveReleasePolicySnapshot,
  type ReleasePolicyExpectedIdentity,
} from './release-policy-resolution.js';
import { createReleasePolicyClosure, type ReleasePolicyClosure } from './release-policy-closure.js';
import { encodeReleasePolicyClosure } from './release-policy-closure-transport.js';
import {
  createReleaseExportProvider,
  type ReleaseExportProviderOptions,
} from './release-export-provider.js';
import { buildResolvedReleasePlanReceipt } from './release-lifecycle.js';
import { canonicalContainerPath } from './container-archive.js';
import {
  createContainerReleaseCertificationAdapters,
  createContainerReleasePreflightProvider,
  type ContainerReleaseCertificationOptions,
  type ProtectedReleasePlanMaterial,
} from './release-certification-provider.js';
import {
  buildReleaseMutationInputPlanV21,
  type ReleaseMutationInputControlsV21,
  type ReleaseMutationInputPlanV21,
} from './release-mutation-inputs.js';
import {
  createReleaseCertificationEvidenceStore,
  type ReleaseCertificationEvidenceStoreOptions,
} from './release-evidence-store.js';
import {
  createReleaseArtifactStore,
  type ReleaseArtifactStoreOptions,
} from './release-artifact-store.js';
import {
  RELEASE_PACK_SPEC_DIGEST,
  type ImmutableReleaseContentSource,
} from './release-prepare-kernel.js';
import {
  validateReleaseLifecycleRequest,
  type PublicationSignatureVerifier,
  type ReleaseLifecycleRequest,
} from './release-lifecycle-execution.js';

/** A locator and raw-byte identity approved by the operator before it is read. */
export interface ProtectedReleaseInputFile {
  readonly path: string;
  readonly sha256: string;
}

export interface ProtectedReleaseHostLaneControls {
  readonly candidate: ReleaseCandidateSnapshot;
  readonly expected: ReleasePolicyExpectedIdentity;
  readonly repository_root: string;
  readonly repository_identity: {
    readonly authority_repository_id: string;
    readonly read_expected_release_repository_id: () => string;
  };
  /** Must be the registered .devai/state/release-lifecycle namespace or a descendant. */
  readonly state_root: string;
  readonly maximum_input_bytes: number;
  readonly unit: {
    readonly intent: unknown;
    readonly packages: readonly {
      readonly manifest_path: string;
      readonly source_entries: readonly string[];
      readonly generated_entries: readonly { readonly path: string; readonly task_node: string }[];
    }[];
    /** Genuine prior protected result for a restarted certification process; independently reverified. */
    readonly preflight_receipt?: unknown;
  };
  readonly execution: Pick<
    ContainerReleaseCertificationOptions,
    'controls' | 'dependencies' | 'environment' | 'toolchain' | 'timeout_ms'
  >;
}

export interface ProtectedReleaseHostRunnerControls extends ProtectedReleaseHostLaneControls {
  /** Use the exact object returned by bootstrapReleaseHost, never a source-mode snapshot. */
  readonly installed_package: ReleasePackageSnapshot;
  readonly producer?: Parameters<typeof resolveReleasePolicySnapshot>[0]['producer'];
  /** A fixed diagnostic preflight lane, prebound in this same process. No store or signer. */
  readonly toolchain_fixture?: ProtectedReleaseHostLaneControls;
  readonly mutation_inputs?: Pick<
    ReleaseMutationInputControlsV21,
    'execution_coverage' | 'maximum_source_bytes' | 'maximum_source_entries'
  >;
  readonly certification_store: ReleaseCertificationEvidenceStoreOptions;
  readonly artifact_store: Omit<ReleaseArtifactStoreOptions, 'binding'>;
  readonly publication_signature_verifier: PublicationSignatureVerifier;
  /** Protected host choices only; absent stages have no ambient fallback. */
  readonly later_stages: {
    readonly export: 'unavailable' | ProtectedReleaseHostExportControls;
    readonly offline_verify: 'unavailable';
  };
}

export type ProtectedReleaseHostExportControls = Pick<
  ReleaseExportProviderOptions,
  'provider' | 'destination' | 'trust' | 'signer'
> &
  Pick<
    ReleaseExportProviderOptions['store'],
    'closure_limits' | 'transport_limits' | 'transcript_limits'
  >;

interface InvocationAuthority {
  /** No role is inferred by this runner; the normal CLI checks this explicit declaration. */
  readonly as_role: 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
  readonly write: boolean;
}

export type ProtectedReleaseHostInvocation =
  | { readonly action: 'release plan'; readonly intent: ProtectedReleaseInputFile }
  | (InvocationAuthority & {
      readonly action:
        'release preflight' | 'release certify' | 'release prepare' | 'release export';
      readonly request: ProtectedReleaseInputFile;
    })
  | {
      readonly action: 'release resume';
      readonly request: ProtectedReleaseInputFile;
      readonly receipts: ProtectedReleaseInputFile;
      readonly publication_receipt?: ProtectedReleaseInputFile;
    };

export interface ProtectedReleaseHostRunner {
  /** Copies, not live provider state. These methods do not persist receipts or advance the lifecycle. */
  readonly readPlan: () => Readonly<Record<string, unknown>>;
  readonly readPolicyClosure: () => ReleasePolicyClosure;
  readonly readFixturePlan: () => Readonly<Record<string, unknown>>;
  /** Serial diagnostic projection only, not a derived-plan brand or execution grant. */
  readonly readMutationInputPlan: () => Omit<ReleaseMutationInputPlanV21, 'readProof'>;
  readonly invoke: (input: ProtectedReleaseHostInvocation) => Promise<CliInvocationResult>;
}

const INVALID = 'release-host-controls-invalid';
const INPUT_INVALID = 'release-host-input-mismatch';
let installed = false;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function fail(code = INVALID): never {
  throw new Error(code);
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function copy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
function closed(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const keys = Reflect.ownKeys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== 'string' || ![...required, ...optional].includes(key))
  )
    fail();
}
function path(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) fail();
  return resolve(value);
}
function regularInput(input: ProtectedReleaseInputFile, maximum: number): unknown {
  try {
    closed(input, ['path', 'sha256']);
    const filename = path(input.path);
    if (!/^[a-f0-9]{64}$/u.test(input.sha256)) fail();
    const before = lstatSync(filename, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) fail();
    const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const equal = (stat: typeof before) =>
      ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(
        (key) => stat[key as keyof typeof stat] === before[key as keyof typeof before],
      );
    try {
      if (!equal(fstatSync(descriptor, { bigint: true }))) fail();
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (count === 0) fail();
        offset += count;
      }
      if (
        readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0 ||
        !equal(fstatSync(descriptor, { bigint: true })) ||
        !equal(lstatSync(filename, { bigint: true })) ||
        hash(bytes) !== input.sha256
      )
        fail();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return fail(INPUT_INVALID);
  }
}

/** Capture one immutable lane without installing adapters or constructing stores. */
function captureReleaseHostLane(
  input: ProtectedReleaseHostLaneControls & {
    readonly installed_package: ReleasePackageSnapshot;
    readonly producer?: ProtectedReleaseHostRunnerControls['producer'];
  },
) {
  if (!isVerifiedReleaseCandidateSnapshot(input.candidate)) fail();
  if (
    !Number.isSafeInteger(input.maximum_input_bytes) ||
    input.maximum_input_bytes < 1 ||
    input.maximum_input_bytes > 0x7fffffff
  )
    fail();
  closed(input.unit, ['intent', 'packages'], ['preflight_receipt']);
  closed(input.execution, ['controls', 'environment', 'toolchain', 'timeout_ms'], ['dependencies']);
  const root = realpathSync(path(input.repository_root));
  const stateRoot = path(input.state_root);
  const stateNamespace = resolve(root, '.devai/state/release-lifecycle');
  if (stateRoot !== stateNamespace && !stateRoot.startsWith(`${stateNamespace}${sep}`)) fail();
  const execution: ProtectedReleaseHostLaneControls['execution'] = {
    ...copy({
      controls: input.execution.controls,
      environment: input.execution.environment,
      toolchain: input.execution.toolchain,
      timeout_ms: input.execution.timeout_ms,
    }),
    ...(input.execution.dependencies === undefined
      ? {}
      : {
          dependencies: input.execution.dependencies.map(({ archive, ...dependency }) => ({
            ...copy(dependency),
            archive: Buffer.from(archive),
          })),
        }),
  };
  const candidate = input.candidate;
  const repository = copy(candidate.repository);
  closed(input.repository_identity, [
    'authority_repository_id',
    'read_expected_release_repository_id',
  ]);
  const repositoryContext = createProtectedReleaseRepositoryContext({
    repository_root: root,
    authority_repository_id: input.repository_identity.authority_repository_id,
    read_expected_release_repository_id:
      input.repository_identity.read_expected_release_repository_id,
    repository,
  });
  const unit = copy(input.unit);
  const expected = copy(input.expected);
  const resolution = resolveReleasePolicySnapshot({
    expected,
    installed_package: input.installed_package,
    candidate,
    ...(input.producer === undefined ? {} : { producer: input.producer }),
  });
  const receipt = buildResolvedReleasePlanReceipt({ intent: unit.intent, resolution });
  if (receipt.verdict !== 'pass' || !Array.isArray(unit.packages) || unit.packages.length === 0)
    fail();
  const packages = unit.packages
    .map((pkg) => {
      closed(pkg, ['manifest_path', 'source_entries', 'generated_entries']);
      if (
        !canonicalContainerPath(pkg.manifest_path) ||
        pkg.manifest_path.split('/').at(-1) !== 'package.json' ||
        !Array.isArray(pkg.source_entries) ||
        !Array.isArray(pkg.generated_entries) ||
        !pkg.source_entries.includes('package.json')
      )
        fail();
      const selectedPaths = [...pkg.source_entries];
      for (const output of pkg.generated_entries) {
        closed(output, ['path', 'task_node']);
        if (
          typeof output.task_node !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/u.test(output.task_node)
        )
          fail();
        selectedPaths.push(output.path);
      }
      if (
        selectedPaths.some((entry) => !canonicalContainerPath(entry)) ||
        new Set(selectedPaths).size !== selectedPaths.length
      )
        fail();
      const prefix = pkg.manifest_path.slice(0, -'package.json'.length);
      for (const entry of pkg.source_entries) candidate.read(`${prefix}${entry}`);
      const raw = candidate.read(pkg.manifest_path);
      const manifest = JSON.parse(raw.toString('utf8')) as { name?: unknown; version?: unknown };
      if (
        typeof manifest.name !== 'string' ||
        manifest.version !== receipt.candidate.version ||
        !pkg.source_entries.includes('package.json')
      )
        fail();
      return {
        mapping: {
          package_id: manifest.name,
          source_entries: pkg.source_entries,
          generated_entries: pkg.generated_entries,
        },
        roster: {
          package_id: manifest.name,
          manifest_path: pkg.manifest_path,
          manifest_digest_sha256: hash(raw),
        },
      };
    })
    .sort((a, b) =>
      Buffer.compare(Buffer.from(a.roster.package_id), Buffer.from(b.roster.package_id)),
    );
  if (
    new Set(packages.map((pkg) => pkg.roster.package_id)).size !== packages.length ||
    new Set(packages.map((pkg) => pkg.roster.manifest_path)).size !== packages.length
  )
    fail();
  const candidateLocator = {
    commit: repository.commit,
    tree: repository.tree,
    release_units: [
      {
        release_unit: receipt.candidate.release_unit,
        version: receipt.candidate.version,
        package_roster: packages.map((pkg) => pkg.roster),
      },
    ],
  };
  // Copy the complete verified population once; no later Git or pathname reads in
  // content resolution. The existing provider still rechecks its exact checkout.
  const objects = candidate.readProof(candidate.paths);
  const format = repository.commit.length === 40 ? 'sha1' : 'sha256';
  const assertRepository = (value: unknown) => {
    if (!same(value, repository)) fail(INPUT_INVALID);
  };
  const git: Pick<ImmutableReleaseContentSource, 'readGitObject' | 'readGitBlob'> = {
    readGitObject(value) {
      assertRepository(value.repository);
      const object = objects.get(value.object_id);
      if (value.object_format !== format || object?.type !== value.type) return fail(INPUT_INVALID);
      return Buffer.from(object.bytes);
    },
    readGitBlob(value) {
      assertRepository(value.repository);
      const locator = value.locator;
      const object = objects.get(value.object_id);
      if (
        value.candidate.commit !== repository.commit ||
        value.candidate.tree !== repository.tree ||
        locator.repository !== repository.id ||
        locator.commit !== repository.commit ||
        locator.tree !== repository.tree ||
        locator.object_format !== format ||
        locator.object_id !== value.object_id ||
        object?.type !== 'blob'
      )
        return fail(INPUT_INVALID);
      const bytes = candidate.read(locator.path);
      if (
        !bytes.equals(Buffer.from(object.bytes)) ||
        bytes.length !== locator.size_bytes ||
        hash(bytes) !== locator.content_digest_sha256
      )
        return fail(INPUT_INVALID);
      return bytes;
    },
  };
  const material: ProtectedReleasePlanMaterial = {
    receipt,
    resolution,
    intent_path: 'invocation',
    intent: unit.intent,
    release_verification_profile: resolution.readInput('release-verification-profile'),
    release_lifecycle_policy: resolution.readInput('release-lifecycle-policy'),
    action_registry: resolution.readInput('action-registry-policy'),
    packages: packages.map((pkg) => pkg.mapping),
    ...(unit.preflight_receipt === undefined ? {} : { preflight_receipt: unit.preflight_receipt }),
  };
  return {
    root,
    stateRoot,
    candidate,
    expected,
    repository,
    repositoryContext,
    unit,
    resolution,
    receipt,
    candidateLocator,
    git,
    material,
    execution,
    maximum: input.maximum_input_bytes,
  };
}

/**
 * Package-owned host composition, called once on the approved bootstrap runtime.
 * Controls and producer approval belong to the operator, never candidate code.
 * A campaign binds one production release unit and optionally its fixed diagnostic
 * preflight lane up front. Only production receives durable-store adapters; no
 * provider, compatibility brand or derived mutation plan escapes this runner.
 *
 * Existing CLI actions run sequentially against digest-pinned inputs and exact
 * prebound lane identities. No retry, next-action dispatch, adapter disposal,
 * cwd change or authority inference occurs. Export requires explicit protected controls;
 * offline verification and remote publication remain unavailable. Input revalidation detects races but
 * is not native openat containment or protection against ABA.
 */
export function createProtectedReleaseHostRunner(
  input: ProtectedReleaseHostRunnerControls,
): ProtectedReleaseHostRunner {
  assertCliInvocationIdle();
  if (installed) fail('release-host-runner-already-installed');
  const laneFields = [
    'candidate',
    'expected',
    'repository_root',
    'state_root',
    'maximum_input_bytes',
    'unit',
    'execution',
    'repository_identity',
  ];
  closed(
    input,
    [
      ...laneFields,
      'installed_package',
      'certification_store',
      'artifact_store',
      'publication_signature_verifier',
      'later_stages',
    ],
    ['producer', 'toolchain_fixture', 'mutation_inputs'],
  );
  assertBoundReleaseHostPackageSnapshot(input.installed_package);
  closed(input.later_stages, ['export', 'offline_verify']);
  if (
    input.later_stages.offline_verify !== 'unavailable' ||
    typeof input.publication_signature_verifier !== 'function'
  )
    fail();
  const exportControls = input.later_stages.export;
  if (exportControls !== 'unavailable') {
    closed(exportControls, [
      'provider',
      'destination',
      'trust',
      'signer',
      'closure_limits',
      'transport_limits',
      'transcript_limits',
    ]);
    closed(exportControls.signer, ['sign', 'verify']);
    if (
      typeof exportControls.signer.sign !== 'function' ||
      typeof exportControls.signer.verify !== 'function'
    )
      fail();
  }
  const cwd = process.cwd();
  const production = captureReleaseHostLane(input);
  const { root, repository, resolution, receipt, git, material } = production;
  let fixture: ReturnType<typeof captureReleaseHostLane> | undefined;
  if (Object.hasOwn(input, 'toolchain_fixture')) {
    closed(input.toolchain_fixture, laneFields);
    if (input.toolchain_fixture === undefined) return fail();
    fixture = captureReleaseHostLane({
      ...input.toolchain_fixture,
      installed_package: input.installed_package,
    });
    if (
      fixture.repository.id === repository.id ||
      fixture.root === root ||
      fixture.root.startsWith(`${root}${sep}`) ||
      root.startsWith(`${fixture.root}${sep}`) ||
      !same(fixture.execution.controls, production.execution.controls) ||
      !same(fixture.execution.environment, production.execution.environment) ||
      !same(fixture.execution.toolchain, production.execution.toolchain) ||
      Object.hasOwn(fixture.unit, 'preflight_receipt') ||
      Object.hasOwn(input.toolchain_fixture.unit, 'preflight_receipt')
    )
      fail();
  }
  const mutationInputs =
    input.mutation_inputs === undefined ? undefined : copy(input.mutation_inputs);
  if (Object.hasOwn(input, 'mutation_inputs')) {
    closed(mutationInputs, [
      'execution_coverage',
      'maximum_source_bytes',
      'maximum_source_entries',
    ]);
    if (fixture === undefined) fail();
  }
  const fixtureProvider =
    fixture === undefined
      ? undefined
      : createContainerReleasePreflightProvider({
          ...fixture.execution,
          repository_root: fixture.root,
          repository_id: fixture.repository.id,
          plans: [fixture.material],
          content_source: fixture.git,
          diagnostic_outputs: [
            {
              task_node: 'diagnostic:mutation-toolchain',
              paths: [
                'packages/fixture/reports/mutation/compatibility.json',
                'packages/fixture/reports/mutation/raw.json',
              ],
            },
          ],
          toolchain_fixture: {
            candidate: fixture.candidate,
            installed_package: input.installed_package,
            production_resolution: resolution,
          },
        });
  const verifySignature = input.publication_signature_verifier;
  const certificationOptions = copy(input.certification_store);
  const artifactOptions = copy(input.artifact_store);
  // repository_roots is the store's exclusion census, not a write allowlist.
  // Both candidates must be excluded so a production store cannot sit inside the fixture.
  if (
    !certificationOptions.repository_roots.includes(root) ||
    !artifactOptions.repository_roots.includes(root) ||
    (fixture !== undefined &&
      (!certificationOptions.repository_roots.includes(fixture.root) ||
        !artifactOptions.repository_roots.includes(fixture.root))) ||
    resolve(certificationOptions.root) === resolve(artifactOptions.root)
  )
    fail();
  const evidence = createReleaseCertificationEvidenceStore(certificationOptions);
  const artifacts = createReleaseArtifactStore({
    ...artifactOptions,
    binding: {
      action_id: 'release prepare',
      repository,
      plan_receipt_digest_sha256: receipt.receipt_digest_sha256,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      sink_id: artifactOptions.sink_id,
    },
  });
  const certification = createContainerReleaseCertificationAdapters({
    ...production.execution,
    repository_root: root,
    repository_id: repository.id,
    plans: [material],
    content_source: git,
    evidence_sink: evidence,
  });
  const content: ImmutableReleaseContentSource = {
    ...git,
    unit_mutation_maximum_bytes: evidence.unit_mutation_maximum_bytes,
    readUnitMutationEvidenceClosure: (value) => evidence.readUnitMutationEvidenceClosure(value),
    readUnitMutationEvidenceReceipt: (value) => evidence.readUnitMutationEvidenceReceipt(value),
    readUnitMutationEvidenceBlob: (value) => evidence.readUnitMutationEvidenceBlob(value),
    readCertificationEvidenceReceipt: (value) => evidence.readCertificationEvidenceReceipt(value),
    readCertificationOutputClosure: (value) => evidence.readCertificationOutputClosure(value),
    readGeneratedBlob: (value) => evidence.readGeneratedBlob(value),
  };
  const exportDelivery =
    exportControls === 'unavailable'
      ? undefined
      : createReleaseExportProvider({
          provider: exportControls.provider,
          destination: exportControls.destination,
          trust: exportControls.trust,
          signer: exportControls.signer,
          mutation_source: content,
          // Committed certification custody only: no task, checkout or cache is reachable.
          certification_source: {
            ...(evidence.certified_evidence_carrier_maximum_bytes === undefined
              ? {}
              : {
                  certified_evidence_carrier_maximum_bytes:
                    evidence.certified_evidence_carrier_maximum_bytes,
                }),
            ...(evidence.readCertifiedEvidenceCarrier === undefined
              ? {}
              : {
                  readCertifiedEvidenceCarrier: (value) =>
                    evidence.readCertifiedEvidenceCarrier?.(value) ??
                    fail('release-certification-evidence-carrier-unavailable'),
                }),
          },
          plan: {
            resolve_plan_input: createResolvedReleasePlanInputResolver(resolution),
            resolve_receipt: (locator) => {
              if (
                locator.kind !== 'release-plan-receipt' ||
                locator.receipt_id !== receipt.receipt_id ||
                locator.receipt_digest_sha256 !== receipt.receipt_digest_sha256
              )
                fail(INPUT_INVALID);
              return copy(receipt);
            },
          },
          store: {
            ...artifactOptions,
            implementation: input.installed_package,
            parent_reader: artifacts,
            closure_limits: exportControls.closure_limits,
            transport_limits: exportControls.transport_limits,
            transcript_limits: exportControls.transcript_limits,
            closures: production.candidateLocator.release_units.flatMap((unit) =>
              unit.package_roster.map((pkg) => ({
                package_id: pkg.package_id,
                expected: production.expected,
                bytes: encodeReleasePolicyClosure(
                  createReleasePolicyClosure({ plan: receipt, resolution }),
                  exportControls.transport_limits,
                ),
              })),
            ),
          },
        });
  const exportLimits =
    exportControls === 'unavailable' ? undefined : copy(exportControls.transcript_limits);
  let pinnedRequest: ReleaseLifecycleRequest | undefined;
  let activeLane = production;
  let fixtureSucceeded = false;
  const assertRequest = (request: ReleaseLifecycleRequest) => {
    if (pinnedRequest !== undefined && !same(request, pinnedRequest)) fail(INPUT_INVALID);
    if (
      !same(request.repository_locator, activeLane.repository) ||
      !same(request.candidate_locator, activeLane.candidateLocator) ||
      (activeLane === fixture && request.action_id !== 'release preflight')
    )
      fail(INPUT_INVALID);
    // Resume forbids receipt locators in its request; its separately pinned
    // receipt-document array below must contain this exact plan instead.
    if (request.action_id === 'release resume') return;
    const plans =
      request.receipt_locators?.filter((value) => value.kind === 'release-plan-receipt') ?? [];
    if (
      plans.length !== 1 ||
      plans[0]?.receipt_id !== activeLane.receipt.receipt_id ||
      plans[0].receipt_digest_sha256 !== activeLane.receipt.receipt_digest_sha256
    )
      fail(INPUT_INVALID);
  };
  let active = false;
  const requireActive = () => {
    if (
      !active ||
      process.cwd() !== cwd ||
      realpathSync(root) !== root ||
      (fixture !== undefined && realpathSync(fixture.root) !== fixture.root)
    )
      fail('release-host-invocation-unbound');
  };
  const requireProduction = (request: ReleaseLifecycleRequest) => {
    requireActive();
    if (activeLane !== production) fail('release-host-stage-unavailable');
    assertRequest(request);
  };
  const mutationPlan = () => {
    if (mutationInputs === undefined)
      return fail('release-host-mutation-input-controls-unavailable');
    return buildReleaseMutationInputPlanV21({
      candidate: production.candidate,
      resolution,
      plan_receipt: receipt,
      controls: {
        ...mutationInputs,
        container: production.execution.controls,
        dependencies: production.execution.dependencies ?? [],
        environment: production.execution.environment,
        toolchain: production.execution.toolchain,
        ...(fixtureSucceeded && fixtureProvider !== undefined
          ? { fixture_provider: fixtureProvider }
          : {}),
      },
    });
  };
  // Reject stale coverage receipts or invalid production inputs before a diagnostic can run.
  if (mutationInputs !== undefined) mutationPlan();
  // Deliberately retain no disposer. One host process owns one immutable binding.
  installed = true;
  installReleaseLifecycleCommandAdapters({
    policy_resolution(value) {
      requireActive();
      if (
        value.repository_id !== activeLane.repository.id ||
        !same(value.candidate, {
          commit: activeLane.repository.commit,
          tree: activeLane.repository.tree,
        }) ||
        value.release_unit !== activeLane.resolution.release_unit
      )
        fail(INPUT_INVALID);
      return activeLane.resolution;
    },
    preflight_provider(request) {
      requireActive();
      assertRequest(request);
      return activeLane === fixture
        ? (fixtureProvider ?? fail())
        : certification.preflight_provider;
    },
    certification_provider(request) {
      requireProduction(request);
      return certification.certification_provider(request);
    },
    prepare_content_source(request) {
      requireProduction(request);
      return content;
    },
    artifact_sink(request) {
      requireProduction(request);
      return artifacts;
    },
    artifact_reader(request) {
      requireProduction(request);
      return exportDelivery?.reader ?? artifacts;
    },
    export_limits(request) {
      requireProduction(request);
      return exportLimits === undefined ? undefined : copy(exportLimits);
    },
    publication_signature_verifier(request) {
      requireProduction(request);
      return verifySignature;
    },
    provider(action, request) {
      requireProduction(request);
      return action === 'release export' ? exportDelivery?.provider : undefined;
    },
    offline_verification_provider: () => undefined,
    authorization: () => undefined,
    offline_receipt_verifier: () => undefined,
    publication_controls: () => undefined,
  });
  return Object.freeze({
    readPlan: () => copy(receipt),
    readPolicyClosure: () => createReleasePolicyClosure({ plan: receipt, resolution }),
    readFixturePlan: () =>
      fixture === undefined ? fail('release-host-fixture-unavailable') : copy(fixture.receipt),
    readMutationInputPlan: () => {
      assertCliInvocationIdle();
      if (active) fail('release-host-invocation-in-progress');
      const { readProof, ...document } = mutationPlan();
      void readProof;
      return copy(document);
    },
    async invoke(value: ProtectedReleaseHostInvocation) {
      assertCliInvocationIdle();
      if (active) fail('release-host-invocation-in-progress');
      if (
        process.cwd() !== cwd ||
        realpathSync(root) !== root ||
        (fixture !== undefined && realpathSync(fixture.root) !== fixture.root)
      )
        fail('release-host-working-directory-changed');
      active = true;
      try {
        const action = value.action;
        if (
          ![
            'release plan',
            'release preflight',
            'release certify',
            'release prepare',
            ...(exportDelivery === undefined ? [] : ['release export']),
            'release resume',
          ].includes(action)
        )
          fail('release-host-stage-unavailable');
        closed(
          value,
          [
            'action',
            ...(['release plan', 'release resume'].includes(action) ? [] : ['as_role', 'write']),
            ...(action === 'release plan' ? ['intent'] : ['request']),
            ...(action === 'release resume' ? ['receipts'] : []),
          ],
          action === 'release resume' ? ['publication_receipt'] : [],
        );
        const invocation = copy(value);
        if (
          'as_role' in invocation &&
          (!['owner', 'architect', 'inspector', 'engineer', 'auditor'].includes(
            invocation.as_role,
          ) ||
            typeof invocation.write !== 'boolean')
        )
          fail();
        let request: ReleaseLifecycleRequest | undefined;
        if (invocation.action !== 'release plan') {
          request = validateReleaseLifecycleRequest(
            regularInput(invocation.request, Math.max(production.maximum, fixture?.maximum ?? 0)),
            invocation.action,
          );
          activeLane = same(request.repository_locator, production.repository)
            ? production
            : fixture !== undefined && same(request.repository_locator, fixture.repository)
              ? fixture
              : fail(INPUT_INVALID);
          // Reapply the selected lane's input bound; the approved digest must still match.
          regularInput(invocation.request, activeLane.maximum);
          if (activeLane === fixture) fixtureSucceeded = false;
          assertRequest(request);
          pinnedRequest = copy(request);
        }
        const args = [
          ...action.split(' '),
          '--repo-root',
          activeLane.root,
          ...('as_role' in invocation
            ? ['--as-role', invocation.as_role, ...(invocation.write ? ['--write'] : [])]
            : []),
        ];
        if (invocation.action === 'release plan') {
          if (!same(regularInput(invocation.intent, production.maximum), production.unit.intent))
            fail(INPUT_INVALID);
          args.push('--intent', invocation.intent.path, '--repository', repository.id);
        } else {
          args.push('--request', invocation.request.path, '--state-root', activeLane.stateRoot);
          if (invocation.action === 'release resume') {
            const receipts = regularInput(invocation.receipts, production.maximum);
            if (!Array.isArray(receipts) || !receipts.some((value) => same(value, receipt)))
              fail(INPUT_INVALID);
            args.push('--receipts', invocation.receipts.path);
            if (invocation.publication_receipt !== undefined) {
              regularInput(invocation.publication_receipt, production.maximum);
              args.push('--publication-receipt', invocation.publication_receipt.path);
            }
          }
        }
        const result = await (action === 'release plan' || action === 'release resume'
          ? invokeDevaiCli(args)
          : withProtectedReleaseRepositoryContext(activeLane.repositoryContext, () =>
              invokeDevaiCli(args),
            ));
        if (activeLane === fixture && result.exit_code === 0) {
          fixtureSucceeded = true;
          // A CLI exit code is not compatibility evidence: the planner checks the private brand.
          if (mutationInputs !== undefined) {
            try {
              mutationPlan();
            } catch (error) {
              fixtureSucceeded = false;
              throw error;
            }
          }
        }
        return result;
      } finally {
        pinnedRequest = undefined;
        activeLane = production;
        active = false;
      }
    },
  });
}
