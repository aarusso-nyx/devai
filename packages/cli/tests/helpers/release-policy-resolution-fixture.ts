import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { canonicalSha256, parseConstitutionVersion } from '@devai-nyx/utils';
import { resolveCanonicalPolicyContent } from '@devai-nyx/skills';
import {
  jsonBytes,
  resolveAdopterPolicyMaterialization,
} from '../../src/services/adopter-policy.js';
import {
  createResolvedReleasePlanInputResolver,
  readReleasePolicyResolutionEvidence,
  resolveReleasePolicySnapshot,
  type VerifiedReleasePolicyResolution,
} from '../../src/services/release-policy-resolution.js';
import {
  verifyReleaseCandidateSnapshot,
  type ReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from '../../src/services/release-candidate-snapshot.js';
import {
  verifyReleasePackageSnapshot,
  type ReleasePackageFile,
  type ReleasePackageSnapshot,
} from '../../src/services/release-package-snapshot.js';
import { verifyReleasePolicyLockfiles } from '../../src/services/release-policy-lockfiles.js';
import { buildResolvedReleasePlanReceipt } from '../../src/services/release-lifecycle.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PACKAGE = '@aarusso-nyx/devai';
const VERSION = '1.4.5';
const TARGET = '1.5.0';
const SOURCE = 'law/policy/adopter-policy.json';
const BINDING = '.devai/config/adopter-policy-binding.json';
const PIN = '.devai/pin/constitution.md';

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function octal(header: Buffer, offset: number, width: number, value: number): void {
  header.write(value.toString(8).padStart(width - 1, '0'), offset, width - 1, 'ascii');
  header[offset + width - 1] = 0;
}
function tar(files: readonly ReleasePackageFile[]): Buffer {
  const records: Buffer[] = [];
  for (const file of files) {
    const path = `package/${file.path}`;
    if (Buffer.byteLength(path) > 100) throw new Error('fixture path');
    const bytes = Buffer.from(file.bytes);
    const header = Buffer.alloc(512);
    header.write(path);
    octal(header, 100, 8, file.mode);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, bytes.length);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    octal(
      header,
      148,
      8,
      header.reduce((sum, byte) => sum + byte, 0),
    );
    records.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
}
function packageSnapshot(): ReleasePackageSnapshot {
  const schemaRoot = join(ROOT, 'law/schemas');
  const policyRoot = join(ROOT, 'law/policy');
  const files: ReleasePackageFile[] = [
    {
      path: 'package.json',
      mode: 0o644,
      bytes: Buffer.from(`{"name":"${PACKAGE}","version":"${VERSION}"}\n`),
    },
    {
      path: 'dist/law/constitution.md',
      mode: 0o644,
      bytes: readFileSync(join(ROOT, 'law/constitution.md')),
    },
    ...readdirSync(schemaRoot)
      .filter((name) => name.endsWith('.schema.json'))
      .sort()
      .map((name) => ({
        path: `dist/runtime/index/schemas/${name}`,
        mode: 0o644,
        bytes: readFileSync(join(schemaRoot, name)),
      })),
    ...(['domains.json', 'thresholds.json', 'scorecard-na.json', 'glob-guards.json'] as const).map(
      (name) => ({
        path: `dist/law/policy/${name}`,
        mode: 0o644,
        bytes: Buffer.from(resolveCanonicalPolicyContent(name)),
      }),
    ),
    ...['release-lifecycle.json', 'action-registry.json'].map((name) => ({
      path: `dist/law/policy/${name}`,
      mode: 0o644,
      bytes: readFileSync(join(policyRoot, name)),
    })),
  ];
  const archive = tar(files);
  const manifest = files
    .map((file) => ({
      path: file.path,
      mode: file.mode,
      size: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const dirs = [
    ...new Set(
      files.flatMap((file) =>
        Array.from({ length: file.path.split('/').length - 1 }, (_, i) =>
          file.path
            .split('/')
            .slice(0, i + 1)
            .join('/'),
        ),
      ),
    ),
  ].sort();
  return verifyReleasePackageSnapshot({
    expected: {
      name: PACKAGE,
      version: VERSION,
      archive_sha256: sha256(archive),
      content_manifest_sha256: canonicalSha256(manifest),
    },
    archive,
    installed_files: files,
    installed_directories: dirs,
    maximum_archive_bytes: archive.length,
    maximum_unpacked_bytes: 4 * 1024 * 1024,
  });
}
function oid(type: ReleaseGitObject['type'], bytes: Uint8Array): string {
  return createHash('sha1').update(`${type} ${bytes.byteLength}\0`).update(bytes).digest('hex');
}
function git(
  files: ReadonlyMap<string, Uint8Array>,
  repository = 'aarusso-nyx/devai',
): {
  readonly snapshot: ReleaseCandidateSnapshot;
  readonly objects: ReadonlyMap<string, ReleaseGitObject>;
} {
  type Node = { children: Map<string, Node | { bytes: Buffer }> };
  const root: Node = { children: new Map() };
  const objects = new Map<string, ReleaseGitObject>();
  for (const [path, value] of files) {
    const parts = path.split('/');
    const leaf = parts.pop();
    if (leaf === undefined) throw new Error('fixture path');
    let node = root;
    for (const part of parts) {
      const current = node.children.get(part);
      const next = current ?? { children: new Map() };
      if ('bytes' in next) throw new Error('fixture collision');
      node.children.set(part, next);
      node = next;
    }
    node.children.set(leaf, { bytes: Buffer.from(value) });
  }
  const tree = (node: Node): string => {
    const entries = [...node.children]
      .map(([name, child]) => {
        if ('bytes' in child) {
          const id = oid('blob', child.bytes);
          objects.set(id, { type: 'blob', bytes: child.bytes });
          return { name, mode: '100644', id };
        }
        return { name, mode: '40000', id: tree(child) };
      })
      .sort((a, b) =>
        Buffer.compare(
          Buffer.from(`${a.name}${a.mode === '40000' ? '/' : ''}`),
          Buffer.from(`${b.name}${b.mode === '40000' ? '/' : ''}`),
        ),
      );
    const bytes = Buffer.concat(
      entries.map((entry) =>
        Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.id, 'hex')]),
      ),
    );
    const id = oid('tree', bytes);
    objects.set(id, { type: 'tree', bytes });
    return id;
  };
  const treeId = tree(root);
  const commitBytes = Buffer.from(
    `tree ${treeId}\nauthor Fixture <fixture@example.invalid> 0 +0000\n\nfixture\n`,
  );
  const commit = oid('commit', commitBytes);
  objects.set(commit, { type: 'commit', bytes: commitBytes });
  return {
    snapshot: verifyReleaseCandidateSnapshot({
      repository: { id: repository, commit, tree: treeId },
      objects,
      maximum_bytes: 4 * 1024 * 1024,
      maximum_entries: 2000,
    }),
    objects,
  };
}

export interface LifecyclePolicyFixture {
  readonly package_snapshot: ReleasePackageSnapshot;
  readonly candidate: ReleaseCandidateSnapshot;
  readonly objects: ReadonlyMap<string, ReleaseGitObject>;
  readonly resolution: VerifiedReleasePolicyResolution;
  readonly receipt: ReturnType<typeof buildResolvedReleasePlanReceipt>;
  readonly resolve_plan_input: (input: Readonly<Record<string, unknown>>) => unknown;
  readonly intent: Readonly<Record<string, unknown>>;
  readonly package_json: Buffer;
  readonly expected: Parameters<typeof resolveReleasePolicySnapshot>[0]['expected'];
}

export interface LifecyclePolicyResolutionSetFixture {
  readonly package_snapshot: ReleasePackageSnapshot;
  readonly candidate: ReleaseCandidateSnapshot;
  readonly resolutions: readonly VerifiedReleasePolicyResolution[];
  readonly receipts: readonly ReturnType<typeof buildResolvedReleasePlanReceipt>[];
  readonly intents: readonly Readonly<Record<string, unknown>>[];
  readonly foreign_resolution: VerifiedReleasePolicyResolution;
}

/**
 * Two independently verified release units deliberately share one candidate,
 * installed package, and materialized policy binding.  This is the only
 * supported multi-unit shape for a single candidate replay.
 */
export function createLifecyclePolicyResolutionSetFixture(): LifecyclePolicyResolutionSetFixture {
  const checked = packageSnapshot();
  const pin = checked.read('dist/law/constitution.md');
  const version = parseConstitutionVersion(pin.toString());
  if (version === null) throw new Error('fixture constitution');
  const document = {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.multi-unit-policy',
    policy_version: '1.0.0',
    release_verification: {
      schemaVersion: '1.0.0',
      policy_id: 'fixture.multi-unit-profile',
      policy_version: '1.0.0',
      release_unit: '@fixture/unit-one',
      version_source: 'package.json',
      default_support: 'current',
      capability_tasks: { lint: ['lint'] },
      risk_capabilities: {},
      mutation_roster: [],
    },
  };
  const materialized = resolveAdopterPolicyMaterialization({
    policy: document,
    currentProject: {
      schemaVersion: '1.0.0',
      project_type: 'framework',
      constitution: { version, sha256: sha256(pin) },
    },
    frameworkVersion: VERSION,
  });
  const policyBytes = Buffer.from(jsonBytes(document));
  const binding = {
    schemaVersion: '1.0.0',
    policy_id: document.policy_id,
    policy_version: document.policy_version,
    source_path: SOURCE,
    source_digest_sha256: sha256(policyBytes),
    materialized: Object.fromEntries(
      [...materialized].map(([path, bytes]) => [path, sha256(Buffer.from(bytes))]),
    ),
  };
  const dependency = { [PACKAGE]: VERSION };
  const candidateFiles = new Map<string, Uint8Array>([
    [SOURCE, policyBytes],
    [BINDING, Buffer.from(jsonBytes(binding))],
    ...[...materialized].map(([path, bytes]) => [path, Buffer.from(bytes)] as const),
    [PIN, pin],
    [
      'package.json',
      Buffer.from(
        JSON.stringify({
          name: 'fixture-multi-unit-adopter',
          version: '1.0.0',
          packageManager: 'npm@10.8.2',
          dependencies: dependency,
        }),
      ),
    ],
    [
      'package-lock.json',
      Buffer.from(
        JSON.stringify({
          name: 'fixture-multi-unit-adopter',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: {
            '': { dependencies: dependency },
            [`node_modules/${PACKAGE}`]: {
              version: VERSION,
              integrity: `sha512-${createHash('sha512').update(checked.readArchive()).digest('base64')}`,
            },
          },
        }),
      ),
    ],
  ]);
  const candidateResult = git(candidateFiles, 'fixture/multi-unit');
  const makeResolution = (release_unit: string, candidate = candidateResult.snapshot) =>
    resolveReleasePolicySnapshot({
      expected: {
        repository: candidate.repository,
        installed_package: checked.identity,
        installation_origin: 'candidate-adopter-dependency',
        release_unit,
      },
      installed_package: checked,
      candidate,
    });
  const units = ['@fixture/unit-one', '@fixture/unit-two'] as const;
  const resolutions = units.map((release_unit) => makeResolution(release_unit));
  const intents = units.map((release_unit) => ({
    schemaVersion: '1.0.0',
    release_unit,
    current_version: VERSION,
    target_version: '1.4.6',
    support: 'current',
    change_kind: 'behavioral',
    changed_paths: ['packages/cli/src/services/release-policy-resolution.ts'],
    changed_packages: [PACKAGE],
    candidate: {
      commit: candidateResult.snapshot.repository.commit,
      tree: candidateResult.snapshot.repository.tree,
    },
    base: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  }));
  const foreignCandidate = git(candidateFiles, 'fixture/foreign-multi-unit').snapshot;
  return {
    package_snapshot: checked,
    candidate: candidateResult.snapshot,
    resolutions,
    receipts: intents.map((intent, index) =>
      buildResolvedReleasePlanReceipt({
        intent,
        resolution:
          resolutions[index] ??
          (() => {
            throw new Error('fixture resolution');
          })(),
      }),
    ),
    intents,
    foreign_resolution: makeResolution('@fixture/foreign-unit', foreignCandidate),
  };
}

/**
 * Materialize the same candidate-bound policy evidence used by the in-memory
 * fixture into an already initialized repository, then resolve it from the
 * repository's real Git objects.  Callers commit only after this returns from
 * its materialization phase, so the candidate commit includes every binding.
 */
export function createFilesystemLifecyclePolicyFixture(input: {
  readonly root: string;
  readonly base: { readonly commit: string; readonly tree: string };
  readonly git: (args: readonly string[]) => string;
  readonly readGitObject: (type: ReleaseGitObject['type'], object_id: string) => Buffer;
  readonly package_manifest: Uint8Array;
}): Omit<LifecyclePolicyFixture, 'candidate' | 'resolution' | 'receipt' | 'resolve_plan_input'> & {
  readonly candidate: ReleaseCandidateSnapshot;
  readonly resolution: VerifiedReleasePolicyResolution;
  readonly receipt: ReturnType<typeof buildResolvedReleasePlanReceipt>;
  readonly resolve_plan_input: (input: Readonly<Record<string, unknown>>) => unknown;
} {
  const fixture = createLifecyclePolicyFixture();
  for (const path of fixture.candidate.paths) {
    const target = join(input.root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, fixture.candidate.read(path));
  }
  mkdirSync(join(input.root, 'packages/cli'), { recursive: true });
  writeFileSync(join(input.root, 'packages/cli/package.json'), input.package_manifest);
  input.git(['add', '.']);
  input.git(['commit', '-qm', 'candidate-policy-bound']);

  const commit = input.git(['rev-parse', 'HEAD']);
  const tree = input.git(['rev-parse', 'HEAD^{tree}']);
  const objectIds = new Set<string>([
    commit,
    ...input
      .git(['rev-list', '--objects', commit])
      .split('\n')
      .map((line) => line.split(' ', 1)[0])
      .filter((value): value is string => value !== undefined && /^[0-9a-f]{40}$/.test(value)),
  ]);
  const objects = new Map<string, ReleaseGitObject>();
  for (const object_id of objectIds) {
    const type = input.git(['cat-file', '-t', object_id]) as ReleaseGitObject['type'];
    if (!['blob', 'tree', 'commit'].includes(type)) throw new Error('fixture Git object type');
    objects.set(object_id, { type, bytes: input.readGitObject(type, object_id) });
  }
  const candidate = verifyReleaseCandidateSnapshot({
    repository: { id: 'aarusso-nyx/devai', commit, tree },
    objects,
    maximum_bytes: 4 * 1024 * 1024,
    maximum_entries: 2000,
  });
  const evidence = readReleasePolicyResolutionEvidence(fixture.resolution);
  const producer = evidence.producer;
  if (producer === undefined) throw new Error('fixture producer evidence');
  const provenance = JSON.parse(Buffer.from(producer.build_provenance).toString('utf8')) as {
    readonly producer_source: {
      readonly repository_id: string;
      readonly commit: string;
      readonly tree: string;
    };
  };
  const source = verifyReleaseCandidateSnapshot({
    repository: {
      id: provenance.producer_source.repository_id,
      commit: provenance.producer_source.commit,
      tree: provenance.producer_source.tree,
    },
    objects: producer.source_objects,
    maximum_bytes: 4 * 1024 * 1024,
    maximum_entries: 2000,
  });
  const expected = { ...fixture.expected, repository: candidate.repository };
  const resolution = resolveReleasePolicySnapshot({
    expected,
    installed_package: fixture.package_snapshot,
    candidate,
    producer: {
      files: producer.files,
      source,
      build_provenance: producer.build_provenance,
    },
  });
  const intent = {
    ...fixture.intent,
    candidate: { commit, tree },
    base: input.base,
  };
  return {
    ...fixture,
    candidate,
    resolution,
    receipt: buildResolvedReleasePlanReceipt({ intent, resolution }),
    resolve_plan_input: createResolvedReleasePlanInputResolver(resolution),
    intent,
    expected,
  };
}

export function createLifecyclePolicyFixture(): LifecyclePolicyFixture {
  const checked = packageSnapshot();
  const pin = checked.read('dist/law/constitution.md');
  const version = parseConstitutionVersion(pin.toString());
  if (version === null) throw new Error('fixture constitution');
  const policy = {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.adopter-policy',
    policy_version: '1.0.0',
    release_verification: {
      schemaVersion: '1.0.0',
      policy_id: 'fixture.release-profile',
      policy_version: '1.0.0',
      release_unit: PACKAGE,
      version_source: 'package.json',
      default_support: 'current',
      capability_tasks: { lint: ['lint'] },
      risk_capabilities: {},
      mutation_roster: [],
    },
  };
  const materialized = resolveAdopterPolicyMaterialization({
    policy,
    currentProject: {
      schemaVersion: '1.0.0',
      project_type: 'framework',
      constitution: { version, sha256: sha256(pin) },
    },
    frameworkVersion: VERSION,
  });
  const policyBytes = Buffer.from(jsonBytes(policy));
  const binding = {
    schemaVersion: '1.0.0',
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    source_path: SOURCE,
    source_digest_sha256: sha256(policyBytes),
    materialized: Object.fromEntries(
      [...materialized].map(([path, bytes]) => [path, sha256(Buffer.from(bytes))]),
    ),
  };
  const package_json = Buffer.from(
    JSON.stringify({
      name: PACKAGE,
      version: TARGET,
      packageManager: 'npm@10.8.2',
      dependencies: { leftpad: '1.3.0' },
    }),
  );
  const candidateLock = {
    name: PACKAGE,
    version: TARGET,
    lockfileVersion: 3,
    packages: { '': { dependencies: { leftpad: '1.3.0' } } },
  };
  const files = new Map<string, Uint8Array>([
    [SOURCE, policyBytes],
    [BINDING, Buffer.from(jsonBytes(binding))],
    ...[...materialized].map(([path, bytes]) => [path, Buffer.from(bytes)] as const),
    [PIN, pin],
    ['package.json', package_json],
    ['package-lock.json', Buffer.from(JSON.stringify(candidateLock))],
  ]);
  const candidate = git(files);
  const toolchain = new Map(files);
  const dependency = { [PACKAGE]: VERSION };
  toolchain.set(
    'package.json',
    Buffer.from(
      JSON.stringify({
        name: 'toolchain',
        version: '1.0.0',
        packageManager: 'npm@10.8.2',
        dependencies: dependency,
      }),
    ),
  );
  toolchain.set(
    'package-lock.json',
    Buffer.from(
      JSON.stringify({
        name: 'toolchain',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: dependency },
          [`node_modules/${PACKAGE}`]: {
            version: VERSION,
            integrity: `sha512-${createHash('sha512').update(checked.readArchive()).digest('base64')}`,
          },
        },
      }),
    ),
  );
  const locks = verifyReleasePolicyLockfiles({
    paths: [...toolchain.keys()],
    read: (path) =>
      Buffer.from(
        toolchain.get(path) ??
          (() => {
            throw new Error('missing');
          })(),
      ),
    installed_package: checked,
    require_installed_dependency: true,
  });
  const source = git(
    new Map([['package.json', Buffer.from(`{"name":"${PACKAGE}","version":"${VERSION}"}\n`)]]),
  );
  const sourceBytes = source.snapshot.read('package.json');
  const provenance = Buffer.from(
    JSON.stringify({
      schemaVersion: '1.0.0',
      producer_source: {
        repository_id: 'aarusso-nyx/devai',
        commit: source.snapshot.repository.commit,
        tree: source.snapshot.repository.tree,
        package_manifest: { path: 'package.json', sha256: sha256(sourceBytes) },
      },
      installed_package: checked.identity,
      toolchain: {
        package_manager: locks.package_manager,
        package_manifest: locks.package_manifest,
        lockfiles: locks.lockfiles,
      },
    }),
  );
  const producer_toolchain = {
    package_manager: locks.package_manager,
    package_manifest: locks.package_manifest,
    lockfiles: locks.lockfiles,
    producer_source: {
      repository_id: 'aarusso-nyx/devai',
      commit: source.snapshot.repository.commit,
      tree: source.snapshot.repository.tree,
      package_manifest: { path: 'package.json', sha256: sha256(sourceBytes) },
      build_provenance_sha256: sha256(provenance),
    },
  };
  const expected = {
    repository: candidate.snapshot.repository,
    installed_package: checked.identity,
    installation_origin: 'external-producer-toolchain',
    release_unit: PACKAGE,
    producer_toolchain,
  } as const;
  const resolution = resolveReleasePolicySnapshot({
    expected,
    installed_package: checked,
    candidate: candidate.snapshot,
    producer: { files: toolchain, source: source.snapshot, build_provenance: provenance },
  });
  const intent = {
    schemaVersion: '1.0.0',
    release_unit: PACKAGE,
    current_version: VERSION,
    target_version: TARGET,
    support: 'current',
    change_kind: 'behavioral',
    changed_paths: ['packages/cli/src/services/release-lifecycle-execution.ts'],
    changed_packages: [PACKAGE],
    candidate: {
      commit: candidate.snapshot.repository.commit,
      tree: candidate.snapshot.repository.tree,
    },
    base: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  };
  return {
    package_snapshot: checked,
    candidate: candidate.snapshot,
    objects: candidate.objects,
    resolution,
    receipt: buildResolvedReleasePlanReceipt({ intent, resolution }),
    resolve_plan_input: createResolvedReleasePlanInputResolver(resolution),
    intent,
    package_json,
    expected,
  };
}
