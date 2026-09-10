import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  buildReleaseMutationInputPlanV21,
  captureReleaseMutationInputExecutionContext,
} from '../../src/services/release-mutation-inputs.js';
import { build, currentFixture } from '../helpers/release-mutation-inputs-fixture.js';
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
const productionRoots: string[] = [];

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
  for (const root of productionRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  runner.mockClear();
});

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitRepository(snapshot: ReturnType<typeof build>['snapshot']) {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'devai-prerequisite-plan-')));
  productionRoots.push(root);
  const git = (args: readonly string[]): Buffer => {
    const result = spawnSync('git', ['-C', root, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.toString());
    return result.stdout;
  };
  git(['init', '-q']);
  const proof = snapshot.readProof(snapshot.paths);
  for (const [id, object] of proof) {
    const path = join(root, '.git', 'devai-proof-input');
    writeFileSync(path, object.bytes, { flag: 'w', mode: 0o600 });
    const actual = git([
      'hash-object',
      '-w',
      ...(object.type === 'commit' ? ['--literally'] : []),
      '-t',
      object.type,
      '--no-filters',
      '--',
      path,
    ])
      .toString()
      .trim();
    if (actual !== id) throw new Error('fixture Git object identity mismatch');
  }
  git(['checkout', '--detach', snapshot.repository.commit]);
  return { root, proof };
}

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
  it.each(['node', 'key', 'duplicate'] as const)(
    'rejects a %s execution identity before an unauthorized container invocation',
    async (defect) => {
      const value = certificationFixture();
      const original = fixtureRuntime.runCheckTasks;
      if (original === undefined) throw new Error('fixture runner missing');
      fixtureRuntime.runCheckTasks = (options) => {
        const executeTask = options.executeTask;
        if (executeTask === undefined) return original(options);
        return original({
          ...options,
          executeTask: (argv, cwd, timeout, environment, identity) => {
            if (defect === 'duplicate') executeTask(argv, cwd, timeout, environment, identity);
            return executeTask(argv, cwd, timeout, environment, {
              nodeId: defect === 'node' ? 'undeclared-task' : identity.nodeId,
              taskKey: defect === 'key' ? 'f'.repeat(64) : identity.taskKey,
            });
          },
        });
      };
      await expect(
        value.assembly.provider.certify({
          request: value.request,
          task_policies: value.assembly.task_policies,
          evidence_sink: value.assembly.evidence_sink,
        }),
      ).rejects.toThrow('release-task-policy-identity-mismatch');
      expect(execute).toHaveBeenCalledTimes(defect === 'duplicate' ? 1 : 0);
    },
  );

  it('reads exact defensive policies without executing tasks or granting certification', () => {
    const value = certificationFixture();
    const policies = value.adapters.read_task_policies(value.request);
    expect(policies).toEqual(value.assembly.task_policies);
    expect(runner.mock.calls.every(([options]) => options.operation === 'plan')).toBe(true);
    expect(runBound).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(verifyRuntime).not.toHaveBeenCalled();
    Reflect.set(policies[0]?.document ?? {}, 'caller_mutation', true);
    expect(value.adapters.read_task_policies(value.request)).toEqual(value.assembly.task_policies);
    expect(() =>
      value.adapters.read_task_policies({
        ...value.request,
        candidate_locator: { ...value.request.candidate_locator, tree: 'f'.repeat(40) },
      }),
    ).toThrow('release-certification-plan-binding-invalid');
    expect(() =>
      takeProtectedMutationPrerequisites(value.adapters.certification_provider, value.request),
    ).toThrow('release-certification-prerequisite-proof-invalid');
  });
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

    // Policy inspection must not consume or clear a completed execution's proof.
    expect(value.adapters.read_task_policies(value.request)).toEqual(value.assembly.task_policies);
    expect(execute).toHaveBeenCalledTimes(1);
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

  it('materializes a genuine protected prerequisite closure into the exact mutation input plan', async () => {
    const base = currentFixture();
    const descriptor = JSON.parse(base.files.get('test-tasks.json')?.toString() ?? '') as {
      tasks: Array<Record<string, unknown>>;
    };
    const consumer = descriptor.tasks.find((task) => task['nodeId'] === 'test:utils');
    if (consumer === undefined) throw new Error('fixture consumer task missing');
    const generatedPath = 'packages/utils/dist/prerequisite.json';
    const producer = {
      nodeId: 'generate:utils',
      dependencies: [],
      argv: ['node', 'scripts/generate-utils.mjs'],
      cwd: '.',
      runner: 'node-builtin-v1',
      inputSelectors: [{ kind: 'prefix', pattern: 'packages/utils/' }],
      toolchainKeys: ['node'],
      allowlistedEnv: ['CI'],
      outputContract: { kind: 'build', paths: [generatedPath] },
    };
    consumer['dependencies'] = [producer.nodeId];
    descriptor.tasks.push(producer);
    base.files.set('test-tasks.json', Buffer.from(JSON.stringify(descriptor)));
    const derived = build(base);
    const unproved = derived.plan.packages.find((entry) => entry.id === 'utils');
    if (unproved === undefined) throw new Error('fixture unproved package missing');
    expect(unproved?.reuse.unresolved).toContain('prerequisite-output-proof-required');
    const unprovedRunner = (
      unproved.expected.inputProjection['bindings'] as Record<string, Record<string, unknown>>
    )['runner'];
    if (unprovedRunner === undefined) throw new Error('fixture unproved runner binding missing');

    const repository = gitRepository(derived.snapshot);
    const executable = derived.controls.container.executables.node;
    if (executable === undefined) throw new Error('fixture executable missing');
    const plannedTasks = [producer, consumer].map((task, index) => ({
      ...task,
      taskKey: String(index + 1).repeat(64),
      executable,
      inputDigest: String(index + 3).repeat(64),
      inputPaths: [],
      matchedChangedPaths: [],
      cacheState: 'execute' as const,
      reason: 'protected prerequisite fixture',
    }));
    const taskPlan = {
      taskPolicyDigest: '9'.repeat(64),
      taskPolicy: { nodes: plannedTasks.map((task) => task.nodeId) },
      tasks: plannedTasks,
    };
    fixtureRuntime.runCheckTasks = (options) => {
      const execution = plannedTasks.map((task) => {
        const result =
          options.operation === 'run'
            ? options.executeTask?.(
                task.argv,
                join(repository.root, task.cwd),
                1000,
                derived.controls.environment,
                { nodeId: task.nodeId, taskKey: task.taskKey },
              )
            : undefined;
        return {
          nodeId: task.nodeId,
          taskKey: task.taskKey,
          disposition: 'executed' as const,
          outcome:
            result?.status === undefined || result.status === 0
              ? ('PASS' as const)
              : ('FAIL' as const),
          reason: 'protected prerequisite fixture',
          durationMs: 1,
        };
      });
      return {
        schemaVersion: '1.0.0',
        operation: options.operation,
        plan: taskPlan,
        execution,
        preflightReceipt: {
          digest: '8'.repeat(64),
          path: '.devai/cache/preflight.json',
          value: {},
        },
        exitCode: execution.every((task) => task.outcome === 'PASS') ? 0 : 1,
      };
    };
    const outputBytes = Buffer.from('{"generated":true}\n');
    containerState.outputs.set(generatedPath, outputBytes);

    const intent = {
      schemaVersion: '1.0.0',
      release_unit: '@aarusso-nyx/devai',
      current_version: '1.4.5',
      target_version: '1.5.0',
      support: 'current',
      change_kind: 'behavioral',
      changed_paths: [],
      changed_packages: [],
      risks: [],
      candidate: {
        commit: derived.snapshot.repository.commit,
        tree: derived.snapshot.repository.tree,
      },
      base: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    };
    const roster = derived.plan.packages.map((entry) => ({
      package_id: entry.expected.packageName,
      manifest_path: `${entry.expected.workspace}/package.json`,
    }));
    const packagePlan = roster.map((entry) => ({
      package_id: entry.package_id,
      source_entries: ['package.json'],
      generated_entries:
        entry.package_id === '@devai-nyx/utils'
          ? [{ path: 'dist/prerequisite.json', task_node: producer.nodeId }]
          : [],
    }));
    const request = {
      schemaVersion: '1.0.0' as const,
      request_kind: 'release-lifecycle-request' as const,
      action_id: 'release certify' as const,
      repository_locator: derived.snapshot.repository,
      candidate_locator: {
        commit: derived.snapshot.repository.commit,
        tree: derived.snapshot.repository.tree,
        release_units: [
          {
            release_unit: '@aarusso-nyx/devai',
            version: '1.5.0',
            package_roster: roster.map((entry) => ({
              ...entry,
              manifest_digest_sha256: digest(derived.snapshot.read(entry.manifest_path)),
            })),
          },
        ],
      },
      receipt_locators: [
        {
          kind: 'release-plan-receipt' as const,
          receipt_id: derived.receipt.receipt_id,
          receipt_digest_sha256: derived.receipt.receipt_digest_sha256,
          path: '.devai/receipts/fixture.json',
        },
      ],
    };
    const proof = repository.proof;
    const readObject = (objectId: string, expectedType?: string): Buffer => {
      const object = proof.get(objectId);
      if (object === undefined || (expectedType !== undefined && object.type !== expectedType))
        throw new Error('fixture Git object missing');
      return Buffer.from(object.bytes);
    };
    let provenPlan: ReturnType<typeof buildReleaseMutationInputPlanV21> | undefined;
    const adapters = createContainerReleaseCertificationAdapters({
      repository_root: repository.root,
      repository_id: derived.snapshot.repository.id,
      plans: [
        {
          receipt: derived.receipt,
          resolution: derived.resolution,
          intent_path: 'release-intent.json',
          intent,
          release_verification_profile: derived.resolution.readInput(
            'release-verification-profile',
          ),
          release_lifecycle_policy: derived.resolution.readInput('release-lifecycle-policy'),
          action_registry: derived.resolution.readInput('action-registry-policy'),
          packages: packagePlan,
        },
      ],
      controls: derived.controls.container,
      dependencies: derived.controls.dependencies,
      environment: derived.controls.environment,
      toolchain: derived.controls.toolchain,
      timeout_ms: 1000,
      mutation_driver: {
        package_snapshot: base.installed,
        limits: {
          maximum_document_bytes: 1_000_000,
          maximum_files: 100,
          maximum_mutants: 1000,
          maximum_raw_report_bytes: 2_000_000,
        },
        buildInputPlan: (closure) => {
          provenPlan = buildReleaseMutationInputPlanV21({
            candidate: derived.snapshot,
            resolution: derived.resolution,
            plan_receipt: derived.receipt,
            controls: { ...derived.controls, prerequisite_closure: closure },
          });
          throw new Error('fixture-plan-captured');
        },
      },
      content_source: {
        readGitObject: ({ object_id, type }) => readObject(object_id, type),
        readGitBlob: ({ object_id }) => readObject(object_id, 'blob'),
      },
      evidence_sink: {
        kind: 'certification-evidence-sink-v3',
        protocol: 'two-phase-content-addressed',
        authority_owner: {},
        beginUnitMutationEvidence: () => {
          throw new Error('unexpected unit mutation transaction');
        },
        begin: () => {
          throw new Error('unexpected certification transaction');
        },
        readCertificationEvidenceReceipt: () => {
          throw new Error('unexpected certification receipt');
        },
        readCertificationOutputClosure: (binding) => ({ ...binding, outputs: [] }),
        readGeneratedBlob: () => {
          throw new Error('unexpected generated blob');
        },
      },
    });
    const assembly = adapters.certification_provider(request);
    await expect(
      assembly.provider.certify({
        request,
        task_policies: assembly.task_policies,
        evidence_sink: assembly.evidence_sink,
      }),
    ).rejects.toThrow('fixture-plan-captured');
    const plan = provenPlan;
    if (plan === undefined) throw new Error('protected prerequisite plan missing');
    const entry = plan.packages.find((item) => item.id === 'utils');
    if (entry === undefined) throw new Error('protected prerequisite package missing');
    expect(entry?.prerequisite_nodes).toEqual([producer.nodeId]);
    expect(entry?.reuse.unresolved).not.toContain('prerequisite-output-proof-required');
    const provenRunner = (
      entry.expected.inputProjection['bindings'] as Record<string, Record<string, unknown>>
    )['runner'];
    expect(provenRunner?.['memberCount']).toBe(unprovedRunner['memberCount']);
    expect(provenRunner?.['populationDigest']).not.toBe(unprovedRunner['populationDigest']);
    expect(captureReleaseMutationInputExecutionContext(plan).prerequisite_outputs).toEqual([
      {
        path: generatedPath,
        mode: '100644',
        size: outputBytes.length,
        sha256: digest(outputBytes),
        producer_task_node: producer.nodeId,
      },
    ]);
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
