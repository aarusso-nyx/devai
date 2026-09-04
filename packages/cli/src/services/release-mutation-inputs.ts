import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { parse as parseYaml } from 'yaml';
import { satisfies, valid } from 'semver';
import { parseConfigFileTextToJson } from 'typescript';
import {
  isVerifiedReleaseCandidateSnapshot,
  type ReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from './release-candidate-snapshot.js';
import {
  isVerifiedReleasePolicyResolution,
  type VerifiedReleasePolicyResolution,
} from './release-policy-resolution.js';
import { verifyResolvedReleasePlanReceipt } from './release-lifecycle.js';
import { parseTaskDescriptor, selectorMatches } from './check-runner/policy.js';
import type { TaskDescriptorNode } from './check-runner/types.js';
import {
  ProtectedCertificationContainer,
  protectedContainerTaskEnvironment,
  type ProtectedContainerControls,
  type ProtectedContainerDependency,
} from './release-certification-container.js';
import {
  assertProtectedFixtureProviderCompatibility,
  captureProtectedMutationPrerequisites,
  type ProtectedMutationPrerequisiteClosure,
} from './release-certification-provider.js';
import type { ReleaseProvider } from './release-lifecycle-execution.js';
import type { ReleaseMutationPackageInputsV21 } from './release-mutation-artifacts.js';

type Json = Readonly<Record<string, unknown>>;
const INVALID = 'MUTATION_INPUT_IDENTITY_MISSING';
const ALGORITHM = 'devai.protected-mutation-inputs.v1';
const TEMPLATE = 'devai.protected-mutation-stryker.v1';
const PACKAGE_IDS = [
  'authority',
  'cli',
  'effects-check',
  'evidence',
  'loop',
  'schemas',
  'sensors',
  'skills',
  'spec',
  'utils',
] as const;
const BINDINGS = [
  'source',
  'tests',
  'manifests',
  'mutationConfiguration',
  'runner',
  'roster',
  'thresholds',
  'sanitizer',
  'lockfile',
  'environment',
  'toolchain',
  'semanticRebind',
] as const;
type Binding = (typeof BINDINGS)[number];

export interface ReleaseMutationSourceMemberV21 {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly object_id: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ReleaseMutationPrerequisiteMember {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly size: number;
  readonly sha256: string;
  readonly producer_task_node: string;
}

export interface ReleaseMutationInputPackageV21 {
  readonly id: string;
  readonly input_digest: string;
  readonly expected: ReleaseMutationPackageInputsV21;
  /** Complete invalidation populations, not a report's emitted-mutant file list. */
  readonly selected_source: readonly ReleaseMutationSourceMemberV21[];
  readonly selected_tests: readonly ReleaseMutationSourceMemberV21[];
  /** Actual mutation selection, package-relative; distinct from selected and emitted censuses. */
  readonly mutation_targets: readonly ReleaseMutationSourceMemberV21[];
  readonly mutation_target_population_digest: string;
  readonly mutation_target_projection_digest: string;
  readonly workspace_dependencies: readonly string[];
  readonly prerequisite_nodes: readonly string[];
  /** v1.2 exact execution inputs; deliberately absent on historical v1.1 plans. */
  readonly execution_configuration?: {
    readonly task_node: string;
    readonly vitest_config: ReleaseMutationSourceMemberV21;
    readonly typescript_config: ReleaseMutationSourceMemberV21;
    readonly typescript_closure: readonly ReleaseMutationSourceMemberV21[];
  };
  readonly reuse: {
    readonly eligible: boolean;
    /** Unresolved selection/configuration also forbids constructing a production producer. */
    readonly unresolved: readonly string[];
  };
}

export interface ReleaseMutationInputPlanV21 {
  readonly repository: ReleaseCandidateSnapshot['repository'];
  readonly release_unit: string;
  readonly release_plan_receipt_digest: string;
  readonly release_profile_digest: string;
  readonly mutation_policy_digest: string;
  readonly template_id: typeof TEMPLATE;
  readonly execution_template_version: '1.1.0' | '1.2.0';
  /** Host execution coverage; never rewrites the verified plan's determination. */
  readonly execution_coverage: Readonly<{
    kind: ReleaseMutationExecutionCoverageV21['kind'];
    repository: ReleaseCandidateSnapshot['repository'];
    release_unit: string;
    target_version: string;
    release_plan_receipt_digest: string;
    release_profile_digest: string;
    policy_resolution_digest: string;
    expected_package_inputs_digest: string;
  }>;
  readonly packages: readonly ReleaseMutationInputPackageV21[];
  /** A derivation brand is not a successful toolchain diagnostic or permission to run. */
  readonly toolchain_fixture_validation: Json;
  readonly grants: {
    readonly execution: false;
    readonly certification: false;
    readonly reuse: false;
  };
  /** Captured candidate proof only; returned object maps and byte arrays are defensive copies. */
  readonly readProof: () => ReadonlyMap<string, ReleaseGitObject>;
}

/**
 * Protected host construction control, pinned before accepting a candidate request. The campaign
 * alternative records the Owner's DEVAI 1.5.0 coverage requirement, not a general adopter policy.
 * Neither alternative accepts package IDs or changes support/mutation determination.
 */
export type ReleaseMutationExecutionCoverageV21 =
  | { readonly kind: 'plan-determined' }
  | {
      readonly kind: 'owner-approved-complete-devai-roster';
      readonly repository: ReleaseCandidateSnapshot['repository'];
      readonly release_unit: '@aarusso-nyx/devai';
      readonly target_version: '1.5.0';
      readonly release_plan_receipt_digest: string;
      readonly release_profile_digest: string;
      readonly policy_resolution_digest: string;
    };

export interface ReleaseMutationInputControlsV21 {
  readonly execution_coverage: ReleaseMutationExecutionCoverageV21;
  /** Process-local verified fixture provider, never serialized authority or execution credit. */
  readonly fixture_provider?: ReleaseProvider;
  /** Actual verified predecessor outputs from the same protected provider, never a caller map. */
  readonly prerequisite_closure?: ProtectedMutationPrerequisiteClosure;
  readonly container: ProtectedContainerControls;
  readonly dependencies: readonly ProtectedContainerDependency[];
  /** Explicit public values from the protected host, never ambient process.env. */
  readonly environment: Readonly<Record<string, string>>;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly maximum_source_bytes: number;
  readonly maximum_source_entries: number;
}

const derived = new WeakSet<object>();
const derivedPackages = new WeakMap<object, string>();
export interface ReleaseMutationInputExecutionContext {
  readonly container_identity: Readonly<Record<string, unknown>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly repository: ReleaseCandidateSnapshot['repository'];
  readonly candidate_files: readonly {
    readonly path: string;
    readonly mode: string;
    readonly object_id: string;
  }[];
  readonly prerequisite_outputs?: readonly ReleaseMutationPrerequisiteMember[];
}
const derivedExecution = new WeakMap<object, ReleaseMutationInputExecutionContext>();
function fail(code = INVALID): never {
  throw Object.assign(new Error(code), { code });
}
function object(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Json;
}
function closed(value: unknown, fields: readonly string[]): void {
  const record = object(value);
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(record)) ||
    Reflect.ownKeys(record).length !== fields.length
  )
    fail();
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
  }
}
function nativeArray<T>(value: readonly T[]): readonly T[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
  }
  return value;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : fail();
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return fail();
  const result = value as string[];
  if (new Set(result).size !== result.length) fail();
  return result;
}
function compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function inputDigest(projection: unknown): string {
  const bytes = Buffer.from(canonicalJson(projection)),
    length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return hash(Buffer.concat([Buffer.from('devai:mutation-input:v2.1\0', 'ascii'), length, bytes]));
}
function path(value: unknown): string {
  const result = text(value);
  if (
    !result ||
    result !== result.normalize('NFC') ||
    result.startsWith('/') ||
    /^[A-Za-z]:/u.test(result) ||
    result.includes('\\') ||
    /\p{Cc}|\p{Cs}/u.test(result) ||
    result.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail();
  return result;
}
function immutable<T>(value: T): T {
  const inspect = (node: unknown, depth: number): void => {
    if (depth > 64) fail();
    if (node !== null && typeof node === 'object') {
      const proto = Object.getPrototypeOf(node);
      if (
        Array.isArray(node)
          ? proto !== Array.prototype
          : proto !== Object.prototype && proto !== null
      )
        fail();
      const names = Object.keys(node);
      if (Reflect.ownKeys(node).length !== names.length + (Array.isArray(node) ? 1 : 0)) fail();
      if (Array.isArray(node) && names.length !== node.length) fail();
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(node, name);
        if (!descriptor || !('value' in descriptor)) fail();
        inspect(descriptor.value, depth + 1);
      }
    } else if (
      node !== null &&
      !['string', 'boolean'].includes(typeof node) &&
      !(typeof node === 'number' && Number.isFinite(node))
    )
      fail();
  };
  inspect(value, 0);
  const copied = JSON.parse(canonicalJson(value)) as T;
  const freeze = (node: unknown): void => {
    if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(freeze);
      Object.freeze(node);
    }
  };
  freeze(copied);
  return copied;
}
function json(bytes: Uint8Array): Json {
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
function safeValues(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const copied = immutable(value);
  if (
    Object.keys(copied).length > 256 ||
    Object.entries(copied).some(
      ([key, item]) =>
        !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(key) ||
        typeof item !== 'string' ||
        item.length > 8192 ||
        /\p{Cc}|\p{Cs}/u.test(item),
    )
  )
    fail();
  return copied;
}

/** Recover modes and object identities from the genuine snapshot's complete tree proof. */
function treeMembers(
  candidate: ReleaseCandidateSnapshot,
  maximum: number,
): Map<
  string,
  {
    readonly mode: string;
    readonly object_id: string;
  }
> {
  const proof = candidate.readProof([]);
  const idBytes = candidate.repository.commit.length / 2;
  const queue = [{ id: candidate.repository.tree, prefix: '' }];
  const files = new Map<string, { mode: string; object_id: string }>();
  let count = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (!current) return fail();
    const entry = proof.get(current.id);
    if (entry?.type !== 'tree') return fail();
    const bytes = Buffer.from(entry.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const space = bytes.indexOf(32, offset),
        nul = bytes.indexOf(0, space + 1);
      if (space <= offset || nul <= space + 1 || nul + 1 + idBytes > bytes.length) fail();
      const mode = bytes.subarray(offset, space).toString('ascii');
      const name = path(`${current.prefix}${bytes.subarray(space + 1, nul).toString('utf8')}`);
      const id = bytes.subarray(nul + 1, nul + 1 + idBytes).toString('hex');
      offset = nul + 1 + idBytes;
      count += 1;
      if (count > maximum) fail();
      if (mode === '40000') queue.push({ id, prefix: `${name}/` });
      else {
        if (files.has(name)) fail();
        files.set(name, { mode, object_id: id });
      }
    }
  }
  if (!same([...files.keys()].sort(compare), candidate.paths)) fail();
  return files;
}

export function isDerivedReleaseMutationInputPlanV21(
  value: unknown,
): value is ReleaseMutationInputPlanV21 {
  return value !== null && typeof value === 'object' && derived.has(value);
}

/** A production driver must come from the same installed package that derived its inputs. */
export function assertReleaseMutationInputPackageIdentity(
  plan: ReleaseMutationInputPlanV21,
  identity: unknown,
): void {
  if (
    !isDerivedReleaseMutationInputPlanV21(plan) ||
    derivedPackages.get(plan) !== canonicalSha256(immutable(identity))
  )
    fail();
}

/** Private derivation custody; serializing a plan never supplies this execution context. */
export function captureReleaseMutationInputExecutionContext(
  plan: ReleaseMutationInputPlanV21,
): ReleaseMutationInputExecutionContext {
  const context = derivedExecution.get(plan);
  if (!isDerivedReleaseMutationInputPlanV21(plan) || context === undefined) return fail();
  return immutable(context);
}

/** Compare only with independently derived inputs. Caller projections are never an input source. */
export function assertReleaseMutationInputProjectionV21(
  plan: ReleaseMutationInputPlanV21,
  packageName: string,
  alleged: unknown,
): void {
  if (!isDerivedReleaseMutationInputPlanV21(plan)) fail();
  const expected = plan.packages.find((entry) => entry.expected.packageName === packageName);
  if (!expected || !same(expected.expected.inputProjection, immutable(alleged)))
    fail('MUTATION_INPUT_DIGEST_MISMATCH');
}

/**
 * Protected template input derivation. Every file read comes from a verified exact Git object
 * snapshot; no checkout, shell, network, candidate module evaluation or caller digest is used.
 * Package bytes intentionally exclude candidate commit/tree and the plan receipt: those bind the
 * later composition, while exact source/config/runner/roster/environment/toolchain drift changes
 * the reusable package input identity. Emitted targets still require protected instrumentation
 * proof; this full selected-file census never substitutes for that proof or a passing task.
 */
export function buildReleaseMutationInputPlanV21(input: {
  readonly candidate: ReleaseCandidateSnapshot;
  readonly resolution: VerifiedReleasePolicyResolution;
  readonly plan_receipt: unknown;
  readonly controls: ReleaseMutationInputControlsV21;
}): ReleaseMutationInputPlanV21 {
  try {
    closed(input, ['candidate', 'resolution', 'plan_receipt', 'controls']);
    if (
      !isVerifiedReleaseCandidateSnapshot(input.candidate) ||
      !isVerifiedReleasePolicyResolution(input.resolution) ||
      !same(input.candidate.repository, input.resolution.repository) ||
      !verifyResolvedReleasePlanReceipt({
        receipt: input.plan_receipt,
        resolution: input.resolution,
      })
    )
      fail();
    const candidate = input.candidate,
      resolution = input.resolution;
    const receipt = object(immutable(input.plan_receipt));
    if (receipt['verdict'] !== 'pass') fail('MUTATION_ROSTER_MISMATCH');
    const profile = object(resolution.readInput('release-verification-profile'));
    const template = object(profile['mutation_execution']);
    const templateVersion = template['schemaVersion'];
    if (
      (templateVersion !== '1.1.0' && templateVersion !== '1.2.0') ||
      profile['schemaVersion'] !== templateVersion ||
      template['template_id'] !== TEMPLATE
    )
      fail();
    const currentTemplate = templateVersion === '1.2.0';
    if (!currentTemplate && resolution.release_unit !== '@aarusso-nyx/devai')
      fail('MUTATION_ROSTER_MISMATCH');
    const targetRule = object(template['mutation_targets']);
    const targetExtensions = strings(targetRule['include_extensions']);
    const targetExclusions = strings(targetRule['exclude_suffixes']);
    const targetSegments = strings(targetRule['exclude_path_segments']);
    const fixtureValidation = object(template['toolchain_fixture_validation']);
    const rawRoster = profile['mutation_roster'];
    if (!Array.isArray(rawRoster)) return fail();
    const roster = rawRoster.map(object).sort((a, b) => compare(text(a['id']), text(b['id'])));
    if (
      roster.length === 0 ||
      new Set(roster.map((entry) => entry['id'])).size !== roster.length ||
      (!currentTemplate &&
        !same(
          roster.map((entry) => entry['id']),
          PACKAGE_IDS,
        ))
    )
      fail('MUTATION_ROSTER_MISMATCH');
    const controls = input.controls;
    const hasFixtureProvider = Object.hasOwn(controls, 'fixture_provider');
    const hasPrerequisiteClosure = Object.hasOwn(controls, 'prerequisite_closure');
    closed(controls, [
      'execution_coverage',
      'container',
      'dependencies',
      'environment',
      'toolchain',
      'maximum_source_bytes',
      'maximum_source_entries',
      ...(hasFixtureProvider ? ['fixture_provider'] : []),
      ...(hasPrerequisiteClosure ? ['prerequisite_closure'] : []),
    ]);
    if (hasFixtureProvider && typeof controls.fixture_provider !== 'function') fail();
    const requestedCoverage = immutable(controls.execution_coverage);
    const coverageIdentity = {
      repository: candidate.repository,
      release_unit: resolution.release_unit,
      target_version: text(object(receipt['candidate'])['version']),
      release_plan_receipt_digest: text(receipt['receipt_digest_sha256']),
      release_profile_digest: canonicalSha256(profile),
      policy_resolution_digest: canonicalSha256(resolution.resolution),
    };
    const determination = object(receipt['determination']);
    if (requestedCoverage.kind === 'plan-determined') {
      if (
        !same(requestedCoverage, { kind: 'plan-determined' }) ||
        determination['mutation'] !== 'full-roster'
      )
        fail('MUTATION_ROSTER_MISMATCH');
    } else if (
      requestedCoverage.kind !== 'owner-approved-complete-devai-roster' ||
      !same(requestedCoverage, { kind: requestedCoverage.kind, ...coverageIdentity }) ||
      candidate.repository.id !== 'aarusso-nyx/devai' ||
      resolution.release_unit !== '@aarusso-nyx/devai' ||
      !same(
        roster.map((entry) => entry['id']),
        PACKAGE_IDS,
      ) ||
      coverageIdentity.target_version !== '1.5.0' ||
      determination['support'] !== 'current' ||
      determination['mutation'] !== 'targeted'
    )
      fail('MUTATION_ROSTER_MISMATCH');
    const containerControls = immutable(controls.container);
    const maximumBytes = controls.maximum_source_bytes,
      maximumEntries = controls.maximum_source_entries;
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      !Number.isSafeInteger(maximumEntries) ||
      maximumEntries < 1 ||
      candidate.paths.length > maximumEntries
    )
      fail();
    const environment = safeValues(controls.environment),
      toolchain = safeValues(controls.toolchain);
    if (
      toolchain['node'] !== containerControls.node_version ||
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
    )
      fail();
    // Construction is pure: verifies all supplied archive bytes/links and immutable engine/image
    // controls but never opens a process. Invocation and behavioral fixture proof remain separate.
    let dependencyBytes = 0;
    const dependencies: ProtectedContainerDependency[] = nativeArray(controls.dependencies).map(
      (entry: ProtectedContainerDependency) => {
        closed(entry, ['mount_path', 'archive', 'sha256', 'inputs']);
        if (
          !Buffer.isBuffer(entry.archive) ||
          Object.getPrototypeOf(entry.archive) !== Buffer.prototype
        )
          return fail();
        dependencyBytes += entry.archive.byteLength;
        if (dependencyBytes > containerControls.maximum_archive_bytes) fail();
        return {
          mount_path: path(entry.mount_path),
          sha256: text(entry.sha256),
          archive: Buffer.from(entry.archive),
          inputs: immutable(entry.inputs),
        };
      },
    );
    const containerIdentity = immutable(
      new ProtectedCertificationContainer(containerControls, dependencies).identity,
    );
    let fixtureValidated = false;
    if (hasFixtureProvider) {
      const provider = controls.fixture_provider;
      if (typeof provider !== 'function') return fail();
      assertProtectedFixtureProviderCompatibility(provider, {
        resolution,
        container_identity: containerIdentity,
        toolchain,
        environment,
      });
      fixtureValidated = true;
    }
    const members = treeMembers(candidate, maximumEntries);
    const prerequisiteProof = hasPrerequisiteClosure
      ? captureProtectedMutationPrerequisites(controls.prerequisite_closure ?? fail(), {
          repository: candidate.repository,
          release_unit: resolution.release_unit,
          release_plan_receipt_digest: text(receipt['receipt_digest_sha256']),
          release_profile_digest: canonicalSha256(profile),
          container_identity: containerIdentity,
          environment,
          toolchain,
        })
      : undefined;
    if (prerequisiteProof !== undefined && !currentTemplate) fail();
    let prerequisiteBytes = 0;
    const prerequisitePaths = new Set<string>();
    const prerequisiteOutputs: ReleaseMutationPrerequisiteMember[] =
      prerequisiteProof?.outputs.map((entry) => {
        prerequisiteBytes += entry.bytes.length;
        if (
          members.has(entry.path) ||
          prerequisitePaths.has(entry.path) ||
          (entry.mode !== '100644' && entry.mode !== '100755') ||
          entry.size !== entry.bytes.length ||
          entry.sha256 !== hash(entry.bytes) ||
          prerequisiteBytes > maximumBytes ||
          !prerequisiteProof.tasks.some((task) => task.node_id === entry.producer_task_node)
        )
          return fail();
        prerequisitePaths.add(entry.path);
        return {
          path: path(entry.path),
          mode: entry.mode,
          size: entry.size,
          sha256: entry.sha256,
          producer_task_node: entry.producer_task_node,
        };
      }) ?? [];
    if (candidate.paths.length + prerequisiteOutputs.length > maximumEntries) fail();
    const captured = new Map<string, Buffer>();
    const population = new Map<string, ReleaseMutationSourceMemberV21>();
    let bytesRead = 0;
    const read = (name: string): Buffer => {
      path(name);
      const existing = captured.get(name);
      if (existing) return existing;
      const member = members.get(name);
      if (!member || (member.mode !== '100644' && member.mode !== '100755')) return fail();
      const bytes = candidate.read(name);
      bytesRead += bytes.length;
      if (bytesRead > maximumBytes) fail();
      captured.set(name, bytes);
      population.set(name, {
        path: name,
        mode: member.mode,
        object_id: member.object_id,
        size: bytes.length,
        sha256: hash(bytes),
      });
      return bytes;
    };
    const file = (name: string): ReleaseMutationSourceMemberV21 => {
      read(name);
      return population.get(name) ?? fail();
    };
    const select = (values: unknown): readonly ReleaseMutationSourceMemberV21[] => {
      const selectors = strings(values).map((value) => path(value.replace(/\/$/u, '')));
      if (selectors.length === 0) return fail();
      for (const selector of selectors)
        if (!candidate.paths.some((name) => name === selector || name.startsWith(`${selector}/`)))
          fail();
      return candidate.paths
        .filter((name) =>
          selectors.some((selector) => name === selector || name.startsWith(`${selector}/`)),
        )
        .map(file);
    };
    const workspace = object(parseYaml(read('pnpm-workspace.yaml').toString('utf8')));
    if (!same(workspace['packages'], ['packages/*'])) fail('MUTATION_ROSTER_MISMATCH');
    const manifests = candidate.paths.filter((name) =>
      /^packages\/[^/]+\/package\.json$/u.test(name),
    );
    if (!same(manifests, roster.map((entry) => path(entry['manifest_path'])).sort(compare)))
      fail('MUTATION_ROSTER_MISMATCH');
    const byPackage = new Map(
      roster.map((entry) => {
        const manifest = json(read(path(entry['manifest_path'])));
        if (manifest['name'] !== entry['package'] || valid(text(manifest['version'])) === null)
          fail('MUTATION_ROSTER_MISMATCH');
        return [text(entry['package']), { entry, manifest }];
      }),
    );
    if (byPackage.size !== roster.length) fail('MUTATION_ROSTER_MISMATCH');
    for (const dependency of dependencies) {
      for (const member of dependency.inputs.files)
        if (hash(read(member.path)) !== member.sha256) fail();
      if (
        !same(
          dependency.inputs.workspace_packages
            .map((pkg) => `${pkg.path}/package.json`)
            .sort(compare),
          manifests,
        )
      )
        fail();
      for (const pkg of dependency.inputs.workspace_packages)
        if (json(read(`${pkg.path}/package.json`))['name'] !== pkg.name) fail();
    }
    const taskBytes = read('test-tasks.json');
    const descriptor = parseTaskDescriptor(JSON.parse(taskBytes.toString('utf8')));
    if (descriptor.repositoryId !== candidate.repository.id) fail();
    const mutationPolicy = resolution.tools.readJson('dist/law/policy/mutation-evidence-v2.json');
    resolution.tools.parse('mutation-evidence-policy-v2.schema.json', mutationPolicy);
    const mutationPolicyDigest = canonicalSha256(mutationPolicy);
    const implementation = object(resolution.resolution['installed_package']);
    const wholeRoster = immutable(roster);
    const commonManifests = ['package.json', 'pnpm-workspace.yaml', ...manifests]
      .sort(compare)
      .map(file);
    const uniqueFiles = (values: readonly ReleaseMutationSourceMemberV21[]) =>
      [...new Map(values.map((member) => [member.path, member])).values()].sort((a, b) =>
        compare(a.path, b.path),
      );
    const dependencyClosure = (initial: string, unresolved: Set<string>): string[] => {
      const found = new Set<string>();
      const queue = [initial];
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const name = queue[cursor];
        if (!name || found.has(name)) continue;
        found.add(name);
        const record = byPackage.get(name);
        if (!record) return fail();
        for (const field of [
          'dependencies',
          'devDependencies',
          'optionalDependencies',
          'peerDependencies',
        ]) {
          const declarations = object(record.manifest[field] ?? {});
          for (const [dependencyName, rawRange] of Object.entries(declarations)) {
            const range = text(rawRange),
              dependency = byPackage.get(dependencyName);
            if (!dependency) {
              if (/^(?:workspace|file|link|npm):/u.test(range))
                unresolved.add('workspace-dependency-alias-unresolved');
              continue;
            }
            const version = text(dependency.manifest['version']);
            const requested = range.startsWith('workspace:')
              ? range.slice('workspace:'.length)
              : range;
            const effective =
              ['*', '^', '~'].includes(requested) && range.startsWith('workspace:')
                ? '*'
                : requested;
            if (!satisfies(version, effective, { includePrerelease: true })) {
              unresolved.add('workspace-dependency-range-unresolved');
            }
            queue.push(dependencyName);
          }
        }
      }
      return [...found].sort(compare);
    };
    const configurationClosure = (
      dependencyNames: readonly string[],
      unresolved: Set<string>,
    ): readonly ReleaseMutationSourceMemberV21[] => {
      const roots = dependencyNames.map((name) =>
        posix.dirname(path(byPackage.get(name)?.entry['manifest_path'])),
      );
      // Root shared TypeScript settings are inputs, not executable configuration or authority.
      const queue = currentTemplate
        ? [
            ...new Set(
              dependencyNames.map((name) => {
                const entry = byPackage.get(name)?.entry;
                const configured = path(entry?.['typescript_config_path']);
                if (!select(entry?.['config_paths']).some((member) => member.path === configured))
                  fail();
                file(configured);
                return configured;
              }),
            ),
          ]
        : candidate.paths.filter(
            (name) =>
              /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/u.test(name) &&
              (posix.dirname(name) === '.' || roots.includes(posix.dirname(name))),
          );
      const selected = new Map<string, ReleaseMutationSourceMemberV21>();
      const edges = new Map<string, string[]>();
      for (const root of roots)
        if (!currentTemplate && !members.has(`${root}/tsconfig.json`))
          unresolved.add('typescript-package-configuration-missing');
      const reference = (parent: string, raw: unknown, directory: boolean): void => {
        if (
          typeof raw !== 'string' ||
          (!directory && !raw.startsWith('.')) ||
          raw.startsWith('/') ||
          raw.includes('\\') ||
          /^[A-Za-z]:/u.test(raw)
        ) {
          unresolved.add('typescript-configuration-reference-unresolved');
          return;
        }
        const base = posix.normalize(posix.join(posix.dirname(parent), raw));
        if (base === '..' || base.startsWith('../')) {
          unresolved.add('typescript-configuration-reference-unresolved');
          return;
        }
        const alternatives = directory
          ? [base, `${base}/tsconfig.json`]
          : [base, `${base}.json`, `${base}/tsconfig.json`];
        const matches = [...new Set(alternatives.map((name) => posix.normalize(name)))].filter(
          (name) => members.has(name),
        );
        if (matches.length !== 1) {
          unresolved.add('typescript-configuration-reference-unresolved');
          return;
        }
        const resolved = matches[0];
        if (!resolved) return fail();
        edges.set(parent, [...(edges.get(parent) ?? []), resolved]);
        // A package project reference outside its manifest-derived source scope cannot silently
        // supply complete reusable inputs. The shared root project graph is captured as config.
        if (
          directory &&
          (currentTemplate || roots.includes(posix.dirname(parent))) &&
          !roots.includes(posix.dirname(resolved))
        )
          unresolved.add('typescript-project-dependency-unresolved');
        if (!selected.has(resolved) && !queue.includes(resolved)) queue.push(resolved);
      };
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const name = queue[cursor];
        if (!name || selected.size >= maximumEntries) return fail();
        if (selected.has(name)) continue;
        selected.set(name, file(name));
        // TypeScript's JSONC parser is pure. No readConfigFile, module loading or candidate eval.
        const parsed = parseConfigFileTextToJson(name, read(name).toString('utf8'));
        if (
          parsed.error ||
          parsed.config === null ||
          typeof parsed.config !== 'object' ||
          Array.isArray(parsed.config)
        ) {
          unresolved.add('typescript-configuration-syntax-unresolved');
          continue;
        }
        const config = object(parsed.config);
        if (config['extends'] !== undefined) {
          const references = Array.isArray(config['extends'])
            ? config['extends']
            : [config['extends']];
          for (const value of references) reference(name, value, false);
        }
        if (config['references'] !== undefined) {
          if (!Array.isArray(config['references']))
            unresolved.add('typescript-configuration-reference-unresolved');
          else
            for (const value of config['references']) {
              if (value === null || typeof value !== 'object' || Array.isArray(value))
                unresolved.add('typescript-configuration-reference-unresolved');
              else reference(name, object(value)['path'], true);
            }
        }
        const compiler = config['compilerOptions'];
        if (
          compiler !== undefined &&
          (compiler === null || typeof compiler !== 'object' || Array.isArray(compiler))
        )
          unresolved.add('typescript-configuration-syntax-unresolved');
        else if (compiler !== undefined && object(compiler)['paths'] !== undefined) {
          const options = object(compiler),
            aliases = options['paths'];
          const baseUrl = options['baseUrl'] ?? '.';
          if (
            aliases === null ||
            typeof aliases !== 'object' ||
            Array.isArray(aliases) ||
            typeof baseUrl !== 'string' ||
            baseUrl.startsWith('/') ||
            baseUrl.includes('\\')
          ) {
            unresolved.add('typescript-path-alias-resolution-unproven');
            continue;
          }
          for (const targets of Object.values(object(aliases))) {
            if (!Array.isArray(targets) || targets.length === 0) {
              unresolved.add('typescript-path-alias-resolution-unproven');
              continue;
            }
            for (const target of targets) {
              if (
                typeof target !== 'string' ||
                target.startsWith('/') ||
                target.includes('\\') ||
                target.split('*').length > 2 ||
                (target.includes('*') && !target.endsWith('*'))
              ) {
                unresolved.add('typescript-path-alias-resolution-unproven');
                continue;
              }
              const resolved = posix.normalize(
                posix.join(posix.dirname(name), baseUrl, target.replace(/\*$/u, '')),
              );
              // No path mapping grants additional source authority. A simple static mapping is
              // complete only inside a package population already bound by the dependency graph.
              if (
                !roots.some((root) => resolved === root || resolved.startsWith(`${root}/`)) ||
                !candidate.paths.some(
                  (item) =>
                    item === resolved || item.startsWith(`${resolved.replace(/\/$/u, '')}/`),
                )
              )
                unresolved.add('typescript-path-alias-resolution-unproven');
            }
          }
        }
      }
      const visited = new Set<string>(),
        visiting = new Set<string>();
      const visit = (name: string): void => {
        if (visiting.has(name)) {
          unresolved.add('typescript-configuration-cycle');
          return;
        }
        if (visited.has(name)) return;
        visiting.add(name);
        for (const dependency of edges.get(name) ?? []) visit(dependency);
        visiting.delete(name);
        visited.add(name);
      };
      for (const name of selected.keys()) visit(name);
      return [...selected.values()].sort((a, b) => compare(a.path, b.path));
    };
    const taskClosure = (initial: TaskDescriptorNode): TaskDescriptorNode[] => {
      const result = new Map<string, TaskDescriptorNode>(),
        visiting = new Set<string>();
      const visit = (node: TaskDescriptorNode): void => {
        if (visiting.has(node.nodeId)) fail();
        if (result.has(node.nodeId)) return;
        visiting.add(node.nodeId);
        for (const id of node.dependencies) {
          const dependency = descriptor.tasks.find((task) => task.nodeId === id);
          if (!dependency) return fail();
          visit(dependency);
        }
        visiting.delete(node.nodeId);
        result.set(node.nodeId, node);
      };
      visit(initial);
      return [...result.values()];
    };
    const effectiveEnvironment = protectedContainerTaskEnvironment(environment);
    const packages = roster.map((entry): ReleaseMutationInputPackageV21 => {
      const packageName = text(entry['package']),
        manifestPath = path(entry['manifest_path']);
      const root = posix.dirname(manifestPath),
        manifest = json(read(manifestPath));
      if (manifest['name'] !== packageName) fail('MUTATION_ROSTER_MISMATCH');
      const source = select(entry['source_selectors']),
        tests = select(entry['test_selectors']);
      if (source.length === 0 || tests.length === 0) fail();
      const targets = candidate.paths
        .filter(
          (name) =>
            name.startsWith(`${root}/src/`) &&
            targetExtensions.some((extension) => name.endsWith(extension)) &&
            !targetExclusions.some((suffix) => name.endsWith(suffix)) &&
            !name
              .slice(root.length + 1)
              .split('/')
              .some((segment) => targetSegments.includes(segment)),
        )
        .map((name) => {
          if (!source.some((member) => member.path === name)) return fail();
          return { ...file(name), path: name.slice(root.length + 1) };
        })
        .sort((a, b) => compare(a.path, b.path));
      if (targets.length === 0) fail('MUTATION_INCOMPLETE');
      const targetPopulationDigest = canonicalSha256(targets),
        targetProjectionDigest = canonicalSha256(targetRule);
      const task = descriptor.tasks.find((node) => node.nodeId === entry['task_node']);
      if (!task) return fail();
      const unresolved = new Set<string>();
      unresolved.add('toolchain-fixture-validation-required');
      if (dependencies.length === 0) unresolved.add('frozen-dependency-closure-missing');
      let dependencyNames = dependencyClosure(packageName, unresolved);
      if (
        unresolved.has('workspace-dependency-alias-unresolved') ||
        unresolved.has('workspace-dependency-range-unresolved')
      ) {
        // Explicit unknown-dependency fallback, never the normal per-package dependency scope.
        dependencyNames = [...byPackage.keys()].sort(compare);
      }
      const dependencySource = uniqueFiles(
        dependencyNames.flatMap((name) => select(byPackage.get(name)?.entry['source_selectors'])),
      );
      const nodes = taskClosure(task);
      const prerequisiteNodes = nodes.filter((node) => node.nodeId !== task.nodeId);
      const generatedPrerequisites = prerequisiteOutputs.filter((output) =>
        prerequisiteNodes.some((node) => node.nodeId === output.producer_task_node),
      );
      let prerequisitesVerified = false;
      if (prerequisiteProof !== undefined) {
        for (const node of prerequisiteNodes) {
          const executed = prerequisiteProof.tasks.find((entry) => entry.node_id === node.nodeId);
          if (executed === undefined || !same(executed.output_contract, node.outputContract))
            fail();
          if (node.outputContract['kind'] !== 'tracked-files') {
            for (const declared of strings(node.outputContract['paths'] ?? [])) {
              if (
                !generatedPrerequisites.some(
                  (output) => output.path === declared && output.producer_task_node === node.nodeId,
                )
              )
                fail();
            }
          }
        }
        prerequisitesVerified = true;
      }
      const prerequisiteInputs = uniqueFiles(
        nodes.flatMap((node) => {
          if (
            Object.keys(environment).some((key) => !node.allowlistedEnv.includes(key)) ||
            node.toolchainKeys.some((key) => !Object.hasOwn(toolchain, key))
          )
            fail();
          if (node.nodeId !== task.nodeId && node.outputContract['kind'] !== 'tracked-files')
            unresolved.add('prerequisite-output-proof-required');
          for (const selector of node.inputSelectors)
            if (!candidate.paths.some((name) => selectorMatches(selector, name)))
              unresolved.add('declared-task-input-unresolved');
          return candidate.paths
            .filter((name) =>
              node.inputSelectors.some((selector) => selectorMatches(selector, name)),
            )
            .map(file);
        }),
      );
      if (descriptor.dynamicFallbackSelectors.length !== 0)
        unresolved.add('dynamic-task-input-selection-unresolved');
      for (const key of strings(entry['toolchain_keys']))
        if (!Object.hasOwn(toolchain, key)) fail();
      const sourceThresholds = object(entry['thresholds']);
      if (
        (!currentTemplate && !same(sourceThresholds, { score_min: 60, survived_max: 50 })) ||
        typeof sourceThresholds['score_min'] !== 'number' ||
        !Number.isFinite(sourceThresholds['score_min']) ||
        sourceThresholds['score_min'] < 0 ||
        sourceThresholds['score_min'] > 100 ||
        typeof sourceThresholds['survived_max'] !== 'number' ||
        !Number.isSafeInteger(sourceThresholds['survived_max']) ||
        sourceThresholds['survived_max'] < 0
      )
        fail('MUTATION_THRESHOLD_MISMATCH');
      const scoreMin = sourceThresholds['score_min'],
        survivedMax = sourceThresholds['survived_max'];
      const thresholds = { break: scoreMin, high: scoreMin, low: scoreMin, scoreMin, survivedMax };
      const declaredConfig = select(entry['config_paths']);
      const typescriptClosure = configurationClosure(dependencyNames, unresolved);
      const config = uniqueFiles([...declaredConfig, ...typescriptClosure]),
        sanitizer = select(entry['sanitizer_paths']);
      const executionConfiguration = currentTemplate
        ? {
            task_node: task.nodeId,
            vitest_config: file(path(entry['vitest_config_path'])),
            typescript_config: file(path(entry['typescript_config_path'])),
            typescript_closure: typescriptClosure,
          }
        : undefined;
      if (
        executionConfiguration !== undefined &&
        [executionConfiguration.vitest_config, executionConfiguration.typescript_config].some(
          (selected) => !declaredConfig.some((member) => member.path === selected.path),
        )
      )
        fail();
      const orchestration = select(entry['orchestration_paths']);
      const lock = file(path(entry['lockfile_path']));
      const toolVersions: Record<string, string> = {};
      for (const key of ['node', 'pnpm', 'vitest', 'typescript', 'stryker']) {
        const version = toolchain[key];
        if (!version || !/^[A-Za-z0-9][A-Za-z0-9._+:-]*$/u.test(version)) return fail();
        toolVersions[key] = version;
      }
      if (toolVersions['stryker'] !== '9.6.1') fail('MUTATION_VERSION_UNSUPPORTED');
      const populations: Record<Binding, readonly unknown[]> = {
        source: dependencySource,
        tests,
        manifests: commonManifests,
        mutationConfiguration: [
          ...config,
          {
            template,
            mutation_targets: targets,
            target_population_digest: targetPopulationDigest,
            target_projection_digest: targetProjectionDigest,
          },
        ],
        runner: [
          ...orchestration,
          {
            template,
            tasks: nodes,
            implementation,
            ...(generatedPrerequisites.length === 0
              ? {}
              : { prerequisite_outputs: generatedPrerequisites }),
          },
        ],
        roster: wholeRoster,
        thresholds: [thresholds],
        sanitizer,
        lockfile: [lock],
        environment: Object.entries(effectiveEnvironment)
          .sort(([a], [b]) => compare(a, b))
          .map(([name, value]) => ({ name, value })),
        toolchain: [{ versions: toolchain, execution: containerIdentity }],
        semanticRebind: [
          {
            algorithm: ALGORITHM,
            implementation,
            mutation_policy_digest: mutationPolicyDigest,
            template,
            workspace_dependencies: dependencyNames,
            prerequisite_inputs: prerequisiteInputs,
            reuse_unresolved: [...unresolved].sort(compare),
          },
        ],
      };
      const rules: Record<Binding, unknown> = {
        source: {
          declared: entry['source_selectors'],
          workspace_dependencies: dependencyNames,
          dependency_fields: [
            'dependencies',
            'devDependencies',
            'optionalDependencies',
            'peerDependencies',
          ],
          unknown_dependency_fallback:
            unresolved.has('workspace-dependency-alias-unresolved') ||
            unresolved.has('workspace-dependency-range-unresolved'),
        },
        tests: entry['test_selectors'],
        manifests: commonManifests.map((member) => member.path),
        mutationConfiguration: {
          paths: entry['config_paths'],
          static_typescript_configuration_closure: config.map((member) => member.path),
          template,
          target_projection: targetRule,
        },
        runner: {
          paths: entry['orchestration_paths'],
          task_nodes: nodes.map((node) => node.nodeId),
          template,
        },
        roster: { order: 'id-lexicographic', whole_roster: true },
        thresholds: template['threshold_projection'],
        sanitizer: entry['sanitizer_paths'],
        lockfile: entry['lockfile_path'],
        environment: { allowlisted: task.allowlistedEnv, fixed_container_environment: true },
        toolchain: {
          declared_keys: entry['toolchain_keys'],
          complete_protected_execution_identity: true,
        },
        semanticRebind: { algorithm: ALGORITHM, implementation, template_id: TEMPLATE },
      };
      const projection = {
        schemaVersion: '2.1.0',
        kind: 'mutation-input-projection-v2',
        packageName,
        workspace: root,
        bindings: Object.fromEntries(
          BINDINGS.map((name) => [
            name,
            {
              canonicalization: 'rfc8785-jcs-utf8',
              memberCount: populations[name].length,
              populationDigest: canonicalSha256(populations[name]),
              selectionRuleDigest: canonicalSha256({
                algorithm: ALGORITHM,
                binding: name,
                file_matching: 'exact-or-directory-prefix-over-complete-git-tree',
                rule: rules[name],
              }),
            },
          ]),
        ),
      };
      resolution.tools.parse(
        'mutation-report-set-v2.schema.json#/$defs/input_projection',
        projection,
      );
      // Input identity binds the static fixture requirement, not this process's observation.
      // Discharge its operational blocker only after that unchanged projection is captured.
      if (fixtureValidated) unresolved.delete('toolchain-fixture-validation-required');
      if (prerequisitesVerified) unresolved.delete('prerequisite-output-proof-required');
      return immutable({
        id: text(entry['id']),
        input_digest: inputDigest(projection),
        expected: {
          packageName,
          workspace: root,
          inputProjection: projection,
          thresholds,
          toolVersions,
        },
        selected_source: source,
        selected_tests: tests,
        mutation_targets: targets,
        mutation_target_population_digest: targetPopulationDigest,
        mutation_target_projection_digest: targetProjectionDigest,
        workspace_dependencies: dependencyNames.filter((name) => name !== packageName),
        prerequisite_nodes: nodes
          .filter((node) => node.nodeId !== task.nodeId)
          .map((node) => node.nodeId),
        ...(executionConfiguration === undefined
          ? {}
          : { execution_configuration: executionConfiguration }),
        reuse: { eligible: unresolved.size === 0, unresolved: [...unresolved].sort(compare) },
      });
    });
    const proof = candidate.readProof([...captured.keys()].sort(compare));
    const result: ReleaseMutationInputPlanV21 = Object.freeze({
      repository: immutable(candidate.repository),
      release_unit: resolution.release_unit,
      release_plan_receipt_digest: text(receipt['receipt_digest_sha256']),
      release_profile_digest: canonicalSha256(profile),
      mutation_policy_digest: mutationPolicyDigest,
      template_id: TEMPLATE,
      execution_template_version: templateVersion,
      execution_coverage: immutable({
        kind: requestedCoverage.kind,
        ...coverageIdentity,
        expected_package_inputs_digest: canonicalSha256(
          packages.map((entry) => ({
            id: entry.id,
            package: entry.expected.packageName,
            input_digest: entry.input_digest,
            mutation_configuration: object(entry.expected.inputProjection['bindings'])[
              'mutationConfiguration'
            ],
          })),
        ),
      }),
      packages: Object.freeze(packages),
      toolchain_fixture_validation: immutable(fixtureValidation),
      grants: Object.freeze({ execution: false, certification: false, reuse: false }),
      readProof: () =>
        new Map(
          [...proof].map(([id, entry]) => [
            id,
            Object.freeze({ type: entry.type, bytes: Buffer.from(entry.bytes) }),
          ]),
        ),
    });
    derived.add(result);
    derivedPackages.set(result, canonicalSha256(implementation));
    derivedExecution.set(
      result,
      immutable({
        container_identity: containerIdentity,
        environment: effectiveEnvironment,
        repository: candidate.repository,
        candidate_files: [...members]
          .map(([path, member]) => ({ path, ...member }))
          .sort((a, b) => compare(a.path, b.path)),
        ...(prerequisiteProof === undefined ? {} : { prerequisite_outputs: prerequisiteOutputs }),
      }),
    );
    return result;
  } catch (error) {
    if (error instanceof Error && /^MUTATION_[A-Z0-9_]+$/u.test(error.message)) throw error;
    return fail();
  }
}
