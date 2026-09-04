import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { canonicalJson, canonicalSha256, parseConstitutionVersion } from '@devai-nyx/utils';
import { stringify } from 'yaml';
import { createReleasePolicyPackageTools } from '../../src/services/release-policy-package.js';
import {
  verifyReleaseCandidateSnapshot,
  type ReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from '../../src/services/release-candidate-snapshot.js';
import { buildResolvedReleasePlanReceipt } from '../../src/services/release-lifecycle.js';
import {
  buildReleaseMutationInputPlanV21,
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
const POLICY_PATH = 'law/policy/devai-adoption.json';
const BINDING_PATH = '.devai/config/adopter-policy-binding.json';
// Exact raw documents from Git revision 8ce7f7d, captured without reformatting.
// Tracked fixture bytes preserve the v1.1 reference in Stryker's history-free sandbox.
const FROZEN_DOCUMENTS: Readonly<
  Record<string, { readonly name: string; readonly sha256: string }>
> = {
  [POLICY_PATH]: {
    name: 'devai-adoption.json',
    sha256: '24982a246ee22c18779114f079e020bfbb7e23cb1fd34c002f5865c6508391b1',
  },
  'law/schemas/release-verification-profile.schema.json': {
    name: 'release-verification-profile.schema.json',
    sha256: '973db5abc11fa3511e063a17ce34caf06e861534a675303638f5e6ce1364ae52',
  },
};
const FROZEN_ROOT = join(ROOT, 'packages/cli/tests/fixtures/historical-mutation-inputs');

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
    const split = Buffer.byteLength(name, 'utf8') > 100 ? name.lastIndexOf('/') : -1;
    const headerName = split < 0 ? name : name.slice(split + 1);
    const prefix = split < 0 ? '' : name.slice(0, split);
    if (Buffer.byteLength(headerName, 'utf8') > 100 || Buffer.byteLength(prefix, 'utf8') > 155)
      throw new Error('fixture archive path too long');
    const bytes = Buffer.from(file.bytes);
    const header = Buffer.alloc(512);
    header.write(headerName, 0, 'utf8');
    header.write(prefix, 345, 'utf8');
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
  const document = FROZEN_DOCUMENTS[path];
  if (document === undefined) throw new Error('historical mutation fixture path unknown');
  const bytes = readFileSync(join(FROZEN_ROOT, document.name));
  if (sha256(bytes) !== document.sha256)
    throw new Error('historical mutation fixture digest mismatch');
  return bytes;
}

export function installedPackage(
  extraFiles: readonly ReleasePackageFile[] = [],
  options: { readonly current?: boolean } = {},
): ReleasePackageSnapshot {
  const version = options.current ? '1.5.0' : VERSION;
  const schemaRoot = join(ROOT, 'law/schemas');
  const policyRoot = join(ROOT, 'law/policy');
  const files: ReleasePackageFile[] = [
    ...extraFiles,
    {
      path: 'package.json',
      mode: 0o644,
      bytes: Buffer.from(JSON.stringify({ name: PACKAGE, version }), 'utf8'),
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
              name === 'release-verification-profile.schema.json' && !options.current
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
      version,
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

export function fixture(
  installed = installedPackage(),
  options: {
    readonly current?: boolean;
    readonly profileOverrides?: Readonly<Record<string, unknown>>;
  } = {},
): Fixture {
  const version = options.current ? '1.5.0' : VERSION;
  const policy = JSON.parse(
    (options.current ? readFileSync(join(ROOT, POLICY_PATH)) : frozen(POLICY_PATH)).toString(
      'utf8',
    ),
  ) as Record<string, unknown>;
  if (options.profileOverrides)
    policy['release_verification'] = {
      ...(policy['release_verification'] as Record<string, unknown>),
      ...options.profileOverrides,
    };
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
    frameworkVersion: version,
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
          dependencies: { [PACKAGE]: version },
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
            '.': { dependencies: { [PACKAGE]: { specifier: version, version } } },
          },
          packages: {
            [`${PACKAGE}@${version}`]: {
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

/** Explicit assembled v1.5.0 test package; never attributed to published v1.4.5. */
export function currentFixture(profileOverrides: Readonly<Record<string, unknown>> = {}): Fixture {
  return fixture(installedPackage([], { current: true }), { current: true, profileOverrides });
}

type BuildOptions = {
  readonly support?: 'current' | 'lts';
  readonly coverage?: ReleaseMutationExecutionCoverageV21;
  readonly message?: string;
  readonly modePath?: string;
  readonly mode?: string;
};

export function build(base: Fixture, files = base.files, options: BuildOptions = {}) {
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
