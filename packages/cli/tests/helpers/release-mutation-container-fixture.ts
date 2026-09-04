import type { SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import {
  decodeContainerArchive,
  encodeContainerArchive,
  encodeContainerDependencyArchive,
  type ContainerArchiveEntry,
} from '../../src/services/container-archive.js';
import {
  ProtectedCertificationContainer,
  type ProtectedContainerControls,
} from '../../src/services/release-certification-container.js';

export interface MutationContainerTransportState {
  readonly calls: string[][];
  source_archive: Buffer;
  workspace_archive: Buffer | undefined;
  readback_archive: Buffer;
  loaded_program: Buffer | undefined;
  envelope: Buffer;
  outer_status: number;
  id: string | undefined;
  workspace_volume: string | undefined;
  nano_cpus: number | undefined;
  mounts: {
    Type: 'volume';
    Name: string;
    Destination: string;
    RW: boolean;
  }[];
  launch: Readonly<Record<string, unknown>> | undefined;
  mutable_program_mount: boolean;
}

export interface MutationContainerTransportFixture {
  readonly root: string;
  readonly controls: ProtectedContainerControls;
  readonly container: ProtectedCertificationContainer;
  readonly state: MutationContainerTransportState;
  readonly docker: (args: readonly string[], input?: Buffer) => SpawnSyncReturns<Buffer>;
  readonly dispose: () => void;
}

const IMAGE = `fixture/node@sha256:${'b'.repeat(64)}`;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function result(stdout: Buffer = Buffer.alloc(0), status = 0): SpawnSyncReturns<Buffer> {
  return {
    pid: 1,
    output: [null, stdout, Buffer.alloc(0)],
    stdout,
    stderr: Buffer.alloc(0),
    status,
    signal: null,
  };
}

function parseMounts(
  command: readonly string[],
  state: MutationContainerTransportState,
): MutationContainerTransportState['mounts'] {
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

/**
 * A host-transport fixture only. The real container still encodes/decodes,
 * validates isolation, and retains its own result custody; this never mocks
 * the container or mutation-program modules.
 */
export function createMutationContainerTransportFixture(input: {
  readonly source: readonly ContainerArchiveEntry[];
  readonly program_files: readonly ContainerArchiveEntry[];
  readonly envelope: Buffer;
  readonly outer_status?: number;
  readonly state?: MutationContainerTransportState;
}): MutationContainerTransportFixture {
  const root = mkdtempSync(join(tmpdir(), 'devai-mutation-container-'));
  const value = controls(root);
  const state: MutationContainerTransportState = input.state ?? {
    calls: [],
    source_archive: encodeContainerDependencyArchive(input.source),
    workspace_archive: undefined,
    readback_archive: encodeContainerArchive(input.program_files),
    loaded_program: undefined,
    envelope: Buffer.from(input.envelope),
    outer_status: input.outer_status ?? 0,
    id: undefined,
    workspace_volume: undefined,
    nano_cpus: undefined,
    mounts: [],
    launch: undefined,
    mutable_program_mount: false,
  };
  const docker = (args: readonly string[], stdin?: Buffer): SpawnSyncReturns<Buffer> => {
    state.calls.push([...args]);
    const command = args.slice(4);
    if (command[0] === 'create') {
      const name = command[command.indexOf('--name') + 1];
      if (name === undefined) throw new Error('fixture docker create without name');
      if (name.startsWith('devai-certify-') && !name.endsWith('-loader')) {
        state.id = name;
        state.mounts.splice(0, state.mounts.length, ...parseMounts(command, state));
        state.workspace_volume = state.mounts.find(
          (mount) => mount.Destination === '/workspace',
        )?.Name;
        const cpus = command[command.indexOf('--cpus') + 1];
        state.nano_cpus = cpus === undefined ? undefined : Number(cpus) * 1_000_000_000;
        const encoded = command.at(-1);
        if (encoded === undefined) throw new Error('fixture mutation launch missing');
        state.launch = JSON.parse(encoded) as Record<string, unknown>;
      }
      return result();
    }
    if (command[0] === 'cp' && command[1] === '-a' && command[2] === '-') {
      if (command[3]?.endsWith(':/devai-host'))
        state.loaded_program = stdin === undefined ? undefined : Buffer.from(stdin);
      if (command[3] === `${state.id}:/workspace`)
        state.workspace_archive = stdin === undefined ? undefined : Buffer.from(stdin);
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
          canonicalJson([
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
                NanoCpus: state.nano_cpus ?? 1_000_000_000,
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
  };
  return {
    root,
    controls: value,
    container: new ProtectedCertificationContainer(value, []),
    state,
    docker,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function mutationEnvelope(input: {
  readonly observation: Buffer;
  readonly report: Buffer;
  readonly process?: {
    readonly error_absent: boolean;
    readonly signal: string | null;
    readonly status: number | null;
  };
}): Buffer {
  return Buffer.from(
    canonicalJson({
      kind: 'devai.protected-mutation-program-result.v1',
      observation_base64: input.observation.toString('base64'),
      process: input.process ?? { error_absent: true, signal: null, status: 0 },
      report_base64: input.report.toString('base64'),
      schemaVersion: '1.0.0',
    }),
    'utf8',
  );
}

export function decodeMutationFixtureWorkspace(
  fixture: MutationContainerTransportFixture,
): readonly ContainerArchiveEntry[] {
  return decodeContainerArchive(
    fixture.state.workspace_archive ?? Buffer.alloc(0),
    fixture.controls.maximum_archive_bytes,
  );
}
