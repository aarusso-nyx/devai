// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020; ADR-SCR-0015 IA-004.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { runWithResolvedSensorMember } from '../../src/authority/sensor-member.js';
import { resolveSenseSelection } from '../../src/commands/sense/facade.js';
import {
  executeSensorTask,
  matchDeclaredSensorTaskProcess,
  resolveSensorTaskBinding,
  type SensorTaskBinding,
} from '../../src/commands/sense/task-binding.js';
import { resolveTaskBoundSenseSelection } from '../../src/commands/sense/task-selection.js';
import { runCheckTasks } from '../../src/services/check-runner/runner.js';

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
  const root = mkdtempSync(join(tmpdir(), 'devai-task-bound-'));
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
  const requests: AuthorityHostEffectRequest[] = [];
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
      if (request.kind === 'process' && request.arguments[0] === bound.task.executable.path) {
        requests.push(request);
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
        return { status: exit, stdout: output, stderr: '', signal: null };
      }
      return apply();
    },
  };
  try {
    const reading = runWithAuthorityHostEffects(scope, () =>
      runWithResolvedSensorMember(bound.kind, () => executeSensorTask(bound)),
    );
    return { reading, starts, requests };
  } finally {
    issuer.dispose();
  }
}

describe('exact reviewed sensor task binding', () => {
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
});
