// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017; ADR-SCR-0020.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { superviseNativeLinuxTask } from '../../src/native-linux-task-supervisor.js';

// Observe actual admission effects. Never replace the catalogue, witness, plan or execution.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
    realpathSync: vi.fn(actual.realpathSync),
    lstatSync: vi.fn(actual.lstatSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), spawn: vi.fn(actual.spawn) };
});

const assetFiles = {
  supervisor: 'native-linux-task-supervisor.js',
  serviceSupervisor: 'native-service-supervisor.js',
  dockerBroker: 'native-service-docker-broker.js',
  linuxPlan: 'native-linux-plan.js',
  linuxReplay: 'native-linux-replay.js',
  inputPreload: 'native-input-provenance.js',
  coverageAdapter: 'native-coverage-adapter.js',
  coverageKernel: 'native-coverage-kernel.js',
  coverageData: 'native-coverage-data.js',
  serviceFixtures: 'native-service-fixtures.js',
  serviceFixturesKernel: 'native-service-fixtures-kernel.js',
  vitestReporter: 'native-test-reporter.js',
  playwrightReporter: 'native-playwright-reporter.js',
  platformProbes: 'native-platform-probes.js',
  playwrightLoader: 'native-playwright-loader.js',
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const snapshots = {
    candidate: { volume: 'candidate-snapshot', manifestSha256: '1'.repeat(64) },
    dependencies: { volume: 'dependency-snapshot', manifestSha256: '2'.repeat(64) },
    helpers: { volume: 'helper-snapshot', manifestSha256: '3'.repeat(64) },
  };
  const portable = {
    schemaVersion: '1.0.0',
    nonce: 'a'.repeat(64),
    repository: '/workspace',
    kind: 'integration_test',
    inputs: { taskId: 'test:integration', population: 'original-integration-tests' },
    candidate: 'b'.repeat(40),
    tree: 'c'.repeat(40),
    backendRecordSha256: 'd'.repeat(64),
    snapshotManifestSha256: Object.fromEntries(
      Object.entries(snapshots).map(([key, snapshot]) => [key, snapshot.manifestSha256]),
    ),
  };
  const json = JSON.stringify(portable);
  return {
    schemaVersion: '1.0.0',
    nonce: portable.nonce,
    docker: {
      executable: '/unprepared/docker',
      sha256: 'e'.repeat(64),
      socket: {
        path: '/unprepared/docker.sock',
        realpath: '/unprepared/docker.sock',
        dev: 1,
        ino: 2,
      },
      engine: { id: 'unprepared-engine', serverVersion: 'fixture', apiVersion: '1.48' },
    },
    hostAssets: Object.fromEntries(
      Object.entries(assetFiles).map(([key, file]) => [
        key,
        { path: `/unprepared/package/${file}`, sha256: 'f'.repeat(64) },
      ]),
    ),
    backend: {
      recordId: 'owned-linux-native-v1-linux-arm64',
      recordSha256: portable.backendRecordSha256,
      runtime: { id: `sha256:${'4'.repeat(64)}`, architecture: 'arm64', os: 'linux' },
      seccomp: { path: '/unprepared/seccomp.json', sha256: '5'.repeat(64) },
    },
    identity: {
      profile: 'postgres-http-v1',
      repository: portable.repository,
      candidate: portable.candidate,
      tree: portable.tree,
      taskId: portable.inputs.taskId,
      population: portable.inputs.population,
      taskPolicySha256: '6'.repeat(64),
      inputSha256: hash(json),
    },
    snapshots,
    services: {
      images: {
        postgres: {
          reference: `postgres@sha256:${'7'.repeat(64)}`,
          id: `sha256:${'8'.repeat(64)}`,
          architecture: 'arm64',
          os: 'linux',
        },
      },
      kinds: ['postgres'],
      redisProcessControl: null,
      limits: {
        maxInstances: 2,
        maxConcurrent: 2,
        requestTimeoutMs: 1000,
        perKind: { postgres: { maxInstances: 2 } },
      },
    },
    portableInput: { json, sha256: hash(json) },
    limits: {
      taskTimeoutMs: 1000,
      prepareTimeoutMs: 1000,
      replayTimeoutMs: 1000,
      cleanupTimeoutMs: 1000,
      maxOutputBytes: 1024,
      memoryBytes: 64 * 1024 * 1024,
      pids: 16,
      shmBytes: 1024 * 1024,
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function noResourceEffects() {
  for (const method of [
    fs.realpathSync,
    fs.lstatSync,
    fs.writeFileSync,
    childProcess.execFileSync,
    childProcess.spawn,
  ])
    expect(method).not.toHaveBeenCalled();
}
function noDiscovery() {
  noResourceEffects();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(fs.existsSync).not.toHaveBeenCalled();
}
beforeEach(() => vi.clearAllMocks());

describe('Linux supervisor admission refuses before discovery or execution', () => {
  it.each(Object.keys(assetFiles))('requires independently bound %s host asset', async (key) => {
    const plan = fixture();
    const hostAssets = Object.fromEntries(
      Object.entries(plan.hostAssets).filter(([name]) => name !== key),
    );
    await expect(superviseNativeLinuxTask({ ...plan, hostAssets })).rejects.toThrow(
      'NATIVE_LINUX_HOST_ASSETS_INVALID',
    );
    noDiscovery();
  });

  const malformed: Array<[string, (plan: Fixture) => unknown, string]> = [
    ['caller authority', (plan) => ({ ...plan, standing: true }), 'PLAN_INVALID'],
    ['incomplete plan', () => ({}), 'PLAN_INVALID'],
    ['null plan', () => null, 'PLAN_INVALID'],
    [
      'relative helper',
      (plan) => ({
        ...plan,
        hostAssets: {
          ...plan.hostAssets,
          linuxPlan: { path: './other.js', sha256: 'f'.repeat(64) },
        },
      }),
      'HOST_ASSETS_INVALID',
    ],
    [
      'extra helper',
      (plan) => ({
        ...plan,
        hostAssets: { ...plan.hostAssets, caller: { path: '/other.js', sha256: 'f'.repeat(64) } },
      }),
      'HOST_ASSETS_INVALID',
    ],
    [
      'aliased snapshots',
      (plan) => ({
        ...plan,
        snapshots: {
          ...plan.snapshots,
          helpers: { ...plan.snapshots.helpers, volume: plan.snapshots.candidate.volume },
        },
      }),
      'SNAPSHOT_ALIAS',
    ],
    [
      'unbound portable bytes',
      (plan) => ({ ...plan, portableInput: { ...plan.portableInput, json: '{}' } }),
      'PORTABLE_INPUT_INVALID',
    ],
    [
      'different candidate',
      (plan) => ({ ...plan, identity: { ...plan.identity, candidate: '9'.repeat(40) } }),
      'PORTABLE_BINDING_INVALID',
    ],
    [
      'different helper snapshot',
      (plan) => ({
        ...plan,
        snapshots: {
          ...plan.snapshots,
          helpers: { ...plan.snapshots.helpers, manifestSha256: '9'.repeat(64) },
        },
      }),
      'PORTABLE_BINDING_INVALID',
    ],
    [
      'unbounded execution',
      (plan) => ({ ...plan, limits: { ...plan.limits, taskTimeoutMs: 0 } }),
      'LIMITS_INVALID',
    ],
    [
      'mutable image tag',
      (plan) => ({
        ...plan,
        services: {
          ...plan.services,
          images: { postgres: { ...plan.services.images.postgres, reference: 'postgres:latest' } },
        },
      }),
      'SERVICE_IMAGE_INVALID',
    ],
    [
      'extra service',
      (plan) => ({ ...plan, services: { ...plan.services, kinds: ['postgres', 'external'] } }),
      'SERVICES_INVALID',
    ],
    [
      'unbounded fixtures',
      (plan) => ({
        ...plan,
        services: { ...plan.services, limits: { ...plan.services.limits, maxInstances: 129 } },
      }),
      'SERVICE_LIMITS_INVALID',
    ],
    [
      'relative engine socket',
      (plan) => ({
        ...plan,
        docker: { ...plan.docker, socket: { ...plan.docker.socket, realpath: './docker.sock' } },
      }),
      'DOCKER_BINDING_INVALID',
    ],
  ];
  it.each(malformed)('refuses %s before any discovery', async (_label, change, code) => {
    await expect(superviseNativeLinuxTask(change(fixture()))).rejects.toThrow(
      `NATIVE_LINUX_${code}`,
    );
    noDiscovery();
  });
});

describe('package-owned backend approval precedes all host preparation', () => {
  it.each([
    'postgres-http-v1',
    'postgres-http-s3-v1',
    'postgres-redis-http-s3-kms-v1',
    'playwright-chromium-web-v1',
  ])(
    'cannot activate %s with caller-authored hashes or successful-looking selection',
    async (profile) => {
      const plan = fixture();
      await expect(
        superviseNativeLinuxTask({ ...plan, identity: { ...plan.identity, profile } }),
      ).rejects.toThrow('NATIVE_LINUX_BACKEND_NOT_APPROVED');
      expect(fs.readFileSync).toHaveBeenCalledTimes(2);
      const paths = vi.mocked(fs.readFileSync).mock.calls.map(([path]) => String(path));
      expect(paths.some((path) => path.endsWith('/law/policy/native-service-backends.json'))).toBe(
        true,
      );
      expect(
        paths.some((path) =>
          path.endsWith('/law/schemas/native-service-backends-policy.schema.json'),
        ),
      ).toBe(true);
      expect(paths.some((path) => path.includes('/unprepared/'))).toBe(false);
      noResourceEffects();
    },
  );
});

describe('assembled private supervisor uses its packaged catalogue and schema', () => {
  it('loads the real packaged schema before refusing an unapproved backend without effects', () => {
    // Build prerequisite is explicit: this exercises the actual assembled entry, not a source
    // substitution. The source path can succeed even when the package schema path is broken.
    const binary = fileURLToPath(
      new URL('../../dist/runtime/index/native-linux-task-supervisor.js', import.meta.url),
    );
    const child = childProcess.spawnSync(process.execPath, [binary, '--execute'], {
      input: JSON.stringify(fixture()),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('');
    const raw = child.output[3];
    expect(raw).toBeTruthy();
    if (typeof raw !== 'string') throw new Error('Installed supervisor receipt is missing');
    const receipt: unknown = JSON.parse(raw);
    expect(receipt).toMatchObject({
      schemaVersion: '1.0.0',
      kind: 'native-linux-task-receipt',
      complete: false,
      standing: false,
      child: null,
      derived: null,
      replay: null,
      lifecycle: [],
      failures: ['Error: NATIVE_LINUX_BACKEND_NOT_APPROVED'],
      cleanupComplete: true,
    });
  });
});
