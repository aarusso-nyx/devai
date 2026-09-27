import { canonicalSha256 } from '@devai-nyx/utils';
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
import {
  type ProtectedToolchainFixtureContext,
  same,
  VERSIONS,
  fail,
  object,
  DYNAMIC_PATHS,
  compare,
  sourceCensus,
  copy,
  hash,
  runtime,
  opaque,
  contexts,
  json,
  WORKSPACE,
  type Json,
  NODE,
  OUTPUTS,
  attachedCustodies,
  custodyContexts,
} from './release-toolchain-fixture-compatibility-support.js';
export {
  issueProtectedToolchainFixtureCompatibility,
  assertProtectedToolchainFixtureCompatibility,
} from './release-toolchain-fixture-compatibility-reports.js';
export type {
  ProtectedToolchainFixtureContext,
  ProtectedToolchainFixtureCompatibility,
} from './release-toolchain-fixture-compatibility-support.js';

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
      !same(fixture.resolution['installed_package'], input.installed_package.identity) ||
      !same(production.resolution['installed_package'], input.installed_package.identity) ||
      !same(input.environment, {}) ||
      // The pinned census must be present and exact. Additional keys are permitted
      // because the production lane shares this toolchain object and binds every key
      // its own selected DAG declares; all of them are recorded in the identity below,
      // so a wider census is bound evidence rather than an unchecked input.
      [...Object.keys(VERSIONS), 'git', 'stryker'].some(
        (key) => typeof input.toolchain[key] !== 'string',
      ) ||
      Object.values(input.toolchain).some(
        (value) => typeof value !== 'string' || value.length === 0,
      ) ||
      input.toolchain['stryker'] !== '9.6.1' ||
      input.dependencies.length === 0 ||
      Object.entries(VERSIONS).some(([key, value]) => input.toolchain[key] !== value)
    )
      fail();
    const profile = object(production.readInput('release-verification-profile'));
    const template = object(profile['mutation_execution']);
    // ADR-MUT-0008 makes v1.2 generic. Keep the historical v1.1 restriction,
    // and bind the adopter unit through its independently verified policy.
    if (
      !['1.1.0', '1.2.0'].includes(String(template['schemaVersion'])) ||
      profile['schemaVersion'] !== template['schemaVersion'] ||
      template['template_id'] !== 'devai.protected-mutation-stryker.v1' ||
      profile['release_unit'] !== production.release_unit ||
      (template['schemaVersion'] === '1.1.0' && production.release_unit !== '@aarusso-nyx/devai')
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
    if (container['node_version'] !== VERSIONS.node) fail();
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
