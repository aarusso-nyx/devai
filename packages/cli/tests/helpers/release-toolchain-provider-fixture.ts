import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalJson, canonicalSha256, parseConstitutionVersion } from '@devai-nyx/utils';
import { stringify } from 'yaml';
import { createReleasePolicyPackageTools } from '../../src/services/release-policy-package.js';
import {
  encodeContainerDependencyArchive,
  type ContainerArchiveEntry,
} from '../../src/services/container-archive.js';
import type {
  PlannedTask,
  TaskDescriptor,
  CheckRunnerOptions,
} from '../../src/services/check-runner/types.js';
import {
  ProtectedCertificationContainer,
  type ProtectedContainerControls,
  type ProtectedContainerDependency,
} from '../../src/services/release-certification-container.js';
import {
  verifyReleaseCandidateSnapshot,
  type ReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from '../../src/services/release-candidate-snapshot.js';
import {
  createProtectedToolchainFixtureContext,
  type ProtectedToolchainFixtureContext,
} from '../../src/services/release-toolchain-fixture-compatibility.js';
import {
  resolveReleasePolicySnapshot,
  type VerifiedReleasePolicyResolution,
} from '../../src/services/release-policy-resolution.js';
import { createLifecyclePolicyFixture } from './release-policy-resolution-fixture.js';
import { buildResolvedReleasePlanReceipt } from '../../src/services/release-lifecycle.js';
import type { ContainerReleaseCertificationOptions } from '../../src/services/release-certification-provider.js';
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

export const loader: { value: Definition | undefined } = { value: undefined };
export const containerState = { outputs: new Map<string, Buffer>(), status: 0 };
export const fixtureRuntime: {
  runCheckTasks: ((options: CheckRunnerOptions) => unknown) | undefined;
} = { runCheckTasks: undefined };
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
    `tree ${treeId}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\nfixture\n`,
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
  const materialized = createReleasePolicyPackageTools(installed).materialize({
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
  options: {
    readonly modePath?: string;
    readonly extraPath?: boolean;
    readonly installed?: Fixture['installed'];
    readonly productionResolution?: VerifiedReleasePolicyResolution;
  } = {},
): Fixture {
  const installed = options.installed ?? createLifecyclePolicyFixture().package_snapshot;
  const { definition, files: fixed } = fixedDefinition();
  loader.value = definition;
  const pin = installed.read('dist/law/constitution.md');
  const constitutionVersion = parseConstitutionVersion(pin.toString('utf8'));
  if (constitutionVersion === null) throw new Error('missing constitution version');
  const policy = JSON.parse(fixed.get(SOURCE_POLICY)?.toString('utf8') ?? '') as Record<
    string,
    unknown
  >;
  const materialized = createReleasePolicyPackageTools(installed).materialize({
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
  const productionResolution =
    options.productionResolution ??
    resolutionFor(
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
  const executable = controls.executables.node;
  if (executable === undefined) throw new Error('missing fixture executable');
  const task: PlannedTask = {
    nodeId: 'diagnostic:mutation-toolchain',
    taskKey: 'd'.repeat(64),
    dependencies: [],
    outputContract: descriptor.tasks[0]?.outputContract ?? {},
    argv: ['node', '../../host/run-diagnostic.mjs'],
    executable,
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

const temporaryRoots: string[] = [];
export function cleanupFixtures(): void {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  fixtureRuntime.runCheckTasks = undefined;
  containerState.outputs.clear();
  containerState.status = 0;
}

function providerFixture(production?: {
  readonly installed: Fixture['installed'];
  readonly resolution: VerifiedReleasePolicyResolution;
}) {
  const value = fixture({
    installed: production?.installed,
    productionResolution: production?.resolution,
  });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-toolchain-provider-')));
  temporaryRoots.push(root);
  const git = (args: readonly string[], input?: Uint8Array): Buffer => {
    const result = spawnSync('git', ['-C', root, ...args], { input });
    if (result.status !== 0) throw new Error(result.stderr.toString());
    return result.stdout;
  };
  git(['init', '-q']);
  for (const [id, object] of value.candidate.readProof(value.candidate.paths)) {
    assert.equal(
      git(['hash-object', '-w', '-t', object.type, '--stdin'], object.bytes).toString().trim(),
      id,
    );
  }
  git(['checkout', '--detach', value.candidate.repository.commit]);
  assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), value.candidate.repository.commit);
  assert.equal(
    git(['rev-parse', 'HEAD^{tree}']).toString().trim(),
    value.candidate.repository.tree,
  );
  const intent = {
    schemaVersion: '1.0.0',
    release_unit: '@devai-toolchain/diagnostic',
    current_version: '0.9.0',
    target_version: '1.0.0',
    support: 'current',
    change_kind: 'behavioral',
    changed_paths: ['packages/fixture/src/subject.ts'],
    changed_packages: ['@devai-toolchain/diagnostic'],
    candidate: { commit: value.candidate.repository.commit, tree: value.candidate.repository.tree },
    base: { commit: value.candidate.repository.commit, tree: value.candidate.repository.tree },
  };
  const receipt = buildResolvedReleasePlanReceipt({ intent, resolution: value.fixtureResolution });
  assert.equal(receipt.verdict, 'pass');
  const boundRequest = {
    ...request(value),
    receipt_locators: [
      {
        kind: 'release-plan-receipt' as const,
        receipt_id: receipt.receipt_id,
        receipt_digest_sha256: receipt.receipt_digest_sha256,
        path: '.devai/receipts/fixture.json',
      },
    ],
  };
  const plan = {
    taskPolicyDigest: '1'.repeat(64),
    taskPolicy: { nodes: [value.task.nodeId] },
    tasks: [value.task],
  };
  fixtureRuntime.runCheckTasks = (options: CheckRunnerOptions) => {
    const result = options.executeTask?.(value.task.argv, join(root, value.task.cwd), 1000, {});
    return {
      schemaVersion: '1.0.0',
      operation: options.operation,
      plan,
      execution: [
        {
          nodeId: value.task.nodeId,
          taskKey: value.task.taskKey,
          disposition: 'executed',
          outcome: result?.status === undefined || result.status === 0 ? 'PASS' : 'FAIL',
          reason: 'fixture',
          durationMs: 1,
        },
      ],
      preflightReceipt: { digest: '2'.repeat(64), path: '.devai/cache/preflight.json', value: {} },
      exitCode: result?.status ?? 0,
    };
  };
  const options: ContainerReleaseCertificationOptions = {
    repository_root: root,
    repository_id: REPOSITORY,
    plans: [
      {
        receipt,
        resolution: value.fixtureResolution,
        intent_path: 'release-intent.json',
        intent,
        release_verification_profile: value.fixtureResolution.readInput(
          'release-verification-profile',
        ),
        release_lifecycle_policy: value.fixtureResolution.readInput('release-lifecycle-policy'),
        action_registry: value.fixtureResolution.readInput('action-registry-policy'),
        packages: [
          {
            package_id: '@devai-toolchain/diagnostic',
            source_entries: ['package.json'],
            generated_entries: [],
          },
        ],
      },
    ],
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
    timeout_ms: 1000,
    diagnostic_outputs: [
      {
        task_node: value.task.nodeId,
        paths: [
          'packages/fixture/reports/mutation/compatibility.json',
          'packages/fixture/reports/mutation/raw.json',
        ],
      },
    ],
    toolchain_fixture: {
      candidate: value.candidate,
      installed_package: value.installed,
      production_resolution: value.productionResolution,
    },
    content_source: {
      readGitObject: ({ type, object_id }) => git(['cat-file', type, object_id]),
      readGitBlob: ({ object_id }) => git(['cat-file', 'blob', object_id]),
    },
    evidence_sink: {
      kind: 'certification-evidence-sink-v3',
      protocol: 'two-phase-content-addressed',
      begin: () => {
        throw new Error('unexpected certification');
      },
      readCertificationEvidenceReceipt: () => {
        throw new Error('unexpected certification');
      },
      readCertificationOutputClosure: (binding) => ({ ...binding, outputs: [] }),
      readGeneratedBlob: () => {
        throw new Error('unexpected certification');
      },
    },
  };
  const subject = value.candidate.read('packages/fixture/src/subject.ts');
  const zero = value.candidate.read('packages/fixture/src/zero.ts');
  const raw = {
    schemaVersion: '1.0',
    projectRoot: '/workspace/candidate/packages/fixture',
    framework: { name: 'StrykerJS', version: '9.6.1' },
    thresholds: { break: 60, high: 60, low: 60 },
    files: {
      'src/subject.ts': {
        source: subject.toString(),
        language: 'typescript',
        mutants: [
          { id: '0', status: 'Killed' as unknown },
          { id: '1', status: 'Killed' as unknown },
          { id: '2', status: 'Survived' as unknown },
        ],
      },
    },
  };
  const compatibility = {
    scope: 'toolchain-compatibility-diagnostic-only',
    core: '9.6.1',
    checker: '9.6.1',
    runner: '9.6.1',
    vitest: '4.1.10',
    typescript: '5.9.3',
    node: 'v24.20.0',
    projectVitestResolved: true,
    readonlyDependencies: true,
    realMutationObserved: true,
    certification: false,
    reusable: false,
    discovery: {
      algorithm: 'devai.fixed-fixture-instrumenter.v1',
      instrumenter_version: '9.6.1',
      options: { plugins: null, excludedMutations: [], ignorers: [] },
      selected: [
        { path: 'src/subject.ts', source_sha256: sha256(subject) },
        { path: 'src/zero.ts', source_sha256: sha256(zero) },
      ],
      instrumented: ['src/subject.ts', 'src/zero.ts'],
      emitted: [{ path: 'src/subject.ts', mutant_ids: ['0', '1', '2'], mutant_count: 3 }],
    },
  };
  containerState.outputs.set(
    'packages/fixture/reports/mutation/raw.json',
    Buffer.from(JSON.stringify(raw)),
  );
  containerState.outputs.set(
    'packages/fixture/reports/mutation/compatibility.json',
    Buffer.from(JSON.stringify(compatibility)),
  );
  const expected = {
    resolution: value.productionResolution,
    container_identity: new ProtectedCertificationContainer(value.controls, value.dependencies)
      .identity,
    toolchain: options.toolchain,
    environment: {},
  };
  return { value, options, request: boundRequest, raw, expected };
}

export { ROOT, DYNAMIC, PACKAGE, fixture, context, request, providerFixture };
