// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-016, INV-DEVAI-018
// Public-boundary acceptance: protected container calls retain their fixed host
// environment and expose only bounded transport/refusal identities.
import type { SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface TransportCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Readonly<Record<string, unknown>>;
}

const transport = vi.hoisted(() => ({
  calls: [] as TransportCall[],
  response: {
    pid: 1,
    output: [null, Buffer.alloc(0), Buffer.alloc(0)],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: 0,
    signal: null,
  } as SpawnSyncReturns<Buffer>,
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    createProtectedReleaseHostAdapter: () => ({
      spawnSync(
        command: string,
        args: readonly string[],
        options: Readonly<Record<string, unknown>>,
      ): SpawnSyncReturns<Buffer> {
        transport.calls.push({ command, args: [...args], options: { ...options } });
        return transport.response;
      },
    }),
  };
});

vi.mock('../../src/services/release-mutation-program.js', () => ({
  captureProtectedMutationProgram: () => {
    throw new Error('unexpected mutation-program capture');
  },
  assertProtectedMutationProgramExecution: () => {
    throw new Error('unexpected mutation-program execution assertion');
  },
}));

import {
  ProtectedCertificationContainer,
  type ProtectedContainerControls,
} from '../../src/services/release-certification-container.js';

const roots: string[] = [];
const IMAGE = `fixture/node@sha256:${'a'.repeat(64)}`;
const BINDING: Parameters<ProtectedCertificationContainer['runBound']>[0] = {
  action_id: 'release preflight',
  repository: { id: 'fixture/repository', commit: 'b'.repeat(40), tree: 'c'.repeat(40) },
  task_policy_digest_sha256: 'd'.repeat(64),
  plan_receipt_digest_sha256: 'e'.repeat(64),
  helper_identity_sha256: 'f'.repeat(64),
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture(): {
  readonly root: string;
  readonly controls: ProtectedContainerControls;
  readonly container: ProtectedCertificationContainer;
} {
  const root = mkdtempSync(join(tmpdir(), 'devai-container-transport-boundaries-'));
  roots.push(root);
  const config = join(root, 'config');
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, 'config.json'), JSON.stringify({ auths: {} }), { mode: 0o600 });
  const docker = join(root, 'docker');
  writeFileSync(docker, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(docker, 0o700);
  const controls: ProtectedContainerControls = {
    docker_binary: docker,
    docker_binary_sha256: sha256(readFileSync(docker)),
    docker_config_directory: config,
    engine_socket: 'unix:///fixture/docker.sock',
    engine_version: 'fixture-engine',
    image: IMAGE,
    node_version: process.version,
    executables: { node: { path: '/usr/local/bin/node', sha256: '1'.repeat(64) } },
    memory_bytes: 64 * 1024 * 1024,
    cpus: 1,
    pids_limit: 2,
    maximum_archive_bytes: 1024 * 1024,
  };
  return { root, controls, container: new ProtectedCertificationContainer(controls) };
}

function response(input: {
  readonly status?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly error?: Error;
}): SpawnSyncReturns<Buffer> {
  const stdout = Buffer.from('private stdout', 'utf8');
  const stderr = Buffer.from('private stderr', 'utf8');
  return {
    pid: 1,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status: input.status ?? 0,
    signal: input.signal ?? null,
    ...(input.error === undefined ? {} : { error: input.error }),
  };
}

function verifyFailure(
  value: ReturnType<typeof fixture>,
  failure: SpawnSyncReturns<Buffer>,
): readonly string[] {
  transport.response = failure;
  const messages: string[] = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    messages.push(String(chunk));
    return true;
  });
  try {
    expect(() => value.container.runBound(BINDING, () => value.container.verifyRuntime())).toThrow(
      'release-certification-container-operation-failed:version',
    );
    return messages;
  } finally {
    stderr.mockRestore();
  }
}

afterEach(() => {
  transport.calls.length = 0;
  transport.response = response({});
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('protected certification container transport boundaries', () => {
  it('refuses a nested binding with the exact identity and releases the outer binding', () => {
    const value = fixture();

    expect(() =>
      value.container.runBound(BINDING, () => value.container.runBound(BINDING, () => 'nested')),
    ).toThrow('release-certification-container-in-use');
    expect(value.container.runBound(BINDING, () => 'released')).toBe('released');
    expect(transport.calls).toEqual([]);
  });

  it('pins the complete host request and rejects a status-only transport failure', () => {
    const value = fixture();

    const messages = verifyFailure(value, response({ status: 17 }));

    expect(transport.calls).toEqual([
      {
        command: value.controls.docker_binary,
        args: [
          '--config',
          value.controls.docker_config_directory,
          '--host',
          value.controls.engine_socket,
          'version',
          '--format',
          '{{.Server.Version}}',
        ],
        options: {
          encoding: null,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        },
      },
    ]);
    expect(messages).toEqual([
      '{"kind":"release-container-operation-failure","operation":"version","status":17,' +
        '"signal":null,"error_code":null,"input_bytes":0}\n',
    ]);
  });

  it('rejects an error-only failure and maps an invalid error code to UNAVAILABLE', () => {
    const value = fixture();
    const error = Object.assign(new Error('private host detail'), { code: 'EIO/trailing' });

    const messages = verifyFailure(value, response({ error }));

    expect(transport.calls).toHaveLength(1);
    expect(messages).toEqual([
      '{"kind":"release-container-operation-failure","operation":"version","status":0,' +
        '"signal":null,"error_code":"UNAVAILABLE","input_bytes":0}\n',
    ]);
    expect(messages.join('')).not.toContain('private host detail');
  });

  it('rejects a signal-only transport failure with its bounded signal identity', () => {
    const value = fixture();

    const messages = verifyFailure(value, response({ signal: 'SIGTERM' }));

    expect(transport.calls).toHaveLength(1);
    expect(messages).toEqual([
      '{"kind":"release-container-operation-failure","operation":"version","status":0,' +
        '"signal":"SIGTERM","error_code":null,"input_bytes":0}\n',
    ]);
  });
});
