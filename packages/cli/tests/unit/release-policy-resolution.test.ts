import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canonicalSha256, parseConstitutionVersion } from '@devai-nyx/utils';
import { resolveCanonicalPolicyContent } from '@devai-nyx/skills';
import {
  jsonBytes,
  resolveAdopterPolicyMaterialization,
} from '../../src/services/adopter-policy.js';
import {
  verifyReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from '../../src/services/release-candidate-snapshot.js';
import {
  verifyReleasePackageSnapshot,
  type ReleasePackageFile,
} from '../../src/services/release-package-snapshot.js';
import {
  isVerifiedReleasePolicyResolution,
  resolveReleasePolicySnapshot,
} from '../../src/services/release-policy-resolution.js';
import {
  buildResolvedReleasePlanReceipt,
  verifyResolvedReleasePlanReceipt,
} from '../../src/services/release-lifecycle.js';
import { verifyReleasePolicyLockfiles } from '../../src/services/release-policy-lockfiles.js';
import { createLifecyclePolicyFixture } from '../helpers/release-policy-resolution-fixture.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCHEMAS = join(ROOT, 'law/schemas');
const POLICY = join(ROOT, 'law/policy');
const VERSION = '1.4.5';
const PACKAGE = '@aarusso-nyx/devai';
const BINDING = '.devai/config/adopter-policy-binding.json';
const SOURCE = 'law/policy/adopter-policy.json';
const PIN = '.devai/pin/constitution.md';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function octal(target: Buffer, offset: number, width: number, value: number): void {
  target.write(value.toString(8).padStart(width - 1, '0'), offset, width - 1, 'ascii');
  target[offset + width - 1] = 0;
}

function archive(files: readonly ReleasePackageFile[]): Buffer {
  const records: Buffer[] = [];
  for (const file of files) {
    const path = `package/${file.path}`;
    if (Buffer.byteLength(path, 'utf8') > 100) throw new Error(`fixture path too long: ${path}`);
    const bytes = Buffer.from(file.bytes);
    const header = Buffer.alloc(512);
    header.write(path, 0, 'utf8');
    octal(header, 100, 8, file.mode);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, bytes.byteLength);
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
    records.push(header, bytes, Buffer.alloc((512 - (bytes.byteLength % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
}

function installedPackage() {
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
    ...readdirSync(SCHEMAS)
      .filter((name) => name.endsWith('.schema.json'))
      .sort()
      .map(
        (name) =>
          ({
            path: `dist/runtime/index/schemas/${name}`,
            mode: 0o644,
            bytes: readFileSync(join(SCHEMAS, name)),
          }) satisfies ReleasePackageFile,
      ),
    ...(['domains.json', 'thresholds.json', 'scorecard-na.json', 'glob-guards.json'] as const).map(
      (name) =>
        ({
          path: `dist/law/policy/${name}`,
          mode: 0o644,
          bytes: Buffer.from(resolveCanonicalPolicyContent(name)),
        }) satisfies ReleasePackageFile,
    ),
    ...['release-lifecycle.json', 'action-registry.json'].map(
      (name) =>
        ({
          path: `dist/law/policy/${name}`,
          mode: 0o644,
          bytes: readFileSync(join(POLICY, name)),
        }) satisfies ReleasePackageFile,
    ),
  ];
  const compressed = archive(files);
  const manifest = files
    .map(({ path, mode, bytes }) => ({ path, mode, size: bytes.byteLength, sha256: sha256(bytes) }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return verifyReleasePackageSnapshot({
    expected: {
      name: PACKAGE,
      version: VERSION,
      archive_sha256: sha256(compressed),
      content_manifest_sha256: canonicalSha256(manifest),
    },
    archive: compressed,
    installed_files: files,
    installed_directories: [
      ...new Set(
        files.flatMap(({ path }) =>
          Array.from({ length: path.split('/').length - 1 }, (_, index) =>
            path
              .split('/')
              .slice(0, index + 1)
              .join('/'),
          ),
        ),
      ),
    ].sort(),
    maximum_archive_bytes: compressed.byteLength,
    maximum_unpacked_bytes: 4 * 1024 * 1024,
  });
}

function gitId(type: ReleaseGitObject['type'], bytes: Uint8Array): string {
  return createHash('sha1').update(`${type} ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function candidate(files: ReadonlyMap<string, Uint8Array>, repositoryId = 'fixture/repository') {
  const objects = new Map<string, ReleaseGitObject>();
  type Tree = { readonly children: Map<string, Tree | { readonly bytes: Buffer }> };
  const root: Tree = { children: new Map() };
  for (const [path, source] of files) {
    const parts = path.split('/');
    const name = parts.pop();
    if (name === undefined) throw new Error('missing fixture name');
    let cursor = root;
    for (const part of parts) {
      const found = cursor.children.get(part);
      if (found !== undefined && 'bytes' in found) throw new Error('fixture path collision');
      const next = found ?? { children: new Map() };
      cursor.children.set(part, next);
      cursor = next as Tree;
    }
    cursor.children.set(name, { bytes: Buffer.from(source) });
  }
  const tree = (node: Tree): string => {
    const entries = [...node.children]
      .map(([name, child]) => {
        if ('bytes' in child) {
          const id = gitId('blob', child.bytes);
          objects.set(id, { type: 'blob', bytes: child.bytes });
          return { name, mode: '100644', id };
        }
        return { name, mode: '40000', id: tree(child) };
      })
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(`${left.name}${left.mode === '40000' ? '/' : ''}`),
          Buffer.from(`${right.name}${right.mode === '40000' ? '/' : ''}`),
        ),
      );
    const bytes = Buffer.concat(
      entries.map(({ name, mode, id }) =>
        Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, 'hex')]),
      ),
    );
    const id = gitId('tree', bytes);
    objects.set(id, { type: 'tree', bytes });
    return id;
  };
  const treeId = tree(root);
  const commitBytes = Buffer.from(
    `tree ${treeId}\nauthor Fixture <fixture@example.invalid> 0 +0000\n\nfixture\n`,
  );
  const commit = gitId('commit', commitBytes);
  objects.set(commit, { type: 'commit', bytes: commitBytes });
  return verifyReleaseCandidateSnapshot({
    repository: { id: repositoryId, commit, tree: treeId },
    objects,
    maximum_bytes: 4 * 1024 * 1024,
    maximum_entries: 1000,
  });
}

function policy(releaseUnit = '@fixture/package') {
  return {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.adopter-policy',
    policy_version: '1.0.0',
    release_verification: {
      schemaVersion: '1.0.0',
      policy_id: 'fixture.release-profile',
      policy_version: '1.0.0',
      release_unit: releaseUnit,
      version_source: 'package.json',
      default_support: 'current',
      capability_tasks: { lint: ['lint'] },
      risk_capabilities: {},
      mutation_roster: [],
    },
  };
}

function sri(snapshot: ReturnType<typeof installedPackage>): string {
  return `sha512-${createHash('sha512').update(snapshot.readArchive()).digest('base64')}`;
}

function filesForCandidate(
  checked: ReturnType<typeof installedPackage>,
  options: { readonly dependency?: boolean; readonly releaseUnit?: string } = {},
) {
  const document = policy(options.releaseUnit);
  const pin = checked.read('dist/law/constitution.md');
  const constitutionVersion = parseConstitutionVersion(pin.toString('utf8'));
  if (constitutionVersion === null) throw new Error('fixture constitution missing version');
  const currentProject = {
    schemaVersion: '1.0.0',
    project_type: 'framework',
    constitution: { version: constitutionVersion, sha256: sha256(pin) },
  };
  const materialized = resolveAdopterPolicyMaterialization({
    policy: document,
    currentProject,
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
  const dependency = options.dependency ?? true;
  const dependencies = dependency ? { [PACKAGE]: VERSION } : { leftpad: '1.3.0' };
  const packageJson = {
    name: 'fixture-root',
    version: '1.0.0',
    packageManager: 'npm@10.8.2',
    dependencies,
  };
  const packageLock = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    packages: {
      '': { dependencies },
      ...(dependency
        ? { [`node_modules/${PACKAGE}`]: { version: VERSION, integrity: sri(checked) } }
        : {}),
    },
  };
  return new Map<string, Uint8Array>([
    [SOURCE, policyBytes],
    [BINDING, Buffer.from(jsonBytes(binding))],
    ...[...materialized].map(([path, bytes]) => [path, Buffer.from(bytes)] as const),
    [PIN, checked.read('dist/law/constitution.md')],
    ['package.json', Buffer.from(JSON.stringify(packageJson))],
    ['package-lock.json', Buffer.from(JSON.stringify(packageLock))],
  ]);
}

function expectRefusal(run: () => unknown, code = 'rpl-policy-resolution-mismatch'): void {
  expect(run).toThrow(new Error(code));
}

function expectEvidenceRefusal(run: () => unknown): void {
  expect(run).toThrow(/^rpl-(?:policy-resolution|adopter-binding)-mismatch$/u);
}

function adopterFixture() {
  const checked = installedPackage();
  const files = filesForCandidate(checked);
  const resolved = candidate(files);
  return {
    checked,
    files,
    resolved,
    expected: {
      repository: resolved.repository,
      installed_package: checked.identity,
      installation_origin: 'candidate-adopter-dependency' as const,
      release_unit: '@fixture/package',
    },
  };
}

function resolve(value: ReturnType<typeof adopterFixture>) {
  return resolveReleasePolicySnapshot({
    expected: value.expected,
    installed_package: value.checked,
    candidate: value.resolved,
  });
}

describe('release policy resolution snapshot', () => {
  it('provides a reusable raw-Git v2 lifecycle fixture with no structural brands', () => {
    const fixture = createLifecyclePolicyFixture();
    expect(fixture.receipt).toMatchObject({ schemaVersion: '2.0.0' });
    expect(fixture.candidate.read('package.json')).toEqual(fixture.package_json);
  });

  it('resolves a candidate-adopter from only branded package and Git snapshots', () => {
    const value = adopterFixture();
    const result = resolve(value);
    expect(result.resolution).toMatchObject({
      installation_origin: 'candidate-adopter-dependency',
      installed_package: value.checked.identity,
      package_manager: 'npm',
    });
    expect(result.readInput('release-verification-profile')).toMatchObject({
      release_unit: '@fixture/package',
    });
    expect(isVerifiedReleasePolicyResolution(result)).toBe(true);
    expect(isVerifiedReleasePolicyResolution({ ...result })).toBe(false);
  });

  it('refuses wrong package identity, fake brands, missing binding/profile, pin, source, and lock drift', () => {
    const value = adopterFixture();
    expectRefusal(
      () =>
        resolveReleasePolicySnapshot({
          expected: {
            ...value.expected,
            installed_package: { ...value.checked.identity, version: '0.0.0' },
          },
          installed_package: value.checked,
          candidate: value.resolved,
        }),
      'rpl-package-identity-mismatch',
    );
    expectRefusal(
      () =>
        resolveReleasePolicySnapshot({
          expected: value.expected,
          installed_package: { ...value.checked },
          candidate: value.resolved,
        }),
      'rpl-package-identity-mismatch',
    );
    expectRefusal(() =>
      resolveReleasePolicySnapshot({
        expected: value.expected,
        installed_package: value.checked,
        candidate: { ...value.resolved },
      }),
    );
    for (const [label, mutate] of [
      ['missing binding', (files: Map<string, Uint8Array>) => files.delete(BINDING)],
      [
        'missing profile',
        (files: Map<string, Uint8Array>) => files.delete('.devai/config/release-verification.json'),
      ],
      ['pin drift', (files: Map<string, Uint8Array>) => files.set(PIN, Buffer.from('drift'))],
      ['source drift', (files: Map<string, Uint8Array>) => files.set(SOURCE, Buffer.from('{}'))],
      [
        'lock drift',
        (files: Map<string, Uint8Array>) => files.set('package-lock.json', Buffer.from('{}')),
      ],
    ] as const) {
      const files = new Map(value.files);
      mutate(files);
      const changed = candidate(files);
      void label;
      expectEvidenceRefusal(() =>
        resolveReleasePolicySnapshot({
          expected: { ...value.expected, repository: changed.repository },
          installed_package: value.checked,
          candidate: changed,
        }),
      );
    }
  });

  it('binds an external producer source, toolchain locks, and raw build provenance bytes', () => {
    const checked = installedPackage();
    const candidateFiles = filesForCandidate(checked, {
      dependency: false,
      releaseUnit: PACKAGE,
    });
    const adopter = candidate(candidateFiles, 'aarusso-nyx/devai');
    const sourceFiles = new Map<string, Uint8Array>([
      ['package.json', Buffer.from(`{"name":"${PACKAGE}","version":"${VERSION}"}\n`)],
    ]);
    const source = candidate(sourceFiles, 'aarusso-nyx/devai');
    const toolchainFiles = filesForCandidate(checked);
    const toolchain = verifyReleasePolicyLockfiles({
      paths: [...toolchainFiles.keys()],
      read: (path) =>
        Buffer.from(
          toolchainFiles.get(path) ??
            (() => {
              throw new Error('missing');
            })(),
        ),
      installed_package: checked,
      require_installed_dependency: true,
    });
    const sourceBytes = source.read('package.json');
    const provenance = Buffer.from(
      JSON.stringify({
        schemaVersion: '1.0.0',
        producer_source: {
          repository_id: 'aarusso-nyx/devai',
          commit: source.repository.commit,
          tree: source.repository.tree,
          package_manifest: { path: 'package.json', sha256: sha256(sourceBytes) },
        },
        installed_package: checked.identity,
        toolchain: {
          package_manager: toolchain.package_manager,
          package_manifest: toolchain.package_manifest,
          lockfiles: toolchain.lockfiles,
        },
      }),
    );
    const expectedProducer = {
      package_manager: toolchain.package_manager,
      package_manifest: toolchain.package_manifest,
      lockfiles: toolchain.lockfiles,
      producer_source: {
        repository_id: 'aarusso-nyx/devai',
        commit: source.repository.commit,
        tree: source.repository.tree,
        package_manifest: { path: 'package.json', sha256: sha256(sourceBytes) },
        build_provenance_sha256: sha256(provenance),
      },
    };
    const input = {
      expected: {
        repository: adopter.repository,
        installed_package: checked.identity,
        installation_origin: 'external-producer-toolchain' as const,
        release_unit: PACKAGE,
        producer_toolchain: expectedProducer,
      },
      installed_package: checked,
      candidate: adopter,
      producer: { files: toolchainFiles, source, build_provenance: provenance },
    };
    const resolved = resolveReleasePolicySnapshot(input);
    expect(resolved.resolution).toMatchObject({
      installation_origin: 'external-producer-toolchain',
      producer_toolchain: expectedProducer,
    });
    expectRefusal(() =>
      resolveReleasePolicySnapshot({
        ...input,
        producer: { ...input.producer, build_provenance: Buffer.from(`${provenance} `) },
      }),
    );
    expectRefusal(() =>
      resolveReleasePolicySnapshot({
        ...input,
        expected: {
          ...input.expected,
          producer_toolchain: {
            ...expectedProducer,
            producer_source: { ...expectedProducer.producer_source, commit: '0'.repeat(40) },
          },
        },
      }),
    );
    expectRefusal(
      () =>
        resolveReleasePolicySnapshot({
          ...input,
          expected: {
            ...input.expected,
            installed_package: { ...checked.identity, archive_sha256: '0'.repeat(64) },
          },
        }),
      'rpl-package-identity-mismatch',
    );
  });

  it('builds and re-verifies a v2 plan only through the branded resolution', () => {
    const value = adopterFixture();
    const resolution = resolve(value);
    const intent = {
      schemaVersion: '1.0.0',
      release_unit: value.expected.release_unit,
      current_version: VERSION,
      target_version: '1.4.6',
      support: 'current',
      change_kind: 'behavioral',
      changed_paths: ['packages/cli/src/services/release-policy-resolution.ts'],
      changed_packages: [PACKAGE],
      candidate: {
        commit: value.resolved.repository.commit,
        tree: value.resolved.repository.tree,
      },
      base: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    };
    const receipt = buildResolvedReleasePlanReceipt({ intent, resolution });
    expect(receipt).toMatchObject({
      schemaVersion: '2.0.0',
      policy_resolution: resolution.resolution,
      verification_kernel: { kernel_id: 'devai.kernel.release-plan-receipt.v3' },
    });
    expect(verifyResolvedReleasePlanReceipt({ receipt, resolution })).toBe(true);
    expect(
      verifyResolvedReleasePlanReceipt({
        receipt: { ...receipt, receipt_digest_sha256: '0'.repeat(64) },
        resolution,
      }),
    ).toBe(false);
    expect(() =>
      buildResolvedReleasePlanReceipt({ intent, resolution: { ...resolution } }),
    ).toThrow(/^rpl-policy-resolution-mismatch$/u);
  });
});
