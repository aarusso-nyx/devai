import { createHash } from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  isVerifiedReleaseCandidateSnapshot,
  type ReleaseCandidateSnapshot,
} from './release-candidate-snapshot.js';
import {
  isVerifiedReleasePackageSnapshot,
  type ReleasePackageSnapshot,
} from './release-package-snapshot.js';
import {
  isVerifiedReleasePolicyResolution,
  type VerifiedReleasePolicyResolution,
} from './release-policy-resolution.js';
import {
  ProtectedCertificationContainer,
  protectedContainerTaskEnvironment,
  type ProtectedContainerControls,
  type ProtectedContainerDependency,
} from './release-certification-container.js';
import {
  validateProtectedDependencyTransport,
  verifyProtectedDependencyInputs,
} from './release-dependency-transport.js';
import { loadReleaseToolchainFixtureDefinition } from './release-toolchain-fixture-definition.js';
import {
  isVerifiedProtectedFixtureDiagnosticCustody,
  type ProtectedFixtureDiagnosticCustody,
} from './release-certification-provider.js';
import type { ContainerArchiveEntry } from './container-archive.js';
import type { TaskDescriptor, PlannedTask } from './check-runner/types.js';
import type { ReleaseLifecycleRequest } from './release-lifecycle-execution.js';

type Json = Readonly<Record<string, unknown>>;
const INVALID = 'release-toolchain-fixture-compatibility-invalid';
const NODE = 'diagnostic:mutation-toolchain';
const WORKSPACE = 'packages/fixture';
const RAW = `${WORKSPACE}/reports/mutation/raw.json`;
const COMPATIBILITY = `${WORKSPACE}/reports/mutation/compatibility.json`;
const OUTPUTS = [COMPATIBILITY, RAW];
const DYNAMIC_PATHS = [
  '.devai/config/adopter-policy-binding.json',
  '.devai/config/domains.json',
  '.devai/config/glob-guards.json',
  '.devai/config/project.json',
  '.devai/config/release-verification.json',
  '.devai/config/scorecard-na.json',
  '.devai/config/thresholds.json',
  '.devai/constitution.md',
  '.devai/pin/constitution.md',
  'host/devai.tgz',
  'pnpm-lock.yaml',
];
const VERSIONS = {
  node: 'v24.20.0',
  pnpm: '9.15.0',
  vitest: '4.1.10',
  typescript: '5.9.3',
};
const RUNTIME_KEYS = [
  'protocol',
  'image',
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
];

/** Opaque host construction control, not a candidate document or execution grant. */
export interface ProtectedToolchainFixtureContext {
  readonly __fixture_context?: never;
}
/** Process-local compatibility only. Deliberately no receipt, read method, or reusable data. */
export interface ProtectedToolchainFixtureCompatibility {
  readonly __fixture_compatibility?: never;
}
interface ContextData {
  identity: Json;
  readonly candidate: ReleaseCandidateSnapshot;
  readonly source: readonly ContainerArchiveEntry[];
  readonly descriptor: Json;
  readonly fixture_resolution: VerifiedReleasePolicyResolution;
  readonly production_resolution: VerifiedReleasePolicyResolution;
  readonly container: Json;
  readonly runtime: Json;
  readonly toolchain: Json;
  readonly template: Json;
  readonly subject: Buffer;
  readonly zero: Buffer;
  bound: boolean;
  attempted: boolean;
  observed: boolean;
  attached: boolean;
  request?: ReleaseLifecycleRequest;
  binding?: Json;
}
const contexts = new WeakMap<object, ContextData>();
const custodyContexts = new WeakMap<object, ContextData>();
const attachedCustodies = new WeakSet<object>();
const compatibilities = new WeakMap<object, ContextData>();
function fail(): never {
  throw new Error(INVALID);
}
function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : fail();
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function copy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function json(bytes: Buffer, maximum = 1024 * 1024): Json {
  if (bytes.length === 0 || bytes.length > maximum) fail();
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
function opaque(): object {
  return Object.freeze(
    Object.defineProperty(Object.create(null) as object, 'toJSON', { value: fail }),
  );
}
function runtime(container: Json): Json {
  const expected = [...RUNTIME_KEYS, 'dependencies', 'dependency_transport_sha256'];
  if (Object.hasOwn(container, 'local_image')) expected.push('local_image');
  if (!same(Object.keys(container).sort(), expected.sort())) fail();
  return copy(
    Object.fromEntries(
      Object.entries(container).filter(
        ([key]) => key !== 'dependencies' && key !== 'dependency_transport_sha256',
      ),
    ),
  );
}

/** Recover mode/object IDs only from an already verified complete Git tree proof. */
function sourceCensus(candidate: ReleaseCandidateSnapshot) {
  const proof = candidate.readProof([]),
    width = candidate.repository.commit.length / 2;
  const pending = [{ id: candidate.repository.tree, prefix: '' }];
  const result: { path: string; mode: string; object_id: string; size: number; sha256: string }[] =
    [];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];
    if (!current) return fail();
    const tree = proof.get(current.id);
    if (tree?.type !== 'tree') return fail();
    const bytes = Buffer.from(tree.bytes);
    for (let offset = 0; offset < bytes.length;) {
      const space = bytes.indexOf(32, offset),
        nul = bytes.indexOf(0, space + 1);
      if (space <= offset || nul <= space + 1 || nul + 1 + width > bytes.length) fail();
      const mode = bytes.subarray(offset, space).toString('ascii');
      const path = current.prefix + bytes.subarray(space + 1, nul).toString('utf8');
      const id = bytes.subarray(nul + 1, nul + 1 + width).toString('hex');
      offset = nul + 1 + width;
      if (mode === '40000') pending.push({ id, prefix: path + '/' });
      else {
        if (mode !== '100644') fail();
        const content = candidate.read(path);
        result.push({ path, mode, object_id: id, size: content.length, sha256: hash(content) });
      }
    }
  }
  return result.sort((a, b) => compare(a.path, b.path));
}

/** Bind all dynamic identities before the fixed diagnostic provider can be invoked. */
export function createProtectedToolchainFixtureContext(input: {
  readonly candidate: ReleaseCandidateSnapshot;
  readonly installed_package: ReleasePackageSnapshot;
  readonly fixture_resolution: VerifiedReleasePolicyResolution;
  readonly production_resolution: VerifiedReleasePolicyResolution;
  readonly controls: ProtectedContainerControls;
  readonly dependencies: readonly ProtectedContainerDependency[];
  readonly environment: Readonly<Record<string, string>>;
  readonly toolchain: Readonly<Record<string, string>>;
}): ProtectedToolchainFixtureContext {
  try {
    const { candidate, fixture_resolution: fixture, production_resolution: production } = input;
    if (
      !isVerifiedReleaseCandidateSnapshot(candidate) ||
      !isVerifiedReleasePackageSnapshot(input.installed_package) ||
      !isVerifiedReleasePolicyResolution(fixture) ||
      !isVerifiedReleasePolicyResolution(production) ||
      !same(candidate.repository, fixture.repository) ||
      candidate.repository.id !== 'devai-diagnostic/mutation-toolchain-diagnostic' ||
      fixture.release_unit !== '@devai-toolchain/diagnostic' ||
      production.release_unit !== '@aarusso-nyx/devai' ||
      !same(fixture.resolution['installed_package'], input.installed_package.identity) ||
      !same(production.resolution['installed_package'], input.installed_package.identity) ||
      !same(input.environment, {}) ||
      !same(
        Object.keys(input.toolchain).sort(),
        [...Object.keys(VERSIONS), 'git', 'stryker'].sort(),
      ) ||
      input.toolchain['stryker'] !== '9.6.1' ||
      input.dependencies.length === 0 ||
      Object.entries(VERSIONS).some(([key, value]) => input.toolchain[key] !== value)
    )
      fail();
    const definition = loadReleaseToolchainFixtureDefinition(input.installed_package);
    const paths = [...definition.manifest.map((entry) => entry.path), ...DYNAMIC_PATHS].sort(
      compare,
    );
    if (!same(paths, candidate.paths) || new Set(paths).size !== paths.length) fail();
    for (const member of definition.manifest)
      if (!candidate.read(member.path).equals(definition.read(member.path))) fail();
    if (!candidate.read('host/devai.tgz').equals(input.installed_package.readArchive())) fail();
    const census = sourceCensus(candidate);
    const source = census.map((entry): ContainerArchiveEntry => ({
      path: entry.path,
      mode: '100644',
      bytes: candidate.read(entry.path),
    }));
    const container = copy(
      new ProtectedCertificationContainer(input.controls, input.dependencies).identity,
    );
    const transport = validateProtectedDependencyTransport(
      input.dependencies,
      input.controls.maximum_archive_bytes,
    );
    verifyProtectedDependencyInputs(transport, source);
    const profile = object(production.readInput('release-verification-profile'));
    const template = object(profile['mutation_execution']);
    if (
      template['schemaVersion'] !== '1.1.0' ||
      template['template_id'] !== 'devai.protected-mutation-stryker.v1' ||
      container['node_version'] !== VERSIONS.node
    )
      fail();
    const identity = copy({
      schemaVersion: '1.0.0',
      definition_sha256: definition.definition_sha256,
      repository: candidate.repository,
      installed_package: input.installed_package.identity,
      source_census: census,
      fixture_policy_resolution_sha256: canonicalSha256(fixture.resolution),
      production_policy_resolution_sha256: canonicalSha256(production.resolution),
      release_profile_sha256: canonicalSha256(profile),
      mutation_template_sha256: canonicalSha256(template),
      task_descriptor_sha256: hash(candidate.read('test-tasks.json')),
      effective_environment_sha256: canonicalSha256(protectedContainerTaskEnvironment({})),
      container,
      runtime_identity: runtime(container),
      toolchain: input.toolchain,
    });
    const context = opaque();
    contexts.set(context, {
      identity,
      candidate,
      source,
      descriptor: json(candidate.read('test-tasks.json')),
      fixture_resolution: fixture,
      production_resolution: production,
      container,
      runtime: runtime(container),
      toolchain: copy(input.toolchain),
      template: copy(template),
      subject: definition.read(`${WORKSPACE}/src/subject.ts`),
      zero: definition.read(`${WORKSPACE}/src/zero.ts`),
      bound: false,
      attempted: false,
      observed: false,
      attached: false,
    });
    return context;
  } catch {
    return fail();
  }
}

/** Provider-only registration; a context cannot be installed in another provider. */
export function bindProtectedToolchainFixtureContext(
  context: ProtectedToolchainFixtureContext,
  input: {
    readonly container: Json;
    readonly environment: Json;
    readonly toolchain: Json;
    readonly resolutions: readonly (VerifiedReleasePolicyResolution | undefined)[];
    readonly receipts: readonly {
      readonly receipt_id: string;
      readonly receipt_digest_sha256: string;
    }[];
    readonly diagnostic_outputs: unknown;
  },
): Json {
  const data = contexts.get(context);
  if (!data || data.bound) return fail();
  data.bound = true;
  if (
    !same(data.container, input.container) ||
    !same(input.environment, {}) ||
    !same(data.toolchain, input.toolchain) ||
    input.resolutions.length !== 1 ||
    input.receipts.length !== 1 ||
    input.resolutions[0] !== data.fixture_resolution ||
    !same(input.diagnostic_outputs, [{ task_node: NODE, paths: OUTPUTS }])
  )
    fail();
  data.identity = copy({ ...data.identity, fixture_plan_receipt: input.receipts[0] });
  return copy(data.identity);
}

/** Checked before any fixture task runs; later failures do not permit a retry with this context. */
export function observeProtectedToolchainFixtureInputs(
  context: ProtectedToolchainFixtureContext,
  input: {
    readonly request: ReleaseLifecycleRequest;
    readonly source: readonly ContainerArchiveEntry[];
    readonly descriptor: TaskDescriptor;
    readonly tasks: readonly PlannedTask[];
  },
): void {
  const data = contexts.get(context);
  if (!data || !data.bound || data.attempted) return fail();
  data.attempted = true;
  const { request } = input;
  if (
    request.action_id !== 'release preflight' ||
    !same(request.repository_locator, data.candidate.repository) ||
    request.candidate_locator.commit !== data.candidate.repository.commit ||
    request.candidate_locator.tree !== data.candidate.repository.tree ||
    !same(request.candidate_locator.release_units, [
      {
        release_unit: '@devai-toolchain/diagnostic',
        version: '1.0.0',
        package_roster: [
          {
            package_id: '@devai-toolchain/diagnostic',
            manifest_path: 'package.json',
            manifest_digest_sha256: hash(data.candidate.read('package.json')),
          },
        ],
      },
    ]) ||
    request.receipt_locators?.length !== 1 ||
    request.receipt_locators[0]?.kind !== 'release-plan-receipt' ||
    !same(
      {
        receipt_id: request.receipt_locators[0]?.receipt_id,
        receipt_digest_sha256: request.receipt_locators[0]?.receipt_digest_sha256,
      },
      data.identity['fixture_plan_receipt'],
    ) ||
    !same(input.descriptor, data.descriptor) ||
    input.tasks.length !== 1 ||
    input.tasks[0]?.nodeId !== NODE ||
    input.tasks[0]?.cwd !== WORKSPACE ||
    !same(input.tasks[0]?.argv, ['node', '../../host/run-diagnostic.mjs']) ||
    input.source.length !== data.source.length
  )
    fail();
  const expected = new Map(data.source.map((entry) => [entry.path, entry]));
  for (const entry of input.source) {
    const value = expected.get(entry.path);
    if (!value || value.mode !== entry.mode || !value.bytes.equals(entry.bytes)) fail();
    expected.delete(entry.path);
  }
  if (expected.size !== 0) fail();
  data.request = copy(request);
  data.observed = true;
}

/** Records the provider's exact container binding, not a caller-supplied receipt claim. */
export function recordProtectedToolchainFixtureBinding(
  context: ProtectedToolchainFixtureContext,
  binding: Json,
): void {
  const data = contexts.get(context);
  if (
    !data?.observed ||
    data.binding !== undefined ||
    binding['action_id'] !== 'release preflight' ||
    !same(binding['repository'], data.candidate.repository) ||
    binding['plan_receipt_digest_sha256'] !==
      object(data.identity['fixture_plan_receipt'])['receipt_digest_sha256']
  )
    fail();
  data.binding = copy(binding);
}

/** A JSON field alone is never this association. Only the verified provider calls this seam. */
export function attachProtectedToolchainFixtureCustody(
  context: ProtectedToolchainFixtureContext,
  custody: ProtectedFixtureDiagnosticCustody,
): void {
  const data = contexts.get(context);
  if (!data || data.attached) return fail();
  data.attached = true;
  if (
    !data.observed ||
    data.binding === undefined ||
    !isVerifiedProtectedFixtureDiagnosticCustody(custody) ||
    attachedCustodies.has(custody)
  )
    fail();
  attachedCustodies.add(custody);
  custodyContexts.set(custody, data);
}

/** Pure bounded interpretation of private fixture bytes; never normalize into production evidence. */
function assertReports(custody: ProtectedFixtureDiagnosticCustody, data: ContextData): void {
  const captured = custody.read();
  if (
    captured.outcome !== 'success' ||
    data.request === undefined ||
    data.binding === undefined ||
    !same(captured.request, data.request) ||
    captured.runs.length !== 1 ||
    !same(captured.fixture_input_identity, data.identity) ||
    !same(captured.runtime_identity, data.runtime) ||
    !same(captured.execution_identity['container'], data.container)
  )
    fail();
  const run = captured.runs[0];
  if (
    !run ||
    run.task_node !== NODE ||
    !same(run.binding, data.binding) ||
    !same(run.process, { status: 0, signal: null, errorAbsent: true }) ||
    !same(
      run.output_census.map((entry) => entry.path),
      OUTPUTS,
    )
  )
    fail();
  const read = (path: string, maximum: number): Json => {
    const member = run.output_census.find((entry) => entry.path === path);
    if (
      !member ||
      member.mode !== '100644' ||
      member.task_node !== NODE ||
      member.size_bytes > maximum
    )
      return fail();
    const bytes = custody.readOutput({ run_index: 0, path, sha256: member.sha256 });
    if (bytes.length !== member.size_bytes || hash(bytes) !== member.sha256) fail();
    return json(bytes, maximum);
  };
  const compatibility = read(COMPATIBILITY, 8192);
  const discovery = object(compatibility['discovery']);
  const emitted = discovery['emitted'];
  if (!Array.isArray(emitted) || emitted.length !== 1) fail();
  const emittedFile = object(emitted[0]);
  const emittedIds = emittedFile['mutant_ids'];
  if (
    !Array.isArray(emittedIds) ||
    emittedIds.length === 0 ||
    emittedIds.length > 1000 ||
    emittedIds.some((id: unknown) => typeof id !== 'string') ||
    new Set(emittedIds).size !== emittedIds.length ||
    !same([...emittedIds].sort(), emittedIds) ||
    !same(emittedFile, {
      path: 'src/subject.ts',
      mutant_ids: emittedIds,
      mutant_count: emittedIds.length,
    }) ||
    !same(discovery, {
      algorithm: 'devai.fixed-fixture-instrumenter.v1',
      instrumenter_version: '9.6.1',
      options: { plugins: null, excludedMutations: [], ignorers: [] },
      selected: [
        { path: 'src/subject.ts', source_sha256: hash(data.subject) },
        { path: 'src/zero.ts', source_sha256: hash(data.zero) },
      ],
      instrumented: ['src/subject.ts', 'src/zero.ts'],
      emitted,
    })
  )
    fail();
  if (
    !same(compatibility, {
      scope: 'toolchain-compatibility-diagnostic-only',
      core: '9.6.1',
      checker: '9.6.1',
      runner: '9.6.1',
      vitest: VERSIONS.vitest,
      typescript: VERSIONS.typescript,
      node: VERSIONS.node,
      projectVitestResolved: true,
      readonlyDependencies: true,
      realMutationObserved: true,
      certification: false,
      reusable: false,
      discovery,
    })
  )
    fail();
  const raw = read(RAW, 1024 * 1024),
    framework = object(raw['framework']);
  if (
    raw['schemaVersion'] !== '1.0' ||
    raw['projectRoot'] !== '/workspace/candidate/packages/fixture' ||
    framework['name'] !== 'StrykerJS' ||
    framework['version'] !== '9.6.1' ||
    !same(raw['thresholds'], { break: 60, high: 60, low: 60 })
  )
    fail();
  const files = object(raw['files']);
  if (!same(Object.keys(files), ['src/subject.ts'])) fail();
  let killed = 0,
    detected = 0,
    survived = 0,
    scored = 0,
    total = 0;
  const ids = new Set<string>();
  for (const value of Object.values(files)) {
    const file = object(value);
    if (
      file['source'] !== data.subject.toString('utf8') ||
      file['language'] !== 'typescript' ||
      !Array.isArray(file['mutants']) ||
      file['mutants'].length > 1000
    )
      fail();
    for (const value of file['mutants']) {
      const mutant = object(value),
        status = mutant['status'];
      if (
        typeof mutant['id'] !== 'string' ||
        typeof status !== 'string' ||
        ids.has(mutant['id']) ||
        !['CompileError', 'Ignored', 'Killed', 'NoCoverage', 'Survived', 'Timeout'].includes(status)
      )
        fail();
      ids.add(mutant['id']);
      total += 1;
      if (status === 'Killed') killed += 1;
      if (status === 'Killed' || status === 'Timeout') detected += 1;
      if (status === 'Survived') survived += 1;
      if (['Killed', 'NoCoverage', 'Survived', 'Timeout'].includes(status)) scored += 1;
    }
  }
  if (
    total === 0 ||
    killed === 0 ||
    scored === 0 ||
    survived > 50 ||
    detected * 100 < scored * 60 ||
    !same([...ids].sort(), emittedIds)
  )
    fail();
}

export function issueProtectedToolchainFixtureCompatibility(
  custody: ProtectedFixtureDiagnosticCustody,
): ProtectedToolchainFixtureCompatibility {
  const data = custodyContexts.get(custody);
  custodyContexts.delete(custody);
  try {
    if (!data || !isVerifiedProtectedFixtureDiagnosticCustody(custody)) return fail();
    assertReports(custody, data);
    const result = opaque();
    compatibilities.set(result, data);
    return result;
  } catch {
    return fail();
  }
}

/** This only checks compatibility. It neither changes a plan nor clears any production gate. */
export function assertProtectedToolchainFixtureCompatibility(
  compatibility: ProtectedToolchainFixtureCompatibility,
  input: {
    readonly resolution: VerifiedReleasePolicyResolution;
    readonly container_identity: Json;
    readonly toolchain: Json;
    readonly environment: Json;
  },
): void {
  const data = compatibilities.get(compatibility);
  if (
    !data ||
    input.resolution !== data.production_resolution ||
    !same(
      object(input.resolution.readInput('release-verification-profile'))['mutation_execution'],
      data.template,
    ) ||
    !same(runtime(input.container_identity), data.runtime) ||
    !same(input.toolchain, data.toolchain) ||
    !same(input.environment, {})
  )
    fail();
}
