import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalSha256 } from '@devai-nyx/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { build, fixture, installedPackage } from '../helpers/release-mutation-inputs-fixture.js';
import type { ContainerArchiveEntry } from '../../src/services/container-archive.js';
import type { ReleaseMutationInputPlanV21 } from '../../src/services/release-mutation-inputs.js';
import type { ReleasePackageSnapshot } from '../../src/services/release-package-snapshot.js';
import {
  captureProtectedMutationProgram,
  captureProtectedMutationProgramPackage,
  createProtectedMutationProgram,
  assertProtectedMutationProgramExecution,
  type ProtectedMutationProgram,
} from '../../src/services/release-mutation-program.js';
import {
  ProtectedCertificationContainer,
  protectedContainerTaskEnvironment,
} from '../../src/services/release-certification-container.js';

const authority = vi.hoisted(() => ({ bound: vi.fn() }));
vi.mock('../../src/services/release-host-package-binding.js', async (original) => ({
  ...(await original<typeof import('../../src/services/release-host-package-binding.js')>()),
  assertBoundReleaseHostPackageSnapshot: authority.bound,
}));
const actualInputs = await vi.importActual<
  typeof import('../../src/services/release-mutation-inputs.js')
>('../../src/services/release-mutation-inputs.js');
const realIdentityAssertion = actualInputs.assertReleaseMutationInputPackageIdentity;
const realExecutionContextCapture = actualInputs.captureReleaseMutationInputExecutionContext;
const identityAssertion = vi.spyOn(actualInputs, 'assertReleaseMutationInputPackageIdentity');
const executionContextCapture = vi.spyOn(
  actualInputs,
  'captureReleaseMutationInputExecutionContext',
);
const ROOT = resolve(import.meta.dirname, '../../../..');
const require = createRequire(import.meta.url);
const corePackage = require.resolve('@stryker-mutator/core/package.json');
const coreVersion = (JSON.parse(readFileSync(corePackage, 'utf8')) as { version: string }).version;
const { FileMatcher } = (await import(
  pathToFileURL(resolve(dirname(corePackage), 'dist/src/config/file-matcher.js')).href
)) as {
  FileMatcher: new (pattern: string) => { matches: (fileName: string) => boolean };
};
const ASSETS = ['mutation-production.mjs', 'mutation-vitest-plugin.mjs'] as const;
const INVALID = 'release-mutation-program-invalid';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const isolatedSource = Buffer.from('export const isolated = true;\n', 'utf8');
const isolatedExecutionContext = {
  container_identity: { fixture: 'isolated-container' },
  environment: { CI: 'fixture' },
  repository: { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  candidate_files: [
    {
      path: 'src/isolated.ts',
      mode: '100644',
      object_id: createHash('sha1')
        .update(Buffer.from(`blob ${isolatedSource.length}\0`, 'utf8'))
        .update(isolatedSource)
        .digest('hex'),
    },
  ],
} as const;
const isolatedPriorOutputs: ReadonlyMap<string, ContainerArchiveEntry> = new Map([
  [
    'generated/output.json',
    { path: 'generated/output.json', mode: '100644', bytes: Buffer.from('{}') },
  ],
]);
const limits = {
  maximum_document_bytes: 1_000_000,
  maximum_files: 100,
  maximum_mutants: 1000,
  maximum_raw_report_bytes: 2_000_000,
};

function genuine(current = true) {
  const installed = installedPackage(
    ASSETS.map((name) => ({
      path: `dist/runtime/host/${name}`,
      mode: 0o644,
      bytes: readFileSync(resolve(ROOT, 'scripts/release-host', name)),
    })),
    { current },
  );
  const base = fixture(installed, { current });
  const value = build(base);
  return {
    installed,
    value,
    input: {
      package_snapshot: installed,
      input_plan: value.plan,
      package_name: '@devai-nyx/utils',
      limits: { ...limits },
    },
  };
}
const current = genuine();

beforeEach(() => {
  authority.bound.mockReset();
  identityAssertion.mockReset();
  identityAssertion.mockImplementation(realIdentityAssertion);
  executionContextCapture.mockReset();
  executionContextCapture.mockImplementation(realExecutionContextCapture);
});

/** Only factory-byte tests isolate prior authority; this is NOT an executable/custody fixture. */
function factoryUnit() {
  const plan = JSON.parse(JSON.stringify(current.value.plan)) as ReleaseMutationInputPlanV21;
  const pkg = plan.packages.find((entry) => entry.expected.packageName === '@devai-nyx/utils');
  if (pkg === undefined || pkg.execution_configuration === undefined)
    throw new Error('fixture package missing');
  Object.assign(pkg, { reuse: { eligible: true, unresolved: [] } });
  identityAssertion.mockImplementation(() => undefined);
  executionContextCapture.mockImplementation(() => isolatedExecutionContext);
  return { pkg, input: { ...current.input, input_plan: plan, limits: { ...limits } } };
}

function file(capture: ReturnType<typeof captureProtectedMutationProgram>, path: string) {
  const entry = capture.files.find((item) => item.path === path);
  if (entry === undefined) throw new Error(`program file missing: ${path}`);
  return entry;
}
function json(
  capture: ReturnType<typeof captureProtectedMutationProgram>,
  path: string,
): Record<string, unknown> {
  return JSON.parse(file(capture, path).bytes.toString('utf8')) as Record<string, unknown>;
}

describe('protected mutation program factory with explicit upstream-authority isolation (ADR-MUT-0008)', () => {
  it('captures a genuine immutable execution context only from the exact derived plan', () => {
    const context = realExecutionContextCapture(current.value.plan);
    expect(context).toEqual({
      container_identity: new ProtectedCertificationContainer(
        current.value.controls.container,
        current.value.controls.dependencies,
      ).identity,
      environment: protectedContainerTaskEnvironment(current.value.controls.environment),
      repository: current.value.snapshot.repository,
      candidate_files: expect.arrayContaining([
        expect.objectContaining({ path: 'packages/utils/src/main.ts', mode: '100644' }),
      ]),
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(() =>
      realExecutionContextCapture(
        JSON.parse(JSON.stringify(current.value.plan)) as ReleaseMutationInputPlanV21,
      ),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
  });

  it('uses the isolated execution-context seam only for factory-byte tests, never as authority', () => {
    const { input } = factoryUnit();
    const program = createProtectedMutationProgram(input);
    expect(() =>
      assertProtectedMutationProgramExecution(program, {
        container_identity: isolatedExecutionContext.container_identity,
        environment: isolatedExecutionContext.environment,
        source: [{ path: 'src/isolated.ts', mode: '100644', bytes: isolatedSource }],
        prior_outputs: new Map(),
      }),
    ).not.toThrow();
    expect(() =>
      assertProtectedMutationProgramExecution(program, {
        container_identity: { fixture: 'substituted-container' },
        environment: isolatedExecutionContext.environment,
        source: [{ path: 'src/isolated.ts', mode: '100644', bytes: isolatedSource }],
        prior_outputs: new Map(),
      }),
    ).toThrow(INVALID);
  });

  it('defensively rereads the exact factory-bound package inputs and limits', () => {
    const { input } = factoryUnit();
    const program = createProtectedMutationProgram(input);
    const first = captureProtectedMutationProgramPackage(program);
    const expected = first.package.expected;
    Object.assign(expected, { packageName: '@caller/substituted' });
    Object.assign(first.limits, { maximum_files: 1 });

    const reread = captureProtectedMutationProgramPackage(program);
    expect(reread.package.expected.packageName).toBe('@devai-nyx/utils');
    expect(reread.limits.maximum_files).toBe(limits.maximum_files);
    expect(() =>
      captureProtectedMutationProgramPackage({ ...program } as ProtectedMutationProgram),
    ).toThrow(INVALID);
  });

  it.each([
    ['a substituted environment', { environment: { CI: 'substituted' } }],
    [
      'a changed candidate blob',
      {
        source: [
          { path: 'src/isolated.ts', mode: '100644', bytes: Buffer.from('changed\n', 'utf8') },
        ],
      },
    ],
    [
      'a changed candidate mode',
      {
        source: [{ path: 'src/isolated.ts', mode: '100755', bytes: isolatedSource }],
      },
    ],
    [
      'an extra candidate file',
      {
        source: [
          { path: 'src/isolated.ts', mode: '100644', bytes: isolatedSource },
          { path: 'src/extra.ts', mode: '100644', bytes: Buffer.from('extra\n', 'utf8') },
        ],
      },
    ],
    ['a missing candidate file', { source: [] }],
    [
      'caller-provided prerequisite outputs',
      {
        prior_outputs: isolatedPriorOutputs,
      },
    ],
  ] as const)('refuses %s at the isolated execution boundary', (_label, change) => {
    const { input } = factoryUnit();
    const program = createProtectedMutationProgram(input);
    expect(() =>
      assertProtectedMutationProgramExecution(program, {
        container_identity: isolatedExecutionContext.container_identity,
        environment: isolatedExecutionContext.environment,
        source: [{ path: 'src/isolated.ts', mode: '100644', bytes: isolatedSource }],
        prior_outputs: new Map(),
        ...change,
      }),
    ).toThrow(INVALID);
  });

  it.each([
    ['subject[1].ts', 'subject1.ts'],
    ['subject?.ts', 'subjectX.ts'],
    ['subject*.ts', 'subjectExpanded.ts'],
    ['subject+(one).ts', 'subjectone.ts'],
    ['subject@(one).ts', 'subjectone.ts'],
    ['subject(one).ts', 'subjectone.ts'],
    ['subject á ç.ts', 'subject a c.ts'],
    ['[?*]+@(ação).ts', 'Xacao.ts'],
  ])(
    'encodes literal %s through the actual pinned Stryker FileMatcher without matching wildcard siblings',
    (name, sibling) => {
      expect(coreVersion).toBe('9.6.1');
      const { input, pkg } = factoryUnit();
      const target = pkg.mutation_targets[0];
      const test = pkg.selected_tests[0];
      if (target === undefined || test === undefined) throw new Error('fixture population missing');
      const targetPath = `packages/utils/src/${name}`;
      const testPath = `packages/utils/tests/${name}`;
      Object.assign(pkg, {
        mutation_targets: [{ ...target, path: `src/${name}` }],
        selected_tests: [{ ...test, path: testPath }],
      });
      const captured = captureProtectedMutationProgram(createProtectedMutationProgram(input));
      const options = json(captured, 'stryker.config.json');
      for (const [key, exact, other] of [
        ['mutate', targetPath, `packages/utils/src/${sibling}`],
        ['testFiles', testPath, `packages/utils/tests/${sibling}`],
      ] as const) {
        const patterns = options[key] as string[];
        expect(patterns).toHaveLength(1);
        const pattern = patterns[0];
        if (pattern === undefined) throw new Error('generated pattern missing');
        expect(pattern).not.toContain('\\');
        const matcher = new FileMatcher(pattern);
        expect(matcher.matches(exact)).toBe(true);
        expect(matcher.matches(other)).toBe(false);
      }
    },
  );

  it.each([':', '{', '}', '!'])(
    'refuses unsupported literal %s in either mutation or test paths before returning a program',
    (punctuation) => {
      for (const population of ['mutation_targets', 'selected_tests'] as const) {
        const { input, pkg } = factoryUnit();
        const member = pkg[population][0];
        if (member === undefined) throw new Error('fixture population missing');
        Object.assign(pkg, {
          [population]: [{ ...member, path: `src/unsupported${punctuation}.ts` }],
        });
        expect(() => createProtectedMutationProgram(input)).toThrow(INVALID);
      }
    },
  );

  it('constructs only exact host-owned files and bound roster/config/threshold options', () => {
    const { input, pkg } = factoryUnit();
    const program = createProtectedMutationProgram(input);
    const capture = captureProtectedMutationProgram(program);
    const config = pkg.execution_configuration;
    if (config === undefined) throw new Error('fixture execution config missing');
    expect(authority.bound).toHaveBeenCalledExactlyOnceWith(current.installed);
    expect(identityAssertion).toHaveBeenCalledExactlyOnceWith(
      input.input_plan,
      current.installed.identity,
    );
    expect(program).toEqual({
      kind: 'protected-mutation-program-v1',
      identity_sha256: capture.identity_sha256,
    });
    expect(Object.isFrozen(program)).toBe(true);
    expect(capture.argv).toEqual(['node', '/devai-host/run.mjs']);
    expect(capture.files.map((entry) => entry.path)).toEqual([
      'invocation.json',
      'mutation-production.mjs',
      'mutation-vitest-plugin.mjs',
      'run.mjs',
      'stryker.config.json',
    ]);
    expect(capture.files.every((entry) => entry.mode === '100644')).toBe(true);
    for (const name of ASSETS)
      expect(file(capture, name).bytes).toEqual(
        current.installed.read(`dist/runtime/host/${name}`),
      );
    expect(json(capture, 'stryker.config.json')).toEqual({
      mutate: ['packages/utils/src/main.ts'],
      testFiles: ['packages/utils/tests/main.test.ts'],
      plugins: ['@stryker-mutator/typescript-checker', '/devai-host/mutation-vitest-plugin.mjs'],
      appendPlugins: [],
      testRunner: 'devai-vitest',
      checkers: ['typescript'],
      coverageAnalysis: 'perTest',
      concurrency: 4,
      thresholds: { break: 60, high: 60, low: 60 },
      reporters: ['json'],
      jsonReporter: { fileName: '/tmp/devai-mutation-report.json' },
      vitest: { configFile: 'tests/config/local.config.ts', related: false },
      tsconfigFile: 'packages/utils/tsconfig.json',
      tempDirName: '/tmp/devai-mutation-production',
      cleanTempDir: 'always',
      symlinkNodeModules: true,
      fileLogLevel: 'off',
      logLevel: 'off',
      timeoutMS: 10000,
      timeoutFactor: 2,
      ignorePatterns: [],
      ignorers: [],
      mutator: { excludedMutations: [] },
      incremental: false,
      inPlace: false,
      buildCommand: '',
    });
    const expectedInputs = [
      ...new Map(
        [
          ...pkg.selected_source,
          ...pkg.selected_tests,
          config.vitest_config,
          config.typescript_config,
          ...config.typescript_closure,
        ].map((member) => [
          member.path,
          { path: member.path, size: member.size, sha256: member.sha256 },
        ]),
      ).values(),
    ];
    expect(json(capture, 'invocation.json')).toEqual({
      node_version: 'v24.20.0',
      versions: { vitest: '4.1.10', typescript: '5.9.3' },
      input_digest: pkg.input_digest,
      observation: {
        workspace: 'packages/utils',
        targets: pkg.mutation_targets.map(({ path, sha256 }) => ({ path, sha256 })),
        maximum_files: 100,
        maximum_mutants: 1000,
      },
      inputs: expectedInputs,
      maximum_observation_bytes: 1_000_000,
      maximum_raw_report_bytes: 2_000_000,
    });
    expect(capture.maximum_observation_bytes).toBe(limits.maximum_document_bytes);
    expect(capture.maximum_raw_report_bytes).toBe(limits.maximum_raw_report_bytes);
    expect(program.identity_sha256).toBe(
      canonicalSha256({
        input_digest: pkg.input_digest,
        package: current.installed.identity,
        files: capture.files.map((entry) => ({
          path: entry.path,
          mode: entry.mode,
          size: entry.bytes.length,
          sha256: hash(entry.bytes),
        })),
      }),
    );
    const wrapper = file(capture, 'run.mjs').bytes.toString('utf8');
    expect(wrapper).toContain("configFile:'/devai-host/stryker.config.json'");
    expect(wrapper).toContain('runPinnedProductionMutation');
    expect(wrapper).toContain('send(3,');
    expect(wrapper).toContain('send(4,');
    expect(wrapper).toContain('lstatSync(path)');
    expect(wrapper).not.toMatch(/npm run|pnpm run|process\.env|\.\/stryker\.conf/);
  });

  it('retains private captured bytes despite caller mutation and refuses serialized capabilities', () => {
    const { input, pkg } = factoryUnit();
    const sourceBytes = new Map(
      ASSETS.map((name) => {
        const path = `dist/runtime/host/${name}`;
        return [path, current.installed.read(path)] as const;
      }),
    );
    const program = createProtectedMutationProgram({
      ...input,
      package_snapshot: {
        ...current.installed,
        read: (path) => sourceBytes.get(path) ?? current.installed.read(path),
      },
    });
    const before = captureProtectedMutationProgram(program);
    for (const bytes of sourceBytes.values()) bytes.fill(0);
    const callerCopy = captureProtectedMutationProgram(program);
    file(callerCopy, 'invocation.json').bytes.fill(0);
    Object.assign(callerCopy, { maximum_observation_bytes: 1, argv: ['ambient'] });
    Object.assign(pkg.expected, { workspace: 'changed-workspace' });
    input.limits.maximum_document_bytes = 1;
    expect(captureProtectedMutationProgram(program)).toEqual(before);
    expect(() => captureProtectedMutationProgram({ ...program })).toThrow(INVALID);
    expect(() =>
      captureProtectedMutationProgram(
        JSON.parse(JSON.stringify(program)) as ProtectedMutationProgram,
      ),
    ).toThrow(INVALID);
    expect(() =>
      captureProtectedMutationProgram({
        kind: 'protected-mutation-program-v1',
        identity_sha256: '0'.repeat(64),
      }),
    ).toThrow(INVALID);
  });

  it('refuses v1.1 even after isolating upstream prerequisites', () => {
    const historical = genuine(false);
    const plan = JSON.parse(JSON.stringify(historical.value.plan)) as ReleaseMutationInputPlanV21;
    for (const pkg of plan.packages)
      Object.assign(pkg, { reuse: { eligible: true, unresolved: [] } });
    identityAssertion.mockImplementation(() => undefined);
    executionContextCapture.mockImplementation(() => isolatedExecutionContext);
    expect(() => createProtectedMutationProgram({ ...historical.input, input_plan: plan })).toThrow(
      INVALID,
    );
  });

  it('keeps a genuine unresolved current plan blocked while checking its real package identity', () => {
    expect(() =>
      actualInputs.assertReleaseMutationInputPackageIdentity(
        current.value.plan,
        current.installed.identity,
      ),
    ).not.toThrow();
    expect(
      current.value.plan.packages.every((pkg) =>
        pkg.reuse.unresolved.includes('toolchain-fixture-validation-required'),
      ),
    ).toBe(true);
    expect(() => createProtectedMutationProgram(current.input)).toThrow(INVALID);
  });

  it('rejects a changed installed package identity and a serialized plan through the real authority assertion', () => {
    const changed = {
      ...current.installed,
      identity: { ...current.installed.identity, archive_sha256: '0'.repeat(64) },
    };
    expect(() =>
      createProtectedMutationProgram({ ...current.input, package_snapshot: changed }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
    expect(() =>
      createProtectedMutationProgram({
        ...current.input,
        input_plan: JSON.parse(JSON.stringify(current.value.plan)) as ReleaseMutationInputPlanV21,
      }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
  });

  it('propagates missing installed host binding before generating bytes', () => {
    authority.bound.mockImplementation(() => {
      throw new Error('unbound package sentinel');
    });
    expect(() => createProtectedMutationProgram(current.input)).toThrow('unbound package sentinel');
    expect(identityAssertion).not.toHaveBeenCalled();
  });

  it.each(['toolchain-fixture-validation-required', 'prerequisite-output-proof-required'])(
    'refuses unresolved %s after isolated identity checks',
    (blocker) => {
      const { input, pkg } = factoryUnit();
      Object.assign(pkg, { reuse: { eligible: true, unresolved: [blocker] } });
      expect(() => createProtectedMutationProgram(input)).toThrow(INVALID);
    },
  );

  it('refuses an unknown requested package', () => {
    const { input } = factoryUnit();
    expect(() =>
      createProtectedMutationProgram({ ...input, package_name: '@fixture/unknown' }),
    ).toThrow(INVALID);
  });

  it.each(['absent', 'mode', 'size', 'digest', 'empty', 'oversized'] as const)(
    'refuses %s source asset bytes or metadata',
    (fault) => {
      const { input } = factoryUnit();
      const target = 'dist/runtime/host/mutation-production.mjs';
      let bytes = current.installed.read(target);
      let manifest = current.installed.manifest.map((entry) => ({ ...entry }));
      const metadata = manifest.find((entry) => entry.path === target);
      if (metadata === undefined) throw new Error('fixture asset missing');
      if (fault === 'absent') manifest = manifest.filter((entry) => entry.path !== target);
      if (fault === 'mode') metadata.mode = 0o755;
      if (fault === 'size') metadata.size += 1;
      if (fault === 'digest') metadata.sha256 = '0'.repeat(64);
      if (fault === 'empty' || fault === 'oversized') {
        bytes = Buffer.alloc(fault === 'empty' ? 0 : 128 * 1024 + 1, 0x61);
        metadata.size = bytes.length;
        metadata.sha256 = hash(bytes);
      }
      const snapshot: ReleasePackageSnapshot = {
        ...current.installed,
        manifest,
        read: (path) => (path === target ? bytes : current.installed.read(path)),
      };
      expect(() =>
        createProtectedMutationProgram({ ...input, package_snapshot: snapshot }),
      ).toThrow(INVALID);
    },
  );

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER, NaN])('refuses invalid limit %s', (limit) => {
    const { input } = factoryUnit();
    input.limits.maximum_mutants = limit;
    expect(() => createProtectedMutationProgram(input)).toThrow();
  });

  it.each(['missing', 'extra'] as const)('refuses %s limit fields', (fault) => {
    const { input } = factoryUnit();
    const malformed = { ...input.limits } as Record<string, number>;
    if (fault === 'missing') delete malformed['maximum_files'];
    else malformed['ambient_timeout'] = 1;
    expect(() =>
      createProtectedMutationProgram({
        ...input,
        limits: malformed as unknown as typeof input.limits,
      }),
    ).toThrow(INVALID);
  });
});
