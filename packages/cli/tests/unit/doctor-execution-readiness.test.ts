// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017; ADR-CHK-0001 and ADR-SCR-0015.
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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import * as taskBinding from '../../src/commands/sense/task-binding.js';
import {
  checkAdopterExecutionReadiness,
  classifyExecutionReadinessFailure,
} from '../../src/commands/doctor-execution-readiness.js';

const roots: string[] = [];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function put(root: string, path: string, value: unknown): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Inspector',
      '-c',
      'user.email=inspector@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

function descriptor() {
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'readiness-fixture-1',
    repositoryId: 'readiness-fixture',
    fallbackNodeId: 'measure',
    dynamicFallbackSelectors: [],
    profiles: [],
    tasks: [
      {
        nodeId: 'measure',
        sensorKinds: ['type_check'],
        dependencies: [] as string[],
        cwd: '.',
        runner: 'exec-v1',
        argv: ['measure'],
        inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
        toolchainKeys: [],
        allowlistedEnv: [],
        outputContract: { population: 'original-population' },
      },
    ],
  };
}

function commit(root: string): void {
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
}

function firstTask(doc: ReturnType<typeof descriptor>) {
  const task = doc.tasks[0];
  if (task === undefined) throw new Error('Inspector fixture has no task');
  return task;
}

function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-readiness-space é-')));
  roots.push(root);
  put(root, '.gitignore', 'node_modules/\n.devai/state/\n');
  put(root, 'src/input.txt', 'original measured source\n');
  put(root, 'package.json', { name: 'readiness-fixture', version: '1.0.0', private: true });
  put(root, 'test-tasks.json', descriptor());
  put(root, '.devai/config/sensor-inputs.json', {
    schemaVersion: '1.0.0',
    inputs: { type_check: { taskId: 'measure', population: 'original-population' } },
  });
  // Any accidental sensor execution leaves a marker; prerequisite inspection must never run it.
  put(root, 'node_modules/.bin/measure', '#!/bin/sh\ntouch SHOULD_NOT_EXECUTE\nexit 0\n');
  chmodSync(join(root, 'node_modules/.bin/measure'), 0o755);
  git(root, 'init', '-q', '-b', 'main');
  commit(root);
  return root;
}

function info(root: string) {
  const check = checkAdopterExecutionReadiness(root);
  return {
    check,
    data: check.info as {
      status: string;
      standing: string;
      identity?: {
        candidate: { commit: string; tree: string; clean: boolean };
        runtime: { version: string; platform: string; arch: string; executableSha256: string };
      };
      bindings: Array<{
        sensorKind: string;
        taskId: string;
        population: string;
        status: string;
        reasonCode: string;
        failureClass?: string;
        remediation?: string;
        taskKey?: string;
      }>;
    },
  };
}

describe('actual declared adopter execution prerequisites', () => {
  it('does not mistake a coverage population selector for an executable task reference', () => {
    const root = fixture();
    put(root, '.devai/config/sensor-inputs.json', {
      schemaVersion: '1.0.0',
      inputs: {
        type_check: { taskId: 'measure', population: 'original-population' },
        test_coverage_depth: { coveragePath: 'coverage/coverage-final.json', population: 'rc' },
      },
    });
    commit(root);
    const { check, data } = info(root);
    expect(check.ok).toBe(true);
    expect(data.bindings).toHaveLength(1);
    expect(data.bindings[0]?.sensorKind).toBe('type_check');
    expect(existsSync(join(root, 'SHOULD_NOT_EXECUTE'))).toBe(false);
  });

  it('plans a declared task without executing it, writing evidence, or changing Git state', () => {
    const root = fixture();
    const before = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
    const { check, data } = info(root);
    expect(check.name).toBe('adopter-execution-readiness');
    expect(check.ok).toBe(true);
    expect(data).toMatchObject({ status: 'pass', standing: 'diagnostic-only' });
    // The same annotation and explicit declaration are one exact binding, not duplicate work.
    expect(data.bindings).toHaveLength(1);
    expect(data.bindings[0]).toMatchObject({
      sensorKind: 'type_check',
      taskId: 'measure',
      population: 'original-population',
      status: 'pass',
    });
    expect(data.bindings[0]?.taskKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(existsSync(join(root, 'SHOULD_NOT_EXECUTE'))).toBe(false);
    expect(existsSync(join(root, '.devai/state'))).toBe(false);
    expect(git(root, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(before);
  });

  it('reports the actual candidate and executing Node bytes rather than a version-only identity', () => {
    const root = fixture();
    const { data } = info(root);
    expect(data.identity).toMatchObject({
      candidate: {
        commit: git(root, 'rev-parse', 'HEAD'),
        tree: git(root, 'rev-parse', 'HEAD^{tree}'),
        clean: true,
      },
      runtime: {
        version: process.version,
        platform: process.platform,
        arch: process.arch,
        executableSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
      },
    });
  });

  it('inspects descriptor annotations even when no sensor-inputs override exists', () => {
    const root = fixture();
    rmSync(join(root, '.devai/config/sensor-inputs.json'));
    commit(root);
    const { check, data } = info(root);
    expect(check.ok).toBe(true);
    expect(data.status).toBe('pass');
    expect(data.bindings).toContainEqual(
      expect.objectContaining({ taskId: 'measure', status: 'pass' }),
    );
  });

  it('validates the whole declaration rather than ignoring malformed sibling inputs', () => {
    const root = fixture();
    put(root, '.devai/config/sensor-inputs.json', {
      schemaVersion: '1.0.0',
      inputs: {
        type_check: { taskId: 'measure', population: 'original-population' },
        not_a_registered_sensor: {},
      },
    });
    commit(root);
    const { check, data } = info(root);
    expect(check.ok).toBe(false);
    expect(data.status).toBe('fail');
  });

  it('preserves the installed schema support for declared plant surfaces', () => {
    const root = fixture();
    put(root, '.devai/config/sensor-inputs.json', {
      schemaVersion: '1.0.0',
      inputs: { type_check: { taskId: 'measure', population: 'original-population' } },
      surfaces: { http: false, database: false, rbac: false, actions: false },
    });
    commit(root);
    expect(info(root).check.ok).toBe(true);
  });

  it('refuses an escaping declaration symlink before exposing its foreign contents', () => {
    const root = fixture();
    const foreign = realpathSync(mkdtempSync(join(tmpdir(), 'devai-readiness-foreign-')));
    roots.push(foreign);
    put(foreign, 'declaration.json', {
      schemaVersion: '1.0.0',
      inputs: { type_check: { taskId: 'measure', population: 'FOREIGN_CONTENT_MUST_NOT_BE_READ' } },
    });
    rmSync(join(root, '.devai/config/sensor-inputs.json'));
    symlinkSync(join(foreign, 'declaration.json'), join(root, '.devai/config/sensor-inputs.json'));
    const { check, data } = info(root);
    expect(check.ok).toBe(false);
    expect(data.status).toBe('fail');
    expect(JSON.stringify(check)).not.toContain('FOREIGN_CONTENT_MUST_NOT_BE_READ');
  });

  it('reconstructs candidate and task identities after actual source changes', () => {
    const root = fixture();
    const first = info(root).data;
    put(root, 'src/input.txt', 'changed measured source\n');
    commit(root);
    const second = info(root).data;
    expect(second.identity?.candidate.commit).not.toBe(first.identity?.candidate.commit);
    expect(second.identity?.candidate.tree).not.toBe(first.identity?.candidate.tree);
    expect(second.bindings[0]?.taskKey).not.toBe(first.bindings[0]?.taskKey);
  });

  it('refuses a report if the real candidate advances during prerequisite planning', () => {
    const root = fixture();
    const original = taskBinding.resolveSensorTaskDeclaration;
    const spy = vi
      .spyOn(taskBinding, 'resolveSensorTaskDeclaration')
      .mockImplementationOnce((...args) => {
        put(root, 'src/input.txt', 'candidate advanced during planning\n');
        commit(root);
        return original(...args);
      });
    try {
      const { check, data } = info(root);
      expect(check.ok).toBe(false);
      expect(data.status).toBe('fail');
      expect(JSON.stringify(check)).toContain('evidence-mismatch');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not turn missing sensor annotations into successful native readiness', () => {
    const root = fixture();
    const doc = descriptor();
    Reflect.deleteProperty(firstTask(doc), 'sensorKinds');
    put(root, 'test-tasks.json', doc);
    commit(root);
    const { check, data } = info(root);
    expect(check.ok).toBe(false);
    expect(data.status).toBe('fail');
    expect(data.bindings).toContainEqual(expect.objectContaining({ status: 'fail' }));
  });

  it('retains mismatched explicit populations as failures alongside valid annotated bindings', () => {
    const root = fixture();
    put(root, '.devai/config/sensor-inputs.json', {
      schemaVersion: '1.0.0',
      inputs: { type_check: { taskId: 'measure', population: 'wrong-population' } },
    });
    commit(root);
    const { check, data } = info(root);
    expect(check.ok).toBe(false);
    expect(data.bindings).toContainEqual(
      expect.objectContaining({
        population: 'wrong-population',
        status: 'fail',
        reasonCode: 'SENSE_TASK_POPULATION_MISMATCH',
      }),
    );
    expect(data.bindings).toContainEqual(
      expect.objectContaining({ population: 'original-population', status: 'pass' }),
    );
  });

  it('reports absent installed executables as blocked preparation with a specific remediation', () => {
    const root = fixture();
    rmSync(join(root, 'node_modules/.bin/measure'));
    const { check, data } = info(root);
    expect(check.ok).toBe(false);
    expect(data.status, JSON.stringify(data)).toBe('blocked');
    expect(data.bindings[0]).toMatchObject({
      status: 'blocked',
      failureClass: 'environment-drift',
    });
    expect(data.bindings[0]?.remediation).toMatch(/install|executable|dependencies/iu);
  });

  it('validates declarations before prerequisite evidence exists while runtime still refuses execution', () => {
    const root = fixture();
    const doc = descriptor();
    const task = firstTask(doc);
    task.dependencies = ['prepare'];
    const preparation = { ...task, nodeId: 'prepare', dependencies: [], sensorKinds: [] };
    doc.tasks.push(preparation);
    // Omit the annotation on the preparation node, as required by the closed schema.
    Reflect.deleteProperty(preparation, 'sensorKinds');
    put(root, 'test-tasks.json', doc);
    commit(root);
    const { check, data } = info(root);
    expect(check.ok).toBe(true);
    expect(data).toMatchObject({ status: 'pass', standing: 'diagnostic-only' });
    expect(data.bindings).toContainEqual(
      expect.objectContaining({
        taskId: 'measure',
        status: 'pass',
        reasonCode: 'ADOPTER_TASK_PLAN_READY',
        readinessScope: 'declaration-plan',
      }),
    );
    expect(() =>
      taskBinding.resolveSensorTaskBinding(root, 'type_check', {
        taskId: 'measure',
        population: 'original-population',
      }),
    ).toThrow('SENSE_TASK_PREREQUISITE_REQUIRED');
    expect(existsSync(join(root, 'SHOULD_NOT_EXECUTE'))).toBe(false);
    expect(existsSync(join(root, '.devai/state'))).toBe(false);
  });

  it.each(['kind', 'population', 'command'] as const)(
    'still rejects an invalid %s declaration before any prerequisite receipt exists',
    (invalid) => {
      const root = fixture();
      const doc = descriptor();
      const task = firstTask(doc);
      task.dependencies = ['doctor'];
      const doctor = { ...task, nodeId: 'doctor', dependencies: [], sensorKinds: [] };
      Reflect.deleteProperty(doctor, 'sensorKinds');
      doc.tasks.push(doctor);
      if (invalid === 'kind') task.sensorKinds = ['build'];
      if (invalid === 'command') task.argv = [];
      if (invalid === 'population') {
        put(root, '.devai/config/sensor-inputs.json', {
          schemaVersion: '1.0.0',
          inputs: { type_check: { taskId: 'measure', population: 'wrong-population' } },
        });
      }
      put(root, 'test-tasks.json', doc);
      commit(root);

      const { check, data } = info(root);
      expect(check.ok).toBe(false);
      expect(data.status).toBe('fail');
      expect(existsSync(join(root, 'SHOULD_NOT_EXECUTE'))).toBe(false);
      expect(existsSync(join(root, '.devai/state'))).toBe(false);
    },
  );

  it('never promotes a declaration preview into a trusted execution binding', () => {
    const root = fixture();
    const declaration = taskBinding.resolveSensorTaskDeclaration(root, 'type_check', {
      taskId: 'measure',
      population: 'original-population',
    });
    expect(declaration).toBeDefined();
    if (declaration === undefined) throw new Error('Inspector declaration fixture missing');
    expect('prerequisiteDigests' in declaration).toBe(false);
    expect(() =>
      taskBinding.executeSensorTask({ ...declaration, prerequisiteDigests: {} }),
    ).toThrow('SENSE_TASK_BINDING_UNTRUSTED');
    expect(existsSync(join(root, 'SHOULD_NOT_EXECUTE'))).toBe(false);
    expect(existsSync(join(root, '.devai/state'))).toBe(false);
  });

  it('reports absent declarations as not-required with no claim of execution standing', () => {
    const root = fixture();
    rmSync(join(root, '.devai/config/sensor-inputs.json'));
    rmSync(join(root, 'test-tasks.json'));
    commit(root);
    const { check, data } = info(root);
    expect(check.ok).toBe(true);
    expect(data).toMatchObject({
      status: 'not-required',
      standing: 'diagnostic-only',
      bindings: [],
    });
  });

  it('fails closed on malformed declarations without throwing out of the doctor report', () => {
    const root = fixture();
    put(root, 'test-tasks.json', '{invalid-json');
    const { check, data } = info(root);
    expect(check.ok).toBe(false);
    expect(data.status).toBe('fail');
    expect(JSON.stringify(check)).not.toMatch(/"standing":"(?:native|executed|adopted)"/u);
  });
});

describe('actionable failure classification preserves refusal', () => {
  it.each([
    ['SENSE_TASK_KIND_MISMATCH', 'fail', 'policy-invalid'],
    ['SENSE_TASK_POPULATION_MISMATCH', 'fail', 'policy-invalid'],
    ['SENSE_NATIVE_INPUT_PACKAGE_UNRESOLVED:typescript', 'blocked', 'environment-drift'],
    ['SENSE_TASK_PREREQUISITE_REQUIRED', 'blocked', 'sensor-stale'],
    ['SENSE_NATIVE_CANDIDATE_DIRTY', 'fail', 'evidence-mismatch'],
    ['SENSE_NATIVE_SERVICE_BACKEND_UNIMPLEMENTED', 'blocked', 'unknown'],
    ['SENSE_NATIVE_REPORTER_REQUIRED', 'fail', 'policy-invalid'],
    ['INTERNAL_MISSING_REFERENCE', 'fail', 'unknown'],
    ['UNEXPECTED_INTERNAL_FAILURE', 'fail', 'unknown'],
  ])('%s preserves %s and %s', (code, status, failureClass) => {
    const result = classifyExecutionReadinessFailure(code);
    expect(result).toMatchObject({ status, failureClass });
    expect(result.remediation.length).toBeGreaterThan(12);
    expect(result.remediation).not.toMatch(/no-sandbox|privileged|disable.*(?:guard|check)/iu);
  });
});
