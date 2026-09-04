import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
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
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly resolve_plan_input: (input: Readonly<Record<string, unknown>>) => unknown;
  readonly intent: Readonly<Record<string, unknown>>;
  readonly package_json: Buffer;
  readonly expected: Parameters<typeof resolveReleasePolicySnapshot>[0]['expected'];
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
