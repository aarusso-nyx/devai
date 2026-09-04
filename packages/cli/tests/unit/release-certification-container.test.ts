import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { dockerCalls } = vi.hoisted(() => ({ dockerCalls: [] as string[][] }));

vi.mock('@devai-nyx/authority', () => ({
  createProtectedReleaseHostAdapter: () => ({
    spawnSync(command: string, args: readonly string[], options: Parameters<typeof spawnSync>[2]) {
      dockerCalls.push([...args]);
      return spawnSync(command, args, options);
    },
  }),
}));

import { ProtectedCertificationContainer } from '../../src/services/release-certification-container.js';

type ProbeMode = 'correct' | 'extra-observed' | 'missing-executables' | 'omit-ps';

interface Fixture {
  readonly root: string;
  readonly controls: ConstructorParameters<typeof ProtectedCertificationContainer>[0];
}

const IMAGE = `fixture/node@sha256:${'a'.repeat(64)}`;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fakeDockerSource(mode: ProbeMode): string {
  return `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const image = ${JSON.stringify(IMAGE)};
const command = args.includes('version') ? 'version' : args.includes('image') ? 'image' : args.includes('run') ? 'run' : '';
if (command === 'version') { process.stdout.write('fixture-engine\\n'); process.exit(0); }
if (command === 'image') { process.stdout.write(JSON.stringify([{ Os: 'linux', Architecture: 'arm64', RepoDigests: [image] }])); process.exit(0); }
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

function fixture(mode: ProbeMode = 'correct'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'devai-container-probe-'));
  const config = join(root, 'config');
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, 'config.json'), JSON.stringify({ auths: {} }), { mode: 0o600 });
  const ps = join(root, 'ps');
  const git = join(root, 'git');
  writeExecutable(ps, '#!/bin/sh\necho fixture-ps\n');
  writeExecutable(git, '#!/bin/sh\necho fixture-git\n');
  const docker = join(root, 'docker');
  writeExecutable(docker, fakeDockerSource(mode));
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

afterEach(() => {
  dockerCalls.length = 0;
});

describe('protected container runtime executable probe', () => {
  it('hashes every declared executable in one networkless readonly runtime probe', () => {
    const value = fixture();
    try {
      verify(value.controls);
      expect(dockerCalls.filter((argv) => argv.includes('run'))).toHaveLength(1);
      const probe = dockerCalls.find((argv) => argv.includes('run'));
      expect(probe).toEqual(
        expect.arrayContaining([
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--ipc',
          'none',
        ]),
      );
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
