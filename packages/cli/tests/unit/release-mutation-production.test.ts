import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import { canonicalJson } from '@devai-nyx/utils';
import { build, fixture, installedPackage } from '../helpers/release-mutation-inputs-fixture.js';
import {
  createMutationContainerTransportFixture,
  mutationEnvelope,
  type MutationContainerTransportFixture,
} from '../helpers/release-mutation-container-fixture.js';
import type { ContainerArchiveEntry } from '../../src/services/container-archive.js';
import {
  ProtectedCertificationContainer,
  protectedContainerTaskEnvironment,
} from '../../src/services/release-certification-container.js';
import type { PlannedTask } from '../../src/services/check-runner/types.js';
import type { ReleaseMutationInputPlanV21 } from '../../src/services/release-mutation-inputs.js';
import {
  captureProtectedMutationProgram,
  createProtectedMutationProgram,
  type ProtectedMutationProgram,
} from '../../src/services/release-mutation-program.js';
import {
  captureProducedMutationPackageV21,
  normalizeProtectedMutationExecutionV21,
} from '../../src/services/release-mutation-production.js';
import { normalizeReleaseMutationPackageV21 } from '../../src/services/release-mutation-artifacts.js';

const host = vi.hoisted(() => ({
  docker: undefined as
    ((args: readonly string[], input?: Buffer) => SpawnSyncReturns<Buffer>) | undefined,
}));
const authority = vi.hoisted(() => ({ bound: vi.fn() }));

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

const inputs = await vi.importActual<
  typeof import('../../src/services/release-mutation-inputs.js')
>('../../src/services/release-mutation-inputs.js');
const identityAssertion = vi.spyOn(inputs, 'assertReleaseMutationInputPackageIdentity');
const executionContextCapture = vi.spyOn(inputs, 'captureReleaseMutationInputExecutionContext');

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
const ZERO = Buffer.from('export const zero = 0;\n', 'utf8');
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

function rawReport(status: 'Killed' | 'Survived' = 'Killed'): Buffer {
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
              location: { start: { line: 1, column: 22 }, end: { line: 1, column: 26 } },
              status,
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

function observation(
  input: {
    readonly mutants?: readonly string[];
    readonly zero_target?: boolean;
    readonly extra?: unknown;
  } = {},
): Buffer {
  const ids = input.mutants ?? ['m-1'];
  return Buffer.from(
    canonicalJson({
      selected: [
        { path: 'src/value.ts', sha256: hash(SOURCE) },
        ...(input.zero_target ? [{ path: 'src/zero.ts', sha256: hash(ZERO) }] : []),
      ],
      instrumented: ['src/value.ts', ...(input.zero_target ? ['src/zero.ts'] : [])],
      source_files: [
        {
          path: 'src/value.ts',
          sha256: hash(SOURCE),
          mutants: ids.map((id) => ({
            id,
            mutatorName: 'BooleanLiteral',
            replacementDigest: hash(REPLACEMENT),
            location: { start: { line: 1, column: 22 }, end: { line: 1, column: 26 } },
          })),
        },
        ...(input.zero_target ? [{ path: 'src/zero.ts', sha256: hash(ZERO), mutants: [] }] : []),
      ],
      ...(input.extra === undefined ? {} : { extra: input.extra }),
    }),
    'utf8',
  );
}

function task(controls: MutationContainerTransportFixture['controls']): PlannedTask {
  const executable = controls.executables.node;
  if (executable === undefined) throw new Error('fixture node executable missing');
  return {
    nodeId: 'mutation-fixture',
    taskKey: 'a'.repeat(64),
    dependencies: [],
    outputContract: {},
    argv: ['node', '/devai-host/run.mjs'],
    executable,
    cwd: '.',
    inputDigest: 'b'.repeat(64),
    inputPaths: [],
    matchedChangedPaths: [],
    cacheState: 'execute',
    reason: 'fixture',
  };
}

interface ProductionFixture {
  readonly program: ProtectedMutationProgram;
  readonly transport: MutationContainerTransportFixture;
  readonly source: readonly ContainerArchiveEntry[];
}

/**
 * Factory preconditions are intentionally isolated here. The subsequent
 * execution uses the real factory capture, real container custody map, and
 * real production normalizer; it is not a certification authority fixture.
 */
function productionFixture(
  input: {
    readonly raw?: Buffer;
    readonly observed?: Buffer;
    readonly worker?: {
      readonly error_absent: boolean;
      readonly signal: string | null;
      readonly status: number | null;
    };
    readonly outer_status?: number;
    readonly limits?: typeof LIMITS;
    readonly zero_target?: boolean;
  } = {},
): ProductionFixture {
  const installed = installedPackage(
    ['mutation-production.mjs', 'mutation-vitest-plugin.mjs'].map((name) => ({
      path: `dist/runtime/host/${name}`,
      mode: 0o644,
      bytes: readFileSync(resolve(ROOT, 'scripts/release-host', name)),
    })),
    { current: true },
  );
  const base = fixture(installed, { current: true });
  const built = build(base);
  const plan = JSON.parse(JSON.stringify(built.plan)) as ReleaseMutationInputPlanV21;
  Object.assign(plan, { execution_template_version: '1.2.0' });
  const pkg = plan.packages.find((entry) => entry.expected.packageName === '@devai-nyx/utils');
  if (pkg === undefined || pkg.execution_configuration === undefined)
    throw new Error('fixture package configuration missing');
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
  const zeroTarget = { path: 'src/zero.ts', size: ZERO.length, sha256: hash(ZERO) };
  const selectedTest = { path: 'tests/value.test.ts', size: TEST.length, sha256: hash(TEST) };
  Object.assign(pkg, {
    expected,
    reuse: { eligible: true, unresolved: [] },
    selected_source: [target, ...(input.zero_target ? [zeroTarget] : [])],
    selected_tests: [selectedTest],
    mutation_targets: [target, ...(input.zero_target ? [zeroTarget] : [])],
  });
  const raw = input.raw ?? rawReport();
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
            location: { start: { line: 1, column: 22 }, end: { line: 1, column: 26 } },
          },
        ],
      },
    ],
    test_files: ['tests/value.test.ts'],
    // The package input digest is policy/source-derived, not a caller-selected
    // transport ceiling. A later smaller driver ceiling is tested separately.
    limits: LIMITS,
  });
  Object.assign(pkg, { input_digest: direct.inputDigest });
  const source: readonly ContainerArchiveEntry[] = [
    { path: 'src/value.ts', mode: '100644', bytes: Buffer.from(SOURCE) },
    { path: 'tests/value.test.ts', mode: '100644', bytes: Buffer.from(TEST) },
    ...(input.zero_target
      ? [{ path: 'src/zero.ts', mode: '100644' as const, bytes: Buffer.from(ZERO) }]
      : []),
  ];
  const preliminary = new ProtectedCertificationContainer(
    built.controls.container,
    built.controls.dependencies,
  );
  const context = {
    container_identity: preliminary.identity,
    environment: protectedContainerTaskEnvironment({}),
    repository: { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    candidate_files: source.map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      object_id: blob(entry.bytes),
    })),
  };
  authority.bound.mockImplementation(() => undefined);
  identityAssertion.mockImplementation(() => undefined);
  executionContextCapture.mockImplementation(() => context);
  const program = createProtectedMutationProgram({
    package_snapshot: installed,
    input_plan: plan,
    package_name: '@fixture/package',
    limits: input.limits ?? LIMITS,
  });
  const transport = createMutationContainerTransportFixture({
    source,
    program_files: captureProtectedMutationProgram(program).files,
    envelope: mutationEnvelope({
      observation: input.observed ?? observation({ zero_target: input.zero_target }),
      report: raw,
      process: input.worker,
    }),
    outer_status: input.outer_status,
  });
  // The context deliberately uses this real transport identity; source bytes
  // are immutable Git blobs, and no provider/program capture is mocked.
  executionContextCapture.mockImplementation(() => ({
    ...context,
    container_identity: transport.container.identity,
  }));
  // Recreate after the exact transport identity is known so the stored context
  // and eventual container invocation are the same real immutable identity.
  const boundProgram = createProtectedMutationProgram({
    package_snapshot: installed,
    input_plan: plan,
    package_name: '@fixture/package',
    limits: input.limits ?? LIMITS,
  });
  host.docker = transport.docker;
  return { program: boundProgram, transport, source };
}

function execute(value: ProductionFixture) {
  host.docker = value.transport.docker;
  return value.transport.container.runBound(
    {
      action_id: 'release preflight',
      repository: { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      task_policy_digest_sha256: 'c'.repeat(64),
      plan_receipt_digest_sha256: 'd'.repeat(64),
      helper_identity_sha256: 'e'.repeat(64),
    },
    () =>
      value.transport.container.execute({
        task: task(value.transport.controls),
        timeout_ms: 1_000,
        environment: {},
        source: value.source,
        prior_outputs: new Map(),
        declared_outputs: [],
        mutation_program: value.program,
      }),
  );
}

beforeEach(() => {
  authority.bound.mockReset();
  identityAssertion.mockReset();
  executionContextCapture.mockReset();
  host.docker = undefined;
});
afterEach(() => {
  host.docker = undefined;
});

describe('protected mutation production normalization', () => {
  it('normalizes only the actual same-program container custody and rereads produced artifacts defensively', () => {
    const value = productionFixture();
    try {
      const execution = execute(value);
      const artifacts = normalizeProtectedMutationExecutionV21({
        program: value.program,
        execution,
      });
      expect(JSON.parse(artifacts.result.bytes.toString('utf8'))).toMatchObject({
        complete: true,
        passed: true,
        targetCensus: { targetFileCount: 1, totalMutants: 1 },
      });
      const reread = captureProducedMutationPackageV21(artifacts);
      artifacts.report.bytes.fill(0);
      expect(captureProducedMutationPackageV21(artifacts).report.bytes).toEqual(
        reread.report.bytes,
      );
      expect(() =>
        normalizeProtectedMutationExecutionV21({
          program: value.program,
          execution: { ...execution },
        }),
      ).toThrow('release-certification-mutation-program-invalid');
      expect(() => captureProducedMutationPackageV21({ ...artifacts })).toThrow(
        'release-certification-mutation-program-invalid',
      );
    } finally {
      value.transport.dispose();
    }
  });

  it('retains selected and instrumented zero-emission targets while normalizing only emitted report files', () => {
    const value = productionFixture({ zero_target: true });
    try {
      const execution = execute(value);
      const artifacts = normalizeProtectedMutationExecutionV21({
        program: value.program,
        execution,
      });
      const report = JSON.parse(artifacts.report.bytes.toString('utf8')) as {
        files: Record<string, unknown>;
      };
      expect(Object.keys(report.files)).toEqual(['packages/package/src/value.ts']);
      expect(JSON.parse(artifacts.result.bytes.toString('utf8'))).toMatchObject({
        complete: true,
        passed: true,
        targetCensus: { targetFileCount: 1, totalMutants: 1 },
      });
    } finally {
      value.transport.dispose();
    }
  });

  it('retains the complete selected/instrumented census and refuses a zero-emission substitution', () => {
    const value = productionFixture({ observed: observation({ mutants: [] }) });
    try {
      const execution = execute(value);
      expect(() =>
        normalizeProtectedMutationExecutionV21({ program: value.program, execution }),
      ).toThrow();
    } finally {
      value.transport.dispose();
    }
  });

  it.each([
    ['a substituted discovered mutant id', observation({ mutants: ['m-substituted'] })],
    ['an unknown observation member', observation({ extra: true })],
  ] as const)('refuses %s before raw report normalization', (_label, observed) => {
    const value = productionFixture({ observed });
    try {
      const execution = execute(value);
      expect(() =>
        normalizeProtectedMutationExecutionV21({ program: value.program, execution }),
      ).toThrow();
    } finally {
      value.transport.dispose();
    }
  });

  it('refuses a custody result when paired with another genuine factory program', () => {
    const left = productionFixture();
    const right = productionFixture();
    try {
      const execution = execute(left);
      expect(() =>
        normalizeProtectedMutationExecutionV21({ program: right.program, execution }),
      ).toThrow('release-certification-mutation-program-invalid');
    } finally {
      left.transport.dispose();
      right.transport.dispose();
    }
  });

  it.each([
    [
      'a changed selected-source digest',
      () => {
        const value = JSON.parse(observation().toString('utf8')) as Record<string, unknown>;
        const selected = value.selected as Array<Record<string, unknown>>;
        const first = selected[0];
        if (first === undefined) throw new Error('fixture selected entry missing');
        first.sha256 = '0'.repeat(64);
        return Buffer.from(canonicalJson(value), 'utf8');
      },
    ],
    [
      'an omitted instrumented target',
      () => {
        const value = JSON.parse(observation().toString('utf8')) as Record<string, unknown>;
        value.instrumented = [];
        return Buffer.from(canonicalJson(value), 'utf8');
      },
    ],
  ] as const)('refuses %s', (_label, makeObservation) => {
    const value = productionFixture({ observed: makeObservation() });
    try {
      expect(() =>
        normalizeProtectedMutationExecutionV21({
          program: value.program,
          execution: execute(value),
        }),
      ).toThrow('release-certification-mutation-program-invalid');
    } finally {
      value.transport.dispose();
    }
  });

  it.each([
    ['an omitted raw report', () => Buffer.from(canonicalJson({}), 'utf8')],
    [
      'an unsupported raw report version',
      () => {
        const value = JSON.parse(rawReport().toString('utf8')) as Record<string, unknown>;
        value.schemaVersion = '2.0';
        return Buffer.from(canonicalJson(value), 'utf8');
      },
    ],
    [
      'an unrelated reported test path',
      () => {
        const value = JSON.parse(rawReport().toString('utf8')) as Record<string, unknown>;
        value.testFiles = { 'tests/unrelated.test.ts': {} };
        return Buffer.from(canonicalJson(value), 'utf8');
      },
    ],
  ] as const)('refuses %s', (_label, makeReport) => {
    const value = productionFixture({ raw: makeReport() });
    try {
      expect(() =>
        normalizeProtectedMutationExecutionV21({
          program: value.program,
          execution: execute(value),
        }),
      ).toThrow();
    } finally {
      value.transport.dispose();
    }
  });

  it('cannot promote a failed protected worker result even when its report is otherwise valid', () => {
    const value = productionFixture({
      worker: { error_absent: true, signal: null, status: 7 },
      outer_status: 0,
    });
    try {
      const execution = execute(value);
      const artifacts = normalizeProtectedMutationExecutionV21({
        program: value.program,
        execution,
      });
      expect(JSON.parse(artifacts.result.bytes.toString('utf8'))).toMatchObject({
        complete: false,
        passed: false,
      });
    } finally {
      value.transport.dispose();
    }
  });

  it('refuses oversized channels before they reach the production normalizer', () => {
    const value = productionFixture({
      limits: { ...LIMITS, maximum_document_bytes: 8 },
    });
    try {
      expect(() => execute(value)).toThrow('release-certification-mutation-program-invalid');
      expect(value.transport.state.calls.some((args) => args.includes('start'))).toBe(true);
      expect(value.transport.state.calls.some((args) => args.includes('rm'))).toBe(true);
    } finally {
      value.transport.dispose();
    }
  });
});
