import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import { ProtectedCertificationContainer } from '../../src/services/release-certification-container.js';
import {
  captureProtectedMutationPrerequisites,
  createContainerReleaseCertificationAdapters,
  takeProtectedMutationPrerequisites,
  type ProtectedMutationPrerequisiteBinding,
} from '../../src/services/release-certification-provider.js';
import type { CheckRunnerOptions } from '../../src/services/check-runner/types.js';
import {
  cleanupFixtures,
  containerState,
  fixtureRuntime,
  providerFixture,
} from '../helpers/release-toolchain-provider-fixture.js';

const runner = vi.fn((options: CheckRunnerOptions) => fixtureRuntime.runCheckTasks?.(options));

vi.mock('../../src/services/check-runner/runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/check-runner/runner.js')>()),
  runCheckTasks: (options: CheckRunnerOptions) => runner(options),
  runCheckTasksAsync: async (options: CheckRunnerOptions) => runner(options),
}));

let runBound: ReturnType<typeof vi.spyOn> | undefined;
let verifyRuntime: ReturnType<typeof vi.spyOn> | undefined;
let execute: ReturnType<typeof vi.spyOn> | undefined;
const runBoundReturns: unknown[] = [];

beforeEach(() => {
  runBound = vi
    .spyOn(ProtectedCertificationContainer.prototype, 'runBound')
    .mockImplementation(<T>(_binding: unknown, operation: () => T): T => {
      const result = operation();
      runBoundReturns.push(result);
      if (result !== null && typeof result === 'object' && 'then' in result)
        throw new Error('runBound callback escaped asynchronously');
      return result;
    });
  verifyRuntime = vi
    .spyOn(ProtectedCertificationContainer.prototype, 'verifyRuntime')
    .mockImplementation(() => undefined);
  execute = vi
    .spyOn(ProtectedCertificationContainer.prototype, 'execute')
    .mockImplementation((input) => ({
      result: { status: containerState.status, signal: null, stdout: '', stderr: '' },
      outputs:
        containerState.status === 0
          ? input.declared_outputs.flatMap((path) => {
              const bytes = containerState.outputs.get(path);
              return bytes === undefined ? [] : [{ path, mode: '100644' as const, bytes }];
            })
          : [],
    }));
});

afterEach(() => {
  runBound?.mockRestore();
  verifyRuntime?.mockRestore();
  execute?.mockRestore();
  runBound = undefined;
  verifyRuntime = undefined;
  execute = undefined;
  runBoundReturns.splice(0);
  cleanupFixtures();
  runner.mockClear();
});

function certificationFixture() {
  const value = providerFixture();
  const { toolchain_fixture: _fixture, ...options } = value.options;
  const [plan] = value.options.plans;
  const receipt = plan?.receipt;
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt))
    throw new Error('fixture receipt missing');
  const receiptDigest = (receipt as Readonly<Record<string, unknown>>)['receipt_digest_sha256'];
  if (typeof receiptDigest !== 'string') throw new Error('fixture receipt digest missing');
  const request = { ...value.request, action_id: 'release certify' as const };
  const adapters = createContainerReleaseCertificationAdapters(options);
  const assembly = adapters.certification_provider(request);
  const expected: ProtectedMutationPrerequisiteBinding = {
    repository: request.repository_locator,
    release_unit: '@devai-toolchain/diagnostic',
    release_plan_receipt_digest: receiptDigest,
    release_profile_digest: canonicalSha256(
      value.options.plans[0]?.release_verification_profile ?? {},
    ),
    container_identity: new ProtectedCertificationContainer(
      value.options.controls,
      value.options.dependencies,
    ).identity,
    environment: value.options.environment,
    toolchain: value.options.toolchain,
  };
  return { adapters, assembly, candidate: value.value.candidate, expected, request };
}

async function completeDag() {
  const value = certificationFixture();
  // This fixed diagnostic profile has no mutation requirement. The mocked
  // transports exercise the adapter/token protocol only; its fixture has no
  // certification sink materialization.
  await expect(
    value.assembly.provider.certify({
      request: value.request,
      task_policies: value.assembly.task_policies,
      evidence_sink: value.assembly.evidence_sink,
    }),
  ).rejects.toThrow('release-certification-output-closure-invalid');
  return value;
}

describe('protected mutation prerequisites', () => {
  it('issues a private token only after the bound non-mutation adapter reports a passing DAG, then returns defensive bytes', async () => {
    const value = await completeDag();
    expect(runBound).toHaveBeenCalledTimes(2);
    expect(verifyRuntime).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runBoundReturns).toHaveLength(2);
    expect(
      runBoundReturns.every(
        (value) => value === null || typeof value !== 'object' || !('then' in value),
      ),
    ).toBe(true);

    const [token] = takeProtectedMutationPrerequisites(
      value.adapters.certification_provider,
      value.request,
    );
    if (token === undefined) throw new Error('missing protected prerequisite token');
    const first = captureProtectedMutationPrerequisites(token, value.expected);
    expect(first.tasks).toEqual([
      expect.objectContaining({ node_id: 'diagnostic:mutation-toolchain' }),
    ]);
    expect(first.outputs).toHaveLength(2);
    expect(first.outputs.every((output) => !value.candidate.paths.includes(output.path))).toBe(
      true,
    );
    const firstOutput = first.outputs[0];
    if (firstOutput === undefined) throw new Error('missing protected prerequisite output');
    firstOutput.bytes.fill(0);
    const second = captureProtectedMutationPrerequisites(token, value.expected);
    const secondOutput = second.outputs[0];
    if (secondOutput === undefined) throw new Error('missing defensive prerequisite output');
    expect(secondOutput.bytes.equals(firstOutput.bytes)).toBe(false);
    expect(() =>
      takeProtectedMutationPrerequisites(value.adapters.certification_provider, value.request),
    ).toThrow('release-certification-prerequisite-proof-invalid');
  });

  it('rejects wrong request/provider, replay, lookalikes, and every binding drift', async () => {
    const value = await completeDag();
    const wrongRequest = {
      ...value.request,
      candidate_locator: { ...value.request.candidate_locator, tree: 'f'.repeat(40) },
    };
    expect(() =>
      takeProtectedMutationPrerequisites(value.adapters.certification_provider, wrongRequest),
    ).toThrow('release-certification-prerequisite-proof-invalid');
    expect(() =>
      takeProtectedMutationPrerequisites(
        (() => value.assembly) as typeof value.adapters.certification_provider,
        value.request,
      ),
    ).toThrow('release-certification-prerequisite-proof-invalid');

    const next = await completeDag();
    const [token] = takeProtectedMutationPrerequisites(
      next.adapters.certification_provider,
      next.request,
    );
    if (token === undefined) throw new Error('missing protected prerequisite token');
    const drifts: readonly ProtectedMutationPrerequisiteBinding[] = [
      { ...next.expected, repository: { ...next.expected.repository, tree: 'e'.repeat(40) } },
      { ...next.expected, release_unit: 'foreign/unit' },
      { ...next.expected, release_plan_receipt_digest: 'd'.repeat(64) },
      { ...next.expected, release_profile_digest: 'c'.repeat(64) },
      { ...next.expected, container_identity: { changed: true } },
      { ...next.expected, environment: { CI: '0' } },
      { ...next.expected, toolchain: { ...next.expected.toolchain, node: 'v0.0.0' } },
    ];
    for (const drift of drifts)
      expect(() => captureProtectedMutationPrerequisites(token, drift)).toThrow(
        'release-certification-prerequisite-proof-invalid',
      );
    expect(() =>
      captureProtectedMutationPrerequisites(
        { kind: 'protected-mutation-prerequisite-closure-v1' },
        next.expected,
      ),
    ).toThrow('release-certification-prerequisite-proof-invalid');
  });

  it('does not issue a token when a protected prerequisite task fails', async () => {
    containerState.status = 1;
    const value = certificationFixture();
    await expect(
      value.assembly.provider.certify({
        request: value.request,
        task_policies: value.assembly.task_policies,
        evidence_sink: value.assembly.evidence_sink,
      }),
    ).rejects.toThrow('release-certification-task-failed');
    expect(runBound).toHaveBeenCalledTimes(2);
    expect(verifyRuntime).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runBoundReturns).toHaveLength(2);
    expect(() =>
      takeProtectedMutationPrerequisites(value.adapters.certification_provider, value.request),
    ).toThrow('release-certification-prerequisite-proof-invalid');
  });
});
