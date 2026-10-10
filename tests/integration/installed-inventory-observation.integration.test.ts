// Invariants: INV-DEVAI-001, INV-DEVAI-002, INV-DEVAI-020; Constitution Article 41.
// Exercise only the assembled package file population, installed under node_modules.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ADOPTER_SOURCES,
  STATE_BODY,
} from '../../packages/cli/tests/unit/inventory-regeneration-adopter-fixture.js';
import { subprocessCoverageEnvironment } from '../helpers/subprocess-coverage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const PACKAGE = process.env['DEVAI_TEST_INSTALLED_PACKAGE'] ?? join(ROOT, 'packages/cli');
const workspaces: string[] = [];
let installation: string;
let binary: string;
type Json = Record<string, unknown>;

beforeAll(() => {
  installation = mkdtempSync(join(tmpdir(), 'devai-installed espaços-'));
  const installed = join(installation, 'node_modules/@aarusso-nyx/devai');
  mkdirSync(installed, { recursive: true });
  cpSync(join(PACKAGE, 'dist'), join(installed, 'dist'), { recursive: true });
  cpSync(join(PACKAGE, 'package.json'), join(installed, 'package.json'));
  binary = join(installed, 'dist/runtime/index/bin.js');
  expect(existsSync(binary)).toBe(true);
});

afterEach(() => {
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  if (installation !== undefined) rmSync(installation, { recursive: true, force: true });
});

function run(root: string, args: readonly string[]) {
  return spawnSync(process.execPath, [binary, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: subprocessCoverageEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
  });
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function put(root: string, path: string, body: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function repository(extra: Readonly<Record<string, string>> = {}, sensorInputs?: Json): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-adopter ação with spaces-'));
  workspaces.push(root);
  put(root, '.gitignore', '.devai/state/\nrecord/proofs/\n');
  for (const [path, body] of Object.entries(ADOPTER_SOURCES)) put(root, path, body);
  for (const [path, body] of Object.entries(extra)) put(root, path, body);
  for (const selector of ['--constitution', '--operational-law', '--subprocess-effects', null]) {
    const binding = run(root, [
      'init',
      'bind',
      ...(selector === null ? [] : [selector]),
      '--target',
      root,
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ]);
    expect(binding.status, binding.stderr || binding.stdout).toBe(0);
  }
  if (sensorInputs !== undefined) {
    put(
      root,
      'law/policy/adoption.json',
      JSON.stringify({
        schemaVersion: '1.0.0',
        policy_id: 'fixture.adoption',
        policy_version: '1.0.0',
        sensor_inputs: sensorInputs,
      }),
    );
    const binding = run(root, [
      'init',
      'bind',
      '--adopter-policy',
      'law/policy/adoption.json',
      '--target',
      root,
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ]);
    expect(binding.status, binding.stderr || binding.stdout).toBe(0);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'installed adopter fixture');
  return root;
}

function value(result: ReturnType<typeof run>): Json {
  const envelope = JSON.parse(result.stdout.trim() || result.stderr) as {
    result?: { value?: Json };
    error?: { context?: { payload?: Json } };
  };
  return envelope.result?.value ?? envelope.error?.context?.payload ?? {};
}

function observe(
  root: string,
  kind: string,
  rootArgs: readonly string[] = [],
  expectedStatus: 'pass' | 'review' = 'pass',
): Json {
  const result = run(root, [
    'sense',
    'run',
    kind,
    ...rootArgs,
    ...(kind === 'inventory_regeneration' ? ['--as-role', 'inspector', '--write'] : []),
    '--format',
    'json',
  ]);
  expect(result.status, result.stderr || result.stdout).toBe(expectedStatus === 'pass' ? 0 : 1);
  const aggregate = value(result);
  expect(aggregate['execution_status']).toBe('pass');
  const results = aggregate['results'] as { stdout: string; stderr: string; status: number }[];
  expect(results).toHaveLength(1);
  expect(results[0]?.status, results[0]?.stderr).toBe(expectedStatus === 'pass' ? 0 : 1);
  return JSON.parse(results[0]?.stdout ?? '') as Json;
}

function record(root: string, reading: Json): void {
  const input = '.devai/state/test-input.json';
  put(root, input, JSON.stringify(reading));
  const result = run(root, [
    'sense',
    'record',
    '--input',
    input,
    '--as-role',
    'inspector',
    '--write',
    '--format',
    'json',
  ]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

describe('installed observation and inventory root regressions', () => {
  it('refuses explicit route populations outside the checkout before measuring', () => {
    const root = repository();
    const outside = mkdtempSync(join(dirname(root), 'external-angular-'));
    workspaces.push(outside);
    put(
      outside,
      'routes.ts',
      "import { Routes } from '@angular/router';\nclass OutsidePage {}\nexport const routes: Routes = [{ path: 'outside-only', component: OutsidePage }];\n",
    );
    symlinkSync(outside, join(root, 'external-routes'));
    for (const path of [`../${basename(outside)}`, outside, 'external-routes']) {
      const result = run(root, [
        'sense',
        'run',
        'inventory_routes',
        '--input',
        JSON.stringify({ framework: 'angular', scanDirs: [path] }),
        '--format',
        'json',
      ]);
      expect(result.status, result.stderr || result.stdout).not.toBe(0);
      expect(result.stderr || result.stdout).toMatch(
        /SENSE_INPUT|SENSOR_INPUTS|contained|escape|relative/iu,
      );
    }
    expect(
      existsSync(join(root, '.devai/state/sensors/inventory_routes/routes-angular.json')),
    ).toBe(false);
  });

  it('forwards the same declared Angular population to direct and regenerated inventory', () => {
    const root = repository(
      {
        'apps/angular/routes.ts':
          "import { Routes } from '@angular/router';\nclass UserPage {}\nexport const routes: Routes = [{ path: 'users/:id', component: UserPage }];\n",
      },
      {
        schemaVersion: '1.0.0',
        inputs: { inventory_routes: { framework: 'angular', scanDirs: ['apps/angular'] } },
        surfaces: { http: true, database: true, rbac: true, actions: true },
      },
    );
    const direct = observe(root, 'inventory_routes');
    expect(direct['metrics']).toMatchObject({ route_count: 1, route_file_count: 1 });
    observe(root, 'inventory_regeneration', [], 'review');
    const generated = JSON.parse(
      readFileSync(join(root, '.devai/state/sensors/inventory_routes/routes-angular.json'), 'utf8'),
    ) as Json;
    expect(generated['framework']).toBe('angular');
    expect(generated['routes']).toEqual([expect.objectContaining({ path: 'users/:id' })]);
    expect(existsSync(join(root, STATE_BODY.inventory_routes))).toBe(false);
  });
  it.each([
    ['default root', []],
    ['explicit relative root', ['--repo-root', '.']],
    ['explicit absolute root', null],
  ] as const)(
    'regenerates all seven surfaces with %s at a spaced non-ASCII checkout',
    (_name, args) => {
      const root = repository();
      const head = git(root, 'rev-parse', 'HEAD');
      const reading = observe(
        root,
        'inventory_regeneration',
        args ?? ['--repo-root', root],
        'review',
      );
      expect(reading['status']).toBe('review');
      expect(reading['findings']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'INVENTORY_REGENERATION_PRODUCER_FINDING',
            message: expect.stringContaining('COVERAGE_NO_USE_CASES'),
          }),
        ]),
      );
      expect(reading['metrics']).toMatchObject({
        integration_head: head,
        required_kinds: 7,
        missing_required_kinds: 0,
      });
      for (const path of Object.values(STATE_BODY)) {
        expect(existsSync(join(root, path)), path).toBe(true);
        expect(readFileSync(join(root, path), 'utf8'), path).not.toContain(root);
      }
      expect(git(root, 'status', '--porcelain')).toBe('');
    },
  );

  it('records a new adapter measurement without a reading ID conflict or historical rewrite', () => {
    const root = repository();
    const first = observe(root, 'inventory_api', ['--repo-root', root]);
    record(root, first);
    const path = join(
      root,
      '.devai/state/sensor-readings/inventory_api',
      `${String(first['id'])}.json`,
    );
    const bytes = readFileSync(path);
    const chainBytes = readFileSync(join(root, 'record/proofs/chain.json'));

    const second = observe(root, 'inventory_api', ['--repo-root', root]);
    expect(second['id']).not.toBe(first['id']);
    expect(second['supersedes']).toBe(first['id']);
    record(root, second);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    const prior = JSON.parse(chainBytes.toString('utf8')) as { records: unknown[] };
    const current = JSON.parse(readFileSync(join(root, 'record/proofs/chain.json'), 'utf8')) as {
      records: unknown[];
    };
    expect(current.records.slice(0, prior.records.length)).toEqual(prior.records);
    const afterSecond = readFileSync(join(root, 'record/proofs/chain.json'));
    record(root, second);
    expect(readFileSync(join(root, 'record/proofs/chain.json')).equals(afterSecond)).toBe(true);
  });

  it('records a new candidate observation without inheriting the prior candidate supersession', () => {
    const root = repository();
    const first = observe(root, 'inventory_api');
    record(root, first);
    const path = join(
      root,
      '.devai/state/sensor-readings/inventory_api',
      `${String(first['id'])}.json`,
    );
    const bytes = readFileSync(path);
    const prefix = JSON.parse(readFileSync(join(root, 'record/proofs/chain.json'), 'utf8')) as {
      records: unknown[];
    };
    put(root, 'README.md', 'next candidate\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-qm', 'next candidate');
    const second = observe(root, 'inventory_api');
    expect(second['id']).not.toBe(first['id']);
    expect(second['supersedes']).toBeUndefined();
    record(root, second);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    const after = JSON.parse(readFileSync(join(root, 'record/proofs/chain.json'), 'utf8')) as {
      records: unknown[];
    };
    expect(after.records.slice(0, prefix.records.length)).toEqual(prefix.records);
  });
});

describe('installed reviewed task execution through authority broker', () => {
  function taskRepo() {
    const task = {
      nodeId: 'reviewed-task',
      sensorKinds: ['type_check', 'unit_test'],
      dependencies: [],
      cwd: '.',
      runner: 'exec-v1',
      argv: ['node', 'src/task.cjs'],
      inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
      toolchainKeys: ['node'],
      allowlistedEnv: [],
      outputContract: { population: 'installed-fixture' },
    };
    return repository(
      {
        'src/task.cjs':
          "const fs = require('node:fs'); fs.mkdirSync('.devai/state', { recursive: true }); fs.writeFileSync('.devai/state/task-started', 'executed'); console.log('Tests  3 passed (3)');\n",
        'test-tasks.json': JSON.stringify({
          schemaVersion: '1.0.0',
          descriptorVersion: 'fixture-1',
          repositoryId: 'fixture',
          fallbackNodeId: 'reviewed-task',
          dynamicFallbackSelectors: [],
          tasks: [task],
          profiles: [],
        }),
      },
      {
        schemaVersion: '1.0.0',
        inputs: {
          type_check: { taskId: 'reviewed-task', population: 'installed-fixture' },
          unit_test: { taskId: 'reviewed-task', population: 'installed-fixture' },
        },
      },
    );
  }
  it('requires --write and then measures an exact selected task with candidate and policy identity', () => {
    const root = taskRepo();
    const denied = run(root, [
      'sense',
      'run',
      'unit_test',
      '--as-role',
      'inspector',
      '--format',
      'json',
    ]);
    expect(denied.status).not.toBe(0);
    expect(denied.stderr || denied.stdout).toMatch(/consent|--write/iu);
    expect(existsSync(join(root, '.devai/state/task-started'))).toBe(false);
    const result = run(root, [
      'sense',
      'run',
      'unit_test',
      '--as-role',
      'inspector',
      '--write',
      '--format',
      'json',
    ]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(join(root, '.devai/state/task-started'), 'utf8')).toBe('executed');
    const results = value(result)['results'] as { stdout: string }[];
    const reading = JSON.parse(results[0]?.stdout ?? '') as Json;
    expect(reading['status']).toBe('pass');
    expect(reading['metrics']).toMatchObject({
      task_id: 'reviewed-task',
      population: 'installed-fixture',
      tests_passed: 3,
      tests_failed: 0,
      candidate_commit: git(root, 'rev-parse', 'HEAD'),
    });
  });
  it.each([
    [
      'read preset',
      [
        'sense',
        'run',
        '--preset',
        'sweep',
        '--round',
        'R-0001',
        '--as-role',
        'inspector',
        '--write',
      ],
      /SENSE_TASK_PRESET_REFUSED/u,
    ],
    [
      'wrong population',
      [
        'sense',
        'run',
        'unit_test',
        '--input',
        '{"taskId":"reviewed-task","population":"other"}',
        '--as-role',
        'inspector',
        '--write',
      ],
      /SENSE_TASK_POPULATION_MISMATCH/u,
    ],
    [
      'extra argv',
      [
        'sense',
        'run',
        'type_check',
        '--input',
        '{"taskId":"reviewed-task","population":"installed-fixture","argv":["node","src/task.cjs","--extra"]}',
        '--as-role',
        'inspector',
        '--write',
      ],
      /SENSE_(?:INPUTS_INVALID|TASK_REFERENCE_INVALID)/u,
    ],
    [
      'wrong kind',
      [
        'sense',
        'run',
        'build',
        '--input',
        '{"taskId":"reviewed-task","population":"installed-fixture"}',
        '--as-role',
        'inspector',
        '--write',
      ],
      /SENSE_TASK_KIND_MISMATCH/u,
    ],
  ])('refuses %s before the script starts', (_label, args, reason) => {
    const root = taskRepo();
    const denied = run(root, [...args, '--format', 'json']);
    expect(denied.status).not.toBe(0);
    expect(denied.stderr || denied.stdout).toMatch(reason);
    expect(existsSync(join(root, '.devai/state/task-started'))).toBe(false);
  });
});
