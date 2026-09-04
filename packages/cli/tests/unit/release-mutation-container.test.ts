import type { SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';
import {
  decodeContainerArchive,
  encodeContainerArchive,
  encodeContainerDependencyArchive,
  type ContainerArchiveEntry,
} from '../../src/services/container-archive.js';
import {
  captureProtectedMutationExecution,
  ProtectedCertificationContainer,
  protectedContainerTaskEnvironment,
  type ProtectedContainerControls,
} from '../../src/services/release-certification-container.js';
import type { ProtectedMutationProgram } from '../../src/services/release-mutation-program.js';
import type { PlannedTask } from '../../src/services/check-runner/types.js';

interface CapturedProgram {
  readonly identity_sha256: string;
  readonly files: readonly ContainerArchiveEntry[];
  readonly argv: readonly string[];
  readonly maximum_observation_bytes: number;
  readonly maximum_raw_report_bytes: number;
}

interface TransportState {
  readonly calls: string[][];
  source_archive: Buffer;
  workspace_archive: Buffer | undefined;
  readback_archive: Buffer;
  loaded_program: Buffer | undefined;
  envelope: Buffer;
  outer_status: number;
  id: string | undefined;
  workspace_volume: string | undefined;
  mounts: {
    readonly Type: 'volume';
    readonly Name: string;
    readonly Destination: string;
    readonly RW: boolean;
  }[];
  launch: Readonly<Record<string, unknown>> | undefined;
  mutable_program_mount: boolean;
}

const state = vi.hoisted((): TransportState => ({
  calls: [],
  source_archive: Buffer.alloc(0),
  workspace_archive: undefined,
  readback_archive: Buffer.alloc(0),
  loaded_program: undefined,
  envelope: Buffer.alloc(0),
  outer_status: 0,
  id: undefined,
  workspace_volume: undefined,
  mounts: [],
  launch: undefined,
  mutable_program_mount: false,
}));

const program = vi.hoisted(() =>
  Object.freeze({
    kind: 'protected-mutation-program-v1' as const,
    identity_sha256: 'a'.repeat(64),
  }),
);

const capturedProgram = vi.hoisted((): CapturedProgram => ({
  identity_sha256: 'a'.repeat(64),
  files: [
    { path: 'invocation.json', mode: '100644', bytes: Buffer.from('{"fixture":true}', 'utf8') },
    { path: 'mutation-production.mjs', mode: '100644', bytes: Buffer.from('export {};\n', 'utf8') },
    {
      path: 'mutation-vitest-plugin.mjs',
      mode: '100644',
      bytes: Buffer.from('export {};\n', 'utf8'),
    },
    { path: 'run.mjs', mode: '100644', bytes: Buffer.from('export {};\n', 'utf8') },
    { path: 'stryker.config.json', mode: '100644', bytes: Buffer.from('{"plugins":[]}', 'utf8') },
  ],
  argv: ['node', '/devai-host/run.mjs'],
  maximum_observation_bytes: 1024,
  maximum_raw_report_bytes: 4096,
}));

/** Transport-only isolation: source execution-context branding is covered in the program suite. */
const executionAssertion = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/release-mutation-program.js', () => ({
  captureProtectedMutationProgram(value: unknown): CapturedProgram {
    if (value !== program) throw new Error('release-mutation-program-invalid');
    return {
      ...capturedProgram,
      argv: [...capturedProgram.argv],
      files: capturedProgram.files.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) })),
    };
  },
  assertProtectedMutationProgramExecution: executionAssertion,
}));

vi.mock('@devai-nyx/authority', () => ({
  createProtectedReleaseHostAdapter: () => ({
    spawnSync(_command: string, args: readonly string[], options?: { readonly input?: Buffer }) {
      return docker(args, options?.input);
    },
  }),
}));

const IMAGE = `fixture/node@sha256:${'b'.repeat(64)}`;
const SOURCE: ContainerArchiveEntry = {
  path: 'src/input.ts',
  mode: '100644',
  bytes: Buffer.from('export const input = true;\n', 'utf8'),
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function result(
  stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0),
  status = 0,
): SpawnSyncReturns<Buffer<ArrayBufferLike>> {
  return {
    pid: 1,
    output: [null, stdout, Buffer.alloc(0)],
    stdout,
    stderr: Buffer.alloc(0),
    status,
    signal: null,
  };
}

function parseMounts(command: readonly string[]): TransportState['mounts'] {
  return command.flatMap((value, index) => {
    if (value !== '--mount') return [];
    const raw = command[index + 1];
    const match = raw?.match(/^type=volume,source=([^,]+),target=([^,]+)(,readonly)?$/u);
    if (match === null || match === undefined) return [];
    const [, name, destination, readonly] = match;
    if (name === undefined || destination === undefined) return [];
    return [
      {
        Type: 'volume' as const,
        Name: name,
        Destination: destination,
        RW:
          destination === '/devai-host' && state.mutable_program_mount
            ? true
            : readonly !== ',readonly',
      },
    ];
  });
}

function docker(args: readonly string[], input?: Buffer): SpawnSyncReturns<Buffer> {
  state.calls.push([...args]);
  const command = args.slice(4);
  if (command[0] === 'create') {
    const name = command[command.indexOf('--name') + 1];
    if (name === undefined) throw new Error('fixture docker create without name');
    if (name.startsWith('devai-certify-') && !name.endsWith('-loader')) {
      state.id = name;
      state.mounts = parseMounts(command);
      state.workspace_volume = state.mounts.find(
        (mount) => mount.Destination === '/workspace',
      )?.Name;
      const encoded = command.at(-1);
      if (encoded === undefined) throw new Error('fixture mutation launch missing');
      state.launch = JSON.parse(encoded) as Record<string, unknown>;
    }
    return result();
  }
  if (command[0] === 'cp' && command[1] === '-a' && command[2] === '-') {
    if (command[3]?.endsWith(':/devai-host'))
      state.loaded_program = input === undefined ? undefined : Buffer.from(input);
    if (command[3] === `${state.id}:/workspace`)
      state.workspace_archive = input === undefined ? undefined : Buffer.from(input);
    return result();
  }
  if (command[0] === 'cp' && command[1]?.endsWith(':/devai-host/.'))
    return result(state.readback_archive);
  if (command[0] === 'cp' && command[1] === `${state.id}:/workspace/candidate/.`)
    return result(state.source_archive);
  if (command[0] === 'start')
    return result(
      state.loaded_program === undefined ? Buffer.alloc(0) : state.envelope,
      state.outer_status,
    );
  if (command[0] === 'inspect') {
    if (state.id === undefined || state.workspace_volume === undefined)
      throw new Error('fixture inspect before container creation');
    return result(
      Buffer.from(
        JSON.stringify([
          {
            State: {
              Running: false,
              Pid: 0,
              Restarting: false,
              ExitCode: state.outer_status,
              OOMKilled: false,
              Error: '',
            },
            HostConfig: {
              NetworkMode: 'none',
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
            Mounts: state.mounts,
          },
        ]),
      ),
    );
  }
  return result();
}

function envelope(
  input: {
    readonly observation?: Buffer;
    readonly report?: Buffer;
    readonly process?: {
      readonly error_absent: boolean;
      readonly signal: string | null;
      readonly status: number | null;
    };
    readonly extra?: Readonly<Record<string, unknown>>;
  } = {},
): Buffer {
  return Buffer.from(
    canonicalJson({
      kind: 'devai.protected-mutation-program-result.v1',
      observation_base64: (input.observation ?? Buffer.from('{"observed":true}', 'utf8')).toString(
        'base64',
      ),
      process: input.process ?? { error_absent: true, signal: null, status: 0 },
      report_base64: (input.report ?? Buffer.from('{"raw":true}', 'utf8')).toString('base64'),
      schemaVersion: '1.0.0',
      ...(input.extra ?? {}),
    }),
    'utf8',
  );
}

function controls(root: string): ProtectedContainerControls {
  const config = join(root, 'config');
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, 'config.json'), JSON.stringify({ auths: {} }), { mode: 0o600 });
  const binary = join(root, 'docker');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(binary, 0o700);
  return {
    docker_binary: binary,
    docker_binary_sha256: sha256(readFileSync(binary)),
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
  };
}

function plannedTask(value: ProtectedContainerControls, mutation = false): PlannedTask {
  const node = value.executables.node;
  if (node === undefined) throw new Error('fixture missing node executable');
  return {
    nodeId: 'fixture-task',
    taskKey: 'd'.repeat(64),
    dependencies: [],
    outputContract: {},
    argv: mutation ? ['node', '/devai-host/run.mjs'] : ['node', '--version'],
    executable: node,
    cwd: '.',
    inputDigest: 'e'.repeat(64),
    inputPaths: [],
    matchedChangedPaths: [],
    cacheState: 'execute',
    reason: 'fixture',
  };
}

function invoke(input: {
  readonly container: ProtectedCertificationContainer;
  readonly controls: ProtectedContainerControls;
  readonly mutation_program?: ProtectedMutationProgram;
  readonly task?: PlannedTask;
  readonly environment?: Readonly<Record<string, string>>;
  readonly source?: readonly ContainerArchiveEntry[];
  readonly prior_outputs?: ReadonlyMap<string, ContainerArchiveEntry>;
  readonly declared_outputs?: readonly string[];
}) {
  return input.container.runBound(
    {
      action_id: 'release preflight',
      repository: { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      task_policy_digest_sha256: 'c'.repeat(64),
      plan_receipt_digest_sha256: 'd'.repeat(64),
      helper_identity_sha256: 'e'.repeat(64),
    },
    () =>
      input.container.execute({
        task: input.task ?? plannedTask(input.controls, input.mutation_program !== undefined),
        timeout_ms: 1_000,
        environment: input.environment ?? {},
        source: input.source ?? [SOURCE],
        prior_outputs: input.prior_outputs ?? new Map(),
        declared_outputs: input.declared_outputs ?? [],
        ...(input.mutation_program === undefined
          ? {}
          : { mutation_program: input.mutation_program }),
      }),
  );
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-mutation-container-'));
  const value = controls(root);
  state.source_archive = encodeContainerDependencyArchive([SOURCE]);
  state.workspace_archive = undefined;
  state.readback_archive = encodeContainerArchive(capturedProgram.files);
  state.envelope = envelope();
  state.outer_status = 0;
  return { root, controls: value, container: new ProtectedCertificationContainer(value, []) };
}

function expectCleanup(): void {
  expect(state.calls.some((args) => args.includes('rm'))).toBe(true);
  expect(state.calls.some((args) => args.includes('volume') && args.includes('rm'))).toBe(true);
}

afterEach(() => {
  state.calls.length = 0;
  state.source_archive = Buffer.alloc(0);
  state.readback_archive = Buffer.alloc(0);
  state.loaded_program = undefined;
  state.envelope = Buffer.alloc(0);
  state.outer_status = 0;
  state.id = undefined;
  state.workspace_volume = undefined;
  state.mounts = [];
  state.launch = undefined;
  state.mutable_program_mount = false;
  executionAssertion.mockReset();
});

describe('protected mutation-program container transport', () => {
  it('keeps the ordinary task route unchanged when no mutation program is supplied', () => {
    const value = fixture();
    try {
      const result = invoke(value);
      expect(result.result).toMatchObject({ status: 0, stdout: '', stderr: '' });
      expect(result).not.toHaveProperty('mutation_observation');
      expect(result).not.toHaveProperty('mutation_report');
      expect(state.calls.flat().join(' ')).not.toContain('/devai-host');
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('rejects an unbranded program before any container effect', () => {
    const value = fixture();
    try {
      expect(() => invoke({ ...value, mutation_program: {} as ProtectedMutationProgram })).toThrow(
        'release-mutation-program-invalid',
      );
      expect(state.calls).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'wrong argv',
      (value: ProtectedContainerControls) => ({
        ...plannedTask(value, true),
        argv: ['node', '--version'],
      }),
    ],
    [
      'wrong cwd',
      (value: ProtectedContainerControls) => ({
        ...plannedTask(value, true),
        cwd: 'packages/fixture',
      }),
    ],
    [
      'wrong executable',
      (value: ProtectedContainerControls) => ({
        ...plannedTask(value, true),
        executable: { path: '/usr/bin/node', sha256: 'f'.repeat(64) },
      }),
    ],
  ] as const)('rejects %s before any container effect', (_label, alter) => {
    const value = fixture();
    try {
      expect(() =>
        invoke({ ...value, mutation_program: program, task: alter(value.controls) }),
      ).toThrow();
      expect(state.calls).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('uses the isolated verified-program capture, verifies its exact loader readback, and mounts it readonly', () => {
    const value = fixture();
    try {
      const result = invoke({ ...value, mutation_program: program });
      expect(result.result).toMatchObject({ status: 0 });
      expect(result.result).not.toHaveProperty('errorCode');
      expect(result.mutation_observation).toEqual(Buffer.from('{"observed":true}', 'utf8'));
      expect(result.mutation_report).toEqual(Buffer.from('{"raw":true}', 'utf8'));
      expect(result.result.stdout).toBe('');
      expect(result.result.stderr).toBe('');
      expect(result.outputs).toEqual([]);
      expect(executionAssertion).toHaveBeenCalledExactlyOnceWith(program, {
        container_identity: value.container.identity,
        environment: protectedContainerTaskEnvironment({}),
        source: [SOURCE],
        prior_outputs: new Map(),
      });
      expect(state.loaded_program).toBeDefined();
      expect(decodeContainerArchive(state.loaded_program ?? Buffer.alloc(0), 1024 * 1024)).toEqual(
        capturedProgram.files,
      );
      expect(state.mounts.find((mount) => mount.Destination === '/devai-host')).toMatchObject({
        RW: false,
      });
      expect(Object.isFrozen(value.container.identity)).toBe(true);
      const executables = value.container.identity.executables;
      if (executables === null || typeof executables !== 'object')
        throw new Error('fixture container identity missing executables');
      expect(Object.isFrozen(executables)).toBe(true);
      expect(() => Object.assign(executables, { node: 'substituted' })).toThrow();
      expectCleanup();
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('retains a separate immutable mutation execution capture for the same result and program only', () => {
    const value = fixture();
    try {
      const result = invoke({ ...value, mutation_program: program });
      const first = captureProtectedMutationExecution(result, program);
      expect(first).toMatchObject({
        program_identity_sha256: program.identity_sha256,
        result: { status: 0, stdout: '', stderr: '' },
      });
      expect(first.mutation_observation).toEqual(Buffer.from('{"observed":true}', 'utf8'));
      expect(first.mutation_report).toEqual(Buffer.from('{"raw":true}', 'utf8'));
      Object.assign(result.result, { stdout: 'caller-mutation' });
      result.mutation_observation?.fill(0);
      Object.assign(first.result, { stderr: 'caller-capture-mutation' });
      first.mutation_report?.fill(0);
      const reread = captureProtectedMutationExecution(result, program);
      expect(reread.result).toMatchObject({ status: 0, stdout: '', stderr: '' });
      expect(reread.mutation_observation).toEqual(Buffer.from('{"observed":true}', 'utf8'));
      expect(reread.mutation_report).toEqual(Buffer.from('{"raw":true}', 'utf8'));
      expect(() => captureProtectedMutationExecution({ ...result }, program)).toThrow(
        'release-certification-mutation-program-invalid',
      );
      expect(() =>
        captureProtectedMutationExecution(result, { ...program } as ProtectedMutationProgram),
      ).toThrow('release-certification-mutation-program-invalid');
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('copies mutation task inputs before the isolated execution assertion can mutate caller-owned values', () => {
    const value = fixture();
    const task = plannedTask(value.controls, true);
    const environment = { FIXTURE: 'original' };
    const source = { ...SOURCE, bytes: Buffer.from(SOURCE.bytes) };
    const predecessor = {
      path: 'generated/prior.json',
      mode: '100644' as const,
      bytes: Buffer.from('{"prior":true}', 'utf8'),
    };
    const priorOutputs = new Map([[predecessor.path, predecessor]]);
    try {
      state.source_archive = encodeContainerDependencyArchive([source, predecessor]);
      executionAssertion.mockImplementation((_program, captured) => {
        expect(captured).toMatchObject({
          environment: expect.objectContaining({ FIXTURE: 'original' }),
          source: [{ path: source.path, mode: source.mode, bytes: source.bytes }],
          prior_outputs: new Map([[predecessor.path, predecessor]]),
        });
        Object.assign(task, { cwd: 'caller-mutated' });
        environment.FIXTURE = 'caller-mutated';
        source.bytes.fill(0);
        predecessor.bytes.fill(0);
      });
      const result = invoke({
        ...value,
        mutation_program: program,
        task,
        environment,
        source: [source],
        prior_outputs: priorOutputs,
        declared_outputs: [predecessor.path],
      });
      expect(result.result).toMatchObject({ status: 0 });
      expect(state.launch).toMatchObject({
        cwd: '/workspace/candidate',
        environment: expect.objectContaining({ FIXTURE: 'original' }),
      });
      const workspace = decodeContainerArchive(
        state.workspace_archive ?? Buffer.alloc(0),
        value.controls.maximum_archive_bytes,
      );
      expect(workspace).toEqual(
        expect.arrayContaining([
          { path: `candidate/${SOURCE.path}`, mode: SOURCE.mode, bytes: SOURCE.bytes },
          {
            path: `candidate/${predecessor.path}`,
            mode: predecessor.mode,
            bytes: Buffer.from('{"prior":true}'),
          },
        ]),
      );
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'a changed loader readback',
      () => {
        state.readback_archive = encodeContainerArchive([
          ...capturedProgram.files.slice(0, -1),
          {
            path: 'stryker.config.json',
            mode: '100644',
            bytes: Buffer.from('{"changed":true}', 'utf8'),
          },
        ]);
      },
    ],
    [
      'a mutable driver mount',
      () => {
        state.mutable_program_mount = true;
      },
    ],
  ] as const)('refuses %s', (_label, tamper) => {
    const value = fixture();
    try {
      tamper();
      expect(() => invoke({ ...value, mutation_program: program })).toThrow(
        /release-certification-(?:mutation-program-invalid|container-isolation-mismatch)/u,
      );
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('refuses candidate source drift after a seemingly successful envelope', () => {
    const value = fixture();
    try {
      state.source_archive = encodeContainerDependencyArchive([
        { ...SOURCE, bytes: Buffer.from('export const input = false;\n', 'utf8') },
      ]);
      expect(() => invoke({ ...value, mutation_program: program })).toThrow(
        'release-certification-source-changed',
      );
      expectCleanup();
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['error absence false', { error_absent: false, signal: null, status: 0 }],
    ['a worker signal', { error_absent: true, signal: 'SIGTERM', status: null }],
    ['a worker nonzero status', { error_absent: true, signal: null, status: 7 }],
  ] as const)(
    'cannot promote an outer success when inner process reports %s',
    (_label, process) => {
      const value = fixture();
      try {
        state.envelope = envelope({ process });
        const result = invoke({ ...value, mutation_program: program });
        expect(result.result).toMatchObject({
          status: 0,
          errorCode: 'PROTECTED_CONTAINER_ABNORMAL',
        });
        expect(result.outputs).toEqual([]);
        expect(result.mutation_observation).toBeDefined();
        expect(result.mutation_report).toBeDefined();
      } finally {
        rmSync(value.root, { recursive: true, force: true });
      }
    },
  );

  it('does not let a successful inner tuple promote an outer failure', () => {
    const value = fixture();
    try {
      state.outer_status = 1;
      const result = invoke({ ...value, mutation_program: program });
      expect(result.result).toMatchObject({ status: 1 });
      expect(result.outputs).toEqual([]);
      expect(result.mutation_observation).toBeDefined();
      expect(result.mutation_report).toBeDefined();
      const captured = captureProtectedMutationExecution(result, program);
      expect(captured.result).toMatchObject({ status: 1 });
      expect(captured.mutation_observation).toBeDefined();
      expect(captured.mutation_report).toBeDefined();
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'malformed envelope JSON',
      () => {
        state.envelope = Buffer.from('{', 'utf8');
      },
    ],
    [
      'an empty observation channel',
      () => {
        state.envelope = envelope({ observation: Buffer.alloc(0) });
      },
    ],
    [
      'an empty report channel',
      () => {
        state.envelope = envelope({ report: Buffer.alloc(0) });
      },
    ],
    [
      'malformed base64',
      () => {
        state.envelope = envelope({ extra: { observation_base64: '*' } });
      },
    ],
    [
      'an extra envelope key',
      () => {
        state.envelope = envelope({ extra: { injected: true } });
      },
    ],
    [
      'a duplicate envelope key',
      () => {
        const value = JSON.parse(envelope().toString('utf8')) as Record<string, unknown>;
        state.envelope = Buffer.from(
          [
            '{',
            `"kind":${JSON.stringify(value.kind)},`,
            `"kind":${JSON.stringify(value.kind)},`,
            `"observation_base64":${JSON.stringify(value.observation_base64)},`,
            `"process":${JSON.stringify(value.process)},`,
            `"report_base64":${JSON.stringify(value.report_base64)},`,
            `"schemaVersion":${JSON.stringify(value.schemaVersion)}`,
            '}',
          ].join(''),
          'utf8',
        );
      },
    ],
    [
      'noncanonical envelope JSON',
      () => {
        const value = JSON.parse(envelope().toString('utf8')) as Record<string, unknown>;
        state.envelope = Buffer.from(
          JSON.stringify({
            schemaVersion: value.schemaVersion,
            report_base64: value.report_base64,
            process: value.process,
            observation_base64: value.observation_base64,
            kind: value.kind,
          }),
          'utf8',
        );
      },
    ],
    [
      'oversized base64 channel',
      () => {
        state.envelope = envelope({
          observation: Buffer.alloc(capturedProgram.maximum_observation_bytes + 1, 1),
        });
      },
    ],
    [
      'an impossible inner status tuple',
      () => {
        state.envelope = envelope({ process: { error_absent: true, signal: null, status: null } });
      },
    ],
  ] as const)('refuses %s', (_label, corrupt) => {
    const value = fixture();
    try {
      corrupt();
      expect(() => invoke({ ...value, mutation_program: program })).toThrow(
        'release-certification-mutation-program-invalid',
      );
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});
