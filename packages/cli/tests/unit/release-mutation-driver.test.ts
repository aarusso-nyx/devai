import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';
import { build, fixture, installedPackage } from '../helpers/release-mutation-inputs-fixture.js';
import {
  createMutationContainerTransportFixture,
  mutationEnvelope,
  type MutationContainerTransportFixture,
} from '../helpers/release-mutation-container-fixture.js';
import type { ContainerArchiveEntry } from '../../src/services/container-archive.js';
import { protectedContainerTaskEnvironment } from '../../src/services/release-certification-container.js';
import type { ReleaseMutationInputPlanV21 } from '../../src/services/release-mutation-inputs.js';
import {
  captureProtectedMutationProgram,
  createProtectedMutationProgram,
} from '../../src/services/release-mutation-program.js';
import { normalizeReleaseMutationPackageV21 } from '../../src/services/release-mutation-artifacts.js';
import {
  produceUnitMutationEvidenceV21,
  protectedMutationProgramTask,
  PROTECTED_MUTATION_TASK_ARGV,
  type ProtectedMutationExecutionRequest,
} from '../../src/services/release-mutation-driver.js';
import type { ReleaseMutationRetentionInputV21 } from '../../src/services/release-mutation-retention.js';

const host = vi.hoisted(() => ({
  docker: undefined as
    ((args: readonly string[], input?: Buffer) => SpawnSyncReturns<Buffer>) | undefined,
}));
const authority = vi.hoisted(() => ({ bound: vi.fn() }));
const retention = vi.hoisted(() => ({ retain: vi.fn() }));

vi.mock('@devai-nyx/authority', () => ({
  createProtectedReleaseHostAdapter: () => ({
    spawnSync(_command: string, args: readonly string[], options?: { readonly input?: Buffer }) {
      const docker = host.docker;
      if (docker === undefined) throw new Error('mutation transport fixture not installed');
      return docker(args, options?.input);
    },
  }),
}));
vi.mock('../../src/services/release-host-package-binding.js', async (original) => ({
  ...(await original<typeof import('../../src/services/release-host-package-binding.js')>()),
  assertBoundReleaseHostPackageSnapshot: authority.bound,
}));
// Retention has independent coverage of finalization, composition and the sink
// transaction. This suite proves what the driver hands it.
vi.mock('../../src/services/release-mutation-retention.js', () => ({
  retainReleaseMutationEvidenceV21: retention.retain,
}));

const inputs = await vi.importActual<
  typeof import('../../src/services/release-mutation-inputs.js')
>('../../src/services/release-mutation-inputs.js');
const executionContextCapture = vi.spyOn(inputs, 'captureReleaseMutationInputExecutionContext');
const identityAssertion = vi.spyOn(inputs, 'assertReleaseMutationInputPackageIdentity');

const ROOT = resolve(import.meta.dirname, '../../../..');
const require = createRequire(import.meta.url);
const coreVersion = (
  JSON.parse(readFileSync(require.resolve('@stryker-mutator/core/package.json'), 'utf8')) as {
    version: string;
  }
).version;

const SOURCE = Buffer.from('export const value = true;\n', 'utf8');
const TEST = Buffer.from(
  "import { value } from '../src/value.js';\nexpect(value).toBe(true);\n",
  'utf8',
);
const REPLACEMENT = 'false';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const blob = (bytes: Uint8Array) =>
  createHash('sha1')
    .update(Buffer.from(`blob ${bytes.byteLength}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
const LIMITS = {
  maximum_document_bytes: 100_000,
  maximum_files: 10,
  maximum_mutants: 100,
  maximum_raw_report_bytes: 100_000,
};
const LOCATION = { start: { line: 1, column: 22 }, end: { line: 1, column: 26 } };

function rawReport(): Buffer {
  return Buffer.from(
    canonicalJson({
      schemaVersion: '1.0',
      projectRoot: '/workspace/candidate',
      framework: { name: 'StrykerJS', version: coreVersion },
      thresholds: { break: 60, high: 60, low: 60 },
      files: {
        'packages/package/src/value.ts': {
          language: 'typescript',
          source: SOURCE.toString('utf8'),
          mutants: [
            {
              id: 'm-1',
              mutatorName: 'BooleanLiteral',
              replacement: REPLACEMENT,
              location: LOCATION,
              status: 'Killed',
            },
          ],
        },
      },
      testFiles: { 'tests/value.test.ts': { source: TEST.toString('utf8'), tests: [] } },
      config: {},
    }),
    'utf8',
  );
}

function observation(): Buffer {
  return Buffer.from(
    canonicalJson({
      selected: [{ path: 'src/value.ts', sha256: hash(SOURCE) }],
      instrumented: ['src/value.ts'],
      source_files: [
        {
          path: 'src/value.ts',
          sha256: hash(SOURCE),
          mutants: [
            {
              id: 'm-1',
              mutatorName: 'BooleanLiteral',
              replacementDigest: hash(REPLACEMENT),
              location: LOCATION,
            },
          ],
        },
      ],
    }),
    'utf8',
  );
}

interface DriverFixture {
  readonly plan: ReleaseMutationInputPlanV21;
  readonly installed: ReturnType<typeof installedPackage>;
  readonly transport: MutationContainerTransportFixture;
  readonly source: readonly ContainerArchiveEntry[];
}

function driverFixture(): DriverFixture {
  const installed = installedPackage(
    ['mutation-production.mjs', 'mutation-vitest-plugin.mjs'].map((name) => ({
      path: `dist/runtime/host/${name}`,
      mode: 0o644,
      bytes: readFileSync(resolve(ROOT, 'scripts/release-host', name)),
    })),
    { current: true },
  );
  const built = build(fixture(installed, { current: true }));
  const plan = JSON.parse(JSON.stringify(built.plan)) as ReleaseMutationInputPlanV21;
  Object.assign(plan, { execution_template_version: '1.2.0' });
  const pkg = plan.packages.find((entry) => entry.expected.packageName === '@devai-nyx/utils');
  if (pkg === undefined) throw new Error('fixture package missing');
  const expected = {
    ...pkg.expected,
    packageName: '@fixture/package',
    workspace: 'packages/package',
    inputProjection: {
      ...pkg.expected.inputProjection,
      packageName: '@fixture/package',
      workspace: 'packages/package',
    },
    thresholds: { break: 60, high: 60, low: 60, scoreMin: 60, survivedMax: 50 },
    toolVersions: {
      ...pkg.expected.toolVersions,
      stryker: coreVersion,
      node: process.version,
      vitest: '4.1.10',
    },
  };
  const target = { path: 'src/value.ts', size: SOURCE.length, sha256: hash(SOURCE) };
  const selectedTest = { path: 'tests/value.test.ts', size: TEST.length, sha256: hash(TEST) };
  Object.assign(pkg, {
    expected,
    reuse: { eligible: true, unresolved: [] },
    selected_source: [target],
    selected_tests: [selectedTest],
    mutation_targets: [target],
    prerequisite_nodes: [],
  });
  const direct = normalizeReleaseMutationPackageV21({
    expected,
    raw_report: rawReport(),
    execution_cwd: '/workspace/candidate',
    process: { errorAbsent: true, signal: null, status: 0 },
    source_files: [
      {
        path: 'packages/package/src/value.ts',
        sha256: hash(SOURCE),
        mutants: [
          {
            id: 'm-1',
            mutatorName: 'BooleanLiteral',
            replacementDigest: hash(REPLACEMENT),
            location: LOCATION,
          },
        ],
      },
    ],
    test_files: ['tests/value.test.ts'],
    limits: LIMITS,
  });
  Object.assign(pkg, { input_digest: direct.inputDigest });
  // Exactly one package so the driver's complete population is unambiguous.
  Object.assign(plan, { packages: [pkg] });
  const source: readonly ContainerArchiveEntry[] = [
    { path: 'src/value.ts', mode: '100644', bytes: Buffer.from(SOURCE) },
    { path: 'tests/value.test.ts', mode: '100644', bytes: Buffer.from(TEST) },
  ];
  authority.bound.mockImplementation(() => undefined);
  identityAssertion.mockImplementation(() => undefined);
  const context = {
    container_identity: {},
    environment: protectedContainerTaskEnvironment({}),
    repository: { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    candidate_files: source.map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      object_id: blob(entry.bytes),
    })),
  };
  executionContextCapture.mockImplementation(() => context);
  const preliminary = createProtectedMutationProgram({
    package_snapshot: installed,
    input_plan: plan,
    package_name: '@fixture/package',
    limits: LIMITS,
  });
  const transport = createMutationContainerTransportFixture({
    source,
    program_files: captureProtectedMutationProgram(preliminary).files,
    envelope: mutationEnvelope({ observation: observation(), report: rawReport() }),
  });
  executionContextCapture.mockImplementation(() => ({
    ...context,
    container_identity: transport.container.identity,
  }));
  host.docker = transport.docker;
  return { plan, installed, transport, source };
}

function runDriver(value: DriverFixture, overrides: Record<string, unknown> = {}) {
  const executable = value.transport.controls.executables.node;
  if (executable === undefined) throw new Error('fixture node executable missing');
  const requests: ProtectedMutationExecutionRequest[] = [];
  return {
    requests,
    result: produceUnitMutationEvidenceV21({
      input_plan: value.plan,
      package_snapshot: value.installed,
      limits: LIMITS,
      task_policy_digests_sha256: ['c'.repeat(64)],
      evidence_sink: {} as never,
      authority_owner: {},
      sink_host: {} as never,
      executable,
      execute: (request) => {
        requests.push(request);
        host.docker = value.transport.docker;
        return value.transport.container.runBound(
          {
            action_id: 'release certify',
            repository: {
              id: 'fixture/repository',
              commit: 'a'.repeat(40),
              tree: 'b'.repeat(40),
            },
            task_policy_digest_sha256: 'c'.repeat(64),
            plan_receipt_digest_sha256: 'd'.repeat(64),
            helper_identity_sha256: 'e'.repeat(64),
          },
          () =>
            value.transport.container.execute({
              task: request.task,
              timeout_ms: 1_000,
              environment: {},
              source: value.source,
              prior_outputs: new Map(),
              declared_outputs: [],
              mutation_program: request.program,
            }),
        );
      },
      ...overrides,
    }),
  };
}

beforeEach(() => {
  authority.bound.mockReset();
  identityAssertion.mockReset();
  executionContextCapture.mockReset();
  retention.retain.mockReset();
  retention.retain.mockImplementation(async () => ({ retained: true }));
  host.docker = undefined;
});
afterEach(() => {
  host.docker = undefined;
});

describe('protected unit mutation driver', () => {
  it('executes one protected program per package and retains the normalized population', async () => {
    const value = driverFixture();
    const run = runDriver(value);
    await expect(run.result).resolves.toEqual({ retained: true });

    expect(run.requests).toHaveLength(1);
    const request = run.requests[0];
    if (request === undefined) throw new Error('driver made no execution request');
    expect(request.package_name).toBe('@fixture/package');
    // The container accepts only this exact argv and working directory.
    expect(request.task.argv).toEqual([...PROTECTED_MUTATION_TASK_ARGV]);
    expect(request.task.cwd).toBe('.');
    expect(request.prerequisite_members).toEqual([]);

    expect(retention.retain).toHaveBeenCalledTimes(1);
    const retained = retention.retain.mock.calls[0]?.[0] as ReleaseMutationRetentionInputV21;
    expect(retained.plan).toBe(value.plan);
    expect(retained.task_policy_digests_sha256).toEqual(['c'.repeat(64)]);
    expect(retained.packages).toHaveLength(1);
    const produced = retained.packages[0];
    if (produced === undefined) throw new Error('retention received no package');
    expect(produced.packageName).toBe('@fixture/package');
    // Never a reuse claim: this driver only ever reports what it actually ran.
    expect(produced.disposition).toBe('executed');
    expect(produced.origin).toBeNull();
    // The result document is derived from the container's private capture.
    expect(JSON.parse(produced.artifacts.result.bytes.toString('utf8'))).toMatchObject({
      packageName: '@fixture/package',
      workspace: 'packages/package',
    });
    expect(produced.artifacts.inputDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('refuses a package whose container execution is not its own program custody', async () => {
    const value = driverFixture();
    await expect(
      runDriver(value, { execute: () => ({ result: { status: 0, signal: null } }) }).result,
    ).rejects.toThrow('release-certification-mutation-program-invalid');
    expect(retention.retain).not.toHaveBeenCalled();
  });

  it('refuses an empty package population and a non-callable executor', async () => {
    const value = driverFixture();
    const empty = {
      ...value,
      plan: { ...value.plan, packages: [] } as ReleaseMutationInputPlanV21,
    };
    await expect(runDriver(empty).result).rejects.toThrow(
      'release-certification-mutation-program-invalid',
    );
    await expect(runDriver(value, { execute: undefined }).result).rejects.toThrow(
      'release-certification-mutation-program-invalid',
    );
    expect(retention.retain).not.toHaveBeenCalled();
  });

  it('builds a task carrying no candidate argv, output contract or input paths', () => {
    const task = protectedMutationProgramTask({
      node_id: 'mutation:@fixture/package',
      task_key: 'mutation:@fixture/package@0',
      executable: { path: '/usr/local/bin/node', sha256: 'f'.repeat(64) },
      input_digest: 'a'.repeat(64),
    });
    expect(task.argv).toEqual(['node', '/devai-host/run.mjs']);
    expect(task.cwd).toBe('.');
    expect(task.inputPaths).toEqual([]);
    expect(task.matchedChangedPaths).toEqual([]);
    expect(task.outputContract).toEqual({ kind: 'none' });
  });
});
