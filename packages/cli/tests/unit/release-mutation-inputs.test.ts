import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { canonicalJson, canonicalSha256, parseConstitutionVersion } from '@devai-nyx/utils';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createReleasePolicyPackageTools } from '../../src/services/release-policy-package.js';
import {
  verifyReleaseCandidateSnapshot,
  type ReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from '../../src/services/release-candidate-snapshot.js';
import { buildResolvedReleasePlanReceipt } from '../../src/services/release-lifecycle.js';
import {
  assertReleaseMutationInputProjectionV21,
  buildReleaseMutationInputPlanV21,
  isDerivedReleaseMutationInputPlanV21,
  type ReleaseMutationExecutionCoverageV21,
} from '../../src/services/release-mutation-inputs.js';
import { resolveReleasePolicySnapshot } from '../../src/services/release-policy-resolution.js';
import {
  verifyReleasePackageSnapshot,
  type ReleasePackageFile,
  type ReleasePackageSnapshot,
} from '../../src/services/release-package-snapshot.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PACKAGE = '@aarusso-nyx/devai';
const VERSION = '1.4.5';
const FROZEN_POLICY_REVISION = '8ce7f7d';
const POLICY_PATH = 'law/policy/devai-adoption.json';
const BINDING_PATH = '.devai/config/adopter-policy-binding.json';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function octal(header: Buffer, offset: number, width: number, value: number): void {
  header.write(value.toString(8).padStart(width - 1, '0'), offset, width - 1, 'ascii');
  header[offset + width - 1] = 0;
}

function archive(files: readonly ReleasePackageFile[]): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const name = `package/${file.path}`;
    if (Buffer.byteLength(name, 'utf8') > 100) throw new Error('fixture archive path too long');
    const bytes = Buffer.from(file.bytes);
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
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
      header.reduce((total, byte) => total + byte, 0),
    );
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.byteLength % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

function frozen(path: string): Buffer {
  return execFileSync('git', ['show', `${FROZEN_POLICY_REVISION}:${path}`], {
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function installedPackage(): ReleasePackageSnapshot {
  const schemaRoot = join(ROOT, 'law/schemas');
  const policyRoot = join(ROOT, 'law/policy');
  const files: ReleasePackageFile[] = [
    {
      path: 'package.json',
      mode: 0o644,
      bytes: Buffer.from(JSON.stringify({ name: PACKAGE, version: VERSION }), 'utf8'),
    },
    {
      path: 'dist/law/constitution.md',
      mode: 0o644,
      bytes: readFileSync(join(ROOT, 'law/constitution.md')),
    },
    ...readdirSync(schemaRoot)
      .filter((name) => name.endsWith('.schema.json'))
      .sort()
      .map(
        (name) =>
          ({
            path: `dist/runtime/index/schemas/${name}`,
            mode: 0o644,
            bytes:
              name === 'release-verification-profile.schema.json'
                ? frozen(`law/schemas/${name}`)
                : readFileSync(join(schemaRoot, name)),
          }) satisfies ReleasePackageFile,
      ),
    ...[
      'domains.json',
      'thresholds.json',
      'scorecard-na.json',
      'glob-guards.json',
      'release-lifecycle.json',
      'action-registry.json',
      'mutation-evidence-v2.json',
    ].map(
      (name) =>
        ({
          path: `dist/law/policy/${name}`,
          mode: 0o644,
          bytes: readFileSync(join(policyRoot, name)),
        }) satisfies ReleasePackageFile,
    ),
  ];
  const compressed = archive(files);
  const manifest = files
    .map((file) => ({
      path: file.path,
      mode: file.mode,
      size: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const directories = [
    ...new Set(
      files.flatMap((file) =>
        Array.from({ length: file.path.split('/').length - 1 }, (_, index) =>
          file.path
            .split('/')
            .slice(0, index + 1)
            .join('/'),
        ),
      ),
    ),
  ].sort();
  return verifyReleasePackageSnapshot({
    expected: {
      name: PACKAGE,
      version: VERSION,
      archive_sha256: sha256(compressed),
      content_manifest_sha256: canonicalSha256(manifest),
    },
    archive: compressed,
    installed_files: files,
    installed_directories: directories,
    maximum_archive_bytes: compressed.byteLength,
    maximum_unpacked_bytes: 8 * 1024 * 1024,
  });
}

function oid(type: ReleaseGitObject['type'], bytes: Uint8Array): string {
  return createHash('sha1').update(`${type} ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function candidate(
  files: ReadonlyMap<string, Uint8Array>,
  options: { readonly modePath?: string; readonly mode?: string; readonly message?: string } = {},
): ReleaseCandidateSnapshot {
  type Tree = {
    readonly children: Map<string, Tree | { readonly path: string; readonly bytes: Buffer }>;
  };
  const root: Tree = { children: new Map() };
  const objects = new Map<string, ReleaseGitObject>();
  for (const [filePath, value] of files) {
    const parts = filePath.split('/');
    const leaf = parts.pop();
    if (leaf === undefined) throw new Error('fixture file path missing leaf');
    let current = root;
    for (const part of parts) {
      const existing = current.children.get(part);
      const next = existing ?? { children: new Map() };
      if ('bytes' in next) throw new Error('fixture path collision');
      current.children.set(part, next);
      current = next;
    }
    current.children.set(leaf, { path: filePath, bytes: Buffer.from(value) });
  }
  const tree = (node: Tree): string => {
    const entries = [...node.children]
      .map(([name, child]) => {
        if ('bytes' in child) {
          const id = oid('blob', child.bytes);
          objects.set(id, { type: 'blob', bytes: child.bytes });
          return {
            name,
            mode: child.path === options.modePath ? (options.mode ?? '100755') : '100644',
            id,
          };
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
    `tree ${treeId}\nauthor Fixture <fixture@example.invalid> 0 +0000\n\n${options.message ?? 'fixture'}\n`,
  );
  const commit = oid('commit', commitBytes);
  objects.set(commit, { type: 'commit', bytes: commitBytes });
  return verifyReleaseCandidateSnapshot({
    repository: { id: 'aarusso-nyx/devai', commit, tree: treeId },
    objects,
    maximum_bytes: 8 * 1024 * 1024,
    maximum_entries: 10_000,
  });
}

interface Fixture {
  readonly installed: ReleasePackageSnapshot;
  readonly files: Map<string, Uint8Array>;
}

function fixture(): Fixture {
  const installed = installedPackage();
  const policy = JSON.parse(frozen(POLICY_PATH).toString('utf8')) as Record<string, unknown>;
  const tools = createReleasePolicyPackageTools(installed);
  const pin = installed.read('dist/law/constitution.md');
  const constitutionVersion = parseConstitutionVersion(pin.toString('utf8'));
  if (constitutionVersion === null) throw new Error('fixture constitution version missing');
  const materialized = tools.materialize({
    policy,
    currentProject: {
      schemaVersion: '1.0.0',
      project_type: 'framework',
      constitution: { version: constitutionVersion, sha256: sha256(pin) },
    },
    frameworkVersion: VERSION,
  });
  const policyBytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  const binding = {
    schemaVersion: '1.0.0',
    policy_id: policy['policy_id'],
    policy_version: policy['policy_version'],
    source_path: POLICY_PATH,
    source_digest_sha256: sha256(policyBytes),
    materialized: Object.fromEntries(
      [...materialized].map(([path, bytes]) => [path, sha256(Buffer.from(bytes))]),
    ),
  };
  const release = policy['release_verification'] as Record<string, unknown>;
  const roster = release['mutation_roster'] as readonly Record<string, unknown>[];
  const files = new Map<string, Uint8Array>([
    [POLICY_PATH, policyBytes],
    [BINDING_PATH, Buffer.from(canonicalJson(binding), 'utf8')],
    ['.devai/pin/constitution.md', pin],
    ...[...materialized].map(([path, bytes]) => [path, Buffer.from(bytes)] as const),
    [
      'package.json',
      Buffer.from(
        JSON.stringify({
          name: 'mutation-fixture',
          version: '1.0.0',
          packageManager: 'pnpm@9.15.0',
          dependencies: { [PACKAGE]: VERSION },
        }),
      ),
    ],
    ['pnpm-workspace.yaml', Buffer.from('packages:\n  - packages/*\n', 'utf8')],
    [
      'pnpm-lock.yaml',
      Buffer.from(
        stringify({
          lockfileVersion: '9.0',
          importers: {
            '.': { dependencies: { [PACKAGE]: { specifier: VERSION, version: VERSION } } },
          },
          packages: {
            [`${PACKAGE}@${VERSION}`]: {
              resolution: {
                integrity: `sha512-${createHash('sha512').update(installed.readArchive()).digest('base64')}`,
              },
            },
          },
        }),
      ),
    ],
  ]);
  const tasks = roster.map((entry) => ({
    nodeId: entry['task_node'],
    dependencies: [],
    argv: ['pnpm', 'test'],
    cwd: '.',
    runner: 'vitest-v1',
    inputSelectors: [{ kind: 'prefix', pattern: `packages/${entry['id']}/` }],
    toolchainKeys: ['node', 'pnpm', 'vitest'],
    allowlistedEnv: ['CI'],
    outputContract: { kind: 'tracked-files', paths: [entry['manifest_path']] },
  }));
  files.set(
    'test-tasks.json',
    Buffer.from(
      JSON.stringify({
        schemaVersion: '1.0.0',
        descriptorVersion: 'fixture1',
        repositoryId: 'aarusso-nyx/devai',
        fallbackNodeId: null,
        dynamicFallbackSelectors: [],
        tasks,
        profiles: [
          { profileId: 'local', mode: 'fixed', requiredNodes: tasks.map((task) => task.nodeId) },
        ],
      }),
    ),
  );
  for (const entry of roster) {
    const id = entry['id'];
    const manifestPath = entry['manifest_path'];
    const packageName = entry['package'];
    if (
      typeof id !== 'string' ||
      typeof manifestPath !== 'string' ||
      typeof packageName !== 'string'
    )
      throw new Error('fixture roster malformed');
    const dependencies =
      id === 'authority'
        ? { '@devai-nyx/schemas': 'workspace:*' }
        : id === 'schemas'
          ? { '@devai-nyx/utils': 'workspace:*' }
          : {};
    files.set(
      manifestPath,
      Buffer.from(JSON.stringify({ name: packageName, version: '1.0.0', dependencies })),
    );
    files.set(`packages/${id}/src/main.ts`, Buffer.from('export const value = true;\n'));
    files.set(`packages/${id}/src/types.d.ts`, Buffer.from('export type Value = boolean;\n'));
    files.set(`packages/${id}/src/main.test.ts`, Buffer.from('export const fixture = true;\n'));
    files.set(
      `packages/${id}/src/__tests__/hidden.ts`,
      Buffer.from('export const fixture = true;\n'),
    );
    files.set(`packages/${id}/tests/main.test.ts`, Buffer.from('export const test = true;\n'));
    files.set(
      `packages/${id}/tsconfig.json`,
      Buffer.from('{"extends":"../../tsconfig.base.json"}\n'),
    );
  }
  files.set('tests/config/local.config.ts', Buffer.from('export default {};\n'));
  files.set('vitest.config.ts', Buffer.from('export default {};\n'));
  files.set('tsconfig.base.json', Buffer.from('{"compilerOptions":{"target":"ES2023"}}\n'));
  files.set('law/schemas/fixture.schema.json', Buffer.from('{}\n'));
  files.set(
    'packages/cli/vendor/evidence-verification/src/mutation-v21.js',
    readFileSync(join(ROOT, 'packages/cli/vendor/evidence-verification/src/mutation-v21.js')),
  );
  return { installed, files };
}

type BuildOptions = {
  readonly support?: 'current' | 'lts';
  readonly coverage?: ReleaseMutationExecutionCoverageV21;
  readonly message?: string;
  readonly modePath?: string;
};

function build(base: Fixture, files = base.files, options: BuildOptions = {}) {
  const snapshot = candidate(files, options);
  const resolution = resolveReleasePolicySnapshot({
    expected: {
      repository: snapshot.repository,
      installed_package: base.installed.identity,
      installation_origin: 'candidate-adopter-dependency',
      release_unit: PACKAGE,
    },
    installed_package: base.installed,
    candidate: snapshot,
  });
  const receipt = buildResolvedReleasePlanReceipt({
    resolution,
    intent: {
      schemaVersion: '1.0.0',
      release_unit: PACKAGE,
      current_version: '1.4.5',
      target_version: '1.5.0',
      support: options.support ?? 'current',
      change_kind: 'behavioral',
      changed_paths: [],
      changed_packages: [],
      risks: [],
      candidate: { commit: snapshot.repository.commit, tree: snapshot.repository.tree },
      base: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    },
  });
  const coverage =
    options.coverage ??
    (options.support === 'lts'
      ? { kind: 'plan-determined' as const }
      : {
          kind: 'owner-approved-complete-devai-roster' as const,
          repository: snapshot.repository,
          release_unit: PACKAGE,
          target_version: '1.5.0',
          release_plan_receipt_digest: receipt.receipt_digest_sha256,
          release_profile_digest: canonicalSha256(
            resolution.readInput('release-verification-profile'),
          ),
          policy_resolution_digest: canonicalSha256(resolution.resolution),
        });
  const controls = {
    execution_coverage: coverage,
    container: {
      docker_binary: '/protected/docker',
      docker_binary_sha256: 'a'.repeat(64),
      docker_config_directory: '/protected/config',
      engine_socket: 'unix:///protected/docker.sock',
      engine_version: '29.5.2',
      image: `node@sha256:${'b'.repeat(64)}`,
      node_version: 'v24.20.0',
      executables: { node: { path: '/usr/local/bin/node', sha256: 'c'.repeat(64) } },
      memory_bytes: 256 * 1024 * 1024,
      cpus: 0.5,
      pids_limit: 64,
      maximum_archive_bytes: 1024 * 1024,
    },
    dependencies: [],
    environment: { CI: '1' },
    toolchain: {
      node: 'v24.20.0',
      pnpm: '9.15.0',
      vitest: '4.1.10',
      typescript: '5.9.3',
      stryker: '9.6.1',
    },
    maximum_source_bytes: 8 * 1024 * 1024,
    maximum_source_entries: 10_000,
  };
  return {
    snapshot,
    resolution,
    receipt,
    controls,
    plan: buildReleaseMutationInputPlanV21({
      candidate: snapshot,
      resolution,
      plan_receipt: receipt,
      controls,
    }),
  };
}

function packageDigest(plan: ReturnType<typeof build>['plan'], id: string): string {
  const entry = plan.packages.find((value) => value.id === id);
  if (entry === undefined) throw new Error(`fixture package ${id} missing`);
  return entry.input_digest;
}

function mutate(
  files: ReadonlyMap<string, Uint8Array>,
  path: string,
  bytes: Uint8Array,
): Map<string, Uint8Array> {
  const result = new Map(files);
  result.set(path, Buffer.from(bytes));
  return result;
}

describe('protected release mutation input derivation', () => {
  it('derives all ten packages and all twelve immutable bindings from genuine snapshots', () => {
    const value = build(fixture());

    expect(value.receipt.determination).toMatchObject({ support: 'current', mutation: 'targeted' });
    expect(isDerivedReleaseMutationInputPlanV21(value.plan)).toBe(true);
    expect(value.plan.grants).toEqual({ execution: false, certification: false, reuse: false });
    expect(value.plan.packages).toHaveLength(10);
    for (const entry of value.plan.packages) {
      const projection = entry.expected.inputProjection;
      if (projection === null || typeof projection !== 'object' || Array.isArray(projection))
        throw new Error('fixture projection malformed');
      const bindings = projection['bindings'];
      if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings))
        throw new Error('fixture bindings malformed');
      expect(Object.keys(bindings)).toHaveLength(12);
      expect(entry.mutation_targets.map((target) => target.path)).toEqual(['src/main.ts']);
      expect(entry.selected_source.length).toBeGreaterThan(entry.mutation_targets.length);
      expect(entry.reuse).toEqual({
        eligible: false,
        unresolved: expect.arrayContaining(['toolchain-fixture-validation-required']),
      });
      assertReleaseMutationInputProjectionV21(
        value.plan,
        entry.expected.packageName,
        entry.expected.inputProjection,
      );
    }
    expect(
      value.plan.packages.find((entry) => entry.id === 'authority')?.workspace_dependencies,
    ).toEqual(['@devai-nyx/schemas', '@devai-nyx/utils']);
  });

  it('requires the exact Owner campaign coverage for current targeted DEVAI and permits plan coverage only for lts full roster', () => {
    const base = fixture();
    const current = build(base);
    const lts = build(base, base.files, { support: 'lts' });

    expect(lts.receipt.determination).toMatchObject({ support: 'lts', mutation: 'full-roster' });
    expect(() => build(base, base.files, { coverage: { kind: 'plan-determined' } })).toThrow(
      'MUTATION_ROSTER_MISMATCH',
    );
    expect(() =>
      build(base, base.files, {
        coverage: {
          ...current.controls.execution_coverage,
          policy_resolution_digest: '0'.repeat(64),
        } as ReleaseMutationExecutionCoverageV21,
      }),
    ).toThrow('MUTATION_ROSTER_MISMATCH');
  });

  it('refuses stale, missing, and extra coverage controls before deriving a producer input plan', () => {
    const base = fixture();
    const current = build(base);
    const coverage = current.controls.execution_coverage;
    if (coverage.kind !== 'owner-approved-complete-devai-roster')
      throw new Error('fixture expected Owner campaign coverage');
    const stale = { ...coverage, release_plan_receipt_digest: '0'.repeat(64) };
    const missing = { ...current.controls, execution_coverage: undefined };
    const extra = { ...coverage, unexpected_package_list: ['cli'] };

    expect(() => build(base, base.files, { coverage: stale })).toThrow('MUTATION_ROSTER_MISMATCH');
    expect(() =>
      buildReleaseMutationInputPlanV21({
        candidate: current.snapshot,
        resolution: current.resolution,
        plan_receipt: current.receipt,
        // The public TypeScript surface is narrow, but the runtime guard must reject an
        // untrusted decoded control record whose required value is absent.
        controls: missing as unknown as typeof current.controls,
      }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
    expect(() =>
      build(base, base.files, { coverage: extra as ReleaseMutationExecutionCoverageV21 }),
    ).toThrow('MUTATION_ROSTER_MISMATCH');
  });

  it('binds source, configuration, lock, environment, toolchain, and Git mode drift to the right packages', () => {
    const base = fixture();
    const initial = build(base);
    const source = build(
      base,
      mutate(
        base.files,
        'packages/utils/src/main.ts',
        Buffer.from('export const value = false;\n'),
      ),
    );
    const sharedConfig = build(
      base,
      mutate(
        base.files,
        'tsconfig.base.json',
        Buffer.from('{"compilerOptions":{"target":"ES2022"}}\n'),
      ),
    );
    const mode = build(base, base.files, { modePath: 'packages/utils/src/main.ts' });
    const unrelated = build(
      base,
      mutate(
        base.files,
        'packages/evidence/src/main.ts',
        Buffer.from('export const value = false;\n'),
      ),
    );

    for (const id of ['authority', 'schemas', 'utils'])
      expect(packageDigest(source.plan, id)).not.toBe(packageDigest(initial.plan, id));
    expect(packageDigest(source.plan, 'evidence')).toBe(packageDigest(initial.plan, 'evidence'));
    expect(packageDigest(unrelated.plan, 'utils')).toBe(packageDigest(initial.plan, 'utils'));
    expect(packageDigest(unrelated.plan, 'evidence')).not.toBe(
      packageDigest(initial.plan, 'evidence'),
    );
    expect(
      sharedConfig.plan.packages.every(
        (entry, index) => entry.input_digest !== initial.plan.packages[index]?.input_digest,
      ),
    ).toBe(true);
    expect(packageDigest(mode.plan, 'utils')).not.toBe(packageDigest(initial.plan, 'utils'));
    expect(() =>
      build(
        base,
        mutate(
          base.files,
          'pnpm-lock.yaml',
          Buffer.from('lockfileVersion: "9.0"\nimporters: {}\n'),
        ),
      ),
    ).toThrow(/^rpl-/u);
    expect(() =>
      buildReleaseMutationInputPlanV21({
        candidate: initial.snapshot,
        resolution: initial.resolution,
        plan_receipt: initial.receipt,
        controls: {
          ...initial.controls,
          environment: { ...initial.controls.environment, PATH: '/ambient' },
        },
      }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
    expect(() =>
      buildReleaseMutationInputPlanV21({
        candidate: initial.snapshot,
        resolution: initial.resolution,
        plan_receipt: initial.receipt,
        controls: {
          ...initial.controls,
          toolchain: { ...initial.controls.toolchain, node: 'v0.0.0' },
        },
      }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
  });

  it('keeps input identity stable across commit-only changes but makes empty or dynamic configuration ineligible', () => {
    const base = fixture();
    const initial = build(base);
    const sameContent = build(base, base.files, { message: 'same tree, another commit' });
    const emptyTarget = new Map(base.files);
    emptyTarget.delete('packages/utils/src/main.ts');
    const unresolvedConfig = mutate(
      base.files,
      'packages/utils/tsconfig.json',
      Buffer.from('{"extends":"unapproved-config-package"}\n'),
    );
    const dynamicConfig = mutate(
      base.files,
      'test-tasks.json',
      Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(base.files.get('test-tasks.json') ?? []).toString('utf8')),
          dynamicFallbackSelectors: [{ kind: 'prefix', pattern: 'packages/' }],
        }),
      ),
    );

    expect(sameContent.snapshot.repository.commit).not.toBe(initial.snapshot.repository.commit);
    expect(sameContent.plan.packages.map((entry) => entry.input_digest)).toEqual(
      initial.plan.packages.map((entry) => entry.input_digest),
    );
    expect(() => build(base, emptyTarget)).toThrow('MUTATION_INCOMPLETE');
    expect(
      build(base, unresolvedConfig).plan.packages.find((entry) => entry.id === 'utils')?.reuse
        .unresolved,
    ).toContain('typescript-configuration-reference-unresolved');
    const dynamic = build(base, dynamicConfig).plan;
    expect(dynamic.packages.every((entry) => entry.reuse.eligible === false)).toBe(true);
    expect(
      dynamic.packages.every((entry) =>
        entry.reuse.unresolved.includes('dynamic-task-input-selection-unresolved'),
      ),
    ).toBe(true);
  });
});
