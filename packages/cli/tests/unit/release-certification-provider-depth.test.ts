import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtectedCertificationContainer } from '../../src/services/release-certification-container.js';
import {
  captureProtectedMutationPrerequisites,
  createContainerReleaseCertificationAdapters,
  isProtectedReleasePreflightProvider,
  isVerifiedProtectedFixtureDiagnosticCustody,
  isVerifiedProtectedPreflightObservation,
  takeProtectedFixtureDiagnosticCustody,
  takeProtectedMutationPrerequisites,
  takeProtectedPreflightObservation,
  type ContainerReleaseCertificationOptions,
} from '../../src/services/release-certification-provider.js';
import type {
  ReleaseLifecycleRequest,
  ReleaseProvider,
} from '../../src/services/release-lifecycle-execution.js';
import type { CheckRunnerOptions } from '../../src/services/check-runner/types.js';
import {
  cleanupFixtures,
  context,
  fixtureRuntime,
  providerFixture,
} from '../helpers/release-toolchain-provider-fixture.js';

const runner = vi.fn((options: CheckRunnerOptions) => fixtureRuntime.runCheckTasks?.(options));

vi.mock('../../src/services/check-runner/runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/check-runner/runner.js')>()),
  runCheckTasks: (options: CheckRunnerOptions) => runner(options),
  runCheckTasksAsync: async (options: CheckRunnerOptions) => runner(options),
}));

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFixtures();
  runner.mockClear();
});

function asOptions(value: unknown): ContainerReleaseCertificationOptions {
  return value as ContainerReleaseCertificationOptions;
}

function asRequest(value: unknown): ReleaseLifecycleRequest {
  return value as ReleaseLifecycleRequest;
}

function providerWithOutputContract(outputContract: Readonly<Record<string, unknown>>) {
  const value = providerFixture();
  Reflect.set(value.value.task, 'outputContract', outputContract);
  const { toolchain_fixture: _fixture, ...options } = value.options;
  const declaredOutputs: string[][] = [];
  vi.spyOn(ProtectedCertificationContainer.prototype, 'runBound').mockImplementation(
    <T>(_binding: unknown, operation: () => T): T => operation(),
  );
  vi.spyOn(ProtectedCertificationContainer.prototype, 'verifyRuntime').mockImplementation(
    () => undefined,
  );
  const execute = vi
    .spyOn(ProtectedCertificationContainer.prototype, 'execute')
    .mockImplementation((input) => {
      declaredOutputs.push([...input.declared_outputs]);
      return {
        result: { status: 0, signal: null, stdout: '', stderr: '' },
        outputs: [],
      };
    });
  return {
    adapters: createContainerReleaseCertificationAdapters({
      ...options,
      diagnostic_outputs: [],
    }),
    declaredOutputs,
    execute,
    request: value.request,
  };
}

describe('protected certification provider boundaries', () => {
  it('rejects malformed construction controls before exposing a provider', () => {
    const value = providerFixture();
    const invalidDiagnostics: readonly unknown[] = [
      null,
      [null],
      [[]],
      [{ task_node: 'diagnostic:mutation-toolchain', paths: [], extra: true }],
      [{ task_node: 1, paths: ['output.json'] }],
      [{ task_node: '', paths: ['output.json'] }],
      [
        { task_node: 'z', paths: ['z.json'] },
        { task_node: 'a', paths: ['a.json'] },
      ],
      [{ task_node: 'a', paths: null }],
      [{ task_node: 'a', paths: [] }],
      [{ task_node: 'a', paths: [1] }],
      [{ task_node: 'a', paths: ['../escape'] }],
      [{ task_node: 'a', paths: ['z.json', 'a.json'] }],
    ];
    for (const diagnostic_outputs of invalidDiagnostics) {
      expect(() =>
        createContainerReleaseCertificationAdapters(
          asOptions({ ...value.options, diagnostic_outputs }),
        ),
      ).toThrow('release-certification-diagnostic-controls-invalid');
    }

    for (const timeout_ms of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createContainerReleaseCertificationAdapters(asOptions({ ...value.options, timeout_ms })),
      ).toThrow('release-certification-container-controls-invalid');
    }
    expect(() =>
      createContainerReleaseCertificationAdapters(
        asOptions({
          ...value.options,
          toolchain: { ...value.options.toolchain, node: 'v0.0.0' },
        }),
      ),
    ).toThrow('release-certification-container-controls-invalid');
    for (const key of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'PATH',
      'HOME',
      'TMPDIR',
      'DOCKER_HOST',
      'DOCKER_CONFIG',
    ]) {
      expect(() =>
        createContainerReleaseCertificationAdapters(
          asOptions({ ...value.options, environment: { [key]: 'candidate-controlled' } }),
        ),
      ).toThrow('release-certification-container-controls-invalid');
    }

    const [plan] = value.options.plans;
    if (plan === undefined) throw new Error('fixture plan unavailable');
    expect(() =>
      createContainerReleaseCertificationAdapters(
        asOptions({ ...value.options, plans: [{ ...plan, resolution: {} }] }),
      ),
    ).toThrow('rpl-policy-resolution-mismatch');
    expect(() =>
      createContainerReleaseCertificationAdapters(
        asOptions({ ...value.options, plans: [{ ...plan, receipt: {} }] }),
      ),
    ).toThrow('release-certification-plan-binding-invalid');
    expect(() =>
      createContainerReleaseCertificationAdapters({
        ...value.options,
        fixture_context: context(value.value),
      }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
    expect(() =>
      createContainerReleaseCertificationAdapters({ ...value.options, plans: [] }),
    ).toThrow('release-toolchain-fixture-compatibility-invalid');
  });

  it('binds every public planning input and consumes no transferable lookalikes', () => {
    const value = providerFixture();
    const { toolchain_fixture: _fixture, ...options } = value.options;
    const adapters = createContainerReleaseCertificationAdapters(options);
    const lookalike: ReleaseProvider = async () => ({
      outcome: 'failure',
      code: 'lookalike',
    });
    expect(isProtectedReleasePreflightProvider(adapters.preflight_provider)).toBe(true);
    expect(isProtectedReleasePreflightProvider(undefined)).toBe(false);
    expect(isProtectedReleasePreflightProvider(lookalike)).toBe(false);

    for (const candidate of [null, undefined, false, 'observation', {}, []]) {
      expect(isVerifiedProtectedPreflightObservation(candidate)).toBe(false);
      expect(isVerifiedProtectedFixtureDiagnosticCustody(candidate)).toBe(false);
    }
    expect(() =>
      takeProtectedPreflightObservation(adapters.preflight_provider, value.request),
    ).toThrow('release-certification-preflight-observation-unavailable');
    expect(() =>
      takeProtectedFixtureDiagnosticCustody(adapters.preflight_provider, value.request),
    ).toThrow('release-certification-diagnostic-custody-unavailable');
    expect(() =>
      takeProtectedMutationPrerequisites(adapters.certification_provider, value.request),
    ).toThrow('release-certification-prerequisite-proof-invalid');
    expect(() =>
      captureProtectedMutationPrerequisites(
        { kind: 'protected-mutation-prerequisite-closure-v1' },
        {} as never,
      ),
    ).toThrow('release-certification-prerequisite-proof-invalid');

    const request = value.request;
    const [unit] = request.candidate_locator.release_units;
    const [pkg] = unit?.package_roster ?? [];
    const [locator] = request.receipt_locators ?? [];
    if (unit === undefined || pkg === undefined || locator === undefined)
      throw new Error('fixture request unavailable');
    const invalidRequests: readonly ReleaseLifecycleRequest[] = [
      asRequest({ ...request, repository_locator: { ...request.repository_locator, id: 'other' } }),
      asRequest({
        ...request,
        candidate_locator: { ...request.candidate_locator, release_units: [] },
      }),
      asRequest({ ...request, action_id: 'release prepare' }),
      asRequest({
        ...request,
        candidate_locator: {
          ...request.candidate_locator,
          release_units: [{ ...unit, release_unit: 'other' }],
        },
      }),
      asRequest({
        ...request,
        candidate_locator: {
          ...request.candidate_locator,
          release_units: [{ ...unit, version: '9.9.9' }],
        },
      }),
      asRequest({
        ...request,
        candidate_locator: { ...request.candidate_locator, commit: 'a'.repeat(40) },
      }),
      asRequest({
        ...request,
        candidate_locator: { ...request.candidate_locator, tree: 'b'.repeat(40) },
      }),
      asRequest({ ...request, receipt_locators: [] }),
      asRequest({ ...request, receipt_locators: [{ ...locator, kind: 'other' }] }),
      asRequest({ ...request, receipt_locators: [{ ...locator, receipt_id: 'other' }] }),
      asRequest({
        ...request,
        receipt_locators: [{ ...locator, receipt_digest_sha256: '0'.repeat(64) }],
      }),
      asRequest({
        ...request,
        candidate_locator: {
          ...request.candidate_locator,
          release_units: [{ ...unit, package_roster: [{ ...pkg, package_id: '@fixture/other' }] }],
        },
      }),
    ];
    for (const invalid of invalidRequests) {
      expect(() => adapters.read_task_policies(invalid)).toThrow(
        'release-certification-plan-binding-invalid',
      );
    }

    const first = adapters.read_task_policies(request);
    expect(first).toHaveLength(1);
    expect(first[0]?.release_unit).toBe('@devai-toolchain/diagnostic');
    Reflect.set(first[0]?.document ?? {}, 'tampered', true);
    expect(adapters.read_task_policies(request)[0]?.document).not.toHaveProperty('tampered');
  });
});

describe('protected certification provider output closure', () => {
  it.each([
    [
      'non-canonical path population',
      {
        kind: 'test',
        requiredResult: 'pass',
        paths: [
          'packages/fixture/reports/mutation/raw.json',
          'packages/fixture/reports//mutation.json',
        ],
      },
    ],
    [
      'non-execution-only declaration',
      {
        kind: 'test',
        requiredResult: 'pass',
        paths: ['packages/fixture/reports/mutation/raw.json'],
        execution_only_paths: false,
      },
    ],
  ] as const)('returns the exact failure identity for a %s', async (_name, outputContract) => {
    const value = providerWithOutputContract(outputContract);

    await expect(value.adapters.preflight_provider(value.request)).resolves.toEqual({
      outcome: 'failure',
      code: 'release-certification-output-closure-invalid',
    });
    expect(value.execute).not.toHaveBeenCalled();
  });

  it('accepts an exact execution-only output declaration', async () => {
    const value = providerWithOutputContract({
      kind: 'test',
      requiredResult: 'pass',
      paths: ['packages/fixture/reports/mutation/raw.json'],
      execution_only_paths: true,
    });

    await expect(value.adapters.preflight_provider(value.request)).resolves.toMatchObject({
      outcome: 'success',
    });
    expect(value.declaredOutputs).toEqual([['packages/fixture/reports/mutation/raw.json']]);
  });

  it.each([
    [
      'tracked-files contract',
      {
        kind: 'tracked-files',
        paths: ['packages/fixture/src/subject.ts'],
      },
    ],
    ['contract without paths', { kind: 'none' }],
  ] as const)('does not declare outputs for a %s', async (_name, outputContract) => {
    const value = providerWithOutputContract(outputContract);

    await expect(value.adapters.preflight_provider(value.request)).resolves.toMatchObject({
      outcome: 'success',
    });
    expect(value.declaredOutputs).toEqual([[]]);
  });
});
