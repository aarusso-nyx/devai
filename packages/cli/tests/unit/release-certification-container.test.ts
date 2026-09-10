import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContainerArchiveEntry } from '../../src/services/container-archive.js';
import type { PlannedTask } from '../../src/services/check-runner/types.js';
import type { ProtectedMutationProgram } from '../../src/services/release-mutation-program.js';
import {
  createMutationContainerTransportFixture,
  type MutationContainerTransportFixture,
} from '../helpers/release-mutation-container-fixture.js';

const { dockerCalls, mutationTransport } = vi.hoisted(() => ({
  dockerCalls: [] as string[][],
  mutationTransport: {
    docker: undefined as MutationContainerTransportFixture['docker'] | undefined,
  },
}));

const mutationProgram = vi.hoisted(() =>
  Object.freeze({
    kind: 'protected-mutation-program-v1' as const,
    identity_sha256: 'a'.repeat(64),
  }),
);

const capturedMutationProgram = vi.hoisted(() => ({
  identity_sha256: 'a'.repeat(64),
  files: [] as ContainerArchiveEntry[],
  argv: ['node', '/devai-host/run.mjs'] as string[],
  maximum_observation_bytes: 8,
  maximum_raw_report_bytes: 12,
}));

const mutationExecutionAssertion = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/release-mutation-program.js', () => ({
  captureProtectedMutationProgram(value: unknown) {
    if (value !== mutationProgram) throw new Error('release-mutation-program-invalid');
    return {
      ...capturedMutationProgram,
      argv: [...capturedMutationProgram.argv],
      files: capturedMutationProgram.files.map((entry) => ({
        ...entry,
        bytes: Buffer.from(entry.bytes),
      })),
    };
  },
  assertProtectedMutationProgramExecution: mutationExecutionAssertion,
}));

vi.mock('@devai-nyx/authority', () => ({
  createProtectedReleaseHostAdapter: () => ({
    spawnSync(command: string, args: readonly string[], options: Parameters<typeof spawnSync>[2]) {
      dockerCalls.push([...args]);
      if (mutationTransport.docker !== undefined)
        return mutationTransport.docker(args, options?.input as Buffer | undefined);
      return spawnSync(command, args, options);
    },
  }),
}));

import { ProtectedCertificationContainer } from '../../src/services/release-certification-container.js';

type ProbeMode = 'correct' | 'extra-observed' | 'missing-executables' | 'omit-ps';

interface ImageInspection {
  readonly Os: string;
  readonly Architecture: string;
  readonly Id?: string;
  readonly RepoDigests?: readonly unknown[];
  readonly Descriptor?: { readonly annotations?: Readonly<Record<string, string>> };
  readonly RootFS?: { readonly Type?: string; readonly Layers?: readonly string[] };
}

interface Fixture {
  readonly root: string;
  readonly controls: ConstructorParameters<typeof ProtectedCertificationContainer>[0];
}

const IMAGE = `fixture/node@sha256:${'a'.repeat(64)}`;
const CONFIGURATION_SHA256 = 'b'.repeat(64);
const MANIFEST_SHA256 = 'c'.repeat(64);
const ROOTFS_DIFF_IDS = [`sha256:${'d'.repeat(64)}`, `sha256:${'e'.repeat(64)}`] as const;
const MUTATION_SOURCE: ContainerArchiveEntry = {
  path: 'src/input.ts',
  mode: '100644',
  bytes: Buffer.from('export const input = true;\n', 'utf8'),
};
const VALID_MUTATION_FILES: readonly ContainerArchiveEntry[] = [
  { path: 'invocation.json', mode: '100644', bytes: Buffer.from('{"fixture":true}', 'utf8') },
  { path: 'run.mjs', mode: '100644', bytes: Buffer.from('export {};\n', 'utf8') },
];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fakeDockerSource(mode: ProbeMode, imageInspection?: ImageInspection): string {
  return `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const image = ${JSON.stringify(IMAGE)};
const command = args.includes('version') ? 'version' : args.includes('image') ? 'image' : args.includes('run') ? 'run' : '';
if (command === 'version') { process.stdout.write('fixture-engine\\n'); process.exit(0); }
if (command === 'image') { process.stdout.write(JSON.stringify([${JSON.stringify(imageInspection ?? { Os: 'linux', Architecture: 'arm64', RepoDigests: [IMAGE] })}])); process.exit(0); }
if (command !== 'run') process.exit(64);
const index = args.indexOf('-e');
if (index < 0 || args[index + 1] === undefined || args[index + 2] === undefined) process.exit(64);
const bootstrap = args[index + 1];
const controls = args[index + 2];
const wrapper = String.raw\`const fs=require('node:fs');const original=fs.readFileSync;fs.readFileSync=(path,...rest)=>path==='/usr/local/bin/node'?original(process.execPath,...rest):original(path,...rest);eval(Buffer.from(process.argv[2],'base64').toString('utf8'));\`;
const result = spawnSync(process.execPath, ['-e', wrapper, controls, Buffer.from(bootstrap).toString('base64')], { encoding: 'buffer' });
if (result.status !== 0 || result.signal !== null || result.error !== undefined) { process.stderr.write(result.stderr ?? ''); process.exit(result.status ?? 1); }
let observed = JSON.parse(result.stdout.toString('utf8'));
${
  mode === 'extra-observed'
    ? "observed.executables.unlisted = { path: '/bin/unlisted', sha256: '0'.repeat(64) };"
    : mode === 'omit-ps'
      ? 'delete observed.executables.ps;'
      : mode === 'missing-executables'
        ? 'delete observed.executables;'
        : ''
}
process.stdout.write(JSON.stringify(observed));
`;
}

function executable(controls: Fixture['controls'], name: string) {
  const value = controls.executables[name];
  if (value === undefined) throw new Error(`fixture executable missing: ${name}`);
  return value;
}

function fixture(mode: ProbeMode = 'correct', imageInspection?: ImageInspection): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'devai-container-probe-'));
  const config = join(root, 'config');
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, 'config.json'), JSON.stringify({ auths: {} }), { mode: 0o600 });
  const ps = join(root, 'ps');
  const git = join(root, 'git');
  writeExecutable(ps, '#!/bin/sh\necho fixture-ps\n');
  writeExecutable(git, '#!/bin/sh\necho fixture-git\n');
  const docker = join(root, 'docker');
  writeExecutable(docker, fakeDockerSource(mode, imageInspection));
  const nodeBytes = readFileSync(process.execPath);
  return {
    root,
    controls: {
      docker_binary: docker,
      docker_binary_sha256: sha256(readFileSync(docker)),
      docker_config_directory: config,
      engine_socket: 'unix:///fixture/docker.sock',
      engine_version: 'fixture-engine',
      image: IMAGE,
      node_version: process.version,
      executables: {
        node: { path: '/usr/local/bin/node', sha256: sha256(nodeBytes) },
        ps: { path: ps, sha256: sha256(readFileSync(ps)) },
        git: { path: git, sha256: sha256(readFileSync(git)) },
      },
      memory_bytes: 64 * 1024 * 1024,
      cpus: 1,
      pids_limit: 2,
      maximum_archive_bytes: 1024 * 1024,
    },
  };
}

function localImageControls(
  controls: Fixture['controls'],
  image = `sha256:${CONFIGURATION_SHA256}`,
): Fixture['controls'] {
  return {
    ...controls,
    image,
    local_image: {
      configuration_sha256: CONFIGURATION_SHA256,
      rootfs_diff_ids: ROOTFS_DIFF_IDS,
    },
  };
}

function verify(controls: Fixture['controls']): void {
  const container = new ProtectedCertificationContainer(controls);
  container.runBound(
    {
      action_id: 'release preflight',
      repository: { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      task_policy_digest_sha256: 'c'.repeat(64),
      plan_receipt_digest_sha256: 'd'.repeat(64),
      helper_identity_sha256: 'e'.repeat(64),
    },
    () => container.verifyRuntime(),
  );
}

function plannedMutationTask(controls: Fixture['controls']): PlannedTask {
  const node = controls.executables.node;
  if (node === undefined) throw new Error('fixture node executable missing');
  return {
    nodeId: 'fixture-mutation',
    taskKey: 'd'.repeat(64),
    dependencies: [],
    outputContract: {},
    argv: ['node', '/devai-host/run.mjs'],
    executable: node,
    cwd: '.',
    inputDigest: 'e'.repeat(64),
    inputPaths: [],
    matchedChangedPaths: [],
    cacheState: 'execute',
    reason: 'fixture',
  };
}

function envelope(
  input: {
    readonly observation_base64?: unknown;
    readonly report_base64?: unknown;
    readonly process?: unknown;
    readonly kind?: unknown;
    readonly schemaVersion?: unknown;
    readonly extra?: Readonly<Record<string, unknown>>;
  } = {},
): Buffer {
  return Buffer.from(
    canonicalJson({
      kind: input.kind ?? 'devai.protected-mutation-program-result.v1',
      observation_base64: input.observation_base64 ?? Buffer.from('observe').toString('base64'),
      process: input.process ?? { error_absent: true, signal: null, status: 0 },
      report_base64: input.report_base64 ?? Buffer.from('report').toString('base64'),
      schemaVersion: input.schemaVersion ?? '1.0.0',
      ...(input.extra ?? {}),
    }),
    'utf8',
  );
}

function invokeMutation(value: MutationContainerTransportFixture) {
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
        task: plannedMutationTask(value.controls),
        timeout_ms: 1_000,
        environment: {},
        source: [MUTATION_SOURCE],
        prior_outputs: new Map(),
        declared_outputs: [],
        mutation_program: mutationProgram as ProtectedMutationProgram,
      }),
  );
}

function mutationFixture(
  bytes = envelope(),
  configure?: () => void,
  transportConfiguredFiles = false,
): MutationContainerTransportFixture {
  capturedMutationProgram.files.splice(
    0,
    capturedMutationProgram.files.length,
    ...VALID_MUTATION_FILES.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) })),
  );
  capturedMutationProgram.maximum_observation_bytes = 8;
  capturedMutationProgram.maximum_raw_report_bytes = 12;
  configure?.();
  const value = createMutationContainerTransportFixture({
    source: [MUTATION_SOURCE],
    program_files: transportConfiguredFiles ? capturedMutationProgram.files : VALID_MUTATION_FILES,
    envelope: bytes,
  });
  mutationTransport.docker = value.docker;
  return value;
}

afterEach(() => {
  dockerCalls.length = 0;
  mutationTransport.docker = undefined;
  mutationExecutionAssertion.mockReset();
});

describe('protected mutation envelope and program manifest boundaries', () => {
  it.each([
    ['a non-string channel', { observation_base64: 7 }],
    ['a noncanonical base64 channel', { observation_base64: 'AB==' }],
    [
      'an observation above its decoded-byte limit',
      { observation_base64: Buffer.alloc(9).toString('base64') },
    ],
  ] as const)('refuses %s', (_description, override) => {
    const value = mutationFixture(envelope(override));
    try {
      expect(() => invokeMutation(value)).toThrow('release-certification-mutation-program-invalid');
    } finally {
      value.dispose();
    }
  });

  it('accepts channels exactly at their decoded-byte limits', () => {
    const value = mutationFixture(
      envelope({
        observation_base64: Buffer.alloc(8, 1).toString('base64'),
        report_base64: Buffer.alloc(12, 2).toString('base64'),
      }),
    );
    try {
      expect(invokeMutation(value)).toMatchObject({
        mutation_observation: Buffer.alloc(8, 1),
        mutation_report: Buffer.alloc(12, 2),
      });
    } finally {
      value.dispose();
    }
  });

  it('binds the container buffer to both encoded channel limits and its fixed envelope margin', () => {
    const value = mutationFixture();
    try {
      invokeMutation(value);
      expect(value.state.launch).toMatchObject({ maximum_buffer_bytes: 1052 });
    } finally {
      value.dispose();
    }
  });

  it('refuses a nonpositive computed envelope limit before a container effect', () => {
    const value = mutationFixture(envelope(), () => {
      capturedMutationProgram.maximum_observation_bytes = -384;
      capturedMutationProgram.maximum_raw_report_bytes = -384;
    });
    try {
      expect(() => invokeMutation(value)).toThrow('release-certification-mutation-program-invalid');
      expect(dockerCalls).toEqual([]);
    } finally {
      value.dispose();
    }
  });

  it.each([
    ['a writable file', [{ path: 'run.mjs', mode: '100755', bytes: Buffer.from('x') }]],
    ['a noncanonical path', [{ path: '../run.mjs', mode: '100644', bytes: Buffer.from('x') }]],
    ['an empty file', [{ path: 'run.mjs', mode: '100644', bytes: Buffer.alloc(0) }]],
    [
      'an oversized file',
      [{ path: 'run.mjs', mode: '100644', bytes: Buffer.alloc(1024 * 1024 + 1) }],
    ],
    [
      'an unordered population',
      [
        { path: 'z.mjs', mode: '100644', bytes: Buffer.from('z') },
        { path: 'a.mjs', mode: '100644', bytes: Buffer.from('a') },
      ],
    ],
    [
      'a duplicate path',
      [
        { path: 'run.mjs', mode: '100644', bytes: Buffer.from('a') },
        { path: 'run.mjs', mode: '100644', bytes: Buffer.from('b') },
      ],
    ],
    ['an empty population', []],
  ] as const)('refuses %s before a container effect', (_description, files) => {
    const value = mutationFixture(
      envelope(),
      () => {
        capturedMutationProgram.files.splice(
          0,
          capturedMutationProgram.files.length,
          ...files.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) })),
        );
      },
      false,
    );
    try {
      expect(() => invokeMutation(value)).toThrow('release-certification-mutation-program-invalid');
      expect(dockerCalls).toEqual([]);
    } finally {
      value.dispose();
    }
  });

  it.each([
    [
      'one file at the per-file maximum',
      [{ path: 'run.mjs', mode: '100644', bytes: Buffer.alloc(1024 * 1024, 1) }],
    ],
    [
      'multiple files whose aggregate is exactly the maximum',
      [
        { path: 'a.mjs', mode: '100644', bytes: Buffer.alloc(512 * 1024, 1) },
        { path: 'b.mjs', mode: '100644', bytes: Buffer.alloc(512 * 1024, 2) },
      ],
    ],
  ] as const)('permits %s through manifest validation', (_description, files) => {
    const value = mutationFixture(
      envelope(),
      () => {
        capturedMutationProgram.files.splice(
          0,
          capturedMutationProgram.files.length,
          ...files.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) })),
        );
      },
      true,
    );
    try {
      // The content bytes pass this validator. The transport fixture then rejects the
      // archive because its framing bytes make the transported representation larger.
      expect(() => invokeMutation(value)).toThrow('release-certification-archive-invalid');
      expect(dockerCalls.length).toBeGreaterThan(0);
    } finally {
      value.dispose();
    }
  });

  it('refuses a population whose safe aggregate exceeds the maximum', () => {
    const value = mutationFixture(envelope(), () => {
      capturedMutationProgram.files.splice(
        0,
        capturedMutationProgram.files.length,
        { path: 'a.mjs', mode: '100644', bytes: Buffer.alloc(512 * 1024 + 1, 1) },
        { path: 'b.mjs', mode: '100644', bytes: Buffer.alloc(512 * 1024, 2) },
      );
    });
    try {
      expect(() => invokeMutation(value)).toThrow('release-certification-mutation-program-invalid');
      expect(dockerCalls).toEqual([]);
    } finally {
      value.dispose();
    }
  });

  it.each([
    ['a wrong envelope kind', { kind: 'fixture.wrong-kind' }],
    ['a wrong envelope schema', { schemaVersion: '2.0.0' }],
    [
      'an extra process member',
      { process: { error_absent: true, signal: null, status: 0, extra: true } },
    ],
    ['a missing error flag', { process: { signal: null, status: 0 } }],
    ['a missing signal', { process: { error_absent: true, status: 0 } }],
    ['a missing status', { process: { error_absent: true, signal: null } }],
    ['a non-boolean error flag', { process: { error_absent: 1, signal: null, status: 0 } }],
    ['a non-string signal', { process: { error_absent: true, signal: 9, status: null } }],
    [
      'a signal with a leading byte',
      { process: { error_absent: true, signal: 'XSIGTERM', status: null } },
    ],
    [
      'a signal with a trailing byte',
      { process: { error_absent: true, signal: 'SIGTERM-', status: null } },
    ],
    ['a non-number status', { process: { error_absent: true, signal: null, status: '0' } }],
    ['a fractional status', { process: { error_absent: true, signal: null, status: 0.5 } }],
    ['a negative status', { process: { error_absent: true, signal: null, status: -1 } }],
    ['a status above 255', { process: { error_absent: true, signal: null, status: 256 } }],
    ['both status and signal', { process: { error_absent: true, signal: 'SIGTERM', status: 1 } }],
    [
      'neither status nor signal after a successful spawn',
      { process: { error_absent: true, signal: null, status: null } },
    ],
  ] as const)('refuses %s', (_description, override) => {
    const value = mutationFixture(envelope(override));
    try {
      expect(() => invokeMutation(value)).toThrow('release-certification-mutation-program-invalid');
    } finally {
      value.dispose();
    }
  });

  it('accepts the maximum process exit status as a failed worker result', () => {
    const value = mutationFixture(
      envelope({ process: { error_absent: true, signal: null, status: 255 } }),
    );
    try {
      expect(invokeMutation(value).result).toMatchObject({
        status: 0,
        errorCode: 'PROTECTED_CONTAINER_ABNORMAL',
      });
    } finally {
      value.dispose();
    }
  });
});

describe('protected container runtime executable probe', () => {
  it('accepts the minimum archive capacity and refuses a smaller one before runtime effects', () => {
    const value = fixture();
    try {
      expect(
        () =>
          new ProtectedCertificationContainer({
            ...value.controls,
            maximum_archive_bytes: 1023,
          }),
      ).toThrow('release-certification-container-controls-invalid');
      expect(
        () =>
          new ProtectedCertificationContainer({
            ...value.controls,
            maximum_archive_bytes: 1024,
          }),
      ).not.toThrow();
      expect(dockerCalls).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('requires the protected Node executable at its fixed container path', () => {
    const value = fixture();
    try {
      expect(
        () =>
          new ProtectedCertificationContainer({
            ...value.controls,
            executables: {
              ...value.controls.executables,
              node: {
                ...executable(value.controls, 'node'),
                path: '/usr/bin/node',
              },
            },
          }),
      ).toThrow('release-certification-container-controls-invalid');
      expect(dockerCalls).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('retains the complete local-image identity in its immutable public identity', () => {
    const value = fixture();
    const controls = localImageControls(value.controls);
    try {
      const container = new ProtectedCertificationContainer(controls);
      expect(container.identity).toMatchObject({ local_image: controls.local_image });
      expect(container.identity.local_image).not.toBe(controls.local_image);
      expect(Object.isFrozen(container.identity.local_image)).toBe(true);
      expect(dockerCalls).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['zero', 0],
    ['a negative value', -1],
    ['a value above the maximum', 16.5],
  ] as const)('refuses %s CPU capacity before invoking the runtime', (_description, cpus) => {
    const value = fixture();
    try {
      expect(() => new ProtectedCertificationContainer({ ...value.controls, cpus })).toThrow(
        'release-certification-container-controls-invalid',
      );
      expect(dockerCalls).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['fractional capacity', 0.5],
    ['the maximum capacity', 16],
  ] as const)('accepts %s and binds it into the public identity', (_description, cpus) => {
    const value = fixture();
    try {
      const container = new ProtectedCertificationContainer({ ...value.controls, cpus });
      expect(container.identity).toMatchObject({ cpus });
      expect(dockerCalls).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['a missing local-image identity', undefined, undefined],
    [
      'a local image digest with a leading byte',
      { configuration_sha256: CONFIGURATION_SHA256, rootfs_diff_ids: ROOTFS_DIFF_IDS },
      `0sha256:${CONFIGURATION_SHA256}`,
    ],
    [
      'a local image digest with a trailing byte',
      { configuration_sha256: CONFIGURATION_SHA256, rootfs_diff_ids: ROOTFS_DIFF_IDS },
      `sha256:${CONFIGURATION_SHA256}0`,
    ],
    [
      'a short local image digest',
      { configuration_sha256: CONFIGURATION_SHA256, rootfs_diff_ids: ROOTFS_DIFF_IDS },
      'sha256:b',
    ],
    [
      'a non-hex local image digest',
      { configuration_sha256: CONFIGURATION_SHA256, rootfs_diff_ids: ROOTFS_DIFF_IDS },
      `sha256:${'g'.repeat(64)}`,
    ],
    [
      'a configuration digest with a leading byte',
      { configuration_sha256: `0${CONFIGURATION_SHA256}`, rootfs_diff_ids: ROOTFS_DIFF_IDS },
      undefined,
    ],
    [
      'a configuration digest with a trailing byte',
      { configuration_sha256: `${CONFIGURATION_SHA256}0`, rootfs_diff_ids: ROOTFS_DIFF_IDS },
      undefined,
    ],
    [
      'a short configuration digest',
      { configuration_sha256: 'b', rootfs_diff_ids: ROOTFS_DIFF_IDS },
      undefined,
    ],
    [
      'a non-hex configuration digest',
      { configuration_sha256: 'g'.repeat(64), rootfs_diff_ids: ROOTFS_DIFF_IDS },
      undefined,
    ],
    [
      'an empty rootfs population',
      { configuration_sha256: CONFIGURATION_SHA256, rootfs_diff_ids: [] },
      undefined,
    ],
    [
      'a rootfs digest with a leading byte',
      {
        configuration_sha256: CONFIGURATION_SHA256,
        rootfs_diff_ids: [`0sha256:${'d'.repeat(64)}`],
      },
      undefined,
    ],
    [
      'a rootfs digest with a trailing byte',
      {
        configuration_sha256: CONFIGURATION_SHA256,
        rootfs_diff_ids: [`sha256:${'d'.repeat(64)}0`],
      },
      undefined,
    ],
    [
      'a short rootfs digest',
      { configuration_sha256: CONFIGURATION_SHA256, rootfs_diff_ids: ['sha256:d'] },
      undefined,
    ],
    [
      'a non-hex rootfs digest',
      { configuration_sha256: CONFIGURATION_SHA256, rootfs_diff_ids: [`sha256:${'g'.repeat(64)}`] },
      undefined,
    ],
    [
      'a mixed valid and invalid rootfs population',
      {
        configuration_sha256: CONFIGURATION_SHA256,
        rootfs_diff_ids: [ROOTFS_DIFF_IDS[0], 'sha256:d'],
      },
      undefined,
    ],
    [
      'a local identity for a registry image',
      { configuration_sha256: CONFIGURATION_SHA256, rootfs_diff_ids: ROOTFS_DIFF_IDS },
      IMAGE,
    ],
  ] as const)(
    'refuses %s before invoking the runtime',
    (_description, localImage, image = `sha256:${CONFIGURATION_SHA256}`) => {
      const value = fixture();
      try {
        const controls = {
          ...value.controls,
          image,
          ...(localImage === undefined ? {} : { local_image: localImage }),
        };
        expect(() => new ProtectedCertificationContainer(controls)).toThrow(
          'release-certification-container-controls-invalid',
        );
        expect(dockerCalls).toEqual([]);
      } finally {
        rmSync(value.root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      'configuration-pinned image',
      `sha256:${CONFIGURATION_SHA256}`,
      {
        Os: 'linux',
        Architecture: 'arm64',
        Id: `sha256:${CONFIGURATION_SHA256}`,
        RootFS: { Type: 'layers', Layers: ROOTFS_DIFF_IDS },
      },
    ],
    [
      'manifest-pinned image',
      `sha256:${MANIFEST_SHA256}`,
      {
        Os: 'linux',
        Architecture: 'arm64',
        Id: `sha256:${MANIFEST_SHA256}`,
        Descriptor: { annotations: { 'config.digest': `sha256:${CONFIGURATION_SHA256}` } },
        RootFS: { Type: 'layers', Layers: ROOTFS_DIFF_IDS },
      },
    ],
  ] as const)('accepts a %s with its exact rootfs identity', (_description, image, inspection) => {
    const value = fixture('correct', inspection);
    try {
      verify(localImageControls(value.controls, image));
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'image ID',
      {
        Os: 'linux',
        Architecture: 'arm64',
        Id: `sha256:${'f'.repeat(64)}`,
        Descriptor: { annotations: { 'config.digest': `sha256:${CONFIGURATION_SHA256}` } },
        RootFS: { Type: 'layers', Layers: ROOTFS_DIFF_IDS },
      },
    ],
    [
      'configuration digest',
      {
        Os: 'linux',
        Architecture: 'arm64',
        Id: `sha256:${MANIFEST_SHA256}`,
        Descriptor: { annotations: { 'config.digest': `sha256:${'f'.repeat(64)}` } },
        RootFS: { Type: 'layers', Layers: ROOTFS_DIFF_IDS },
      },
    ],
    [
      'malformed configuration digest',
      {
        Os: 'linux',
        Architecture: 'arm64',
        Id: `sha256:${MANIFEST_SHA256}`,
        Descriptor: { annotations: { 'config.digest': 'sha256:bad' } },
        RootFS: { Type: 'layers', Layers: ROOTFS_DIFF_IDS },
      },
    ],
    [
      'rootfs type',
      {
        Os: 'linux',
        Architecture: 'arm64',
        Id: `sha256:${MANIFEST_SHA256}`,
        Descriptor: { annotations: { 'config.digest': `sha256:${CONFIGURATION_SHA256}` } },
        RootFS: { Type: 'unknown', Layers: ROOTFS_DIFF_IDS },
      },
    ],
    [
      'rootfs layer population',
      {
        Os: 'linux',
        Architecture: 'arm64',
        Id: `sha256:${MANIFEST_SHA256}`,
        Descriptor: { annotations: { 'config.digest': `sha256:${CONFIGURATION_SHA256}` } },
        RootFS: { Type: 'layers', Layers: [ROOTFS_DIFF_IDS[0]] },
      },
    ],
    [
      'malformed rootfs layer digest',
      {
        Os: 'linux',
        Architecture: 'arm64',
        Id: `sha256:${MANIFEST_SHA256}`,
        Descriptor: { annotations: { 'config.digest': `sha256:${CONFIGURATION_SHA256}` } },
        RootFS: { Type: 'layers', Layers: ['sha256:bad', ROOTFS_DIFF_IDS[1]] },
      },
    ],
    [
      'empty rootfs layer population',
      {
        Os: 'linux',
        Architecture: 'arm64',
        Id: `sha256:${MANIFEST_SHA256}`,
        Descriptor: { annotations: { 'config.digest': `sha256:${CONFIGURATION_SHA256}` } },
        RootFS: { Type: 'layers', Layers: [] },
      },
    ],
  ] as const)(
    'refuses a manifest-pinned image with a mismatched %s',
    (_description, inspection) => {
      const value = fixture('correct', inspection);
      try {
        expect(() =>
          verify(localImageControls(value.controls, `sha256:${MANIFEST_SHA256}`)),
        ).toThrow('release-certification-container-identity-mismatch');
      } finally {
        rmSync(value.root, { recursive: true, force: true });
      }
    },
  );

  it('hashes every declared executable in one networkless readonly runtime probe', () => {
    const value = fixture();
    try {
      verify(value.controls);
      const prefix = [
        '--config',
        value.controls.docker_config_directory,
        '--host',
        value.controls.engine_socket,
      ];
      expect(dockerCalls).toEqual([
        [...prefix, 'version', '--format', '{{.Server.Version}}'],
        [...prefix, 'image', 'inspect', IMAGE],
        [
          ...prefix,
          'run',
          '--rm',
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
          IMAGE,
          '/usr/local/bin/node',
          '-e',
          expect.any(String),
          canonicalJson(value.controls.executables),
        ],
      ]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['engine version', undefined, { engine_version: 'fixture-engine-other' }],
    ['operating system', { Os: 'darwin', Architecture: 'arm64', RepoDigests: [IMAGE] }, {}],
    ['architecture', { Os: 'linux', Architecture: 'amd64', RepoDigests: [IMAGE] }, {}],
    ['missing repository digests', { Os: 'linux', Architecture: 'arm64' }, {}],
    ['empty repository digests', { Os: 'linux', Architecture: 'arm64', RepoDigests: [] }, {}],
    [
      'wrong repository digest',
      {
        Os: 'linux',
        Architecture: 'arm64',
        RepoDigests: [`fixture/node@sha256:${'f'.repeat(64)}`],
      },
      {},
    ],
  ] as const)(
    'refuses a registry-pinned image with a mismatched %s',
    (_description, inspection, controlsOverride) => {
      const value = fixture('correct', inspection);
      try {
        expect(() => verify({ ...value.controls, ...controlsOverride })).toThrow(
          'release-certification-container-identity-mismatch',
        );
      } finally {
        rmSync(value.root, { recursive: true, force: true });
      }
    },
  );

  it('accepts a registry digest from a different repository with the exact selected digest', () => {
    const value = fixture('correct', {
      Os: 'linux',
      Architecture: 'arm64',
      RepoDigests: [`mirror.invalid/node@sha256:${'a'.repeat(64)}`],
    });
    try {
      verify(value.controls);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'an unrelated string digest',
      [`fixture/node@sha256:${'f'.repeat(64)}`, `mirror.invalid/node@sha256:${'a'.repeat(64)}`],
    ],
    ['a non-string digest', [7, `mirror.invalid/node@sha256:${'a'.repeat(64)}`]],
  ] as const)('accepts one exact registry digest alongside %s', (_description, repoDigests) => {
    const value = fixture('correct', {
      Os: 'linux',
      Architecture: 'arm64',
      RepoDigests: repoDigests,
    });
    try {
      verify(value.controls);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('refuses a declared ps path that the runtime probe cannot read', () => {
    const value = fixture();
    try {
      const ps = executable(value.controls, 'ps');
      const controls = {
        ...value.controls,
        executables: {
          ...value.controls.executables,
          ps: { ...ps, path: join(value.root, 'missing-ps') },
        },
      };
      expect(() => verify(controls)).toThrow(
        'release-certification-container-operation-failed:run',
      );
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('refuses a wrong declared ps hash after the runtime probe reads it', () => {
    const value = fixture();
    try {
      const ps = executable(value.controls, 'ps');
      const controls = {
        ...value.controls,
        executables: {
          ...value.controls.executables,
          ps: { ...ps, sha256: 'f'.repeat(64) },
        },
      };
      expect(() => verify(controls)).toThrow('release-certification-container-identity-mismatch');
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('refuses a wrong Node runtime hash', () => {
    const value = fixture();
    try {
      const node = executable(value.controls, 'node');
      const controls = {
        ...value.controls,
        executables: {
          ...value.controls.executables,
          node: { ...node, sha256: 'f'.repeat(64) },
        },
      };
      expect(() => verify(controls)).toThrow('release-certification-container-identity-mismatch');
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each(['extra-observed', 'omit-ps'] as const)(
    'refuses a %s executable-map population',
    (mode) => {
      const value = fixture(mode);
      try {
        expect(() => verify(value.controls)).toThrow(
          'release-certification-container-identity-mismatch',
        );
      } finally {
        rmSync(value.root, { recursive: true, force: true });
      }
    },
  );

  it('permits a host that deliberately declares only the required Node executable', () => {
    const value = fixture();
    try {
      const node = executable(value.controls, 'node');
      verify({ ...value.controls, executables: { node } });
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('refuses a bootstrap result without its executable map', () => {
    const value = fixture('missing-executables');
    try {
      expect(() => verify(value.controls)).toThrow('release-certification-container-invalid');
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});
