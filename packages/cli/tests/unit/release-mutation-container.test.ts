import { rmSync } from 'node:fs';
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
import {
  createMutationContainerTransportFixture,
  type MutationContainerTransportFixture,
  type MutationContainerTransportState,
} from '../helpers/release-mutation-container-fixture.js';

interface CapturedProgram {
  readonly identity_sha256: string;
  readonly files: readonly ContainerArchiveEntry[];
  readonly argv: readonly string[];
  readonly maximum_observation_bytes: number;
  readonly maximum_raw_report_bytes: number;
}

const state = vi.hoisted((): MutationContainerTransportState => ({
  calls: [],
  source_archive: Buffer.alloc(0),
  workspace_archive: undefined,
  readback_archive: Buffer.alloc(0),
  loaded_program: undefined,
  envelope: Buffer.alloc(0),
  outer_status: 0,
  id: undefined,
  workspace_volume: undefined,
  nano_cpus: undefined,
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

const SOURCE: ContainerArchiveEntry = {
  path: 'src/input.ts',
  mode: '100644',
  bytes: Buffer.from('export const input = true;\n', 'utf8'),
};

let activeFixture: MutationContainerTransportFixture | undefined;

function docker(args: readonly string[], input?: Buffer) {
  if (activeFixture === undefined) throw new Error('fixture transport not installed');
  return activeFixture.docker(args, input);
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
  readonly diagnostic_output_paths?: readonly string[];
  readonly declared_namespaces?: readonly {
    readonly prefix: string;
    readonly required_paths: readonly string[];
  }[];
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
        ...(input.diagnostic_output_paths === undefined
          ? {}
          : { diagnostic_output_paths: input.diagnostic_output_paths }),
        ...(input.mutation_program === undefined
          ? {}
          : { mutation_program: input.mutation_program }),
        ...(input.declared_namespaces === undefined
          ? {}
          : { declared_namespaces: input.declared_namespaces }),
      }),
  );
}

function fixture() {
  state.source_archive = encodeContainerDependencyArchive([SOURCE]);
  state.workspace_archive = undefined;
  state.readback_archive = encodeContainerArchive(capturedProgram.files);
  state.envelope = envelope();
  state.outer_status = 0;
  activeFixture = createMutationContainerTransportFixture({
    source: [SOURCE],
    program_files: capturedProgram.files,
    envelope: state.envelope,
    outer_status: state.outer_status,
    state,
  });
  return activeFixture;
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
  state.nano_cpus = undefined;
  state.mounts = [];
  state.launch = undefined;
  state.mutable_program_mount = false;
  activeFixture = undefined;
  executionAssertion.mockReset();
});

describe('protected mutation-program container transport', () => {
  it('refuses a nested binding and releases the same container after the outer operation', () => {
    const value = fixture();
    const binding = {
      action_id: 'release preflight' as const,
      repository: { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      task_policy_digest_sha256: 'c'.repeat(64),
      plan_receipt_digest_sha256: 'd'.repeat(64),
      helper_identity_sha256: 'e'.repeat(64),
    };
    try {
      value.container.runBound(binding, () => {
        expect(() => value.container.runBound(binding, () => undefined)).toThrow(
          'release-certification-container-in-use',
        );
      });
      expect(value.container.runBound(binding, () => 'released')).toBe('released');
      expect(state.calls).toEqual([]);
    } finally {
      value.dispose();
    }
  });

  it('accepts disjoint output namespaces and captures every required member', () => {
    const value = fixture();
    const outputs: ContainerArchiveEntry[] = [
      { path: 'dist/a.js', mode: '100644', bytes: Buffer.from('a') },
      { path: 'reports/b.json', mode: '100644', bytes: Buffer.from('b') },
    ];
    state.source_archive = encodeContainerDependencyArchive([SOURCE, ...outputs]);
    try {
      const result = invoke({
        ...value,
        mutation_program: program,
        declared_namespaces: [
          { prefix: 'dist', required_paths: ['dist/a.js'] },
          { prefix: 'reports', required_paths: ['reports/b.json'] },
        ],
      });
      expect(result.outputs).toEqual(outputs);
    } finally {
      value.dispose();
    }
  });

  it.each([
    ['a noncanonical prefix', [{ prefix: '../dist', required_paths: ['dist/a.js'] }]],
    ['an empty required population', [{ prefix: 'dist', required_paths: [] }]],
    ['a noncanonical required path', [{ prefix: 'dist', required_paths: ['dist/../output.js'] }]],
    ['a required path outside its prefix', [{ prefix: 'dist', required_paths: ['other/a.js'] }]],
    [
      'a mixed valid and invalid required population',
      [{ prefix: 'dist', required_paths: ['dist/a.js', 'other/a.js'] }],
    ],
    [
      'duplicate prefixes',
      [
        { prefix: 'dist', required_paths: ['dist/a.js'] },
        { prefix: 'dist', required_paths: ['dist/b.js'] },
      ],
    ],
    [
      'a child followed by its parent',
      [
        { prefix: 'dist/sub', required_paths: ['dist/sub/a.js'] },
        { prefix: 'dist', required_paths: ['dist/b.js'] },
      ],
    ],
    [
      'a parent followed by its child',
      [
        { prefix: 'dist', required_paths: ['dist/a.js'] },
        { prefix: 'dist/sub', required_paths: ['dist/sub/b.js'] },
      ],
    ],
    [
      'one overlap among otherwise disjoint predecessors',
      [
        { prefix: 'dist/sub', required_paths: ['dist/sub/a.js'] },
        { prefix: 'reports', required_paths: ['reports/a.json'] },
        { prefix: 'dist', required_paths: ['dist/b.js'] },
      ],
    ],
  ] as const)('refuses %s before creating a container', (_description, declared_namespaces) => {
    const value = fixture();
    try {
      expect(() => invoke({ ...value, mutation_program: program, declared_namespaces })).toThrow(
        'release-certification-output-closure-invalid',
      );
      expect(state.calls).toEqual([]);
    } finally {
      value.dispose();
    }
  });

  it.each(['ETIMEDOUT', 'EPIPE', '/private/protected-value'])(
    'reports bounded transport metadata without disclosing command output: %s',
    (code) => {
      const value = fixture();
      const messages: string[] = [];
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        messages.push(String(chunk));
        return true;
      });
      activeFixture = {
        ...value,
        docker(args, input) {
          const result = value.docker(args, input);
          const command = args.slice(4);
          if (command[0] === 'cp' && command[3] === `${state.id}:/workspace`)
            return {
              ...result,
              status: null,
              signal: 'SIGTERM',
              error: Object.assign(new Error('private error text'), { code }),
              stderr: Buffer.from('private stderr text'),
            };
          return result;
        },
      };
      try {
        expect(() => invoke(value)).toThrow('release-certification-container-operation-failed:cp');
        expect(messages).toHaveLength(1);
        expect(JSON.parse(messages[0] ?? '')).toMatchObject({
          kind: 'release-container-operation-failure',
          operation: 'cp',
          status: null,
          signal: 'SIGTERM',
          error_code: code.startsWith('/') ? 'UNAVAILABLE' : code,
        });
        expect(messages.join('')).not.toContain('private');
        expect(messages.join('')).not.toContain('export const input');
      } finally {
        stderr.mockRestore();
        value.dispose();
      }
    },
  );

  it.each(['ETIMEDOUT', 'EPIPE', '/private/protected-value'])(
    'retains sanitized attach failure metadata before a shutdown refusal: %s',
    (code) => {
      const value = fixture();
      const messages: string[] = [];
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        messages.push(String(chunk));
        return true;
      });
      let inspections = 0;
      activeFixture = {
        ...value,
        docker(args, input) {
          const result = value.docker(args, input);
          const command = args.slice(4);
          if (command[0] === 'start')
            return {
              ...result,
              status: null,
              signal: 'SIGTERM',
              error: Object.assign(new Error('private error text'), { code }),
              stderr: Buffer.from('private stderr text'),
            };
          if (command[0] === 'inspect' && inspections++ === 0) {
            const inspection = JSON.parse(result.stdout.toString());
            Object.assign(inspection[0].State, { Running: true, Pid: 12 });
            return { ...result, stdout: Buffer.from(JSON.stringify(inspection)) };
          }
          return result;
        },
      };
      try {
        expect(() => invoke(value)).toThrow('release-certification-container-quiescence-unproven');
        expect(messages).toHaveLength(1);
        expect(JSON.parse(messages[0] ?? '')).toMatchObject({
          kind: 'release-container-attach-failure',
          status: null,
          signal: 'SIGTERM',
          error_code: code.startsWith('/') ? 'UNAVAILABLE' : code,
          timeout_ms: 11_000,
        });
        expect(messages.join('')).not.toContain('private');
        expect(messages.join('')).not.toContain('export const input');
        expectCleanup();
      } finally {
        stderr.mockRestore();
        value.dispose();
      }
    },
  );

  it.each([
    ['a writable root filesystem', { ReadonlyRootfs: false }],
    ['privileged execution', { Privileged: true }],
    ['the host PID namespace', { PidMode: 'host' }],
    ['the host IPC namespace', { IpcMode: 'host' }],
    ['an automatic restart policy', { RestartPolicy: { Name: 'always' } }],
    ['a larger memory limit', { Memory: 64 * 1024 * 1024 + 1 }],
    ['a larger memory-swap limit', { MemorySwap: 128 * 1024 * 1024 }],
    ['a larger CPU allocation', { NanoCpus: 1_000_000_001 }],
    ['a larger process limit', { PidsLimit: 3 }],
    ['an additional retained capability', { CapDrop: ['ALL', 'NET_RAW'] }],
    ['missing no-new-privileges', { SecurityOpt: [] }],
  ] as const)('refuses an inspection reporting %s', (_description, hostConfigPatch) => {
    const value = fixture();
    activeFixture = {
      ...value,
      docker(args, input) {
        const result = value.docker(args, input);
        if (args[4] !== 'inspect') return result;
        const inspection = JSON.parse(result.stdout.toString()) as [
          { HostConfig: Record<string, unknown> },
        ];
        Object.assign(inspection[0].HostConfig, hostConfigPatch);
        return { ...result, stdout: Buffer.from(canonicalJson(inspection)) };
      },
    };
    try {
      expect(() => invoke(value)).toThrow('release-certification-container-isolation-mismatch');
      expectCleanup();
    } finally {
      value.dispose();
    }
  });

  it('preserves a copy failure when the created container is independently confirmed stopped', () => {
    const value = fixture();
    activeFixture = {
      ...value,
      docker(args, input) {
        const result = value.docker(args, input);
        const command = args.slice(4);
        if (command[0] === 'cp' && command[3] === `${state.id}:/workspace`)
          return { ...result, status: 1 };
        if (command[0] === 'kill' || command[0] === 'wait')
          throw new Error('created container has never started');
        return result;
      },
    };
    try {
      expect(() => invoke(value)).toThrow('release-certification-container-operation-failed:cp');
      expect(state.calls.some((args) => args[4] === 'inspect')).toBe(true);
      expect(state.calls.some((args) => ['kill', 'wait', 'start'].includes(args[4] ?? ''))).toBe(
        false,
      );
      expectCleanup();
    } finally {
      value.dispose();
    }
  });

  it.each([
    { Running: true },
    { Pid: 12 },
    { Restarting: true },
    { Running: null },
    { Pid: null },
    { Restarting: null },
  ])(
    'preserves resources when shutdown remains unproved despite successful kill and wait: %j',
    (changed) => {
      const value = fixture();
      activeFixture = {
        ...value,
        docker(args, input) {
          const result = value.docker(args, input);
          const command = args.slice(4);
          if (command[0] === 'cp' && command[3] === `${state.id}:/workspace`)
            return { ...result, status: 1 };
          if (command[0] === 'inspect') {
            const inspection = JSON.parse(result.stdout.toString());
            Object.assign(inspection[0].State, changed);
            return { ...result, stdout: Buffer.from(JSON.stringify(inspection)) };
          }
          return result;
        },
      };
      try {
        expect(() => invoke(value)).toThrow('release-certification-container-quiescence-unproven');
        expect(state.calls.some((args) => args[4] === 'kill')).toBe(true);
        expect(state.calls.some((args) => args[4] === 'wait')).toBe(true);
        expect(
          state.calls.some(
            (args) => args[4] === 'rm' || (args[4] === 'volume' && args[5] === 'rm'),
          ),
        ).toBe(false);
      } finally {
        value.dispose();
      }
    },
  );

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

  it('refuses whole public identity replacement before a mutation-program container effect', () => {
    const value = fixture();
    const other = new ProtectedCertificationContainer(
      { ...value.controls, engine_version: 'distinct-fixture-engine' },
      [],
    );
    try {
      expect(other.identity).not.toEqual(value.container.identity);
      executionAssertion.mockImplementation((_program, captured) => {
        expect(captured.container_identity).toEqual(other.identity);
      });
      // TypeScript readonly alone does not prevent this runtime replacement.
      expect(() =>
        Object.defineProperty(value.container, 'identity', {
          value: other.identity,
          writable: true,
          configurable: true,
        }),
      ).toThrow();
      expect(state.calls).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('derives the public identity from the exact captured controls used for container launch', () => {
    const value = fixture();
    let reads = 0;
    const controls = Object.defineProperty({ ...value.controls }, 'cpus', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? 2 : 1;
      },
    }) as ProtectedContainerControls;
    try {
      const container = new ProtectedCertificationContainer(controls, []);
      expect(container.identity).toMatchObject({ cpus: 2 });
      expect(reads).toBe(1);
      const result = invoke({ ...value, container, mutation_program: undefined });
      expect(result.result).toMatchObject({ status: 0 });
      const create = state.calls.find((args) => args.includes('create') && args.includes('--cpus'));
      expect(create).toContain('--cpus');
      expect(create?.[create.indexOf('--cpus') + 1]).toBe('2');
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('samples a mutation program selector once, so an absent first value remains the ordinary route', () => {
    const value = fixture();
    let reads = 0;
    const input = Object.defineProperty(
      {
        task: plannedTask(value.controls),
        timeout_ms: 1_000,
        environment: {},
        source: [SOURCE],
        prior_outputs: new Map<string, ContainerArchiveEntry>(),
        declared_outputs: [],
      },
      'mutation_program',
      {
        enumerable: true,
        get() {
          reads += 1;
          return reads === 1 ? undefined : program;
        },
      },
    );
    try {
      const result = value.container.runBound(
        {
          action_id: 'release preflight',
          repository: { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
          task_policy_digest_sha256: 'c'.repeat(64),
          plan_receipt_digest_sha256: 'd'.repeat(64),
          helper_identity_sha256: 'e'.repeat(64),
        },
        () => value.container.execute(input),
      );
      expect(reads).toBe(1);
      expect(result).not.toHaveProperty('mutation_observation');
      expect(() => captureProtectedMutationExecution(result, program)).toThrow(
        'release-certification-mutation-program-invalid',
      );
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  it('copies mutation source through intrinsic array iteration before callbacks can replace map', () => {
    const value = fixture();
    const source = [SOURCE];
    Object.defineProperty(source, 'map', {
      value: () => {
        throw new Error('caller-controlled-source-map');
      },
    });
    try {
      const result = invoke({ ...value, mutation_program: program, source });
      expect(result.result).toMatchObject({ status: 0 });
      expect(executionAssertion).toHaveBeenCalledExactlyOnceWith(program, {
        container_identity: value.container.identity,
        environment: protectedContainerTaskEnvironment({}),
        source: [SOURCE],
        prior_outputs: new Map(),
      });
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

  it('retains the selected diagnostic population before protected callbacks can mutate it', () => {
    const value = fixture();
    const output: ContainerArchiveEntry = {
      path: 'reports/diagnostic.json',
      mode: '100644',
      bytes: Buffer.from('{"diagnostic":true}\n', 'utf8'),
    };
    const diagnosticOutputPaths = [output.path];
    try {
      state.source_archive = encodeContainerDependencyArchive([SOURCE, output]);
      executionAssertion.mockImplementation(() => {
        diagnosticOutputPaths[0] = 'reports/substituted.json';
      });
      const result = invoke({
        ...value,
        mutation_program: program,
        declared_outputs: [output.path],
        diagnostic_output_paths: diagnosticOutputPaths,
      });
      expect(result.outputs).toEqual([output]);
      expect(result.diagnostic_outputs).toEqual([output]);
    } finally {
      value.dispose();
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

  it('refuses an empty mutation envelope after an outer success', () => {
    const value = fixture();
    try {
      state.envelope = Buffer.alloc(0);
      expect(() => invoke({ ...value, mutation_program: program })).toThrow(
        'release-certification-mutation-program-invalid',
      );
    } finally {
      value.dispose();
    }
  });

  it.each(['status', 'signal', 'error'] as const)(
    'retains an outer %s failure without requiring an unavailable mutation envelope',
    (failure) => {
      const value = fixture();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      state.envelope = Buffer.alloc(0);
      if (failure === 'status') {
        state.outer_status = 1;
      } else {
        activeFixture = {
          ...value,
          docker(args, input) {
            const result = value.docker(args, input);
            if (args.slice(4)[0] !== 'start') return result;
            return failure === 'signal'
              ? { ...result, status: null, signal: 'SIGTERM' }
              : {
                  ...result,
                  status: null,
                  error: Object.assign(new Error('fixture'), { code: 'EIO' }),
                };
          },
        };
      }
      try {
        const result = invoke({ ...value, mutation_program: program });
        expect(result.outputs).toEqual([]);
        expect(result).not.toHaveProperty('mutation_observation');
        expect(result).not.toHaveProperty('mutation_report');
        expect(result.result).toMatchObject(
          failure === 'status'
            ? { status: 1, signal: null }
            : failure === 'signal'
              ? { status: 0, signal: 'SIGTERM' }
              : { status: 0, signal: null, errorCode: 'PROTECTED_CONTAINER_ABNORMAL' },
        );
      } finally {
        stderr.mockRestore();
        value.dispose();
      }
    },
  );

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

  it.each([
    ['status', { status: 7 }, { status: 7, signal: null, error_code: null }],
    [
      'signal',
      { status: null, signal: 'SIGTERM' },
      { status: null, signal: 'SIGTERM', error_code: null },
    ],
    [
      'host error',
      {
        status: null,
        error: Object.assign(new Error('private host detail'), { code: 'EIO' }),
      },
      { status: null, signal: null, error_code: 'EIO' },
    ],
  ] as const)('reports an attach failure caused only by %s', (_label, changed, expected) => {
    const value = fixture();
    const messages: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      messages.push(String(chunk));
      return true;
    });
    activeFixture = {
      ...value,
      docker(args, input) {
        const result = value.docker(args, input);
        return args.slice(4)[0] === 'start' ? { ...result, ...changed } : result;
      },
    };
    try {
      invoke({ ...value, mutation_program: program });
      expect(messages).toHaveLength(1);
      expect(JSON.parse(messages[0] ?? '')).toEqual({
        kind: 'release-container-attach-failure',
        ...expected,
        timeout_ms: 11_000,
      });
      expect(messages.join('')).not.toContain('private host detail');
    } finally {
      stderr.mockRestore();
      value.dispose();
    }
  });

  it.each([
    ['signal prefix', 'noiseSIGTERM', 'EIO'],
    ['signal suffix', 'SIGTERMnoise', 'EIO'],
    ['error-code prefix', 'SIGTERM', 'noiseEIO'],
    ['error-code suffix', 'SIGTERM', 'EIO/noise'],
  ] as const)('rejects an attach diagnostic with an invalid %s', (_label, signal, code) => {
    const value = fixture();
    const messages: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      messages.push(String(chunk));
      return true;
    });
    activeFixture = {
      ...value,
      docker(args, input) {
        const result = value.docker(args, input);
        if (args.slice(4)[0] !== 'start') return result;
        return {
          ...result,
          status: null,
          signal,
          error: Object.assign(new Error('private host detail'), { code }),
        };
      },
    };
    try {
      invoke({ ...value, mutation_program: program });
      expect(messages).toHaveLength(1);
      expect(JSON.parse(messages[0] ?? '')).toMatchObject({
        kind: 'release-container-attach-failure',
        signal: signal === 'SIGTERM' ? 'SIGTERM' : null,
        error_code: code === 'EIO' ? 'EIO' : 'UNAVAILABLE',
      });
      expect(messages.join('')).not.toContain('private host detail');
    } finally {
      stderr.mockRestore();
      value.dispose();
    }
  });

  it.each([
    ['running', { Running: true }],
    ['owned pid', { Pid: 12 }],
    ['restarting', { Restarting: true }],
  ] as const)(
    'refuses a post-start container that remains %s and uses the exact shutdown commands',
    (_label, changed) => {
      const value = fixture();
      let inspections = 0;
      activeFixture = {
        ...value,
        docker(args, input) {
          const result = value.docker(args, input);
          if (args.slice(4)[0] !== 'inspect' || inspections++ !== 0) return result;
          const inspection = JSON.parse(result.stdout.toString()) as Array<{
            State: Record<string, unknown>;
          }>;
          Object.assign(inspection[0]?.State ?? {}, changed);
          return { ...result, stdout: Buffer.from(JSON.stringify(inspection)) };
        },
      };
      try {
        expect(() => invoke({ ...value, mutation_program: program })).toThrow(
          'release-certification-container-quiescence-unproven',
        );
        const commands = state.calls.map((args) => args.slice(4));
        expect(commands.filter(([command]) => command === 'inspect')).toHaveLength(2);
        expect(commands.filter(([command]) => command === 'kill')).toEqual([
          ['kill', '--signal', 'KILL', state.id],
        ]);
        expect(commands.filter(([command]) => command === 'wait')).toEqual([['wait', state.id]]);
        expectCleanup();
      } finally {
        value.dispose();
      }
    },
  );

  it('accepts a clean stopped tuple after one inspection and never invokes shutdown', () => {
    const value = fixture();
    try {
      const result = invoke({ ...value, mutation_program: program });
      expect(result.result).toEqual({ status: 0, signal: null, stdout: '', stderr: '' });
      const commands = state.calls.map((args) => args.slice(4));
      expect(commands.filter(([command]) => command === 'inspect')).toHaveLength(1);
      expect(commands.some(([command]) => command === 'kill' || command === 'wait')).toBe(false);
      expectCleanup();
    } finally {
      value.dispose();
    }
  });

  it.each([
    ['host spawn error', { executionError: true }],
    ['container OOM', { oomKilled: true }],
    ['engine state error', { stateError: 'fixture-engine-error' }],
  ] as const)('retains an abnormal result caused only by %s', (_label, changed) => {
    const value = fixture();
    activeFixture = {
      ...value,
      docker(args, input) {
        const result = value.docker(args, input);
        const command = args.slice(4)[0];
        if (command === 'start' && changed.executionError === true)
          return {
            ...result,
            error: Object.assign(new Error('fixture'), { code: 'EIO' }),
          };
        if (command !== 'inspect') return result;
        const inspection = JSON.parse(result.stdout.toString()) as Array<{
          State: Record<string, unknown>;
        }>;
        Object.assign(inspection[0]?.State ?? {}, {
          OOMKilled: changed.oomKilled ?? false,
          Error: changed.stateError ?? '',
        });
        return { ...result, stdout: Buffer.from(JSON.stringify(inspection)) };
      },
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = invoke({ ...value, mutation_program: program });
      expect(result.result).toEqual({
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        errorCode: 'PROTECTED_CONTAINER_ABNORMAL',
      });
      expect(result.outputs).toEqual([]);
      expect(result.mutation_observation).toEqual(Buffer.from('{"observed":true}', 'utf8'));
      expect(result.mutation_report).toEqual(Buffer.from('{"raw":true}', 'utf8'));
    } finally {
      stderr.mockRestore();
      value.dispose();
    }
  });

  it('returns ordinary task streams without sending them through mutation diagnostics', () => {
    const value = fixture();
    const messages: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      messages.push(String(chunk));
      return true;
    });
    activeFixture = {
      ...value,
      docker(args, input) {
        const result = value.docker(args, input);
        return args.slice(4)[0] === 'start'
          ? {
              ...result,
              stdout: Buffer.from('ordinary stdout', 'utf8'),
              stderr: Buffer.from('ordinary stderr', 'utf8'),
            }
          : result;
      },
    };
    try {
      const result = invoke(value);
      expect(result.result).toEqual({
        status: 0,
        signal: null,
        stdout: 'ordinary stdout',
        stderr: 'ordinary stderr',
      });
      expect(messages).toEqual([]);
    } finally {
      stderr.mockRestore();
      value.dispose();
    }
  });

  it('keeps mutation task channels empty while delivering nonempty worker stderr separately', () => {
    const value = fixture();
    const messages: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      messages.push(String(chunk));
      return true;
    });
    activeFixture = {
      ...value,
      docker(args, input) {
        const result = value.docker(args, input);
        return args.slice(4)[0] === 'start'
          ? { ...result, stderr: Buffer.from('fixture diagnostic', 'utf8') }
          : result;
      },
    };
    try {
      const result = invoke({ ...value, mutation_program: program });
      expect(result.result).toEqual({ status: 0, signal: null, stdout: '', stderr: '' });
      expect(messages).toEqual(['release certify: mutation worker stderr: fixture diagnostic\n']);
    } finally {
      stderr.mockRestore();
      value.dispose();
    }
  });

  it('does not create a mutation diagnostic when worker stderr is empty', () => {
    const value = fixture();
    const messages: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      messages.push(String(chunk));
      return true;
    });
    try {
      const result = invoke({ ...value, mutation_program: program });
      expect(result.result).toEqual({ status: 0, signal: null, stdout: '', stderr: '' });
      expect(messages).toEqual([]);
    } finally {
      stderr.mockRestore();
      value.dispose();
    }
  });
});
