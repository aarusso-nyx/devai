// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020; ADR-SCR-0015 IA-004.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { canonicalJson } from '@devai-nyx/utils';
import { appendRecord, initChain } from '../../../evidence/src/evidence/chain.js';
import {
  senseHarnessInvariantAlignment,
  buildSensorReading,
  type SensorReading,
} from '@devai-nyx/sensors';
import { computeHarnessInvariantAlignment } from '../../../sensors/src/harness-invariant-alignment.js';
import {
  declaredInvariantProducerStanding,
  senseDeclaredHarnessInvariantAlignment,
} from '../../src/commands/sense/declared-invariant-producers.js';
import { afterEach, aroundEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { runWithResolvedSensorMember } from '../../src/authority/sensor-member.js';
import { resolveSenseSelection } from '../../src/commands/sense/facade.js';
import {
  executeSensorTask,
  attestNativeTaskExecution,
  matchDeclaredSensorTaskProcess,
  resolveSensorTaskBinding,
  type SensorTaskBinding,
} from '../../src/commands/sense/task-binding.js';
import { resolveTaskBoundSenseSelection } from '../../src/commands/sense/task-selection.js';
import { nativeInputPreloadPath } from '../../src/commands/sense/native-runner-selection.js';
import { inspectNativeInputProvenance } from '../../src/commands/sense/native-input-provenance.js';
import { resolveSensorReadingInstance } from '../../src/commands/sense/reading-instance.js';
import { runCheckTasks } from '../../src/services/check-runner/runner.js';
import {
  isHarnessMutatedPath,
  RELEASE_INPUT_PROJECTION,
  trackedPaths,
} from '../../src/services/check-runner/policy-git.js';
import { installNativeVitest } from '../fixtures/native-test-results/native-runner-fixture.js';

const roots: string[] = [];
const ENV = 'DEVAI_INSPECTOR_TASK_CONTEXT';
const originalEnv = process.env[ENV];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env.DEVAI_INSPECTOR_TASK_CONTEXT;
  else process.env[ENV] = originalEnv;
});
function put(root: string, path: string, value: unknown): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}
function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  ).trim();
}
function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'fixture-1',
    repositoryId: 'fixture',
    fallbackNodeId: 'measure',
    dynamicFallbackSelectors: [],
    profiles: [],
    tasks: [
      {
        nodeId: 'measure',
        sensorKinds: ['type_check', 'unit_test', 'perf_test', 'build', 'migration_check'],
        dependencies: [],
        cwd: '.',
        runner: 'exec-v1',
        argv: ['measure'],
        inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
        toolchainKeys: [],
        allowlistedEnv: [ENV],
        outputContract: { population: 'reviewed-population' },
        ...overrides,
      },
    ],
  };
}
function fixture(overrides: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-task-bound-')));
  roots.push(root);
  put(root, '.gitignore', 'node_modules/\n.devai/state/\n');
  put(root, 'src/input.txt', 'measured input\n');
  put(root, 'test-tasks.json', descriptor(overrides));
  put(root, 'node_modules/.bin/measure', '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'node_modules/.bin/measure'), 0o755);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}
function addPrerequisite(doc: ReturnType<typeof descriptor>): void {
  const selected = doc.tasks[0];
  if (selected === undefined) throw new Error('Fixture selected node missing');
  doc.tasks.push({ ...selected, nodeId: 'prepare', dependencies: [] });
}
function binding(root: string, kind = 'type_check') {
  const result = resolveSensorTaskBinding(root, kind, {
    taskId: 'measure',
    population: 'reviewed-population',
  });
  if (result === undefined) throw new Error('Fixture binding missing');
  return result;
}
function execute(bound: SensorTaskBinding, output = '', exit = 0, during?: () => void) {
  let starts = 0;
  let returnedStdout = output;
  const requests: AuthorityHostEffectRequest[] = [];
  const native = bound.nativeSelectionDigest !== undefined;
  const executable = native ? process.execPath : bound.task.executable.path;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'inspector-task',
    issuer_version: '1.0.0',
    invocation_id: 'task-binding-test',
    canonicalSha256: () => 'a'.repeat(64),
    randomId: () => 'task-receipt',
    now: () => new Date().toISOString(),
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'sense run',
    invocation_id: 'task-binding-test',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect(request, apply) {
      if (
        request.kind === 'process' &&
        request.symbol === 'spawnSync' &&
        request.arguments[0] === executable &&
        (!native ||
          (Array.isArray(request.arguments[1]) &&
            request.arguments[1][0] === bound.task.executable.path))
      ) {
        requests.push(request);
        expect(request.arguments[1]).toEqual(
          native
            ? [bound.task.executable.path, ...bound.task.argv.slice(1)]
            : bound.task.argv.slice(1),
        );
        expect(matchDeclaredSensorTaskProcess(bound.root, request)).toBe(bound);
        expect(
          matchDeclaredSensorTaskProcess(bound.root, {
            ...request,
            arguments: [
              request.arguments[0],
              [...(request.arguments[1] as string[]), '--extra'],
              request.arguments[2],
            ],
          }),
        ).toBeUndefined();
        expect(
          matchDeclaredSensorTaskProcess(bound.root, {
            ...request,
            arguments: [
              request.arguments[0],
              request.arguments[1],
              { ...(request.arguments[2] as object) },
            ],
          }),
        ).toBeUndefined();
        starts += 1;
        during?.();
        const processOptions = request.arguments[2] as { env?: Record<string, string> };
        let actualNativeStdout: string | undefined;
        if (native) {
          // Generate provenance with the real pinned runner, at this exact bound root and nonce.
          // The broker still controls the returned result to exercise hostile result populations.
          actualNativeStdout = execFileSync(process.execPath, request.arguments[1] as string[], {
            ...processOptions,
            cwd: bound.root,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
          });
        }
        const nonce = processOptions.env?.['DEVAI_NATIVE_COLLECTION_NONCE'];
        let stdout =
          nonce === undefined ? output : output.replaceAll('fixture-capture-nonce', nonce);
        if (actualNativeStdout !== undefined) {
          try {
            const actual = JSON.parse(actualNativeStdout) as {
              devaiCollection: { runtimeOutputRoots: string[] };
            };
            const controlled = JSON.parse(stdout) as {
              devaiCollection?: { runtimeOutputRoots?: string[] };
            };
            if (controlled.devaiCollection !== undefined) {
              // Forward only genuine same-execution output roots; hostile result mutations remain.
              controlled.devaiCollection.runtimeOutputRoots =
                actual.devaiCollection.runtimeOutputRoots;
              stdout = JSON.stringify(controlled);
            }
          } catch {
            // Deliberately truncated/non-JSON result evidence must remain malformed.
          }
        }
        returnedStdout = stdout;
        return { status: exit, stdout, stderr: '', signal: null };
      }
      return apply();
    },
  };
  try {
    const reading = runWithAuthorityHostEffects(scope, () =>
      runWithResolvedSensorMember(bound.kind, () => executeSensorTask(bound)),
    );
    return { reading, starts, requests, stdout: returnedStdout };
  } finally {
    issuer.dispose();
  }
}

function nativeContract() {
  const requiredTestIds = [
    ['tests/one.test.ts', 'adds'],
    ['tests/two.test.ts', 'multiplies'],
  ]
    .map(
      ([file, title]) =>
        `test:v1:${encodeURIComponent(JSON.stringify(['audit-fixture', file, ['arithmetic'], title]))}`,
    )
    .sort();
  return {
    schemaVersion: '1.0.0',
    format: 'vitest-json',
    selectionEvidence: {
      kind: 'devai-native-collection',
      reporter: 'vitest-v1',
      projectName: 'audit-fixture',
    },
    projectId: 'audit-fixture',
    transport: { kind: 'direct' },
    executableFiles: ['tests/one.test.ts', 'tests/two.test.ts'],
    requiredTestIds,
  };
}
function nativeFixture(contract: ReturnType<typeof nativeContract>, defaultVite = false): string {
  const repositoryRoot = resolve(import.meta.dirname, '../../../..');
  const root = fixture({
    argv: [
      'vitest',
      'run',
      '--configLoader',
      'native',
      '--config',
      './vitest.config.mjs',
      '--reporter',
      '@aarusso-nyx/devai/native-vitest-reporter',
      '--no-cache',
    ],
    inputSelectors: [{ kind: 'glob', pattern: '**/*' }],
    outputContract: {
      kind: 'command-result',
      population: 'reviewed-population',
      resultPopulation: contract,
    },
  });
  put(root, 'package.json', {
    private: true,
    type: 'module',
    devDependencies: {
      vitest: '4.1.11',
      vite: '7.3.6',
      '@aarusso-nyx/devai': JSON.parse(
        readFileSync(join(repositoryRoot, 'packages/cli/package.json'), 'utf8'),
      )['version'],
    },
  });
  put(
    root,
    'vitest.config.mjs',
    "export default {test:{name:'audit-fixture',include:['tests/**/*.test.ts'],pool:'forks',maxWorkers:1,watch:false,coverage:{enabled:false}}};\n",
  );
  mkdirSync(join(root, 'node_modules/@aarusso-nyx'), { recursive: true });
  installNativeVitest(repositoryRoot, root, { defaultVite });
  symlinkSync(
    join(repositoryRoot, 'packages/cli'),
    join(root, 'node_modules/@aarusso-nyx/devai'),
    'dir',
  );
  for (const [name, title] of [
    ['one', 'adds'],
    ['two', 'multiplies'],
  ]) {
    put(
      root,
      `tests/${name}.test.ts`,
      `import {describe,it,expect} from 'vitest'; describe('arithmetic',()=>{it('${title}',()=>expect(2+2).toBe(4));});\n`,
    );
  }
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'native selected files');
  return root;
}
function nativeOutput(root: string): string {
  return readFileSync(
    new URL('../fixtures/native-test-results/vitest-collection.json', import.meta.url),
    'utf8',
  ).replaceAll('/native-fixture', root);
}

describe('exact reviewed sensor task binding', () => {
  it('refuses an unimplemented service backend before resolving an absent host binary', () => {
    const root = fixture({
      argv: ['devai-inspector-deliberately-absent-native-runner'],
      sensorKinds: ['unit_test'],
      outputContract: {
        kind: 'command-result',
        population: 'reviewed-population',
        resultPopulation: {
          ...nativeContract(),
          serviceProfile: {
            schemaVersion: '1.0.0',
            profile: 'postgres-http-v1',
            backendId: 'owned-linux-native-v1-linux-arm64',
            provisioner: { kind: 'owned-docker-v1', toolchainKey: 'docker' },
            postgres: { image: `postgres:16-alpine@sha256:${'a'.repeat(64)}` },
          },
        },
      },
    });
    expect(() =>
      statSync(join(root, 'node_modules/.bin/devai-inspector-deliberately-absent-native-runner')),
    ).toThrow();
    expect(() => binding(root, 'unit_test')).toThrow('SENSE_NATIVE_SERVICE_BACKEND_UNIMPLEMENTED');
  });
  it('binds exact task/policy/candidate/population and always measures the selected node', () => {
    const root = fixture();
    const bound = binding(root);
    expect(bound.task.cacheState).toBe('execute');
    const first = execute(bound);
    const second = execute(bound);
    expect(first.starts).toBe(1);
    expect(second.starts).toBe(1);
    expect(first.reading.status).toBe('pass');
    expect(first.reading.metrics).toMatchObject({
      task_id: 'measure',
      population: 'reviewed-population',
      candidate_commit: git(root, 'rev-parse', 'HEAD'),
      descriptor_digest: bound.plan.descriptorDigest,
      task_policy_digest: bound.plan.taskPolicyDigest,
    });
  });
  it.each([
    ['unknown task', { taskId: 'missing', population: 'reviewed-population' }],
    ['population mismatch', { taskId: 'measure', population: 'other' }],
    [
      'added argv',
      { taskId: 'measure', population: 'reviewed-population', argv: ['measure', '--extra'] },
    ],
    [
      'forged member',
      { taskId: 'measure', population: 'reviewed-population', memberKind: 'type_check' },
    ],
  ])('refuses %s before execution', (_label, input) => {
    const root = fixture();
    expect(() => resolveSensorTaskBinding(root, 'type_check', input)).toThrow();
  });
  it('refuses missing and wrong sensor annotations', () => {
    for (const sensorKinds of [undefined, ['build']]) {
      const root = fixture({ sensorKinds });
      expect(() => binding(root)).toThrow('SENSE_TASK_KIND_MISMATCH');
    }
  });
  it('refuses a generated-output contract and an uncompleted prerequisite', () => {
    const generated = fixture({
      outputContract: { population: 'reviewed-population', generated_namespaces: [] },
    });
    expect(() => binding(generated)).toThrow('SENSE_TASK_DESCRIPTOR_INVALID');
    const root = fixture();
    const doc = descriptor({ dependencies: ['prepare'] });
    addPrerequisite(doc);
    put(root, 'test-tasks.json', doc);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'dependency');
    expect(() => binding(root)).toThrow('SENSE_TASK_PREREQUISITE_REQUIRED');
  });
  it('requires a current exact prerequisite receipt and executes only the selected node', () => {
    process.env[ENV] = 'before';
    const root = fixture();
    const doc = descriptor({ dependencies: ['prepare'] });
    addPrerequisite(doc);
    const complete = {
      ...doc,
      profiles: [{ profileId: 'rc', mode: 'fixed', requiredNodes: ['prepare'] }],
    };
    put(root, 'test-tasks.json', complete);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'dependency');
    const executed: string[] = [];
    const checked = runCheckTasks({
      repoRoot: root,
      target: 'rc',
      operation: 'run',
      toolchain: {},
      environment: { [ENV]: 'before' },
      executeTask(_argv, _cwd, _timeout, _env, identity) {
        executed.push(identity.nodeId);
        return { status: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    expect(checked.exitCode, JSON.stringify(checked)).toBe(0);
    expect(executed).toEqual(['prepare']);
    const bound = binding(root);
    expect(Object.keys(bound.prerequisiteDigests)).toEqual(['prepare']);
    expect(execute(bound).starts).toBe(1);
    expect(executed).toEqual(['prepare']);
    process.env[ENV] = 'after';
    expect(() => binding(root)).toThrow('SENSE_TASK_PREREQUISITE_REQUIRED');
  });
  it('derives authority-policy environment identity from exact policy bytes for prerequisite reconstruction', () => {
    const root = fixture();
    const doc = descriptor({
      dependencies: ['prepare'],
      allowlistedEnv: ['DEVAI_AUTHORITY_POLICY_SHA256'],
    });
    addPrerequisite(doc);
    put(root, 'test-tasks.json', {
      ...doc,
      profiles: [{ profileId: 'rc', mode: 'fixed', requiredNodes: ['prepare'] }],
    });
    const policyBytes = '{"fixture":"authority-policy"}';
    put(root, '.devai/config/authority-policy.json', policyBytes);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'authority binding');
    const checked = runCheckTasks({
      repoRoot: root,
      target: 'rc',
      operation: 'run',
      toolchain: {},
      environment: {},
      executeTask() {
        return { status: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    expect(checked.exitCode, JSON.stringify(checked)).toBe(0);
    expect(binding(root).environment['DEVAI_AUTHORITY_POLICY_SHA256']).toBe(
      createHash('sha256').update(policyBytes).digest('hex'),
    );
  });
  it('rejects forged binding objects and missing trusted member context', () => {
    const root = fixture();
    const bound = binding(root);
    expect(() => executeSensorTask({ ...bound })).toThrow('SENSE_TASK_BINDING_UNTRUSTED');
    expect(() => executeSensorTask(bound)).toThrow('SENSE_TASK_MEMBER_CONTEXT_REQUIRED');
    expect(() => runWithResolvedSensorMember('build', () => executeSensorTask(bound))).toThrow(
      'SENSE_TASK_MEMBER_CONTEXT_REQUIRED',
    );
  });
  it.each([
    'descriptor',
    'input',
    'candidate',
    'declaration',
    'environment',
    'executable',
  ] as const)('rejects changed %s identity before the selected process starts', (field) => {
    process.env[ENV] = 'before';
    const root = fixture();
    const bound = binding(root);
    if (field === 'descriptor')
      put(root, 'test-tasks.json', descriptor({ argv: ['measure', '--changed'] }));
    if (field === 'input') put(root, 'src/input.txt', 'changed\n');
    if (field === 'candidate') {
      put(root, 'src/input.txt', 'changed\n');
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'next');
    }
    if (field === 'declaration')
      put(root, '.devai/config/sensor-inputs.json', { schemaVersion: '1.0.0', inputs: {} });
    if (field === 'environment') process.env[ENV] = 'after';
    if (field === 'executable') put(root, 'node_modules/.bin/measure', '#!/bin/sh\nexit 1\n');
    expect(() => execute(bound)).toThrow();
  });
  it.each([
    ['', 'unknown', undefined],
    ['Tests  3 passed (3)\n', 'pass', 3],
    ['Tests  1 failed | 2 passed (3)\n', 'fail', 2],
    ['{"numPassedTests":4,"numFailedTests":0,"numTotalTests":4,"success":true}', 'pass', 4],
    ['{"numPassedTests":-1,"numFailedTests":0}', 'unknown', undefined],
    ['Tests 3 passed (99)\n', 'unknown', undefined],
    ['Tests 3 passed |\n', 'unknown', undefined],
    [
      '{"numPassedTests":3,"numFailedTests":0,"numTotalTests":99,"success":false}',
      'unknown',
      undefined,
    ],
  ] as const)('uses measured test counts from %j', (output, status, passed) => {
    const root = fixture();
    const result = execute(binding(root, 'unit_test'), output);
    expect(result.reading.status).toBe(status);
    expect(result.reading.metrics?.['tests_passed']).toBe(passed);
  });
  it('does not treat a zero performance exit without metrics as measured PASS', () => {
    const root = fixture();
    expect(execute(binding(root, 'perf_test'), 'done').reading.status).toBe('unknown');
    expect(
      execute(binding(root, 'perf_test'), '{"p50_ms":2,"p95_ms":4}').reading.metrics,
    ).toMatchObject({ p50_ms: 2, p95_ms: 4 });
  });
  it.each([
    ['{"p50_ms":2,"p95_ms":-1}', 'unknown'],
    ['{"p50_ms":2,"p95_ms":"4"}', 'unknown'],
    ['{"unrelated":2}', 'unknown'],
    ['{"p50_ms":2}', 'pass'],
    ['{"p50_ms":2,"p95_ms":4,"throughput_rps":100}', 'pass'],
    ['{"p50_ms":2}\n{"p50_ms":', 'unknown'],
  ] as const)('validates the complete selected performance result %j', (output, status) => {
    const root = fixture();
    const result = execute(binding(root, 'perf_test'), output);
    expect(result.reading.status).toBe(status);
    if (status === 'unknown') expect(result.reading.metrics?.['p50_ms']).toBeUndefined();
  });
  it('binds native results to the exact task, candidate, selected files and raw streams', () => {
    const contract = nativeContract();
    const root = nativeFixture(contract);
    const bound = binding(root, 'unit_test');
    const output = nativeOutput(bound.root);
    const result = execute(bound, output);
    const options = result.requests[0]?.arguments[2] as { env?: Record<string, string> };
    const nonce = options.env?.['DEVAI_NATIVE_COLLECTION_NONCE'];
    expect(nonce).toMatch(/^[a-f0-9]{64}$/u);
    const contextPath = join(
      root,
      '.devai/state/native-config-traces',
      String(nonce),
      'adapter-context.json',
    );
    const contextBytes = readFileSync(contextPath);
    const context = JSON.parse(contextBytes.toString('utf8')) as {
      git: { path: string; sha256: string };
    };
    expect(context).toEqual({
      nonce,
      repository: root,
      candidate: git(root, 'rev-parse', 'HEAD'),
      packageDir: root,
      git: {
        path: realpathSync(context.git.path),
        sha256: createHash('sha256').update(readFileSync(context.git.path)).digest('hex'),
      },
      tracked: trackedPaths(root).filter((path) => !isHarnessMutatedPath(path)),
      excludedPrefixes: RELEASE_INPUT_PROJECTION.excludedPrefixes,
    });
    expect(statSync(contextPath).mode & 0o777).toBe(0o400);
    expect(statSync(contextPath).nlink).toBe(1);
    expect(options.env).toEqual({
      CI: '1',
      NO_COLOR: '1',
      ...bound.environment,
      NODE_V8_COVERAGE: '',
      DEVAI_NATIVE_ADAPTER_CONTEXT_SHA256: createHash('sha256').update(contextBytes).digest('hex'),
      DEVAI_NATIVE_COLLECTION_NONCE: nonce,
      DEVAI_NATIVE_INPUT_TRACE: join(
        root,
        '.devai/state/native-config-traces',
        String(nonce),
        'inputs.ndjson',
      ),
      DEVAI_NATIVE_INPUT_SCOPE: 'main',
      DEVAI_NATIVE_RUNNER: 'vitest-v1',
      DEVAI_NATIVE_RUNTIME_ROOT: join(
        root,
        '.devai/state/native-config-traces',
        String(nonce),
        'runtime',
      ),
      TMPDIR: join(root, '.devai/state/native-config-traces', String(nonce), 'runtime'),
      PWTEST_CACHE_DIR: join(
        root,
        '.devai/state/native-config-traces',
        String(nonce),
        'runtime/playwright',
      ),
      NODE_OPTIONS: `--import=${pathToFileURL(nativeInputPreloadPath()).href}`,
    });
    const measuredOutput = result.stdout;
    const effectiveCommand = canonicalJson({
      executable: realpathSync(process.execPath),
      argv: [bound.task.executable.path, ...bound.task.argv.slice(1)],
      outputRoot: null,
    });
    expect(result.reading.metrics?.native_effective_command).toBe(effectiveCommand);
    expect(result.reading.metrics?.native_effective_command_sha256).toBe(
      createHash('sha256').update(effectiveCommand).digest('hex'),
    );
    expect(result.reading.metrics?.native_stdout).toBe(measuredOutput);
    expect(result.starts).toBe(1);
    expect(result.reading.status).toBe('pass');
    expect(result.reading.metrics).toMatchObject({
      task_id: 'measure',
      population: 'reviewed-population',
      candidate_commit: git(root, 'rev-parse', 'HEAD'),
      candidate_tree: git(root, 'rev-parse', 'HEAD^{tree}'),
      task_key: bound.task.taskKey,
      input_digest: bound.task.inputDigest,
      descriptor_digest: bound.plan.descriptorDigest,
      task_policy_digest: bound.plan.taskPolicyDigest,
      tests_passed: 2,
      tests_failed: 0,
      stdout_sha256: createHash('sha256').update(measuredOutput).digest('hex'),
      stderr_sha256: createHash('sha256').update('').digest('hex'),
      native_plan_sha256: createHash('sha256').update(measuredOutput.trim()).digest('hex'),
      native_result_project: 'audit-fixture',
    });
    const native = JSON.parse(String(result.reading.metrics?.native_result_population)) as Record<
      string,
      unknown
    >;
    expect(native['testIds']).toEqual(contract.requiredTestIds);
    expect(native['executedTestIds']).toEqual(contract.requiredTestIds);
    expect(native['executableFiles']).toEqual(contract.executableFiles);
    expect(result.reading.metrics?.native_result_contract_sha256).toBe(
      createHash('sha256').update(canonicalJson(contract)).digest('hex'),
    );
  });

  it.runIf(process.platform === 'linux')(
    'replays genuine platform facts and refuses changed identity, custody, semantics and missing rechecks',
    () => {
      const root = nativeFixture(nativeContract());
      const bound = binding(root, 'unit_test');
      const result = execute(bound, nativeOutput(root));
      expect(result.reading.status, JSON.stringify(result.reading.findings)).toBe('pass');
      const raw = String(result.reading.metrics?.native_input_trace);
      const rows = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const nonce = String(rows[0]?.['nonce']);
      const index = rows.findIndex((row) => row['kind'] === 'framework-platform-probe');
      expect(index).toBeGreaterThan(0);
      const rowAt = (values: Record<string, unknown>[]) => {
        const row = values[index];
        if (row === undefined) throw new Error('Authentic platform fact missing');
        return row;
      };
      const fact = rowAt(rows);
      expect(fact['path']).toBe('/proc/version');
      const recheckIndex = rows.findIndex(
        (row) =>
          row['kind'] === 'framework-platform-probe-recheck' &&
          row['scope'] === fact['scope'] &&
          row['probeId'] === fact['probeId'],
      );
      expect(recheckIndex).toBeGreaterThan(index);
      const inspect = (values: Record<string, unknown>[]) =>
        inspectNativeInputProvenance(
          root,
          nonce,
          values.map((row) => JSON.stringify(row)).join('\n'),
          result.stdout,
          bound.task,
        );
      expect(inspect(rows)).toEqual([]);
      for (const [field, value] of [
        ['api', 'readFile'],
        ['encoding', 'utf-8'],
        ['path', '/etc/passwd'],
        ['arch', 'other'],
        ['platform', 'darwin'],
        ['osRelease', 'changed'],
        ['pid', -1],
        ['probeId', 0],
      ] as const) {
        const changed = structuredClone(rows);
        rowAt(changed)[field] = value;
        expect(inspect(changed), field).not.toEqual([]);
      }
      for (const [field, value] of [
        ['packageName', 'lookalike'],
        ['packageVersion', '0.0.0'],
        ['sha256', '0'.repeat(64)],
        ['sourceSha256', '0'.repeat(64)],
        ['scriptId', '0'],
        ['line', 1],
        ['column', 1],
        ['file', '/tmp/lookalike.js'],
      ] as const) {
        const changed = structuredClone(rows);
        (rowAt(changed)['caller'] as Record<string, unknown>)[field] = value;
        expect(inspect(changed), field).not.toEqual([]);
      }
      for (const [field, value] of [
        ['sha256', '0'.repeat(64)],
        ['rawSha256', '0'.repeat(64)],
        ['realpath', '/tmp/version'],
        ['semantics', { includesMicrosoft: true }],
      ] as const) {
        const changed = structuredClone(rows);
        (rowAt(changed)['observation'] as Record<string, unknown>)[field] = value;
        expect(inspect(changed), field).toEqual(['NATIVE_PLATFORM_PROBE_CHANGED']);
      }
      const missing = structuredClone(rows);
      missing.splice(recheckIndex, 1);
      expect(inspect(missing)).toEqual(['NATIVE_PLATFORM_RECHECK_MISSING']);
      const orphan = structuredClone(rows);
      orphan.splice(index, 1);
      expect(inspect(orphan)).toEqual(['NATIVE_PLATFORM_RECHECK_INVALID']);
      const duplicate = structuredClone(rows);
      duplicate.splice(index, 0, structuredClone(fact));
      expect(inspect(duplicate)).toEqual(['NATIVE_PLATFORM_PROBE_DUPLICATE']);
      const wrongScope = structuredClone(rows);
      rowAt(wrongScope)['scope'] = 'unregistered';
      expect(inspect(wrongScope)).not.toEqual([]);
      const afterSeal = structuredClone(rows);
      afterSeal.push(structuredClone(fact));
      expect(inspect(afterSeal)).toEqual(['NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID']);
    },
  );

  it.runIf(process.platform === 'linux').each(['/proc/version', '/etc/os-release', '/usr/bin/ldd'])(
    'refuses actual candidate reads of %s despite genuine framework facts in the same run',
    (path) => {
      const root = nativeFixture(nativeContract());
      const source = readFileSync(join(root, 'tests/one.test.ts'), 'utf8');
      put(
        root,
        'tests/one.test.ts',
        `import {readFileSync} from 'node:fs';\n${source}\nreadFileSync(${JSON.stringify(path)},'utf8');\n`,
      );
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'candidate platform read witness');
      const result = execute(binding(root, 'unit_test'), nativeOutput(root));
      expect(result.reading.status).toBe('unknown');
      expect(result.reading.metrics?.tests_passed).toBeUndefined();
      expect(result.reading.findings).toContainEqual(
        expect.objectContaining({ code: `NATIVE_INPUT_EXTERNAL_PATH:${path}` }),
      );
    },
  );

  it('refuses candidate host-file reads through an imported private platform helper', () => {
    const root = nativeFixture(nativeContract());
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'devai candidate outside ç ')));
    roots.push(outside);
    const path = join(outside, 'fixture-input.txt');
    writeFileSync(path, 'owned test bytes');
    const helper = join(dirname(nativeInputPreloadPath()), 'native-platform-probes.js');
    const source = readFileSync(join(root, 'tests/one.test.ts'), 'utf8');
    put(
      root,
      'tests/one.test.ts',
      `
import {readFileSync} from 'node:fs';
import {nativePlatformProbeObservation,frameworkPlatformProbeCallers} from ${JSON.stringify(pathToFileURL(helper).href)};
${source}
const caller={...frameworkPlatformProbeCallers[0],path:${JSON.stringify(path)}};
try {nativePlatformProbeObservation(caller);} catch {}
const bytes=readFileSync(${JSON.stringify(path)});
nativePlatformProbeObservation(caller,{platform:'linux',osRelease:'6'},${JSON.stringify(path)},bytes);
`,
    );
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'candidate private helper read witness');
    const result = execute(binding(root, 'unit_test'), nativeOutput(root));
    expect(result.reading.status).toBe('unknown');
    expect(result.reading.metrics?.tests_passed).toBeUndefined();
    expect(result.reading.findings).toContainEqual(
      expect.objectContaining({ code: `NATIVE_INPUT_EXTERNAL_PATH:${path}` }),
    );
  });

  it.each(['authored-counts', 'truncated', 'cached'] as const)(
    'refuses %s as native same-run execution evidence',
    (mode) => {
      const root = nativeFixture(nativeContract());
      const output =
        mode === 'authored-counts'
          ? '{"passed":2,"failed":0}'
          : mode === 'truncated'
            ? nativeOutput(root).slice(0, -15)
            : `cache hit, replaying logs\n${nativeOutput(root)}`;
      const result = execute(binding(root, 'unit_test'), output);
      expect(result.starts).toBe(1);
      expect(result.reading.status).toBe('unknown');
      expect(result.reading.metrics?.tests_passed).toBeUndefined();
    },
  );

  it.each([
    ['BASE_URL', '/forged/'],
    ['MODE', 'forged-mode'],
    ['DEV', false],
    ['PROD', true],
    ['FORCE_TTY', 'true'],
  ])(
    'refuses reporter environment evidence that disagrees with the actual worker: %s',
    (key, value) => {
      const root = nativeFixture(nativeContract());
      const output = JSON.parse(nativeOutput(root)) as {
        devaiCollection: { resolvedSelection: Record<string, unknown>[] };
      };
      const selected = output.devaiCollection.resolvedSelection[0];
      if (selected === undefined) throw new Error('Authentic collection has no selected project');
      if (key === 'FORCE_TTY') selected['forceTTY'] = value;
      else
        selected['viteEnvironment'] = {
          ...(selected['viteEnvironment'] as object),
          [String(key)]: value,
        };
      const result = execute(binding(root, 'unit_test'), JSON.stringify(output));
      expect(result.reading.status).toBe('unknown');
      expect(result.reading.metrics?.tests_passed).toBeUndefined();
      expect(result.reading.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'NATIVE_INPUT_RUNTIME_ENVIRONMENT_CHANGED' }),
        ]),
      );
    },
  );

  it('refuses a bare configuration module name before native execution', () => {
    const root = nativeFixture(nativeContract());
    const document = JSON.parse(readFileSync(join(root, 'test-tasks.json'), 'utf8')) as {
      tasks: { argv: string[] }[];
    };
    const task = document.tasks[0];
    if (task === undefined) throw new Error('Fixture task missing');
    task.argv[task.argv.indexOf('--config') + 1] = 'vitest.config.mjs';
    put(root, 'test-tasks.json', document);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'unsupported bare native configuration path');
    expect(() => binding(root, 'unit_test')).toThrow('SENSE_NATIVE_CONFIG_PATH_REQUIRED');
  });

  it('refuses the default Vite8 runner as unmeasured rather than granting Vite7 provenance', () => {
    const root = nativeFixture(nativeContract(), true);
    expect(() => binding(root, 'unit_test')).toThrow('SENSE_NATIVE_VITE_VERSION_UNSUPPORTED');
  });

  it.each([
    ['const selected = Date.now();', 'SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED'],
    ['const selected = Math.random();', 'SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED'],
    [
      'const { random: choose } = Math; choose();',
      'SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED',
    ],
    [
      "await fetch('https://example.invalid/selection');",
      'SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED',
    ],
    ["import net from 'node:net';", 'SENSE_NATIVE_CONFIG_CAPABILITY_UNSUPPORTED'],
    ["Reflect.get(globalThis, 'Date');", 'SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED'],
    [
      "const choose = (() => {})['constructor'];",
      'SENSE_NATIVE_CONFIG_COMPUTED_CAPABILITY_UNSUPPORTED',
    ],
    [
      "const moduleName = './selector.mjs'; await import(moduleName);",
      'SENSE_NATIVE_CONFIG_COMPUTED_IMPORT_UNSUPPORTED',
    ],
  ])('refuses ambient or computed native configuration selection %s', (selection, code) => {
    const root = nativeFixture(nativeContract());
    const config = readFileSync(join(root, 'vitest.config.mjs'), 'utf8');
    put(root, 'vitest.config.mjs', `${selection}\n${config}`);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'unsupported native configuration selection');
    expect(() => binding(root, 'unit_test')).toThrow(code);
  });

  it.each([
    [
      "const ts = require('typescript'); ts.sys.getMemoryUsage();",
      'SENSE_NATIVE_CONFIG_TYPESCRIPT_CAPABILITY_UNSUPPORTED',
    ],
    [
      "const ts = await import('typescript'); ts.sys.getMemoryUsage();",
      'SENSE_NATIVE_CONFIG_TYPESCRIPT_CAPABILITY_UNSUPPORTED',
    ],
    ["export { sys } from 'typescript';", 'SENSE_NATIVE_CONFIG_TYPESCRIPT_CAPABILITY_UNSUPPORTED'],
    ["export * from 'typescript';", 'SENSE_NATIVE_CONFIG_TYPESCRIPT_CAPABILITY_UNSUPPORTED'],
    [
      "import compiler from 'typescript'; compiler.sys.getMemoryUsage();",
      'SENSE_NATIVE_CONFIG_TYPESCRIPT_CAPABILITY_UNSUPPORTED',
    ],
    [
      'const clock = new Intl.DateTimeFormat(); clock.format();',
      'SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED',
    ],
  ])('refuses untraced compiler or locale-clock acquisition %s', (selection, code) => {
    const root = nativeFixture(nativeContract());
    const config = readFileSync(join(root, 'vitest.config.mjs'), 'utf8');
    put(root, 'vitest.config.mjs', `${selection}\n${config}`);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'unsupported compiler or locale clock');
    expect(() => binding(root, 'unit_test')).toThrow(code);
  });

  it.each([
    "import compiler from 'typescript'; compiler.createSourceFile('fixture.ts', 'export {};', compiler.ScriptTarget.Latest, true);",
    "import * as compiler from 'typescript'; compiler.createSourceFile('fixture.ts', 'export {};', compiler.ScriptTarget.Latest, true);",
    "import {createSourceFile as parse, ScriptTarget} from 'typescript'; parse('fixture.ts', 'export {};', ScriptTarget.Latest, true);",
  ])('preserves reviewed static compiler AST imports %s', (selection) => {
    const root = nativeFixture(nativeContract());
    const repositoryRoot = resolve(import.meta.dirname, '../../../..');
    const installed = join(repositoryRoot, 'node_modules/typescript');
    symlinkSync(installed, join(root, 'node_modules/typescript'), 'dir');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    manifest.devDependencies['typescript'] = JSON.parse(
      readFileSync(join(installed, 'package.json'), 'utf8'),
    )['version'];
    put(root, 'package.json', manifest);
    const config = readFileSync(join(root, 'vitest.config.mjs'), 'utf8');
    put(root, 'vitest.config.mjs', `${selection}\n${config}`);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'reviewed static compiler AST configuration');
    expect(binding(root, 'unit_test').nativeSelectionDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    'const environment = process.env;',
    "Object.assign(process.env, {MODE:'forged'});",
    "Object.defineProperty(process.env, 'MODE', {value:'forged'});",
    'delete process.env.MODE;',
    "process.env.MODE = 'forged';",
    "(process.env.MODE) += 'forged';",
    'process.env.MODE++;',
    '++process.env.MODE;',
    "({MODE:process.env.MODE} = {MODE:'forged'});",
  ])('refuses native configuration environment aliasing or mutation %s', (selection) => {
    const root = nativeFixture(nativeContract());
    const config = readFileSync(join(root, 'vitest.config.mjs'), 'utf8');
    put(root, 'vitest.config.mjs', `${selection}\n${config}`);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'unsupported native environment mutation');
    expect(() => binding(root, 'unit_test')).toThrow(
      'SENSE_NATIVE_CONFIG_ENVIRONMENT_MUTATION_UNSUPPORTED',
    );
  });

  it.each(['const mode = process.env.MODE;', "const mode = process.env['MODE'];"])(
    'preserves direct reads from the closed native environment %s',
    (selection) => {
      const root = nativeFixture(nativeContract());
      const config = readFileSync(join(root, 'vitest.config.mjs'), 'utf8');
      put(root, 'vitest.config.mjs', `${selection}\n${config}`);
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'closed native environment read');
      expect(binding(root, 'unit_test').nativeSelectionDigest).toMatch(/^[a-f0-9]{64}$/u);
    },
  );

  it('follows tracked configuration helpers before admitting native selection', () => {
    const root = nativeFixture(nativeContract());
    const config = readFileSync(join(root, 'vitest.config.mjs'), 'utf8');
    put(root, 'selector.mjs', 'export const selected = Date.now();\n');
    put(root, 'vitest.config.mjs', `import './selector.mjs';\n${config}`);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'ambient selection in configuration helper');
    expect(() => binding(root, 'unit_test')).toThrow(
      'SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED',
    );
  });

  it('withholds credit when the same-run collection includes a file omitted from the declaration', () => {
    const contract = nativeContract();
    const root = nativeFixture({ ...contract, executableFiles: ['tests/one.test.ts'] });
    const result = execute(binding(root, 'unit_test'), nativeOutput(root));
    expect(result.starts).toBe(1);
    expect(result.reading.status).toBe('unknown');
    expect(result.reading.metrics?.tests_passed).toBeUndefined();
  });

  it('withholds credit when collection and final results disagree about an additional executable', () => {
    const root = nativeFixture(nativeContract());
    put(root, 'tests/third.wiring-spec.ts', "it('third', () => {});\n");
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'third executable');
    const output = JSON.parse(nativeOutput(root)) as {
      devaiCollection: { plannedFiles: string[] };
    };
    // Deliberately inconsistent negative evidence: the final capture remains two files.
    output.devaiCollection.plannedFiles.push(join(root, 'tests/third.wiring-spec.ts'));
    const result = execute(binding(root, 'unit_test'), JSON.stringify(output));
    expect(result.starts).toBe(1);
    expect(result.reading.status).toBe('unknown');
    expect(result.reading.metrics?.tests_passed).toBeUndefined();
  });

  it('refuses a selected untracked executable file omitted from the complete declaration', () => {
    const root = nativeFixture(nativeContract());
    put(root, 'tests/untracked.e2e.ts', "it('untracked', () => {});\n");
    expect(() => binding(root, 'unit_test')).toThrow('SENSE_NATIVE_CANDIDATE_DIRTY');
  });

  it('does not emit PASS when a declared build artifact was not produced', () => {
    const root = fixture({
      outputContract: {
        kind: 'workspace-build',
        population: 'reviewed-population',
        paths: ['dist/artifact'],
      },
    });
    let status: string | undefined;
    try {
      status = execute(binding(root, 'build')).reading.status;
    } catch {
      status = 'refused';
    }
    expect(status).not.toBe('pass');
  });
  it.each(['input', 'candidate'] as const)(
    'refuses post-execution %s drift before producing old-candidate evidence',
    (field) => {
      const root = fixture();
      const bound = binding(root);
      let status: string | undefined;
      try {
        status = execute(bound, '', 0, () => {
          put(root, 'src/input.txt', 'changed by task\n');
          if (field === 'candidate') {
            git(root, 'add', '.');
            git(root, 'commit', '-qm', 'task advanced candidate');
          }
        }).reading.status;
      } catch {
        status = 'refused';
      }
      expect(status).not.toBe('pass');
    },
  );
  it('escalates kind execution to explicit local write and refuses read preset expansion', () => {
    const root = fixture();
    const inputs = new Map([
      ['type_check', { taskId: 'measure', population: 'reviewed-population' }],
    ]);
    const selected = resolveTaskBoundSenseSelection(
      resolveSenseSelection({ kind: 'type_check' }),
      root,
      inputs,
    );
    expect(selected.aggregate_effect).toBe('local-write');
    expect(selected.members[0]).toMatchObject({
      effect: 'local-write',
      consent: { write: true, publish: false },
      capabilities: expect.arrayContaining(['fs:workspace', 'proc:declared-sensor-task']),
    });
    expect(() =>
      resolveTaskBoundSenseSelection(
        resolveSenseSelection({ preset: 'sweep' }, { roundId: 'R-0001' }),
        root,
        inputs,
      ),
    ).toThrow('SENSE_TASK_PRESET_REFUSED');
    const migration = resolveTaskBoundSenseSelection(
      resolveSenseSelection({ kind: 'migration_check' }),
      root,
      new Map([['migration_check', { taskId: 'measure', population: 'reviewed-population' }]]),
    );
    expect(migration.members[0]?.capabilities).toContain('db:write');
  });

  it.each(['build', 'type_check', 'perf_test'] as const)(
    'grants check-cache state only to the exact task-bound %s member',
    (kind) => {
      const root = fixture();
      const unbound = resolveTaskBoundSenseSelection(
        resolveSenseSelection({ kind }),
        root,
        new Map(),
      );
      expect(unbound.members[0]?.capabilities).not.toContain('fs:f5-state');

      const selected = resolveTaskBoundSenseSelection(
        resolveSenseSelection({ kind }),
        root,
        new Map([[kind, { taskId: 'measure', population: 'reviewed-population' }]]),
      );
      expect(selected.aggregate_effect).toBe('local-write');
      expect(selected.members[0]).toMatchObject({
        effect: 'local-write',
        consent: { write: true, publish: false },
        capabilities: expect.arrayContaining([
          'fs:workspace',
          'fs:f5-state',
          'proc:declared-sensor-task',
        ]),
      });
      expect(selected.members[0]?.capabilities).not.toContain('fs:proofs');

      // This executes the exact descriptor argv once. The shared host seam also
      // tests that one extra process argument cannot match the trusted binding.
      expect(execute(binding(root, kind)).starts).toBe(1);
      expect(() =>
        runWithResolvedSensorMember('lint', () => executeSensorTask(binding(root, kind))),
      ).toThrow('SENSE_TASK_MEMBER_CONTEXT_REQUIRED');
    },
  );

  it('resolves pre-authority task references without probing toolchains or prerequisite caches', () => {
    const root = fixture();
    const doc = descriptor({ dependencies: ['prepare'], toolchainKeys: ['pnpm', 'git'] });
    addPrerequisite(doc);
    put(root, 'test-tasks.json', doc);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'toolchain prerequisites');
    const processes: AuthorityHostEffectRequest[] = [];
    const issuer = createAuthorityDecisionIssuer({
      issuer_id: 'inspector-reference-only',
      issuer_version: '1.0.0',
      invocation_id: 'reference-only',
      canonicalSha256: () => 'a'.repeat(64),
      randomId: () => 'reference-only',
      now: () => new Date().toISOString(),
      receipt_ttl_ms: 30_000,
    });
    const scope: AuthorityHostEffectScope = {
      action_id: 'sense run',
      invocation_id: 'reference-only',
      effect: 'read',
      receipt_store: issuer,
      apply_effect(request, apply) {
        if (request.kind === 'process') {
          processes.push(request);
          throw new Error('INSPECTOR_REFERENCE_MUST_NOT_SPAWN');
        }
        return apply();
      },
    };
    const selected = runWithAuthorityHostEffects(scope, () =>
      resolveTaskBoundSenseSelection(
        resolveSenseSelection({ kind: 'type_check' }),
        root,
        new Map([['type_check', { taskId: 'measure', population: 'reviewed-population' }]]),
      ),
    );
    expect(selected.aggregate_effect).toBe('local-write');
    expect(selected.members[0]?.capabilities).toContain('proc:declared-sensor-task');
    expect(processes).toEqual([]);
    expect(existsSync(join(root, '.devai/state'))).toBe(false);
    expect(() => binding(root)).toThrow('SENSE_TASK_PREREQUISITE_REQUIRED');
  });

  it.each([
    ['valid', undefined],
    ['extra argv', 'SENSE_NATIVE_SELECTION_UNSUPPORTED'],
    ['ambient config', 'SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED'],
  ] as const)(
    'validates pre-authority native %s references without process effects',
    (variant, code) => {
      const root = fixture({
        argv: [
          'devai-inspector-deliberately-absent-native-runner',
          'run',
          '--configLoader',
          'native',
          '--config',
          './vitest.config.mjs',
          '--reporter',
          '@aarusso-nyx/devai/native-vitest-reporter',
          ...(variant === 'extra argv' ? ['--testNamePattern', 'selected'] : []),
        ],
        outputContract: {
          kind: 'command-result',
          population: 'reviewed-population',
          resultPopulation: nativeContract(),
        },
      });
      put(
        root,
        'vitest.config.mjs',
        `${variant === 'ambient config' ? 'const selected = Date.now();\n' : ''}export default {test:{watch:false}};\n`,
      );
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'static native reference');
      const processes: AuthorityHostEffectRequest[] = [];
      const issuer = createAuthorityDecisionIssuer({
        issuer_id: 'inspector-native-reference-only',
        issuer_version: '1.0.0',
        invocation_id: 'native-reference-only',
        canonicalSha256: () => 'a'.repeat(64),
        randomId: () => 'native-reference-only',
        now: () => new Date().toISOString(),
        receipt_ttl_ms: 30_000,
      });
      const scope: AuthorityHostEffectScope = {
        action_id: 'sense run',
        invocation_id: 'native-reference-only',
        effect: 'read',
        receipt_store: issuer,
        apply_effect(request, apply) {
          if (request.kind === 'process') {
            processes.push(request);
            throw new Error('INSPECTOR_NATIVE_REFERENCE_MUST_NOT_SPAWN');
          }
          return apply();
        },
      };
      const select = () =>
        runWithAuthorityHostEffects(scope, () =>
          resolveTaskBoundSenseSelection(
            resolveSenseSelection({ kind: 'unit_test' }),
            root,
            new Map([['unit_test', { taskId: 'measure', population: 'reviewed-population' }]]),
          ),
        );
      try {
        if (code === undefined) {
          const selected = select();
          expect(selected.aggregate_effect).toBe('local-write');
          expect(selected.members[0]?.capabilities).toEqual(
            expect.arrayContaining(['proc:declared-sensor-task', 'fs:proofs', 'fs:f5-state']),
          );
          expect(selected.members[0]?.consent).toEqual({ write: true, publish: false });
        } else expect(select).toThrow(code);
        expect(processes).toEqual([]);
        expect(existsSync(join(root, '.devai/state'))).toBe(false);
      } finally {
        issuer.dispose();
      }
    },
  );

  it.each(
    ['owned-linux-native-v1-linux-amd64', 'owned-linux-native-v1-linux-arm64'].flatMap(
      (backendId) =>
        [true, false].flatMap((validRunMode) =>
          [true, false].flatMap((extraArgv) =>
            [true, false].map((ambientConfig) => ({
              backendId,
              validRunMode,
              extraArgv,
              ambientConfig,
            })),
          ),
        ),
    ),
  )(
    'refuses service $backendId before native guards (run=$validRunMode, extra=$extraArgv, ambient=$ambientConfig) without effects',
    ({ backendId, validRunMode, extraArgv, ambientConfig }) => {
      const root = fixture({
        argv: [
          'devai-inspector-deliberately-absent-native-runner',
          validRunMode ? 'run' : 'watch',
          '--configLoader',
          'native',
          '--config',
          './vitest.config.mjs',
          '--reporter',
          '@aarusso-nyx/devai/native-vitest-reporter',
          ...(extraArgv ? ['--testNamePattern', 'selected'] : []),
        ],
        sensorKinds: ['unit_test'],
        toolchainKeys: ['pnpm', 'git'],
        outputContract: {
          kind: 'command-result',
          population: 'reviewed-population',
          resultPopulation: {
            ...nativeContract(),
            serviceProfile: {
              schemaVersion: '1.0.0',
              profile: 'postgres-http-v1',
              backendId,
              provisioner: { kind: 'owned-docker-v1', toolchainKey: 'docker' },
              postgres: { image: `postgres:16-alpine@sha256:${'a'.repeat(64)}` },
            },
          },
        },
      });
      put(
        root,
        'vitest.config.mjs',
        `${ambientConfig ? 'const selected = Date.now();\n' : ''}export default {test:{watch:false}};\n`,
      );
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'service refusal precedence');
      expect(
        existsSync(
          join(root, 'node_modules/.bin/devai-inspector-deliberately-absent-native-runner'),
        ),
      ).toBe(false);
      const processes: AuthorityHostEffectRequest[] = [];
      const issuer = createAuthorityDecisionIssuer({
        issuer_id: 'inspector-service-reference-only',
        issuer_version: '1.0.0',
        invocation_id: 'service-reference-only',
        canonicalSha256: () => 'a'.repeat(64),
        randomId: () => 'service-reference-only',
        now: () => new Date().toISOString(),
        receipt_ttl_ms: 30_000,
      });
      const scope: AuthorityHostEffectScope = {
        action_id: 'sense run',
        invocation_id: 'service-reference-only',
        effect: 'read',
        receipt_store: issuer,
        apply_effect(request, apply) {
          if (request.kind === 'process') {
            processes.push(request);
            throw new Error('INSPECTOR_SERVICE_REFERENCE_MUST_NOT_SPAWN');
          }
          return apply();
        },
      };
      try {
        expect(() =>
          runWithAuthorityHostEffects(scope, () =>
            resolveTaskBoundSenseSelection(
              resolveSenseSelection({ kind: 'unit_test' }),
              root,
              new Map([['unit_test', { taskId: 'measure', population: 'reviewed-population' }]]),
            ),
          ),
        ).toThrow('SENSE_NATIVE_SERVICE_BACKEND_UNIMPLEMENTED');
        expect(processes).toEqual([]);
        expect(existsSync(join(root, '.devai/state'))).toBe(false);
      } finally {
        issuer.dispose();
      }
    },
  );

  it.each([
    ['kind', 'SENSE_TASK_KIND_MISMATCH'],
    ['population', 'SENSE_TASK_POPULATION_MISMATCH'],
    ['command', 'SENSE_TASK_DESCRIPTOR_INVALID'],
  ] as const)('refuses invalid pre-authority %s references', (invalid, code) => {
    const root = fixture(
      invalid === 'kind' ? { sensorKinds: ['build'] } : invalid === 'command' ? { argv: [] } : {},
    );
    expect(() =>
      resolveTaskBoundSenseSelection(
        resolveSenseSelection({ kind: 'type_check' }),
        root,
        new Map([
          [
            'type_check',
            {
              taskId: 'measure',
              population: invalid === 'population' ? 'wrong-population' : 'reviewed-population',
            },
          ],
        ]),
      ),
    ).toThrow(code);
  });
});

interface Obligation {
  invariant_id: string;
  subject: string;
  taskId: string;
  population: string;
  requiredTestIds: string[];
}
function obligations(): Obligation[] {
  return nativeContract().requiredTestIds.map((testId, index) => ({
    invariant_id: 'INV-ADOPTER-001',
    subject: `scope-${index + 1}`,
    taskId: 'measure',
    population: 'reviewed-population',
    requiredTestIds: [testId],
  }));
}
function bindObligations(root: string, bindings: Obligation[]): void {
  const target = '.devai/config/invariant-producers.json';
  const source = 'law/adopter-policy.json';
  const projection = { schemaVersion: '1.0.0', bindings };
  const policy = {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.invariant-producers',
    policy_version: '1.0.0',
    invariant_producers: projection,
  };
  put(root, source, policy);
  put(root, target, projection);
  const digest = (path: string) =>
    createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex');
  put(root, '.devai/config/adopter-policy-binding.json', {
    schemaVersion: '1.0.0',
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    source_path: source,
    source_digest_sha256: digest(source),
    materialized: { [target]: digest(target) },
  });
}
function obligationFixture(bindings = obligations(), allMode = false): string {
  const root = nativeFixture(nativeContract());
  put(root, '.gitignore', 'node_modules/\n.devai/state/\nrecord/proofs/\n');
  put(root, 'law/invariants/INV-ADOPTER-001.json', {
    id: 'INV-ADOPTER-001',
    severity: 'gate',
    measurable_via: ['check --only integrity'],
    measurable_via_mode: allMode ? 'all' : 'any',
  });
  put(
    root,
    '.github/workflows/ci.yml',
    'jobs:\n  verify:\n    steps:\n      - run: vitest run --configLoader native --config ./vitest.config.mjs --reporter @aarusso-nyx/devai/native-vitest-reporter --no-cache\n      - run: devai check --only integrity\n',
  );
  bindObligations(root, bindings);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'reviewed obligations');
  initChain(join(root, 'record/proofs/chain.json'));
  return root;
}
function persistObligationReading(
  root: string,
  mutate?: (reading: SensorReading) => SensorReading,
  receiptHead?: string,
  receiptTime?: string,
): SensorReading {
  const bound = binding(root, 'unit_test');
  const observed = execute(bound, nativeOutput(bound.root)).reading;
  const instance = resolveSensorReadingInstance(root, observed);
  const reading = mutate?.(instance) ?? instance;
  const facts = ({ id: _id, supersedes: _supersedes, ...body }: SensorReading) =>
    canonicalJson(body);
  // Only an actual internally minted measurement may receive execution origin.
  if (facts(observed) === facts(reading)) attestNativeTaskExecution(root, observed, reading);
  recordObligationReading(root, reading, receiptHead, receiptTime);
  return reading;
}
function recordObligationReading(
  root: string,
  reading: SensorReading,
  receiptHead?: string,
  receiptTime?: string,
): void {
  const path = `.devai/state/sensor-readings/unit_test/${reading.id}.json`;
  const chainPath = join(root, 'record/proofs/chain.json');
  const previous = JSON.parse(readFileSync(chainPath, 'utf8')) as { records: unknown[] };
  put(root, path, `${JSON.stringify(reading, null, 2)}\n`);
  appendRecord(join(root, 'record/proofs/chain.json'), {
    id: `EV-${(previous.records.length + 1).toString(16).padStart(16, '0')}`,
    timestamp: receiptTime ?? new Date().toISOString(),
    actor: 'inspector',
    actor_role: 'agent:inspector',
    action: 'sense.readings.record',
    status: 'completed',
    context: {
      repo_root: root,
      git: { head_sha: receiptHead ?? git(root, 'rev-parse', 'HEAD'), dirty_files: [] },
    },
    artifacts: [
      {
        path,
        sha256: createHash('sha256')
          .update(readFileSync(join(root, path)))
          .digest('hex'),
      },
    ],
  });
}
function freshInstance(reading: SensorReading, supersedes?: string): SensorReading {
  const identity = buildSensorReading({
    sensorName: reading.sensor.name,
    sensorKind: reading.sensor.kind,
    command: reading.command.split(' '),
    status: reading.status,
    deterministic: reading.deterministic,
    forceUniqueId: true,
    timestamp: new Date().toISOString(),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(reading.metrics === undefined ? {} : { metrics: reading.metrics }),
    ...(reading.exit_code === undefined ? {} : { exit_code: reading.exit_code }),
  });
  return { ...reading, id: identity.id, ...(supersedes === undefined ? {} : { supersedes }) };
}
function alignObligations(root: string) {
  return senseDeclaredHarnessInvariantAlignment({
    repoRoot: root,
    candidateHead: git(root, 'rev-parse', 'HEAD'),
    now: new Date().toISOString(),
  });
}

describe('exact declared invariant subject execution standing', () => {
  it('refuses an invented final instance identity before issuing execution origin', () => {
    const root = obligationFixture();
    const observed = execute(binding(root, 'unit_test'), nativeOutput(root)).reading;
    const instance = resolveSensorReadingInstance(root, observed);
    const before = readFileSync(join(root, 'record/proofs/chain.json'), 'utf8');
    expect(() => attestNativeTaskExecution(root, observed, freshInstance(instance))).toThrow(
      /SENSE_NATIVE_EXECUTION_(INSTANCE|ORIGIN)/u,
    );
    expect(readFileSync(join(root, 'record/proofs/chain.json'), 'utf8')).toBe(before);
  });

  it('cannot issue a second origin for an invented instance from the same native execution', () => {
    const root = obligationFixture();
    const observed = execute(binding(root, 'unit_test'), nativeOutput(root)).reading;
    const instance = resolveSensorReadingInstance(root, observed);
    attestNativeTaskExecution(root, observed, instance);
    const before = readFileSync(join(root, 'record/proofs/chain.json'), 'utf8');
    expect(() => attestNativeTaskExecution(root, observed, freshInstance(instance))).toThrow(
      /SENSE_NATIVE_EXECUTION_(INSTANCE|ORIGIN)/u,
    );
    expect(readFileSync(join(root, 'record/proofs/chain.json'), 'utf8')).toBe(before);
    recordObligationReading(root, instance);
    expect(alignObligations(root).status).toBe('pass');
  });

  it('refuses a cloned native reading as an execution origin even with coherent raw output and nonce', () => {
    const root = obligationFixture();
    const observed = execute(binding(root, 'unit_test'), nativeOutput(root)).reading;
    const authored = structuredClone(observed);
    expect(authored.metrics?.native_collection_nonce).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => attestNativeTaskExecution(root, authored, authored)).toThrow(
      'SENSE_NATIVE_EXECUTION_ORIGIN_UNTRUSTED',
    );
    recordObligationReading(root, authored);
    expect(declaredInvariantProducerStanding(root).map((row) => row.passed)).toEqual([
      false,
      false,
    ]);
    expect(alignObligations(root).status).toBe('review');
  });

  it('refuses altered final measurement facts before minting any execution origin', () => {
    const root = obligationFixture();
    const observed = execute(binding(root, 'unit_test'), nativeOutput(root)).reading;
    const changed = { ...observed, metrics: { ...observed.metrics, tests_passed: 999 } };
    expect(() => attestNativeTaskExecution(root, observed, changed)).toThrow(
      'SENSE_NATIVE_EXECUTION_INSTANCE_CHANGED',
    );
    recordObligationReading(root, changed);
    expect(declaredInvariantProducerStanding(root).every((row) => !row.passed)).toBe(true);
  });

  it.each(['missing', 'forged-tuple', 'forged-digest'] as const)(
    'refuses %s effective execution command before issuing native origin',
    (mode) => {
      const root = obligationFixture();
      const measured = execute(binding(root, 'unit_test'), nativeOutput(root)).reading;
      expect(measured.status).toBe('pass');
      const metrics = { ...measured.metrics };
      if (mode === 'missing') delete metrics['native_effective_command'];
      if (mode === 'forged-digest') metrics['native_effective_command_sha256'] = 'f'.repeat(64);
      if (mode === 'forged-tuple') {
        const command = JSON.parse(String(metrics['native_effective_command']));
        command.argv.push('--output', '/outside');
        metrics['native_effective_command'] = canonicalJson(command);
        metrics['native_effective_command_sha256'] = createHash('sha256')
          .update(String(metrics['native_effective_command']))
          .digest('hex');
      }
      const before = readFileSync(join(root, 'record/proofs/chain.json'));
      expect(() => attestNativeTaskExecution(root, measured, { ...measured, metrics })).toThrow(
        'SENSE_NATIVE_EXECUTION_INSTANCE_CHANGED',
      );
      expect(readFileSync(join(root, 'record/proofs/chain.json'))).toEqual(before);
      const instance = resolveSensorReadingInstance(root, measured);
      attestNativeTaskExecution(root, measured, instance);
      recordObligationReading(root, instance);
      expect(alignObligations(root).status).toBe('pass');
    },
    // Real pinned native execution plus origin/standing replay exceeded 30s under gate load.
    // Bound only these fixture cases; the native task keeps its separate 600s execution limit.
    60_000,
  );

  it.each(['fail', 'unknown'] as const)(
    'refuses an in-place mutation of an actual %s measurement into PASS',
    (status) => {
      const root = obligationFixture();
      const bound = binding(root, 'unit_test');
      const observed =
        status === 'fail'
          ? execute(bound, nativeOutput(root), 1).reading
          : execute(bound, '{"passed":2,"failed":0}').reading;
      expect(observed.status).toBe(status);
      Object.assign(observed, { status: 'pass', exit_code: 0 });
      Object.assign(observed.metrics ?? {}, { tests_passed: 2, tests_failed: 0 });
      expect(() => attestNativeTaskExecution(root, observed, observed)).toThrow(
        'SENSE_NATIVE_EXECUTION_INSTANCE_CHANGED',
      );
      recordObligationReading(root, observed);
      expect(declaredInvariantProducerStanding(root).every((row) => !row.passed)).toBe(true);
    },
  );

  it('requires both exact subjects and complete chain-bound native task results', () => {
    const root = obligationFixture();
    persistObligationReading(root);
    const standing = declaredInvariantProducerStanding(root);
    expect(standing).toHaveLength(2);
    expect(standing.map((row) => row.passed)).toEqual([true, true]);
    expect(alignObligations(root).status).toBe('pass');
    expect(
      computeHarnessInvariantAlignment(
        { repoRoot: root, candidateHead: git(root, 'rev-parse', 'HEAD') },
        standing.slice(0, 1),
      ).status,
    ).toBe('review');
  });

  it('cannot replace a declared subject with generic successful action evidence or another subject', () => {
    const root = obligationFixture();
    persistObligationReading(root);
    const standing = declaredInvariantProducerStanding(root).map((row) => ({
      ...row,
      subject: 'wrong-subject',
    }));
    const forgedOptions = {
      repoRoot: root,
      candidateHead: git(root, 'rev-parse', 'HEAD'),
      declaredProducerStanding: standing,
      observations: [
        {
          command: 'devai check --only integrity',
          status: 'pass' as const,
          candidate_sha: git(root, 'rev-parse', 'HEAD'),
          completed_at: new Date().toISOString(),
        },
      ],
    };
    expect(senseHarnessInvariantAlignment(forgedOptions).status).toBe('review');
  });

  it.each([
    ['unknown-invariant', 'INVARIANT_PRODUCER_OBLIGATION_INVALID'],
    ['wrong-task', 'INVARIANT_PRODUCER_TASK_MISMATCH'],
    ['wrong-population', 'INVARIANT_PRODUCER_TASK_MISMATCH'],
    ['wrong-result-id', 'INVARIANT_PRODUCER_RESULT_IDS_MISMATCH'],
    ['duplicate-subject', 'INVARIANT_PRODUCER_OBLIGATION_INVALID'],
  ])('refuses %s declarations before credit', (mode, error) => {
    const rows = obligations();
    const [first, second] = rows;
    if (first === undefined || second === undefined)
      throw new Error('Obligation fixture incomplete');
    if (mode === 'unknown-invariant') first.invariant_id = 'INV-UNKNOWN-001';
    if (mode === 'wrong-task') first.taskId = 'absent';
    if (mode === 'wrong-population') first.population = 'wrong';
    if (mode === 'wrong-result-id') first.requiredTestIds = ['test:v1:absent'];
    if (mode === 'duplicate-subject') second.subject = first.subject;
    const root = obligationFixture(rows);
    expect(() => declaredInvariantProducerStanding(root)).toThrow(error);
  });

  it.each(['receipt-candidate', 'reading-candidate', 'task', 'failed', 'incomplete-ids'] as const)(
    'refuses %s custody mismatch',
    (mode) => {
      const root = obligationFixture();
      persistObligationReading(
        root,
        (reading) => {
          const metrics = { ...reading.metrics };
          if (mode === 'reading-candidate') metrics['candidate_commit'] = 'f'.repeat(40);
          if (mode === 'task') metrics['task_id'] = 'another-kind-task';
          if (mode === 'incomplete-ids') {
            const native = JSON.parse(String(metrics['native_result_population'])) as Record<
              string,
              unknown
            >;
            native['executedTestIds'] = [];
            metrics['native_result_population'] = canonicalJson(native);
          }
          return {
            ...reading,
            metrics,
            ...(mode === 'failed' ? ({ status: 'fail', exit_code: 1 } as const) : {}),
          };
        },
        mode === 'receipt-candidate' ? 'f'.repeat(40) : undefined,
      );
      expect(declaredInvariantProducerStanding(root).map((row) => row.passed)).toEqual([
        false,
        false,
      ]);
      expect(alignObligations(root).status).toBe('review');
    },
  );

  it('refuses changed selected source inputs after recorded execution', () => {
    const root = obligationFixture();
    persistObligationReading(root);
    put(root, 'tests/one.test.ts', "it('changed', () => {});\n");
    expect(declaredInvariantProducerStanding(root).every((row) => !row.passed)).toBe(true);
  });

  it('refuses a forged chain manifest', () => {
    const root = obligationFixture();
    persistObligationReading(root);
    const path = 'record/proofs/chain.json';
    const chain = JSON.parse(readFileSync(join(root, path), 'utf8')) as { head: string };
    chain.head = 'f'.repeat(64);
    put(root, path, chain);
    expect(() => declaredInvariantProducerStanding(root)).toThrow(
      'INVARIANT_PRODUCER_CHAIN_INVALID',
    );
  });

  it('refuses stale reading and custody timestamps', () => {
    const root = obligationFixture();
    const stale = new Date(Date.now() - 2 * 86_400_000).toISOString();
    persistObligationReading(
      root,
      (reading) => ({ ...reading, timestamp: stale }),
      undefined,
      stale,
    );
    expect(declaredInvariantProducerStanding(root).every((row) => !row.passed)).toBe(true);
  });

  it('does not refresh an old execution by recording its immutable reading again', () => {
    const root = obligationFixture();
    const observed = persistObligationReading(root);
    expect(alignObligations(root).status).toBe('pass');
    const future = Date.now() + 2 * 86_400_000;
    recordObligationReading(root, observed, undefined, new Date(future).toISOString());
    const clock = vi.spyOn(Date, 'now').mockReturnValue(future);
    try {
      expect(declaredInvariantProducerStanding(root).every((row) => !row.passed)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['swallowed', 'wrong-directory', 'conditional'] as const)(
    'refuses %s CI execution',
    (mode) => {
      const root = obligationFixture();
      const step =
        mode === 'swallowed'
          ? '      - run: vitest run --configLoader native --config ./vitest.config.mjs --reporter @aarusso-nyx/devai/native-vitest-reporter --no-cache || true'
          : mode === 'wrong-directory'
            ? '      - working-directory: other\n        run: vitest run --configLoader native --config ./vitest.config.mjs --reporter @aarusso-nyx/devai/native-vitest-reporter --no-cache'
            : '      - if: false\n        run: vitest run --configLoader native --config ./vitest.config.mjs --reporter @aarusso-nyx/devai/native-vitest-reporter --no-cache';
      put(root, '.github/workflows/ci.yml', `jobs:\n  verify:\n    steps:\n${step}\n`);
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'different CI invocation');
      persistObligationReading(root);
      expect(alignObligations(root).status).toBe('review');
    },
  );

  it('refuses deletion of an owned producer projection instead of re-enabling generic fallback', () => {
    const root = obligationFixture();
    persistObligationReading(root);
    rmSync(join(root, '.devai/config/invariant-producers.json'));
    let status: string;
    try {
      const reading = senseDeclaredHarnessInvariantAlignment({
        repoRoot: root,
        candidateHead: git(root, 'rev-parse', 'HEAD'),
        observations: [
          {
            command: 'devai check --only integrity',
            status: 'pass',
            candidate_sha: git(root, 'rev-parse', 'HEAD'),
            completed_at: new Date().toISOString(),
          },
        ],
      });
      status = reading.status;
    } catch {
      status = 'refused';
    }
    expect(status).not.toBe('pass');
  });

  it('refuses forged passing native metrics when captured output bytes disagree', () => {
    const root = obligationFixture();
    persistObligationReading(root, (reading) => ({
      ...reading,
      out_head: 'not a native result',
      err_head: 'forged stream',
      metrics: { ...reading.metrics, stdout_sha256: 'a'.repeat(64), stderr_sha256: 'b'.repeat(64) },
    }));
    expect(declaredInvariantProducerStanding(root).every((row) => !row.passed)).toBe(true);
  });

  it('refuses two recorded unsuperseded task instances instead of choosing the newest timestamp', () => {
    const root = obligationFixture();
    // Both genuine executions finish while the store is empty; neither can see a predecessor.
    // The trusted process broker returns an earlier failed exit and a later
    // successful exit, yielding distinct genuine minted measurement bodies.
    const first = execute(binding(root, 'unit_test'), nativeOutput(root), 1).reading;
    attestNativeTaskExecution(root, first, resolveSensorReadingInstance(root, first));
    const second = execute(binding(root, 'unit_test'), nativeOutput(root)).reading;
    attestNativeTaskExecution(root, second, resolveSensorReadingInstance(root, second));
    expect(second.id).not.toBe(first.id);
    expect(first.status).toBe('fail');
    expect(second.status).toBe('pass');
    expect(first.supersedes).toBeUndefined();
    expect(second.supersedes).toBeUndefined();
    recordObligationReading(root, first);
    recordObligationReading(root, second);
    expect(() => declaredInvariantProducerStanding(root)).toThrow(
      'INVARIANT_PRODUCER_AMBIGUOUS:unit_test',
    );
  });

  it('accepts an explicitly superseding native instance without mutating predecessor bytes', () => {
    const root = obligationFixture();
    const first = persistObligationReading(root);
    const predecessorPath = join(root, `.devai/state/sensor-readings/unit_test/${first.id}.json`);
    const original = readFileSync(predecessorPath);
    const second = persistObligationReading(root);
    expect(second.supersedes).toBe(first.id);
    expect(readFileSync(predecessorPath)).toEqual(original);
    expect(alignObligations(root).status).toBe('pass');
  });

  it('does not let annotation order choose a different compatible kind over recorded execution', () => {
    const root = obligationFixture();
    const tasks = descriptor({
      sensorKinds: ['integration_test', 'unit_test'],
      argv: [
        'vitest',
        'run',
        '--configLoader',
        'native',
        '--config',
        './vitest.config.mjs',
        '--reporter',
        '@aarusso-nyx/devai/native-vitest-reporter',
        '--no-cache',
      ],
      inputSelectors: [{ kind: 'glob', pattern: '**/*' }],
      outputContract: {
        kind: 'command-result',
        population: 'reviewed-population',
        resultPopulation: nativeContract(),
      },
    });
    put(root, 'test-tasks.json', tasks);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'compatible kind annotations');
    persistObligationReading(root);
    expect(alignObligations(root).status).toBe('pass');
  });

  it('does not credit CI loader environment omitted from the declared task execution', () => {
    const root = obligationFixture();
    put(
      root,
      '.github/workflows/ci.yml',
      'jobs:\n  verify:\n    steps:\n      - env:\n          NODE_OPTIONS: --require ./injected.cjs\n        run: vitest run --configLoader native --config ./vitest.config.mjs --reporter @aarusso-nyx/devai/native-vitest-reporter --no-cache\n',
    );
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'CI loader selection');
    persistObligationReading(root);
    expect(alignObligations(root).status).toBe('review');
  });

  it('preserves all-mode generic action obligations in addition to both declared subjects', () => {
    const root = obligationFixture(obligations(), true);
    persistObligationReading(root);
    expect(alignObligations(root).status).toBe('review');
    const reading = senseDeclaredHarnessInvariantAlignment({
      repoRoot: root,
      candidateHead: git(root, 'rev-parse', 'HEAD'),
      observations: [
        {
          command: 'devai check --only integrity',
          status: 'pass',
          candidate_sha: git(root, 'rev-parse', 'HEAD'),
          completed_at: new Date().toISOString(),
        },
      ],
    });
    expect(reading.status).toBe('pass');
  });
});
