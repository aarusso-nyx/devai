import { createHash } from 'node:crypto';
import { canonicalJson, parseConstitutionVersion } from '@devai-nyx/utils';
import { ADOPTER_POLICY_TARGETS, isJsonObject } from './adopter-policy.js';
import {
  parseAdopterPolicyBinding,
  verifyAdopterPolicyBindingSnapshot,
} from './adopter-policy-binding.js';
import {
  isVerifiedReleaseCandidateSnapshot,
  type ReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from './release-candidate-snapshot.js';
import {
  isVerifiedReleasePackageSnapshot,
  type ReleasePackageIdentity,
  type ReleasePackageSnapshot,
} from './release-package-snapshot.js';
import {
  createReleasePolicyPackageTools,
  type ReleasePolicyPackageTools,
} from './release-policy-package.js';
import { verifyReleasePolicyLockfiles } from './release-policy-lockfiles.js';

export interface ReleasePolicyExpectedIdentity {
  readonly repository: ReleaseCandidateSnapshot['repository'];
  readonly installed_package: ReleasePackageIdentity;
  readonly installation_origin: 'candidate-adopter-dependency' | 'external-producer-toolchain';
  readonly release_unit: string;
  readonly producer_toolchain?: Readonly<Record<string, unknown>>;
}

export interface VerifiedReleasePolicyResolution {
  readonly repository: ReleaseCandidateSnapshot['repository'];
  readonly release_unit: string;
  readonly resolution: Readonly<Record<string, unknown>>;
  readonly tools: ReleasePolicyPackageTools;
  readonly readInput: (
    kind: 'release-verification-profile' | 'release-lifecycle-policy' | 'action-registry-policy',
  ) => unknown;
}

/** Raw data only. Transport encoding is host-owned; these bytes never select code or trust. */
export interface ReleasePolicyResolutionEvidence {
  readonly archive: Uint8Array;
  readonly candidate_objects: ReadonlyMap<string, ReleaseGitObject>;
  readonly producer?: {
    readonly files: ReadonlyMap<string, Uint8Array>;
    readonly source_objects: ReadonlyMap<string, ReleaseGitObject>;
    readonly build_provenance: Uint8Array;
  };
}

const verified = new WeakSet<object>();
const inputResolvers = new WeakMap<object, VerifiedReleasePolicyResolution>();
const evidenceReaders = new WeakMap<object, () => ReleasePolicyResolutionEvidence>();
const INVALID = 'rpl-policy-resolution-mismatch';
const PROFILE = '.devai/config/release-verification.json';
const PROJECT = '.devai/config/project.json';
const PIN = '.devai/pin/constitution.md';
const BINDING = '.devai/config/adopter-policy-binding.json';

function fail(code = INVALID): never {
  throw new Error(code);
}
function object(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? value : fail();
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function json(bytes: Buffer): unknown {
  const text = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(text, 'utf8'))) return fail();
  return JSON.parse(text) as unknown;
}
function immutable<T>(value: T): T {
  const copy = JSON.parse(canonicalJson(value)) as T;
  const freeze = (node: unknown): void => {
    if (node !== null && typeof node === 'object') {
      for (const child of Object.values(node)) freeze(child);
      Object.freeze(node);
    }
  };
  freeze(copy);
  return copy;
}

export function isVerifiedReleasePolicyResolution(
  value: unknown,
): value is VerifiedReleasePolicyResolution {
  return value !== null && typeof value === 'object' && verified.has(value);
}

/** Export only the immutable inputs used by a genuine resolution, never later pathname reads. */
export function readReleasePolicyResolutionEvidence(
  resolution: VerifiedReleasePolicyResolution,
): ReleasePolicyResolutionEvidence {
  const read = evidenceReaders.get(resolution);
  return read === undefined ? fail() : read();
}

export function resolutionForReleasePlanInputResolver(
  resolver: unknown,
): VerifiedReleasePolicyResolution | undefined {
  return typeof resolver === 'function' ? inputResolvers.get(resolver) : undefined;
}

export function createResolvedReleasePlanInputResolver(
  resolution: VerifiedReleasePolicyResolution,
): (input: Readonly<Record<string, unknown>>) => unknown {
  if (!isVerifiedReleasePolicyResolution(resolution)) return fail();
  const resolver = (input: Readonly<Record<string, unknown>>): unknown => {
    const kind = input['kind'];
    if (kind === 'release-intent')
      return resolution.tools.parse('release-intent.schema.json', input['inline_document']);
    if (
      kind !== 'release-verification-profile' &&
      kind !== 'release-lifecycle-policy' &&
      kind !== 'action-registry-policy'
    )
      return fail('rpl-input-unresolved');
    return resolution.readInput(kind);
  };
  inputResolvers.set(resolver, resolution);
  return Object.freeze(resolver);
}

/** Common read-only resolution kernel for planning and all later replay boundaries. */
export function resolveReleasePolicySnapshot(input: {
  readonly expected: ReleasePolicyExpectedIdentity;
  readonly installed_package: ReleasePackageSnapshot;
  readonly candidate: ReleaseCandidateSnapshot;
  readonly producer?: {
    readonly files: ReadonlyMap<string, Uint8Array>;
    readonly source: ReleaseCandidateSnapshot;
    readonly build_provenance: Uint8Array;
  };
}): VerifiedReleasePolicyResolution {
  try {
    const expected = immutable(input.expected);
    if (
      !isVerifiedReleasePackageSnapshot(input.installed_package) ||
      !same(expected.installed_package, input.installed_package.identity)
    )
      return fail('rpl-package-identity-mismatch');
    if (
      !isVerifiedReleaseCandidateSnapshot(input.candidate) ||
      !same(expected.repository, input.candidate.repository) ||
      typeof expected.release_unit !== 'string' ||
      expected.release_unit.length === 0
    )
      return fail();
    const tools = createReleasePolicyPackageTools(input.installed_package);
    const candidate = input.candidate;
    if (!candidate.paths.includes(BINDING)) return fail('rpl-adopter-binding-mismatch');
    const parsedBinding = parseAdopterPolicyBinding(candidate.read(BINDING).toString('utf8'));
    if ('reason' in parsedBinding) return fail('rpl-adopter-binding-mismatch');
    if (!candidate.paths.includes(parsedBinding.binding.source_path))
      return fail('rpl-policy-source-unresolved');
    const files = new Map<string, Buffer>();
    for (const path of [BINDING, parsedBinding.binding.source_path, ...ADOPTER_POLICY_TARGETS]) {
      if (candidate.paths.includes(path)) files.set(path, candidate.read(path));
    }
    const binding = verifyAdopterPolicyBindingSnapshot({
      files,
      frameworkVersion: expected.installed_package.version,
      validatePolicy: (document) => {
        tools.parse('adopter-policy.schema.json', document);
        return true;
      },
      validateProject: (document) => {
        tools.parse('project-config.schema.json', document);
        return true;
      },
      materialize: tools.materialize,
    });
    const pin = candidate.read(PIN);
    const canonicalPin = input.installed_package.read('dist/law/constitution.md');
    const constitution = object(binding.project['constitution']);
    const version = parseConstitutionVersion(canonicalPin.toString('utf8'));
    if (
      version === null ||
      !pin.equals(canonicalPin) ||
      constitution['version'] !== version ||
      constitution['sha256'] !== sha256(pin)
    )
      return fail('rpl-adopter-binding-mismatch');
    const adopterDependency = expected.installation_origin === 'candidate-adopter-dependency';
    if (!adopterDependency && expected.installation_origin !== 'external-producer-toolchain')
      return fail();
    const locks = verifyReleasePolicyLockfiles({
      paths: candidate.paths,
      read: candidate.read,
      installed_package: input.installed_package,
      require_installed_dependency: adopterDependency,
    });
    let producerToolchain: Readonly<Record<string, unknown>> | undefined;
    let producerEvidence:
      (() => NonNullable<ReleasePolicyResolutionEvidence['producer']>) | undefined;
    if (adopterDependency) {
      if (expected.producer_toolchain !== undefined || input.producer !== undefined) return fail();
    } else {
      if (
        expected.repository.id !== 'aarusso-nyx/devai' ||
        expected.release_unit !== '@aarusso-nyx/devai' ||
        input.producer === undefined ||
        expected.producer_toolchain === undefined ||
        !isVerifiedReleaseCandidateSnapshot(input.producer.source)
      )
        return fail();
      const producer = input.producer;
      const toolchain = new Map(
        [...producer.files].map(([path, bytes]) => [path, Buffer.from(bytes)]),
      );
      const toolchainLocks = verifyReleasePolicyLockfiles({
        paths: [...toolchain.keys()],
        read: (path) => toolchain.get(path) ?? fail(),
        installed_package: input.installed_package,
        require_installed_dependency: true,
      });
      const provenanceBytes = Buffer.from(producer.build_provenance);
      const provenance = tools.parse<Record<string, unknown>>(
        'release-policy-resolution.schema.json#/$defs/producer_build_provenance',
        json(provenanceBytes),
      );
      const sourceClaim = object(provenance['producer_source']);
      if (
        sourceClaim['repository_id'] !== 'aarusso-nyx/devai' ||
        !same(producer.source.repository, {
          id: sourceClaim['repository_id'],
          commit: sourceClaim['commit'],
          tree: sourceClaim['tree'],
        })
      )
        return fail();
      const sourceManifest = object(sourceClaim['package_manifest']);
      if (typeof sourceManifest['path'] !== 'string') return fail();
      const sourceBytes = producer.source.read(sourceManifest['path']);
      const sourcePackage = object(json(sourceBytes));
      if (
        sha256(sourceBytes) !== sourceManifest['sha256'] ||
        sourcePackage['name'] !== expected.installed_package.name ||
        sourcePackage['version'] !== expected.installed_package.version
      )
        return fail();
      const toolchainIdentity = {
        package_manager: toolchainLocks.package_manager,
        package_manifest: toolchainLocks.package_manifest,
        lockfiles: toolchainLocks.lockfiles,
      };
      if (
        !same(provenance['installed_package'], expected.installed_package) ||
        !same(provenance['toolchain'], toolchainIdentity)
      )
        return fail();
      producerToolchain = {
        ...toolchainIdentity,
        producer_source: { ...sourceClaim, build_provenance_sha256: sha256(provenanceBytes) },
      };
      if (!same(producerToolchain, expected.producer_toolchain)) return fail();
      const sourcePath = sourceManifest['path'];
      const sourceSnapshot = producer.source;
      const toolchainPaths = [
        toolchainLocks.package_manifest.path,
        ...toolchainLocks.lockfiles.map((lock) => lock.path),
      ];
      producerEvidence = () => ({
        files: new Map(
          toolchainPaths.map((path) => [path, Buffer.from(toolchain.get(path) ?? fail())]),
        ),
        source_objects: sourceSnapshot.readProof([sourcePath]),
        build_provenance: Buffer.from(provenanceBytes),
      });
    }
    const resolution = tools.parse<Readonly<Record<string, unknown>>>(
      'release-policy-resolution.schema.json',
      {
        schemaVersion: '1.0.0',
        resolver_id: 'devai.release-policy-resolution.v1',
        installed_package: expected.installed_package,
        installation_origin: expected.installation_origin,
        package_manager: locks.package_manager,
        adopter_package: locks.package_manifest,
        lockfiles: locks.lockfiles,
        project: { path: PROJECT, sha256: sha256(candidate.read(PROJECT)) },
        constitution: { path: PIN, sha256: sha256(pin) },
        adopter_policy: binding.adopter_policy,
        binding_receipt: binding.binding_receipt,
        materialized: binding.materialized,
        ...(producerToolchain === undefined ? {} : { producer_toolchain: producerToolchain }),
      },
    );
    const documents = new Map<string, unknown>([
      [
        'release-verification-profile',
        tools.parse('release-verification-profile.schema.json', json(candidate.read(PROFILE))),
      ],
      [
        'release-lifecycle-policy',
        tools.parse(
          'release-lifecycle-policy.schema.json',
          tools.readJson('dist/law/policy/release-lifecycle.json'),
        ),
      ],
      [
        'action-registry-policy',
        tools.parse(
          'action-registry.schema.json',
          tools.readJson('dist/law/policy/action-registry.json'),
        ),
      ],
    ]);
    const result: VerifiedReleasePolicyResolution = Object.freeze({
      repository: immutable(expected.repository),
      release_unit: expected.release_unit,
      resolution: immutable(resolution),
      tools,
      readInput: (kind: Parameters<VerifiedReleasePolicyResolution['readInput']>[0]) =>
        immutable(documents.get(kind) ?? fail('rpl-input-unresolved')),
    });
    verified.add(result);
    const candidatePaths = [
      ...new Set([
        BINDING,
        parsedBinding.binding.source_path,
        ...ADOPTER_POLICY_TARGETS,
        PIN,
        locks.package_manifest.path,
        ...locks.lockfiles.map((lock) => lock.path),
      ]),
    ].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const installed = input.installed_package;
    evidenceReaders.set(result, () => ({
      archive: installed.readArchive(),
      candidate_objects: candidate.readProof(candidatePaths),
      ...(producerEvidence === undefined ? {} : { producer: producerEvidence() }),
    }));
    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      [
        INVALID,
        'rpl-package-identity-mismatch',
        'rpl-adopter-binding-mismatch',
        'rpl-input-unresolved',
        'rpl-policy-source-unresolved',
      ].includes(error.message)
    )
      throw error;
    return fail();
  }
}
