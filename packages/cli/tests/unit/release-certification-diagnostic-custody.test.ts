import type { SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeContainerDependencyArchive,
  type ContainerArchiveEntry,
  type ContainerDependencyArchiveEntry,
} from '../../src/services/container-archive.js';
import {
  ProtectedCertificationContainer,
  type ProtectedContainerDependency,
} from '../../src/services/release-certification-container.js';
import type { PlannedTask } from '../../src/services/check-runner/types.js';

interface TransportState {
  readonly calls: string[][];
  captured: Buffer;
  exitCode: number;
  id: string | undefined;
  workspaceVolume: string | undefined;
  mounts: {
    readonly Type: 'volume';
    readonly Name: string;
    readonly Destination: string;
    readonly RW: boolean;
  }[];
  isolationMismatch: boolean;
  running: boolean;
}

const transport = vi.hoisted((): TransportState => ({
  calls: [],
  captured: Buffer.alloc(0),
  exitCode: 0,
  id: undefined,
  workspaceVolume: undefined,
  mounts: [],
  isolationMismatch: false,
  running: false,
}));

vi.mock('@devai-nyx/authority', () => ({
  createProtectedReleaseHostAdapter: () => ({
    spawnSync(_command: string, args: readonly string[]) {
      return docker(args);
    },
  }),
}));

const IMAGE = `fixture/node@sha256:${'a'.repeat(64)}`;
const SOURCE: ContainerArchiveEntry = {
  path: 'src/input.ts',
  mode: '100644',
  bytes: Buffer.from('export const source = true;\n', 'utf8'),
};
const OUTPUT_A: ContainerArchiveEntry = {
  path: 'reports/a.json',
  mode: '100644',
  bytes: Buffer.from('{"diagnostic":"a"}\n', 'utf8'),
};
const OUTPUT_B: ContainerArchiveEntry = {
  path: 'reports/b.json',
  mode: '100644',
  bytes: Buffer.from('{"diagnostic":"b"}\n', 'utf8'),
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function result(stdout = Buffer.alloc(0), status = 0): SpawnSyncReturns<Buffer> {
  return {
    pid: 1,
    output: [null, stdout, Buffer.alloc(0)],
    stdout,
    stderr: Buffer.alloc(0),
    status,
    signal: null,
  };
}

function docker(args: readonly string[]): SpawnSyncReturns<Buffer> {
  transport.calls.push([...args]);
  const command = args.slice(4);
  if (command[0] === 'create') {
    const name = command[command.indexOf('--name') + 1];
    if (name === undefined) throw new Error('fixture docker create without name');
    if (name.startsWith('devai-certify-')) {
      transport.id = name;
      transport.mounts = command.flatMap((value, index) => {
        if (value !== '--mount') return [];
        const mount = command[index + 1];
        const match = mount?.match(/^type=volume,source=([^,]+),target=([^,]+)(,readonly)?$/u);
        if (match === null || match === undefined) return [];
        const [, source, destination, readonly] = match;
        if (source === undefined || destination === undefined) return [];
        return [
          {
            Type: 'volume' as const,
            Name: source,
            Destination: destination,
            RW: readonly !== ',readonly',
          },
        ];
      });
      transport.workspaceVolume = transport.mounts.find(
        (mount) => mount.Destination === '/workspace',
      )?.Name;
    }
    return result();
  }
  if (command[0] === 'start') return result(Buffer.alloc(0), transport.exitCode);
  if (command[0] === 'inspect') {
    const id = transport.id;
    const volume = transport.workspaceVolume;
    if (id === undefined || volume === undefined) throw new Error('fixture inspect before create');
    return result(
      Buffer.from(
        JSON.stringify([
          {
            State: {
              Running: transport.running,
              Pid: transport.running ? 1 : 0,
              Restarting: false,
              ExitCode: transport.exitCode,
              OOMKilled: false,
              Error: '',
            },
            HostConfig: {
              NetworkMode: transport.isolationMismatch ? 'bridge' : 'none',
              ReadonlyRootfs: true,
              Privileged: false,
              PidMode: '',
              IpcMode: 'none',
              RestartPolicy: { Name: 'no' },
              Memory: 64 * 1024 * 1024,
              MemorySwap: 64 * 1024 * 1024,
              NanoCpus: 1_000_000_000,
              PidsLimit: 2,
              CapDrop: ['ALL'],
              SecurityOpt: ['no-new-privileges'],
            },
            Mounts: transport.mounts,
          },
        ]),
      ),
    );
  }
  if (command[0] === 'cp' && command[1] === `${transport.id}:/workspace/candidate/.`)
    return result(Buffer.from(transport.captured.toString('base64'), 'base64'));
  return result();
}

function task(
  controls: ConstructorParameters<typeof ProtectedCertificationContainer>[0],
): PlannedTask {
  const node = controls.executables.node;
  if (node === undefined) throw new Error('fixture node executable missing');
  return {
    nodeId: 'fixture-task',
    taskKey: 'a'.repeat(64),
    dependencies: [],
    outputContract: {},
    argv: ['node', '--version'],
    executable: node,
    cwd: '.',
    inputDigest: 'b'.repeat(64),
    inputPaths: [],
    matchedChangedPaths: [],
    cacheState: 'execute',
    reason: 'fixture',
  };
}

interface Fixture {
  readonly root: string;
  readonly container: ProtectedCertificationContainer;
  readonly controls: ConstructorParameters<typeof ProtectedCertificationContainer>[0];
  readonly dependencies: readonly ProtectedContainerDependency[];
  readonly source: readonly ContainerArchiveEntry[];
}

function fixture(withDependency = false): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'devai-diagnostic-custody-'));
  const config = join(root, 'config');
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, 'config.json'), JSON.stringify({ auths: {} }), { mode: 0o600 });
  const docker = join(root, 'docker');
  writeFileSync(docker, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(docker, 0o700);
  const controls = {
    docker_binary: docker,
    docker_binary_sha256: sha256(readFileSync(docker)),
    docker_config_directory: config,
    engine_socket: 'unix:///fixture/docker.sock',
    engine_version: 'fixture-engine',
    image: IMAGE,
    node_version: process.version,
    executables: { node: { path: '/usr/local/bin/node', sha256: 'c'.repeat(64) } },
    memory_bytes: 64 * 1024 * 1024,
    cpus: 1,
    pids_limit: 2,
    maximum_archive_bytes: 1024 * 1024,
  } as const;
  const source = [SOURCE] as const;
  const completeSource = withDependency ? dependencySource() : source;
  const dependencies: readonly ProtectedContainerDependency[] = withDependency
    ? [dependencyFixture(completeSource)]
    : [];
  return {
    root,
    controls,
    container: new ProtectedCertificationContainer(controls, dependencies),
    dependencies,
    source: completeSource,
  };
}

function dependencySource(): readonly ContainerArchiveEntry[] {
  const rootManifest = Buffer.from('{"name":"fixture-root"}\n', 'utf8');
  const lockfile = Buffer.from('lockfileVersion: 9\n', 'utf8');
  const workspace = Buffer.from('packages:\n  - packages/package\n', 'utf8');
  const packageManifest = Buffer.from('{"name":"@fixture/package"}\n', 'utf8');
  return [
    SOURCE,
    { path: 'package.json', mode: '100644', bytes: rootManifest },
    { path: 'pnpm-lock.yaml', mode: '100644', bytes: lockfile },
    { path: 'pnpm-workspace.yaml', mode: '100644', bytes: workspace },
    { path: 'packages/package/package.json', mode: '100644', bytes: packageManifest },
  ];
}

function dependencyFixture(
  source: readonly ContainerArchiveEntry[],
  mountPath = 'node_modules',
  entries: readonly ContainerDependencyArchiveEntry[] = [
    { path: 'fixture/index.js', mode: '100644', bytes: Buffer.from('module.exports = 1;\n') },
  ],
): ProtectedContainerDependency {
  const file = (path: string): ContainerArchiveEntry => {
    const value = source.find((entry) => entry.path === path);
    if (value === undefined) throw new Error(`fixture dependency input missing: ${path}`);
    return value;
  };
  const archive = encodeContainerDependencyArchive(entries);
  return {
    mount_path: mountPath,
    archive,
    sha256: sha256(archive),
    inputs: {
      files: [
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'packages/package/package.json',
      ].map((path) => ({ path, sha256: sha256(file(path).bytes) })),
      workspace_packages: [
        {
          path: 'packages/package',
          name: '@fixture/package',
          manifest_sha256: sha256(file('packages/package/package.json').bytes),
        },
      ],
    },
  };
}

function execute(
  value: Fixture,
  options: {
    readonly captured: readonly ContainerDependencyArchiveEntry[];
    readonly status?: number;
    readonly diagnostic_output_paths?: readonly string[];
    readonly prior_outputs?: ReadonlyMap<string, ContainerArchiveEntry>;
    readonly source?: readonly ContainerArchiveEntry[];
    readonly declared_outputs?: readonly string[];
    readonly declared_namespaces?: readonly {
      readonly prefix: string;
      readonly required_paths: readonly string[];
    }[];
  },
) {
  transport.captured = encodeContainerDependencyArchive(options.captured);
  transport.exitCode = options.status ?? 0;
  return value.container.runBound(
    {
      action_id: 'release preflight',
      repository: { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      task_policy_digest_sha256: 'c'.repeat(64),
      plan_receipt_digest_sha256: 'd'.repeat(64),
      helper_identity_sha256: 'e'.repeat(64),
    },
    () =>
      value.container.execute({
        task: task(value.controls),
        timeout_ms: 1_000,
        environment: {},
        source: options.source ?? value.source,
        prior_outputs: options.prior_outputs ?? new Map(),
        declared_outputs: options.declared_outputs ?? [OUTPUT_A.path, OUTPUT_B.path],
        ...(options.diagnostic_output_paths === undefined
          ? {}
          : { diagnostic_output_paths: options.diagnostic_output_paths }),
        ...(options.declared_namespaces === undefined
          ? {}
          : { declared_namespaces: options.declared_namespaces }),
      }),
  );
}

afterEach(() => {
  transport.calls.length = 0;
  transport.captured = Buffer.alloc(0);
  transport.exitCode = 0;
  transport.id = undefined;
  transport.workspaceVolume = undefined;
  transport.mounts = [];
  transport.isolationMismatch = false;
  transport.running = false;
});

describe('protected dependency identity custody', () => {
  it('accepts a genuine workspace dependency mount and binds its exact identity', () => {
    const value = fixture();
    const source = dependencySource();
    const dependency = dependencyFixture(source, 'packages/package/node_modules');
    try {
      const container = new ProtectedCertificationContainer(value.controls, [dependency]);
      expect(container.identity).toMatchObject({
        dependencies: [{ mount_path: dependency.mount_path, sha256: dependency.sha256 }],
      });
      expect(transport.calls).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['the exact link', 'index.js', undefined],
    ['a changed link', 'other.js', 'release-certification-dependency-changed'],
  ] as const)('verifies %s from the captured dependency namespace', (_label, target, error) => {
    const dependencyFile: ContainerDependencyArchiveEntry = {
      path: 'fixture/index.js',
      mode: '100644',
      bytes: Buffer.from('module.exports = 1;\n'),
    };
    const entries: readonly ContainerDependencyArchiveEntry[] = [
      dependencyFile,
      { path: 'fixture/link.js', mode: '120000', target: 'index.js' },
    ];
    const value = fixture();
    const source = dependencySource();
    const dependency = dependencyFixture(source, 'node_modules', entries);
    const bound = {
      ...value,
      container: new ProtectedCertificationContainer(value.controls, [dependency]),
      dependencies: [dependency],
      source,
    };
    try {
      const operation = () =>
        execute(bound, {
          captured: [
            ...source,
            { ...dependencyFile, path: 'node_modules/fixture/index.js' },
            { path: 'node_modules/fixture/link.js', mode: '120000', target },
            OUTPUT_A,
            OUTPUT_B,
          ],
        });
      if (error === undefined) {
        expect(operation().result.status).toBe(0);
      } else {
        expect(operation).toThrow(error);
      }
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['duplicate source paths', { source: [SOURCE, SOURCE] }],
    ['a source that is also an output', { declared_outputs: [SOURCE.path] }],
    [
      'a source inside an output namespace',
      {
        declared_namespaces: [{ prefix: 'src', required_paths: ['src/generated.json'] }],
      },
    ],
    [
      'a predecessor inside an output namespace',
      {
        prior_outputs: new Map([
          [
            'reports/prior.json',
            {
              path: 'reports/prior.json',
              mode: '100644' as const,
              bytes: Buffer.from('{"prior":true}\n', 'utf8'),
            },
          ],
        ]),
        declared_namespaces: [{ prefix: 'reports', required_paths: ['reports/generated.json'] }],
      },
    ],
  ] as const)('refuses %s before creating a container namespace', (_label, options) => {
    const value = fixture();
    try {
      expect(() => execute(value, { captured: [], ...options })).toThrow(
        'release-certification-output-closure-invalid',
      );
      expect(transport.calls).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['an exact source path', 'source', 'node_modules'],
    ['a nested source path', 'source', 'node_modules/injected.js'],
    ['an exact output path', 'output', 'node_modules'],
    ['a nested output path', 'output', 'node_modules/generated.json'],
    ['an exact namespace prefix', 'namespace', 'node_modules'],
    ['a nested namespace prefix', 'namespace', 'node_modules/generated'],
  ] as const)(
    'refuses %s that collides with the protected dependency mount',
    (_label, kind, path) => {
      const value = fixture();
      const source = dependencySource();
      const dependency = dependencyFixture(source, 'node_modules', [
        { path: 'fixture/index.js', mode: '100644', bytes: Buffer.from('module.exports = 1;\n') },
      ]);
      const bound = {
        ...value,
        container: new ProtectedCertificationContainer(value.controls, [dependency]),
        dependencies: [dependency],
        source,
      };
      const collision: ContainerArchiveEntry = {
        path,
        mode: '100644',
        bytes: Buffer.from('collision\n', 'utf8'),
      };
      try {
        expect(() =>
          execute(bound, {
            captured: [],
            ...(kind === 'source' ? { source: [...source, collision] } : {}),
            ...(kind === 'output' ? { declared_outputs: [path] } : {}),
            ...(kind === 'namespace'
              ? {
                  declared_outputs: [],
                  declared_namespaces: [
                    { prefix: path, required_paths: [`${path}/required.json`] },
                  ],
                }
              : {}),
          }),
        ).toThrow('release-certification-output-closure-invalid');
        expect(transport.calls).toEqual([]);
      } finally {
        rmSync(value.root, { recursive: true, force: true });
      }
    },
  );

  it('uses the exact isolated loader and readonly mount for a verified dependency', () => {
    const value = fixture();
    const source = dependencySource();
    const dependencyEntry: ContainerDependencyArchiveEntry = {
      path: 'fixture/index.js',
      mode: '100644',
      bytes: Buffer.from('module.exports = 1;\n'),
    };
    const dependency = dependencyFixture(source, 'node_modules', [dependencyEntry]);
    const bound = {
      ...value,
      container: new ProtectedCertificationContainer(value.controls, [dependency]),
      dependencies: [dependency],
      source,
    };
    try {
      const result_ = execute(bound, {
        captured: [
          ...source,
          { ...dependencyEntry, path: `node_modules/${dependencyEntry.path}` },
          OUTPUT_A,
          OUTPUT_B,
        ],
      });
      expect(result_.result.status).toBe(0);
      const id = transport.id;
      if (id === undefined) throw new Error('fixture main container id missing');
      const commands = transport.calls.map((args) => args.slice(4));
      const restrictions = [
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '2',
        '--memory',
        String(64 * 1024 * 1024),
        '--memory-swap',
        String(64 * 1024 * 1024),
        '--cpus',
        '1',
        '--user',
        '10001:10001',
        '--ipc',
        'none',
        '--restart',
        'no',
        '--tmpfs',
        '/tmp:rw,exec,nosuid,nodev,size=536870912',
        '--env',
        'HOME=/tmp',
        '--env',
        'TMPDIR=/tmp',
      ];
      expect(commands).toContainEqual([
        'volume',
        'create',
        '--label',
        `devai.certification=${id}`,
        `${id}-workspace`,
      ]);
      expect(commands).toContainEqual([
        'volume',
        'create',
        '--label',
        `devai.certification=${id}`,
        `${id}-dependency-0`,
      ]);
      expect(commands).toContainEqual([
        'create',
        '--name',
        `${id}-dependency-loader`,
        ...restrictions,
        '--mount',
        `type=volume,source=${id}-workspace,target=/workspace`,
        '--mount',
        `type=volume,source=${id}-dependency-0,target=/workspace/candidate/node_modules`,
        IMAGE,
        '/usr/local/bin/node',
        '--version',
      ]);
      expect(commands).toContainEqual(['cp', '-a', '-', `${id}-dependency-loader:/workspace`]);
      const mainCreate = commands.find((command) => command[0] === 'create' && command[2] === id);
      expect(mainCreate).toEqual(
        expect.arrayContaining([
          '--mount',
          `type=volume,source=${id}-dependency-0,target=/workspace/candidate/node_modules,readonly`,
        ]),
      );
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('creates no dependency loader or dependency volume when the population is empty', () => {
    const value = fixture();
    try {
      expect(execute(value, { captured: [SOURCE, OUTPUT_A, OUTPUT_B] }).result.status).toBe(0);
      const commands = transport.calls.map((args) => args.slice(4));
      expect(commands.flat().some((value_) => value_.includes('-dependency-'))).toBe(false);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});

describe('protected container diagnostic output custody', () => {
  it('returns a separately copied, selected diagnostic subset after a successful exact closure', () => {
    const value = fixture();
    try {
      const result = execute(value, {
        captured: [SOURCE, OUTPUT_A, OUTPUT_B],
        diagnostic_output_paths: [OUTPUT_A.path],
      });
      expect(result.result.status).toBe(0);
      expect(result.outputs).toEqual([OUTPUT_A, OUTPUT_B]);
      expect(result.diagnostic_outputs).toEqual([OUTPUT_A]);
      const diagnostic = result.diagnostic_outputs?.[0];
      if (diagnostic === undefined) throw new Error('fixture diagnostic output missing');
      diagnostic.bytes.fill(0);
      expect(result.outputs[0]?.bytes).toEqual(OUTPUT_A.bytes);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('keeps failure outputs nonordinary while allowing missing newly declared outputs', () => {
    const value = fixture();
    try {
      const result = execute(value, {
        captured: [SOURCE, OUTPUT_A],
        status: 1,
        diagnostic_output_paths: [OUTPUT_A.path, OUTPUT_B.path],
      });
      expect(result.result.status).toBe(1);
      expect(result.outputs).toEqual([]);
      expect(result.diagnostic_outputs).toEqual([OUTPUT_A]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('preserves the legacy failure fast path when diagnostics are omitted', () => {
    const value = fixture();
    try {
      const result = execute(value, { captured: [SOURCE], status: 1 });
      expect(result.outputs).toEqual([]);
      expect(result).not.toHaveProperty('diagnostic_outputs');
      expect(
        transport.calls.some(
          (args) => args.slice(4, 6).join(' ') === `cp ${transport.id}:/workspace/candidate/.`,
        ),
      ).toBe(false);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'unproven namespace shutdown',
      (): void => {
        transport.running = true;
      },
      'release-certification-container-quiescence-unproven',
    ],
    [
      'an isolation mismatch',
      (): void => {
        transport.isolationMismatch = true;
      },
      'release-certification-container-isolation-mismatch',
    ],
  ] as const)('never returns diagnostic bytes after %s', (_label, configure, error) => {
    const value = fixture();
    try {
      configure();
      expect(() =>
        execute(value, {
          captured: [SOURCE, OUTPUT_A, OUTPUT_B],
          diagnostic_output_paths: [OUTPUT_A.path],
        }),
      ).toThrow(error);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['unsorted paths', [OUTPUT_B.path, OUTPUT_A.path]],
    ['a duplicate path', [OUTPUT_A.path, OUTPUT_A.path]],
    ['a path outside declared outputs', ['reports/not-declared.json']],
  ] as const)('refuses diagnostic selections with %s before container effects', (_label, paths) => {
    const value = fixture();
    try {
      expect(() =>
        execute(value, { captured: [SOURCE, OUTPUT_A, OUTPUT_B], diagnostic_output_paths: paths }),
      ).toThrow('release-certification-output-closure-invalid');
      expect(transport.calls).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['a missing source', [], 'release-certification-output-closure-invalid'],
    [
      'a changed source',
      [{ ...SOURCE, bytes: Buffer.from('changed\n') }],
      'release-certification-source-changed',
    ],
    [
      'an unexpected output',
      [SOURCE, { path: 'reports/unexpected.json', mode: '100644', bytes: Buffer.alloc(0) }],
      'release-certification-output-closure-invalid',
    ],
    [
      'a symbolic-link entry',
      [{ path: 'src/input.ts', mode: '120000', target: '/host/input.ts' }],
      'release-certification-source-mode-unsupported',
    ],
  ] as const)('refuses failed diagnostic capture with %s', (_label, captured, error) => {
    const value = fixture();
    try {
      expect(() =>
        execute(value, {
          captured,
          status: 1,
          diagnostic_output_paths: [OUTPUT_A.path],
        }),
      ).toThrow(error);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('refuses missing or changed predecessor and dependency bytes during failed diagnostic capture', () => {
    const value = fixture(true);
    try {
      const predecessor: ContainerArchiveEntry = {
        path: OUTPUT_A.path,
        mode: OUTPUT_A.mode,
        bytes: Buffer.from('{"prior":true}\n'),
      };
      const dependency = {
        path: 'node_modules/fixture/index.js',
        mode: '100644' as const,
        bytes: Buffer.from('module.exports = 1;\n'),
      };
      expect(() =>
        execute(value, {
          captured: [...value.source, predecessor],
          status: 1,
          diagnostic_output_paths: [OUTPUT_A.path],
          prior_outputs: new Map([[predecessor.path, predecessor]]),
        }),
      ).toThrow('release-certification-output-closure-invalid');
      expect(() =>
        execute(value, {
          captured: [...value.source, dependency],
          status: 1,
          diagnostic_output_paths: [OUTPUT_A.path],
          prior_outputs: new Map([[predecessor.path, predecessor]]),
        }),
      ).toThrow('release-certification-output-closure-invalid');
      expect(() =>
        execute(value, {
          captured: [
            ...value.source,
            { ...dependency, bytes: Buffer.from('changed\n') },
            predecessor,
          ],
          status: 1,
          diagnostic_output_paths: [OUTPUT_A.path],
          prior_outputs: new Map([[predecessor.path, predecessor]]),
        }),
      ).toThrow('release-certification-dependency-changed');
      expect(() =>
        execute(value, {
          captured: [
            ...value.source,
            dependency,
            { ...predecessor, bytes: Buffer.from('{"prior":false}\n') },
          ],
          status: 1,
          diagnostic_output_paths: [OUTPUT_A.path],
          prior_outputs: new Map([[predecessor.path, predecessor]]),
        }),
      ).toThrow('release-certification-predecessor-output-changed');
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});
