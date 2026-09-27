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
import { createProtectedReleaseRepositoryContext } from '@devai-nyx/authority';
import { isVerifiedReleaseCandidateSnapshot } from './release-candidate-snapshot.js';
import type { ReleasePackageSnapshot } from './release-package-snapshot.js';
import { resolveReleasePolicySnapshot } from './release-policy-resolution.js';
import { buildResolvedReleasePlanReceipt } from './release-lifecycle.js';
import { canonicalContainerPath } from './container-archive.js';
import type { ProtectedReleasePlanMaterial } from './release-certification-provider.js';
import type { ImmutableReleaseContentSource } from './release-prepare-kernel.js';
import type {
  ProtectedReleaseInputFile,
  ProtectedReleaseHostLaneControls,
  ProtectedReleaseHostRunnerControls,
} from './release-protected-host-runner-types.js';

const INVALID = 'release-host-controls-invalid';
export const INPUT_INVALID = 'release-host-input-mismatch';
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export function fail(code = INVALID): never {
  throw new Error(code);
}
export function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
export function copy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
export function closed(
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
export function regularInput(input: ProtectedReleaseInputFile, maximum: number): unknown {
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
export function captureReleaseHostLane(
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
