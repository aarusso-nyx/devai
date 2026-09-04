import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, canonicalSha256, parseConstitutionVersion } from '@devai-nyx/utils';
import { stringify } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { resolveAdopterPolicyMaterialization } from '../../src/services/adopter-policy.js';
import { encodeContainerDependencyArchive } from '../../src/services/container-archive.js';
import type { ContainerArchiveEntry } from '../../src/services/container-archive.js';
import type { PlannedTask, TaskDescriptor } from '../../src/services/check-runner/types.js';
import {
  ProtectedCertificationContainer,
  type ProtectedContainerControls,
  type ProtectedContainerDependency,
} from '../../src/services/release-certification-container.js';
import {
  isVerifiedReleaseCandidateSnapshot,
  verifyReleaseCandidateSnapshot,
  type ReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from '../../src/services/release-candidate-snapshot.js';
import {
  createProtectedToolchainFixtureContext,
  bindProtectedToolchainFixtureContext,
  observeProtectedToolchainFixtureInputs,
  type ProtectedToolchainFixtureContext,
} from '../../src/services/release-toolchain-fixture-compatibility.js';
import {
  resolveReleasePolicySnapshot,
  type VerifiedReleasePolicyResolution,
} from '../../src/services/release-policy-resolution.js';
import {
  validateProtectedDependencyTransport,
  verifyProtectedDependencyInputs,
} from '../../src/services/release-dependency-transport.js';
import { createLifecyclePolicyFixture } from '../helpers/release-policy-resolution-fixture.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const FIXTURE_ROOT = resolve(import.meta.dirname, '../fixtures/mutation-toolchain');
const PACKAGE = '@aarusso-nyx/devai';
const VERSION = '1.4.5';
const REPOSITORY = 'devai-diagnostic/mutation-toolchain-diagnostic';
const SOURCE_POLICY = 'law/policy/diagnostic-adoption.json';
const BINDING = '.devai/config/adopter-policy-binding.json';
const PIN = '.devai/pin/constitution.md';
const DYNAMIC = [
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
] as const;

type DefinitionEntry = {
  readonly path: string;
  readonly mode: '100644';
  readonly size: number;
  readonly sha256: string;
};
type Definition = {
  readonly schemaVersion: '1.0.0';
  readonly definition_sha256: string;
  readonly manifest: readonly DefinitionEntry[];
  readonly read: (path: string) => Buffer;
};

const loader = vi.hoisted((): { value: Definition | undefined } => ({ value: undefined }));
vi.mock('../../src/services/release-toolchain-fixture-definition.js', () => ({
  loadReleaseToolchainFixtureDefinition: () => {
    if (loader.value === undefined) throw new Error('fixture definition unavailable');
    return loader.value;
  },
}));

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytes(path: string): Buffer {
  return readFileSync(join(FIXTURE_ROOT, path));
}

function fixedDefinition(): {
  readonly definition: Definition;
  readonly files: ReadonlyMap<string, Buffer>;
} {
  const source = new Map<string, Buffer>([
    ['law/policy/diagnostic-adoption.json', bytes('diagnostic-adoption.json')],
    ['.gitignore', bytes('fixture-root-gitignore')],
    ['README.md', bytes('fixture-root-readme.md')],
    ['package.json', bytes('root-package.json')],
    ['pnpm-workspace.yaml', bytes('root-pnpm-workspace.yaml')],
    ['packages/fixture/src/subject.ts', bytes('subject.ts')],
    ['test-tasks.json', bytes('test-tasks.json')],
    ['packages/fixture/package.json', bytes('packages/fixture/package.json')],
    ['packages/fixture/src/zero.ts', bytes('packages/fixture/src/zero.ts')],
    [
      'packages/fixture/tests/subject.test.ts',
      bytes('packages/fixture/tests/subject.test.ts.fixture'),
    ],
    ['packages/fixture/stryker.config.json', bytes('packages/fixture/stryker.config.json')],
    ['packages/fixture/tsconfig.json', bytes('packages/fixture/tsconfig.json')],
    ['packages/fixture/vitest.config.cjs', bytes('packages/fixture/vitest.config.cjs')],
    [
      'host/run-diagnostic.mjs',
      readFileSync(join(ROOT, 'scripts/release-host/mutation-diagnostic.mjs')),
    ],
  ]);
  const manifest = [...source]
    .map(([path, value]) => ({
      path,
      mode: '100644' as const,
      size: value.length,
      sha256: sha256(value),
    }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const definition: Definition = Object.freeze({
    schemaVersion: '1.0.0',
    definition_sha256: canonicalSha256({ schemaVersion: '1.0.0', manifest }),
    manifest: Object.freeze(manifest),
    read: (path) =>
      Buffer.from(
        source.get(path) ??
          (() => {
            throw new Error('unknown fixture entry');
          })(),
      ),
  });
  return { definition, files: source };
}

function oid(type: ReleaseGitObject['type'], value: Uint8Array): string {
  return createHash('sha1').update(`${type} ${value.byteLength}\0`).update(value).digest('hex');
}

function candidate(
  files: ReadonlyMap<string, Uint8Array>,
  options: { readonly modePath?: string; readonly repository?: string } = {},
): ReleaseCandidateSnapshot {
  type Tree = {
    readonly children: Map<string, Tree | { readonly path: string; readonly bytes: Buffer }>;
  };
  const root: Tree = { children: new Map() };
  const objects = new Map<string, ReleaseGitObject>();
  for (const [path, value] of files) {
    const parts = path.split('/');
    const leaf = parts.pop();
    if (leaf === undefined) throw new Error('fixture path missing leaf');
    let node = root;
    for (const part of parts) {
      const current = node.children.get(part);
      const next = current ?? {
        children: new Map<string, Tree | { readonly path: string; readonly bytes: Buffer }>(),
      };
      if ('bytes' in next) throw new Error('fixture path collision');
      node.children.set(part, next);
      node = next;
    }
    node.children.set(leaf, { path, bytes: Buffer.from(value) });
  }
  const tree = (node: Tree): string => {
    const entries = [...node.children]
      .map(([name, child]) => {
        if ('bytes' in child) {
          const id = oid('blob', child.bytes);
          objects.set(id, { type: 'blob', bytes: child.bytes });
          return { name, mode: child.path === options.modePath ? '100755' : '100644', id };
        }
        return { name, mode: '40000', id: tree(child) };
      })
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(`${left.name}${left.mode === '40000' ? '/' : ''}`),
          Buffer.from(`${right.name}${right.mode === '40000' ? '/' : ''}`),
        ),
      );
    const value = Buffer.concat(
      entries.map((entry) =>
        Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.id, 'hex')]),
      ),
    );
    const id = oid('tree', value);
    objects.set(id, { type: 'tree', bytes: value });
    return id;
  };
  const treeId = tree(root);
  const commitBytes = Buffer.from(
    `tree ${treeId}\nauthor Fixture <fixture@example.invalid> 0 +0000\n\nfixture\n`,
  );
  const commit = oid('commit', commitBytes);
  objects.set(commit, { type: 'commit', bytes: commitBytes });
  return verifyReleaseCandidateSnapshot({
    repository: { id: options.repository ?? REPOSITORY, commit, tree: treeId },
    objects,
    maximum_bytes: 8 * 1024 * 1024,
    maximum_entries: 10_000,
  });
}

function dependency(source: readonly ContainerArchiveEntry[]): ProtectedContainerDependency {
  const find = (path: string): ContainerArchiveEntry => {
    const entry = source.find((value) => value.path === path);
    if (entry === undefined) throw new Error(`missing dependency input ${path}`);
    return entry;
  };
  const archive = encodeContainerDependencyArchive([
    {
      path: '@aarusso-nyx/devai/index.js',
      mode: '100644',
      bytes: Buffer.from('module.exports = 1;\n'),
    },
  ]);
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'packages/fixture/package.json',
  ].map((path) => ({ path, sha256: sha256(find(path).bytes) }));
  return {
    mount_path: 'node_modules',
    archive,
    sha256: sha256(archive),
    inputs: {
      files,
      workspace_packages: [
        {
          path: 'packages/fixture',
          name: '@devai-toolchain/fixture',
          manifest_sha256: sha256(find('packages/fixture/package.json').bytes),
        },
      ],
    },
  };
}

interface Fixture {
  readonly candidate: ReleaseCandidateSnapshot;
  readonly installed: ReturnType<typeof createLifecyclePolicyFixture>['package_snapshot'];
  readonly fixtureResolution: VerifiedReleasePolicyResolution;
  readonly productionResolution: VerifiedReleasePolicyResolution;
  readonly controls: ProtectedContainerControls;
  readonly dependencies: readonly ProtectedContainerDependency[];
  readonly source: readonly ContainerArchiveEntry[];
  readonly descriptor: TaskDescriptor;
  readonly task: PlannedTask;
}

function resolutionFor(
  installed: Fixture['installed'],
  policyPath: string,
  policyBytes: Buffer,
  releaseUnit: string,
  repository: string,
): VerifiedReleasePolicyResolution {
  const pin = installed.read('dist/law/constitution.md');
  const version = parseConstitutionVersion(pin.toString('utf8'));
  if (version === null) throw new Error('fixture constitution version');
  const policy = JSON.parse(policyBytes.toString('utf8')) as Record<string, unknown>;
  const materialized = resolveAdopterPolicyMaterialization({
    policy,
    currentProject: {
      schemaVersion: '1.0.0',
      project_type: 'framework',
      constitution: { version, sha256: sha256(pin) },
    },
    frameworkVersion: VERSION,
  });
  const binding = {
    schemaVersion: '1.0.0',
    policy_id: policy['policy_id'],
    policy_version: policy['policy_version'],
    source_path: policyPath,
    source_digest_sha256: sha256(policyBytes),
    materialized: Object.fromEntries(
      [...materialized].map(([path, value]) => [path, sha256(Buffer.from(value))]),
    ),
  };
  const archiveSRI = `sha512-${createHash('sha512').update(installed.readArchive()).digest('base64')}`;
  const manifest = Buffer.from(
    JSON.stringify({
      name: repository === REPOSITORY ? '@devai-toolchain/diagnostic' : PACKAGE,
      version: '1.0.0',
      packageManager: 'pnpm@9.15.0',
      dependencies: { [PACKAGE]: 'file:host/devai.tgz' },
    }),
  );
  const lock = Buffer.from(
    stringify({
      lockfileVersion: '9.0',
      importers: {
        '.': {
          dependencies: {
            [PACKAGE]: { specifier: 'file:host/devai.tgz', version: 'file:host/devai.tgz' },
          },
        },
      },
      packages: {
        [`${PACKAGE}@file:host/devai.tgz`]: {
          version: VERSION,
          resolution: { integrity: archiveSRI },
        },
      },
    }),
  );
  const snapshot = candidate(
    new Map<string, Uint8Array>([
      [policyPath, policyBytes],
      [BINDING, Buffer.from(canonicalJson(binding))],
      ...[...materialized].map(([path, value]) => [path, Buffer.from(value)] as const),
      [PIN, pin],
      ['package.json', manifest],
      ['pnpm-lock.yaml', lock],
      ['pnpm-workspace.yaml', Buffer.from('packages:\n  - packages/*\n')],
      ['host/devai.tgz', installed.readArchive()],
    ]),
    { repository },
  );
  return resolveReleasePolicySnapshot({
    expected: {
      repository: snapshot.repository,
      installed_package: installed.identity,
      installation_origin: 'candidate-adopter-dependency',
      release_unit: releaseUnit,
    },
    installed_package: installed,
    candidate: snapshot,
  });
}

function fixture(
  options: { readonly modePath?: string; readonly extraPath?: boolean } = {},
): Fixture {
  const installed = createLifecyclePolicyFixture().package_snapshot;
  const { definition, files: fixed } = fixedDefinition();
  loader.value = definition;
  const pin = installed.read('dist/law/constitution.md');
  const constitutionVersion = parseConstitutionVersion(pin.toString('utf8'));
  if (constitutionVersion === null) throw new Error('missing constitution version');
  const policy = JSON.parse(fixed.get(SOURCE_POLICY)?.toString('utf8') ?? '') as Record<
    string,
    unknown
  >;
  const materialized = resolveAdopterPolicyMaterialization({
    policy,
    currentProject: {
      schemaVersion: '1.0.0',
      project_type: 'framework',
      constitution: { version: constitutionVersion, sha256: sha256(pin) },
    },
    frameworkVersion: VERSION,
  });
  const policyBytes = fixed.get(SOURCE_POLICY);
  if (policyBytes === undefined) throw new Error('missing diagnostic policy');
  const binding = {
    schemaVersion: '1.0.0',
    policy_id: policy['policy_id'],
    policy_version: policy['policy_version'],
    source_path: SOURCE_POLICY,
    source_digest_sha256: sha256(policyBytes),
    materialized: Object.fromEntries(
      [...materialized].map(([path, value]) => [path, sha256(Buffer.from(value))]),
    ),
  };
  const archiveSRI = `sha512-${createHash('sha512').update(installed.readArchive()).digest('base64')}`;
  const lock = stringify({
    lockfileVersion: '9.0',
    importers: {
      '.': {
        dependencies: {
          '@aarusso-nyx/devai': {
            specifier: 'file:host/devai.tgz',
            version: 'file:host/devai.tgz',
          },
          '@stryker-mutator/core': { specifier: '9.6.1', version: '9.6.1' },
          '@stryker-mutator/typescript-checker': { specifier: '9.6.1', version: '9.6.1' },
          '@stryker-mutator/vitest-runner': { specifier: '9.6.1', version: '9.6.1' },
          vitest: { specifier: '4.1.10', version: '4.1.10' },
          typescript: { specifier: '5.9.3', version: '5.9.3' },
        },
      },
    },
    packages: {
      '@aarusso-nyx/devai@file:host/devai.tgz': {
        version: VERSION,
        resolution: { integrity: archiveSRI },
      },
    },
  });
  const files = new Map<string, Uint8Array>([
    ...fixed,
    [BINDING, Buffer.from(canonicalJson(binding))],
    ...[...materialized].map(([path, value]) => [path, Buffer.from(value)] as const),
    [PIN, pin],
    ['.devai/constitution.md', pin],
    ['host/devai.tgz', installed.readArchive()],
    ['pnpm-lock.yaml', Buffer.from(lock)],
  ]);
  if (options.extraPath === true) files.set('unexpected.txt', Buffer.from('unexpected\n'));
  const snapshot = candidate(files, { modePath: options.modePath });
  const expected = (release_unit: string) => ({
    repository: snapshot.repository,
    installed_package: installed.identity,
    installation_origin: 'candidate-adopter-dependency' as const,
    release_unit,
  });
  const fixtureResolution = resolveReleasePolicySnapshot({
    expected: expected('@devai-toolchain/diagnostic'),
    installed_package: installed,
    candidate: snapshot,
  });
  const productionResolution = resolutionFor(
    installed,
    'law/policy/devai-adoption.json',
    readFileSync(join(ROOT, 'law/policy/devai-adoption.json')),
    PACKAGE,
    'aarusso-nyx/devai',
  );
  const source = snapshot.paths.map((path) => ({
    path,
    mode: '100644' as const,
    bytes: snapshot.read(path),
  }));
  const controls: ProtectedContainerControls = {
    docker_binary: '/protected/docker',
    docker_binary_sha256: 'a'.repeat(64),
    docker_config_directory: '/protected/config',
    engine_socket: 'unix:///protected/docker.sock',
    engine_version: '29.5.2',
    image: `node@sha256:${'b'.repeat(64)}`,
    node_version: 'v24.20.0',
    executables: { node: { path: '/usr/local/bin/node', sha256: 'c'.repeat(64) } },
    memory_bytes: 64 * 1024 * 1024,
    cpus: 1,
    pids_limit: 2,
    maximum_archive_bytes: 1024 * 1024,
  };
  const descriptor = JSON.parse(
    snapshot.read('test-tasks.json').toString('utf8'),
  ) as TaskDescriptor;
  const task: PlannedTask = {
    nodeId: 'diagnostic:mutation-toolchain',
    taskKey: 'd'.repeat(64),
    dependencies: [],
    outputContract: descriptor.tasks[0]?.outputContract ?? {},
    argv: ['node', '../../host/run-diagnostic.mjs'],
    executable: controls.executables.node,
    cwd: 'packages/fixture',
    inputDigest: 'e'.repeat(64),
    inputPaths: [],
    matchedChangedPaths: [],
    cacheState: 'execute',
    reason: 'fixture',
  };
  return {
    candidate: snapshot,
    installed,
    fixtureResolution,
    productionResolution,
    controls,
    source,
    dependencies: [dependency(source)],
    descriptor,
    task,
  };
}

function context(value: Fixture): ProtectedToolchainFixtureContext {
  return createProtectedToolchainFixtureContext({
    candidate: value.candidate,
    installed_package: value.installed,
    fixture_resolution: value.fixtureResolution,
    production_resolution: value.productionResolution,
    controls: value.controls,
    dependencies: value.dependencies,
    environment: {},
    toolchain: {
      node: 'v24.20.0',
      pnpm: '9.15.0',
      git: '2.47.3',
      vitest: '4.1.10',
      typescript: '5.9.3',
      stryker: '9.6.1',
    },
  });
}

function request(value: Fixture) {
  return {
    schemaVersion: '1.0.0' as const,
    request_kind: 'release-lifecycle-request' as const,
    action_id: 'release preflight' as const,
    repository_locator: value.candidate.repository,
    candidate_locator: {
      commit: value.candidate.repository.commit,
      tree: value.candidate.repository.tree,
      release_units: [
        {
          release_unit: '@devai-toolchain/diagnostic',
          version: '1.0.0',
          package_roster: [
            {
              package_id: '@devai-toolchain/diagnostic',
              manifest_path: 'package.json',
              manifest_digest_sha256: sha256(value.candidate.read('package.json')),
            },
          ],
        },
      ],
    },
    receipt_locators: [
      {
        kind: 'release-plan-receipt' as const,
        receipt_id: 'fixture-receipt',
        receipt_digest_sha256: 'f'.repeat(64),
        path: '.devai/receipts/fixture.json',
      },
    ],
  };
}

describe('release toolchain fixture compatibility', () => {
  it('uses genuine candidate and policy resolution brands at the mocked fixed-definition unit seam', () => {
    const value = fixture();
    const definition = loader.value;
    if (definition === undefined) throw new Error('missing mocked fixture definition');
    const expectedPaths = [...definition.manifest.map((entry) => entry.path), ...DYNAMIC].sort();
    expect(value.candidate.paths).toEqual(expectedPaths);
    expect(
      () => new ProtectedCertificationContainer(value.controls, value.dependencies),
    ).not.toThrow();
    expect(value.productionResolution.readInput('release-verification-profile')).toMatchObject({
      mutation_execution: {
        schemaVersion: '1.1.0',
        template_id: 'devai.protected-mutation-stryker.v1',
      },
    });
    const transport = validateProtectedDependencyTransport(
      value.dependencies,
      value.controls.maximum_archive_bytes,
    );
    expect(() => verifyProtectedDependencyInputs(transport, value.source)).not.toThrow();
    expect(value.fixtureResolution.resolution).toMatchObject({
      installed_package: value.installed.identity,
    });
    expect(value.productionResolution.resolution).toMatchObject({
      installed_package: value.installed.identity,
    });
    const protectedContext = context(value);
    expect(isVerifiedReleaseCandidateSnapshot(value.candidate)).toBe(true);
    expect(() => JSON.stringify(protectedContext)).toThrow(
      'release-toolchain-fixture-compatibility-invalid',
    );
    const container = new ProtectedCertificationContainer(value.controls, value.dependencies);
    const identity = bindProtectedToolchainFixtureContext(protectedContext, {
      container: container.identity,
      environment: {},
      toolchain: {
        node: 'v24.20.0',
        pnpm: '9.15.0',
        git: '2.47.3',
        vitest: '4.1.10',
        typescript: '5.9.3',
        stryker: '9.6.1',
      },
      resolutions: [value.fixtureResolution],
      receipts: [{ receipt_id: 'fixture-receipt', receipt_digest_sha256: 'f'.repeat(64) }],
      diagnostic_outputs: [
        {
          task_node: 'diagnostic:mutation-toolchain',
          paths: [
            'packages/fixture/reports/mutation/compatibility.json',
            'packages/fixture/reports/mutation/raw.json',
          ],
        },
      ],
    });
    expect(identity).toMatchObject({
      schemaVersion: '1.0.0',
      repository: value.candidate.repository,
    });
    observeProtectedToolchainFixtureInputs(protectedContext, {
      request: request(value),
      source: value.source,
      descriptor: value.descriptor,
      tasks: [value.task],
    });
    expect(() =>
      observeProtectedToolchainFixtureInputs(protectedContext, {
        request: request(value),
        source: value.source,
        descriptor: value.descriptor,
        tasks: [value.task],
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
  });

  it('refuses fixture source census drift before a provider can bind or execute', () => {
    expect(() => context(fixture({ extraPath: true }))).toThrow(
      'release-toolchain-fixture-compatibility-invalid',
    );
    expect(() => context(fixture({ modePath: 'packages/fixture/src/subject.ts' }))).toThrow(
      'release-toolchain-fixture-compatibility-invalid',
    );
  });

  it('rejects spoofed contexts and unbound runtime/toolchain substitutions', () => {
    const value = fixture();
    expect(() =>
      bindProtectedToolchainFixtureContext({} as ProtectedToolchainFixtureContext, {
        container: {},
        environment: {},
        toolchain: {},
        resolutions: [],
        receipts: [],
        diagnostic_outputs: [],
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
    expect(() =>
      createProtectedToolchainFixtureContext({
        candidate: value.candidate,
        installed_package: value.installed,
        fixture_resolution: value.fixtureResolution,
        production_resolution: value.productionResolution,
        controls: value.controls,
        dependencies: value.dependencies,
        environment: { CI: '1' },
        toolchain: {
          node: 'v24.20.0',
          pnpm: '9.15.0',
          git: '2.47.3',
          vitest: '4.1.10',
          typescript: '5.9.3',
          stryker: '9.6.1',
        },
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
  });

  it('consumes a bound context on a malformed task observation', () => {
    const value = fixture();
    const protectedContext = context(value);
    const container = new ProtectedCertificationContainer(value.controls, value.dependencies);
    bindProtectedToolchainFixtureContext(protectedContext, {
      container: container.identity,
      environment: {},
      toolchain: {
        node: 'v24.20.0',
        pnpm: '9.15.0',
        git: '2.47.3',
        vitest: '4.1.10',
        typescript: '5.9.3',
        stryker: '9.6.1',
      },
      resolutions: [value.fixtureResolution],
      receipts: [{ receipt_id: 'fixture-receipt', receipt_digest_sha256: 'f'.repeat(64) }],
      diagnostic_outputs: [
        {
          task_node: 'diagnostic:mutation-toolchain',
          paths: [
            'packages/fixture/reports/mutation/compatibility.json',
            'packages/fixture/reports/mutation/raw.json',
          ],
        },
      ],
    });
    const altered = value.source.map((entry) =>
      entry.path === 'packages/fixture/src/subject.ts'
        ? { ...entry, bytes: Buffer.from('export const enabled = () => 0;\n') }
        : entry,
    );
    expect(() =>
      observeProtectedToolchainFixtureInputs(protectedContext, {
        request: request(value),
        source: altered,
        descriptor: value.descriptor,
        tasks: [value.task],
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
    expect(() =>
      observeProtectedToolchainFixtureInputs(protectedContext, {
        request: request(value),
        source: value.source,
        descriptor: value.descriptor,
        tasks: [value.task],
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
  });
});
