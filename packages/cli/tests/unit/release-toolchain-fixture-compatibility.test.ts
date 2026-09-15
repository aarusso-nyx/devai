import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtectedCertificationContainer } from '../../src/services/release-certification-container.js';
import { createContainerReleasePreflightProvider } from '../../src/services/release-certification-provider.js';
import type { CheckRunnerOptions } from '../../src/services/check-runner/types.js';
import {
  providerFixture,
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

vi.mock('../../src/services/check-runner/runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/check-runner/runner.js')>()),
  runCheckTasks: (options: CheckRunnerOptions) => runner(options),
  runCheckTasksAsync: async (options: CheckRunnerOptions) => runner(options),
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

describe('ordinary private preflight factory boundaries', () => {
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
    expect(await provider({ ...value.request, action_id: 'release certify' })).toMatchObject({
      outcome: 'failure',
      code: 'release-certification-plan-binding-invalid',
    });
    expect(certificationStore).not.toHaveBeenCalled();
    for (const call of sinkCalls) expect(call).not.toHaveBeenCalled();
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
});
