import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtectedCertificationContainer } from '../../src/services/release-certification-container.js';
import { isVerifiedReleaseCandidateSnapshot } from '../../src/services/release-candidate-snapshot.js';
import {
  createProtectedToolchainFixtureContext,
  bindProtectedToolchainFixtureContext,
  observeProtectedToolchainFixtureInputs,
  recordProtectedToolchainFixtureBinding,
  attachProtectedToolchainFixtureCustody,
  issueProtectedToolchainFixtureCompatibility,
  type ProtectedToolchainFixtureContext,
} from '../../src/services/release-toolchain-fixture-compatibility.js';
import { resolveReleasePolicySnapshot } from '../../src/services/release-policy-resolution.js';
import {
  validateProtectedDependencyTransport,
  verifyProtectedDependencyInputs,
} from '../../src/services/release-dependency-transport.js';
import {
  assertProtectedFixtureProviderCompatibility,
  createContainerReleaseCertificationAdapters,
  createContainerReleasePreflightProvider,
  takeProtectedFixtureDiagnosticCustody,
} from '../../src/services/release-certification-provider.js';
import type { CheckRunnerOptions } from '../../src/services/check-runner/types.js';
import { buildReleaseMutationInputPlanV21 } from '../../src/services/release-mutation-inputs.js';
import {
  fixture as mutationFixture,
  build as buildMutationFixture,
  currentFixture,
} from '../helpers/release-mutation-inputs-fixture.js';
import {
  DYNAMIC,
  PACKAGE,
  fixture,
  context,
  request,
  providerFixture,
  loader,
  containerState,
  fixtureRuntime,
  cleanupFixtures,
} from '../helpers/release-toolchain-provider-fixture.js';
const runner = vi.fn((options: CheckRunnerOptions) => fixtureRuntime.runCheckTasks?.(options));
const containerCalls: {
  runBound: ReturnType<typeof vi.spyOn> | undefined;
  verifyRuntime: ReturnType<typeof vi.spyOn> | undefined;
  execute: ReturnType<typeof vi.spyOn> | undefined;
} = { runBound: undefined, verifyRuntime: undefined, execute: undefined };
const certificationStore = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('unexpected certification store construction');
  }),
);
vi.mock('../../src/services/release-evidence-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/release-evidence-store.js')>()),
  createReleaseCertificationEvidenceStore: certificationStore,
}));

vi.mock('../../src/services/release-toolchain-fixture-definition.js', () => ({
  loadReleaseToolchainFixtureDefinition: () => {
    if (loader.value === undefined) throw new Error('fixture definition unavailable');
    return loader.value;
  },
}));
vi.mock('../../src/services/check-runner/runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/check-runner/runner.js')>()),
  runCheckTasks: (options: CheckRunnerOptions) => runner(options),
}));
beforeEach(() => {
  containerCalls.runBound = vi
    .spyOn(ProtectedCertificationContainer.prototype, 'runBound')
    .mockImplementation(<T>(_binding: unknown, operation: () => T): T => operation());
  containerCalls.verifyRuntime = vi
    .spyOn(ProtectedCertificationContainer.prototype, 'verifyRuntime')
    .mockImplementation(() => undefined);
  containerCalls.execute = vi
    .spyOn(ProtectedCertificationContainer.prototype, 'execute')
    .mockImplementation((input) => {
      const select = (paths: readonly string[]) =>
        paths.flatMap((path) => {
          const bytes = containerState.outputs.get(path);
          return bytes === undefined
            ? []
            : [{ path, mode: '100644' as const, bytes: Buffer.from(bytes) }];
        });
      return {
        result: { status: containerState.status, signal: null, stdout: '', stderr: '' },
        outputs: containerState.status === 0 ? select(input.declared_outputs) : [],
        ...(input.diagnostic_output_paths === undefined
          ? {}
          : { diagnostic_outputs: select(input.diagnostic_output_paths) }),
      };
    });
});

afterEach(() => {
  containerCalls.runBound?.mockRestore();
  containerCalls.verifyRuntime?.mockRestore();
  containerCalls.execute?.mockRestore();
  containerCalls.runBound = undefined;
  containerCalls.verifyRuntime = undefined;
  containerCalls.execute = undefined;
  cleanupFixtures();
  runner.mockClear();
  certificationStore.mockClear();
});

describe('release toolchain fixture compatibility', () => {
  it('runs the private preflight-only factory without an evidence store or any certification surface', async () => {
    const value = providerFixture();
    const { evidence_sink: unusedSink, ...options } = value.options;
    const sinkCalls = [
      vi.spyOn(unusedSink, 'begin'),
      vi.spyOn(unusedSink, 'readCertificationEvidenceReceipt'),
      vi.spyOn(unusedSink, 'readCertificationOutputClosure'),
      vi.spyOn(unusedSink, 'readGeneratedBlob'),
    ];
    expect(Object.hasOwn(options, 'evidence_sink')).toBe(false);
    const provider = createContainerReleasePreflightProvider(options);
    expect(typeof provider).toBe('function');
    expect(Object.keys(provider)).toEqual([]);
    expect(provider).not.toHaveProperty('certification_provider');
    expect(await provider(value.request)).toMatchObject({ outcome: 'success' });
    expect(containerCalls.runBound).toHaveBeenCalled();
    expect(containerCalls.verifyRuntime).toHaveBeenCalled();
    expect(containerCalls.execute).toHaveBeenCalled();
    expect(() =>
      assertProtectedFixtureProviderCompatibility(provider, value.expected),
    ).not.toThrow();
    expect(() => takeProtectedFixtureDiagnosticCustody(provider, value.request)).toThrow(
      'release-certification-diagnostic-custody-unavailable',
    );
    expect(await provider({ ...value.request, action_id: 'release certify' })).toMatchObject({
      outcome: 'failure',
      code: 'release-certification-plan-binding-invalid',
    });
    expect(certificationStore).not.toHaveBeenCalled();
    for (const call of sinkCalls) expect(call).not.toHaveBeenCalled();
  });

  it('accepts the exact assembled current v1.2 profile and template in a one-shot private context', async () => {
    const base = currentFixture();
    const production = buildMutationFixture(base);
    const value = providerFixture({ installed: base.installed, resolution: production.resolution });
    const template = production.resolution.readInput('release-verification-profile') as {
      readonly schemaVersion: string;
      readonly mutation_execution: { readonly schemaVersion: string };
    };

    expect(template).toMatchObject({
      schemaVersion: '1.2.0',
      mutation_execution: { schemaVersion: '1.2.0' },
    });
    const adapters = createContainerReleaseCertificationAdapters(value.options);
    expect(await adapters.preflight_provider(value.request)).toMatchObject({ outcome: 'success' });
    expect(() =>
      assertProtectedFixtureProviderCompatibility(adapters.preflight_provider, value.expected),
    ).not.toThrow();
    expect(await adapters.preflight_provider(value.request)).toMatchObject({ outcome: 'failure' });
    expect(() =>
      assertProtectedFixtureProviderCompatibility(adapters.preflight_provider, value.expected),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
  });

  it('rejects every supplied evidence sink at the private factory boundary before task or store effects', () => {
    const value = providerFixture();
    const { evidence_sink: sink, ...options } = value.options;
    for (const evidence_sink of [undefined, sink]) {
      expect(() =>
        Reflect.apply(createContainerReleasePreflightProvider, undefined, [
          { ...options, evidence_sink },
        ]),
      ).toThrow('release-certification-diagnostic-controls-invalid');
    }
    const readSink = vi.fn(() => {
      throw new Error('evidence sink getter must not run');
    });
    const accessor = Object.defineProperty({ ...options }, 'evidence_sink', { get: readSink });
    expect(() => createContainerReleasePreflightProvider(accessor)).toThrow(
      'release-certification-diagnostic-controls-invalid',
    );
    const inherited = Object.setPrototypeOf({ ...options }, { evidence_sink: sink });
    expect(Object.hasOwn(inherited, 'evidence_sink')).toBe(false);
    expect(() => createContainerReleasePreflightProvider(inherited)).toThrow(
      'release-certification-diagnostic-controls-invalid',
    );
    expect(readSink).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(certificationStore).not.toHaveBeenCalled();
  });

  it('removes only the fixture blocker from all ten plans using the genuine provider and preserves every other identity and grant', async () => {
    const base = mutationFixture();
    const production = buildMutationFixture(base);
    const value = providerFixture({ installed: base.installed, resolution: production.resolution });
    const adapters = createContainerReleaseCertificationAdapters(value.options);
    const controls = {
      ...production.controls,
      container: value.options.controls,
      environment: value.options.environment,
      toolchain: value.options.toolchain,
    };
    const input = {
      candidate: production.snapshot,
      resolution: production.resolution,
      plan_receipt: production.receipt,
      controls,
    };
    const before = buildReleaseMutationInputPlanV21(input);
    expect(before.packages).toHaveLength(10);
    expect(
      before.packages.every((entry) =>
        entry.reuse.unresolved.includes('toolchain-fixture-validation-required'),
      ),
    ).toBe(true);
    expect(() =>
      buildReleaseMutationInputPlanV21({
        ...input,
        controls: { ...controls, fixture_provider: adapters.preflight_provider },
      }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
    expect(await adapters.preflight_provider(value.request)).toMatchObject({ outcome: 'success' });
    const after = buildReleaseMutationInputPlanV21({
      ...input,
      controls: { ...controls, fixture_provider: adapters.preflight_provider },
    });
    expect({ ...after, readProof: after.readProof() }).toEqual({
      ...before,
      readProof: before.readProof(),
      packages: before.packages.map((entry) => ({
        ...entry,
        reuse: {
          eligible: false,
          unresolved: entry.reuse.unresolved.filter(
            (reason) => reason !== 'toolchain-fixture-validation-required',
          ),
        },
      })),
    });
    expect(after.grants).toEqual({ execution: false, certification: false, reuse: false });
    expect(after.packages.every((entry) => entry.reuse.unresolved.length > 0)).toBe(true);
    const wrongProvider = createContainerReleaseCertificationAdapters(
      value.options,
    ).preflight_provider;
    for (const substituted of [
      { ...controls, fixture_provider: {} },
      { ...controls, fixture_provider: async () => ({ outcome: 'success' }) },
      { ...controls, fixture_provider: wrongProvider },
      { ...controls, fixture_provider: adapters.preflight_provider, environment: { CI: '1' } },
      {
        ...controls,
        fixture_provider: adapters.preflight_provider,
        toolchain: { ...controls.toolchain, git: 'different' },
      },
      {
        ...controls,
        fixture_provider: adapters.preflight_provider,
        container: { ...controls.container, cpus: 0.5 },
      },
    ]) {
      expect(() =>
        buildReleaseMutationInputPlanV21({ ...input, controls: substituted as typeof controls }),
      ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
    }
    const otherResolution = resolveReleasePolicySnapshot({
      expected: {
        repository: production.snapshot.repository,
        installed_package: base.installed.identity,
        installation_origin: 'candidate-adopter-dependency',
        release_unit: PACKAGE,
      },
      installed_package: base.installed,
      candidate: production.snapshot,
    });
    expect(otherResolution.resolution).toEqual(production.resolution.resolution);
    expect(() =>
      buildReleaseMutationInputPlanV21({
        ...input,
        resolution: otherResolution,
        controls: { ...controls, fixture_provider: adapters.preflight_provider },
      }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
    expect(await adapters.preflight_provider(value.request)).toMatchObject({ outcome: 'failure' });
    expect(() =>
      buildReleaseMutationInputPlanV21({
        ...input,
        controls: { ...controls, fixture_provider: adapters.preflight_provider },
      }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
    const withoutProvider = buildReleaseMutationInputPlanV21(input);
    expect({ ...withoutProvider, readProof: withoutProvider.readProof() }).toEqual({
      ...before,
      readProof: before.readProof(),
    });
    const failed = createContainerReleaseCertificationAdapters(value.options);
    containerState.status = 1;
    expect(await failed.preflight_provider(value.request)).toMatchObject({ outcome: 'failure' });
    expect(() =>
      buildReleaseMutationInputPlanV21({
        ...input,
        controls: { ...controls, fixture_provider: failed.preflight_provider },
      }),
    ).toThrow('MUTATION_INPUT_IDENTITY_MISSING');
  });

  it('autoissues compatibility only inside the actual protected provider and consumes raw custody', async () => {
    const value = providerFixture();
    const adapters = createContainerReleaseCertificationAdapters(value.options);
    expect(await adapters.preflight_provider(value.request)).toMatchObject({ outcome: 'success' });
    expect(() =>
      assertProtectedFixtureProviderCompatibility(adapters.preflight_provider, value.expected),
    ).not.toThrow();
    expect(() =>
      takeProtectedFixtureDiagnosticCustody(adapters.preflight_provider, value.request),
    ).toThrow('release-certification-diagnostic-custody-unavailable');
    expect(() =>
      assertProtectedFixtureProviderCompatibility(
        async () => ({ outcome: 'failure', code: 'fixture' }),
        value.expected,
      ),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
    expect(() =>
      assertProtectedFixtureProviderCompatibility(adapters.preflight_provider, {
        ...value.expected,
        toolchain: { ...value.expected.toolchain, node: 'v24.0.0' },
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
    expect(await adapters.preflight_provider(value.request)).toMatchObject({ outcome: 'failure' });
    expect(() =>
      assertProtectedFixtureProviderCompatibility(adapters.preflight_provider, value.expected),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
  });

  it('refuses a raw mutant status array instead of coercing it to Survived', async () => {
    const value = providerFixture();
    const mutant = value.raw.files['src/subject.ts'].mutants[2];
    if (mutant === undefined) throw new Error('missing fixture mutant');
    mutant.status = ['Survived'];
    containerState.outputs.set(
      'packages/fixture/reports/mutation/raw.json',
      Buffer.from(JSON.stringify(value.raw)),
    );
    const adapters = createContainerReleaseCertificationAdapters(value.options);
    expect(await adapters.preflight_provider(value.request)).toMatchObject({
      outcome: 'failure',
      code: 'release-toolchain-fixture-compatibility-invalid',
    });
    expect(() =>
      assertProtectedFixtureProviderCompatibility(adapters.preflight_provider, value.expected),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
  });

  it('never reattaches an already consumed global custody to another genuine context', async () => {
    const value = providerFixture();
    const firstContext = context(value.value);
    const options = { ...value.options, toolchain_fixture: undefined };
    const first = createContainerReleaseCertificationAdapters({
      ...options,
      fixture_context: firstContext,
    });
    expect(await first.preflight_provider(value.request)).toMatchObject({ outcome: 'success' });
    const custody = takeProtectedFixtureDiagnosticCustody(first.preflight_provider, value.request);
    expect(() => issueProtectedToolchainFixtureCompatibility(custody)).not.toThrow();

    const secondContext = context(value.value);
    createContainerReleaseCertificationAdapters({ ...options, fixture_context: secondContext });
    observeProtectedToolchainFixtureInputs(secondContext, {
      request: value.request,
      source: value.value.source,
      descriptor: value.value.descriptor,
      tasks: [value.value.task],
    });
    const binding = custody.read().runs[0]?.binding;
    if (binding === undefined) throw new Error('missing fixture binding');
    recordProtectedToolchainFixtureBinding(secondContext, binding);
    expect(() => attachProtectedToolchainFixtureCustody(secondContext, custody)).toThrow(
      'release-toolchain-fixture-compatibility-invalid',
    );
    expect(() => issueProtectedToolchainFixtureCompatibility(custody)).toThrow(
      'release-toolchain-fixture-compatibility-invalid',
    );
  });

  it('does not issue compatibility after transport failure and rejects substituted runtime controls', async () => {
    const value = providerFixture();
    const adapters = createContainerReleaseCertificationAdapters(value.options);
    expect(await adapters.preflight_provider(value.request)).toMatchObject({ outcome: 'success' });
    expect(() =>
      assertProtectedFixtureProviderCompatibility(adapters.preflight_provider, {
        ...value.expected,
        container_identity: { ...value.expected.container_identity, memory_bytes: 1 },
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
    const failed = createContainerReleaseCertificationAdapters(value.options);
    containerState.status = 1;
    expect(await failed.preflight_provider(value.request)).toMatchObject({ outcome: 'failure' });
    expect(() =>
      assertProtectedFixtureProviderCompatibility(failed.preflight_provider, value.expected),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
  });
  it('uses genuine candidate and policy resolution brands at the mocked fixed-definition unit seam', () => {
    const historical = mutationFixture();
    const historicalProduction = buildMutationFixture(historical);
    const value = fixture({
      installed: historical.installed,
      productionResolution: historicalProduction.resolution,
    });
    const definition = loader.value;
    if (definition === undefined) throw new Error('missing mocked fixture definition');
    const expectedPaths = [...definition.manifest.map((entry) => entry.path), ...DYNAMIC].sort();
    expect(value.candidate.paths).toEqual(expectedPaths);
    expect(
      () => new ProtectedCertificationContainer(value.controls, value.dependencies),
    ).not.toThrow();
    expect(value.productionResolution.readInput('release-verification-profile')).toMatchObject({
      mutation_execution: {
        schemaVersion: '1.1.0',
        template_id: 'devai.protected-mutation-stryker.v1',
      },
    });
    const transport = validateProtectedDependencyTransport(
      value.dependencies,
      value.controls.maximum_archive_bytes,
    );
    expect(() => verifyProtectedDependencyInputs(transport, value.source)).not.toThrow();
    expect(value.fixtureResolution.resolution).toMatchObject({
      installed_package: value.installed.identity,
    });
    expect(value.productionResolution.resolution).toMatchObject({
      installed_package: value.installed.identity,
    });
    const protectedContext = context(value);
    expect(isVerifiedReleaseCandidateSnapshot(value.candidate)).toBe(true);
    expect(() => JSON.stringify(protectedContext)).toThrow(
      'release-toolchain-fixture-compatibility-invalid',
    );
    const container = new ProtectedCertificationContainer(value.controls, value.dependencies);
    const identity = bindProtectedToolchainFixtureContext(protectedContext, {
      container: container.identity,
      environment: {},
      toolchain: {
        node: 'v24.20.0',
        pnpm: '9.15.0',
        git: '2.47.3',
        vitest: '4.1.10',
        typescript: '5.9.3',
        stryker: '9.6.1',
      },
      resolutions: [value.fixtureResolution],
      receipts: [{ receipt_id: 'fixture-receipt', receipt_digest_sha256: 'f'.repeat(64) }],
      diagnostic_outputs: [
        {
          task_node: 'diagnostic:mutation-toolchain',
          paths: [
            'packages/fixture/reports/mutation/compatibility.json',
            'packages/fixture/reports/mutation/raw.json',
          ],
        },
      ],
    });
    expect(identity).toMatchObject({
      schemaVersion: '1.0.0',
      repository: value.candidate.repository,
    });
    observeProtectedToolchainFixtureInputs(protectedContext, {
      request: request(value),
      source: value.source,
      descriptor: value.descriptor,
      tasks: [value.task],
    });
    expect(() =>
      observeProtectedToolchainFixtureInputs(protectedContext, {
        request: request(value),
        source: value.source,
        descriptor: value.descriptor,
        tasks: [value.task],
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
  });

  it('refuses fixture source census drift before a provider can bind or execute', () => {
    expect(() => context(fixture({ extraPath: true }))).toThrow(
      'release-toolchain-fixture-compatibility-invalid',
    );
    expect(() => context(fixture({ modePath: 'packages/fixture/src/subject.ts' }))).toThrow(
      'release-toolchain-fixture-compatibility-invalid',
    );
  });

  it('rejects spoofed contexts and unbound runtime/toolchain substitutions', () => {
    const value = fixture();
    expect(() =>
      bindProtectedToolchainFixtureContext({} as ProtectedToolchainFixtureContext, {
        container: {},
        environment: {},
        toolchain: {},
        resolutions: [],
        receipts: [],
        diagnostic_outputs: [],
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
    expect(() =>
      createProtectedToolchainFixtureContext({
        candidate: value.candidate,
        installed_package: value.installed,
        fixture_resolution: value.fixtureResolution,
        production_resolution: value.productionResolution,
        controls: value.controls,
        dependencies: value.dependencies,
        environment: { CI: '1' },
        toolchain: {
          node: 'v24.20.0',
          pnpm: '9.15.0',
          git: '2.47.3',
          vitest: '4.1.10',
          typescript: '5.9.3',
          stryker: '9.6.1',
        },
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
  });

  it('consumes a bound context on a malformed task observation', () => {
    const value = fixture();
    const protectedContext = context(value);
    const container = new ProtectedCertificationContainer(value.controls, value.dependencies);
    bindProtectedToolchainFixtureContext(protectedContext, {
      container: container.identity,
      environment: {},
      toolchain: {
        node: 'v24.20.0',
        pnpm: '9.15.0',
        git: '2.47.3',
        vitest: '4.1.10',
        typescript: '5.9.3',
        stryker: '9.6.1',
      },
      resolutions: [value.fixtureResolution],
      receipts: [{ receipt_id: 'fixture-receipt', receipt_digest_sha256: 'f'.repeat(64) }],
      diagnostic_outputs: [
        {
          task_node: 'diagnostic:mutation-toolchain',
          paths: [
            'packages/fixture/reports/mutation/compatibility.json',
            'packages/fixture/reports/mutation/raw.json',
          ],
        },
      ],
    });
    const altered = value.source.map((entry) =>
      entry.path === 'packages/fixture/src/subject.ts'
        ? { ...entry, bytes: Buffer.from('export const enabled = () => 0;\n') }
        : entry,
    );
    expect(() =>
      observeProtectedToolchainFixtureInputs(protectedContext, {
        request: request(value),
        source: altered,
        descriptor: value.descriptor,
        tasks: [value.task],
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
    expect(() =>
      observeProtectedToolchainFixtureInputs(protectedContext, {
        request: request(value),
        source: value.source,
        descriptor: value.descriptor,
        tasks: [value.task],
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
  });
});
