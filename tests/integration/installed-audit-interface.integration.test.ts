// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-020; ADR-SCR-0017.
// DEVAI executes exclusively from the assembled package; Vitest is the adopter's pinned runner.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
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
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { subprocessCoverageEnvironment } from '../helpers/subprocess-coverage.js';
import {
  installNativeVitest,
  installNativePlaywright,
  linkRuntimePackageDependencies,
} from '../../packages/cli/tests/fixtures/native-test-results/native-runner-fixture.js';

const ROOT = resolve(import.meta.dirname, '../..');
const PACKAGE = process.env['DEVAI_TEST_INSTALLED_PACKAGE'] ?? join(ROOT, 'packages/cli');
const roots: string[] = [];
const KEEP_NATIVE_FIXTURES = process.env['DEVAI_INSPECTOR_KEEP_NATIVE_FIXTURES'] === '1';
let installation: string;
let binary: string;
let installedPackage: string;
type Json = Record<string, unknown>;
const put = (root: string, path: string, value: string | object) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
beforeAll(() => {
  installation = mkdtempSync(join(tmpdir(), 'devai audit installé ç '));
  const installed = join(installation, 'node_modules/@aarusso-nyx/devai');
  installedPackage = installed;
  mkdirSync(installed, { recursive: true });
  cpSync(join(PACKAGE, 'dist'), join(installed, 'dist'), { recursive: true });
  cpSync(join(PACKAGE, 'package.json'), join(installed, 'package.json'));
  linkRuntimePackageDependencies(PACKAGE, installed);
  binary = join(installed, 'dist/runtime/index/bin.js');
  expect(existsSync(binary)).toBe(true);
});
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (KEEP_NATIVE_FIXTURES)
      process.stderr.write(`DEVAI_INSPECTOR_NATIVE_FIXTURE_ROOT=${JSON.stringify(root)}\n`);
    else rmSync(root, { recursive: true, force: true });
  }
});
afterAll(() => {
  if (installation === undefined) return;
  if (KEEP_NATIVE_FIXTURES)
    process.stderr.write(`DEVAI_INSPECTOR_NATIVE_INSTALLATION=${JSON.stringify(installation)}\n`);
  else rmSync(installation, { recursive: true, force: true });
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
      'user.name=DEVAI Inspector',
      '-c',
      'user.email=inspector@devai.local',
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
function commit(root: string): void {
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'installed audit fixture');
}
function repository(
  extra: Record<string, string | object>,
  optionalPolicy: Json,
  temporaryParent = tmpdir(),
): string {
  const root = mkdtempSync(join(temporaryParent, 'devai audit adopter ç '));
  roots.push(root);
  put(root, '.gitignore', 'node_modules/\n.devai/state/\nrecord/proofs/\n');
  for (const [path, value] of Object.entries(extra)) put(root, path, value);
  for (const selector of ['--constitution', '--operational-law', '--subprocess-effects', null]) {
    const result = run(root, [
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
    expect(result.status, result.stderr || result.stdout).toBe(0);
  }
  put(root, 'law/policy/adoption.json', {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.audit-interface',
    policy_version: '1.0.0',
    ...optionalPolicy,
  });
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
  git(root, 'init', '-q', '-b', 'main');
  commit(root);
  return root;
}
function reading(
  root: string,
  kind: string,
  args: readonly string[] = [],
  expected?: 'pass' | 'review' | 'unknown',
): Json {
  const result = run(root, ['sense', 'run', kind, ...args, '--format', 'json']);
  const envelope = JSON.parse(result.stdout || result.stderr) as {
    result?: { value?: { results?: { stdout: string }[] } };
    error?: { context?: { payload?: { results?: { stdout: string }[] } } };
  };
  const results = envelope.result?.value?.results ?? envelope.error?.context?.payload?.results;
  expect(results, result.stdout || result.stderr).toHaveLength(1);
  expect(results?.[0]?.stdout, result.stdout || result.stderr).toBeTruthy();
  const value = JSON.parse(results?.[0]?.stdout ?? '') as Json;
  if (expected !== undefined) {
    expect(
      value['status'],
      JSON.stringify({
        findings: value['findings'],
        stderr: (value['metrics'] as Json)?.['native_stderr'],
        stdout: (value['metrics'] as Json)?.['native_stdout'],
        trace: (value['metrics'] as Json)?.['native_input_trace'],
      }),
    ).toBe(expected);
    expect(result.status).toBe(expected === 'pass' ? 0 : 1);
  }
  return value;
}
function record(root: string, value: Json): void {
  put(root, '.devai/state/test-input.json', value);
  const result = run(root, [
    'sense',
    'record',
    '--input',
    '.devai/state/test-input.json',
    '--as-role',
    'inspector',
    '--write',
    '--format',
    'json',
  ]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
}
const nativeId = (file: string, title: string) =>
  `test:v1:${encodeURIComponent(JSON.stringify(['audit-fixture', file, ['arithmetic'], title]))}`;
function nativeRepository(isolatedRunner = false, temporaryParent = tmpdir()): string {
  const cases = [
    ['one', 'adds'],
    ['two', 'multiplies'],
  ] as const;
  const tasks = cases.map(([name, title]) => ({
    nodeId: `test:${name}`,
    sensorKinds: ['unit_test'],
    dependencies: [],
    cwd: '.',
    runner: 'exec-v1',
    argv: [
      'vitest',
      'run',
      '--configLoader',
      'native',
      '--config',
      `./vitest.${name}.config.mjs`,
      '--reporter',
      '@aarusso-nyx/devai/native-vitest-reporter',
      '--no-cache',
    ],
    inputSelectors: [{ kind: 'glob', pattern: '**/*' }],
    toolchainKeys: ['node'],
    allowlistedEnv: [],
    outputContract: {
      kind: 'command-result',
      population: `scope-${name}`,
      resultPopulation: {
        schemaVersion: '1.0.0',
        format: 'vitest-json',
        selectionEvidence: {
          kind: 'devai-native-collection',
          reporter: 'vitest-v1',
          projectName: 'audit-fixture',
        },
        projectId: 'audit-fixture',
        transport: { kind: 'direct' },
        executableFiles: [`tests/${name}.test.ts`],
        requiredTestIds: [nativeId(`tests/${name}.test.ts`, title)],
      },
    },
  }));
  const extra: Record<string, string | object> = {
    'package.json': {
      private: true,
      type: 'module',
      packageManager: 'pnpm@9.15.0',
      devDependencies: {
        vitest: '4.1.11',
        vite: '7.3.6',
        '@aarusso-nyx/devai': JSON.parse(
          readFileSync(join(installedPackage, 'package.json'), 'utf8'),
        )['version'],
      },
    },
    'test-tasks.json': {
      schemaVersion: '1.0.0',
      descriptorVersion: 'audit-fixture-1',
      repositoryId: 'fixture',
      fallbackNodeId: 'test:one',
      dynamicFallbackSelectors: [],
      profiles: [],
      tasks,
    },
    'law/invariants/INV-ADOPTER-001.json': {
      id: 'INV-ADOPTER-001',
      severity: 'gate',
      measurable_via: ['sense run unit_test'],
    },
    '.github/workflows/ci.yml': `jobs:\n  tests:\n    steps:\n${tasks.map((task) => `      - run: ${task.argv.join(' ')}`).join('\n')}\n`,
  };
  for (const [name, title] of cases) {
    extra[`vitest.${name}.config.mjs`] =
      `export default {test:{name:'audit-fixture',include:['tests/${name}.test.ts'],pool:'forks',maxWorkers:1,watch:false,coverage:{enabled:false}}};\n`;
    extra[`tests/${name}.test.ts`] =
      `import {describe,it,expect} from 'vitest'; describe('arithmetic',()=>{it('${title}',()=>expect(2+2).toBe(4));});\n`;
  }
  const root = repository(
    extra,
    {
      invariant_producers: {
        schemaVersion: '1.0.0',
        bindings: tasks.map((task, index) => ({
          invariant_id: 'INV-ADOPTER-001',
          subject: `subject-${index + 1}`,
          taskId: task.nodeId,
          population: task.outputContract.population,
          requiredTestIds: task.outputContract.resultPopulation.requiredTestIds,
        })),
      },
    },
    temporaryParent,
  );
  // A real separately installed adopter test runner; DEVAI implementation remains package-only.
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  mkdirSync(join(root, 'node_modules/@aarusso-nyx'), { recursive: true });
  installNativeVitest(ROOT, root, { isolateRunner: isolatedRunner });
  symlinkSync(installedPackage, join(root, 'node_modules/@aarusso-nyx/devai'), 'dir');
  expect(
    JSON.parse(readFileSync(join(root, 'node_modules/vitest/package.json'), 'utf8'))['version'],
  ).toBe('4.1.11');
  return root;
}

function nativePlaywrightRepository(): string {
  const task = {
    nodeId: 'test:playwright',
    sensorKinds: ['unit_test'],
    dependencies: [],
    cwd: '.',
    runner: 'exec-v1',
    argv: [
      'playwright',
      'test',
      '--config',
      './playwright.config.mjs',
      '--project',
      'audit-native',
      '--reporter',
      '@aarusso-nyx/devai/native-playwright-reporter',
    ],
    inputSelectors: [{ kind: 'glob', pattern: '**/*' }],
    toolchainKeys: ['node'],
    allowlistedEnv: [],
    outputContract: {
      kind: 'command-result',
      population: 'native-playwright',
      resultPopulation: {
        schemaVersion: '1.0.0',
        format: 'playwright-json',
        selectionEvidence: {
          kind: 'devai-native-collection',
          reporter: 'playwright-v1',
          projectName: 'audit-native',
        },
        projectId: 'audit-fixture',
        transport: { kind: 'direct' },
        executableFiles: ['tests/native.spec.ts'],
        requiredTestIds: [nativeId('tests/native.spec.ts', 'adds')],
      },
    },
  };
  const root = repository(
    {
      'package.json': {
        private: true,
        type: 'module',
        optionalDependencies: { fsevents: '2.3.3' },
        devDependencies: {
          '@playwright/test': '1.60.0',
          '@aarusso-nyx/devai': JSON.parse(
            readFileSync(join(installedPackage, 'package.json'), 'utf8'),
          )['version'],
        },
      },
      'test-tasks.json': {
        schemaVersion: '1.0.0',
        descriptorVersion: 'playwright-fixture-1',
        repositoryId: 'fixture',
        fallbackNodeId: task.nodeId,
        dynamicFallbackSelectors: [],
        profiles: [],
        tasks: [task],
      },
      'playwright.config.mjs':
        "import {defineConfig} from '@playwright/test'; export default defineConfig({testDir:'./tests',testMatch:'native.spec.ts',outputDir:'.devai/state/playwright-results',workers:1,projects:[{name:'audit-native'}]});\n",
      'tests/native.spec.ts':
        "import {test,expect} from '@playwright/test'; test.describe('arithmetic',()=>{test('adds',()=>expect(2+2).toBe(4));});\n",
      'law/invariants/INV-ADOPTER-001.json': {
        id: 'INV-ADOPTER-001',
        severity: 'gate',
        measurable_via: ['sense run unit_test'],
      },
      '.github/workflows/ci.yml': `jobs:\n  tests:\n    steps:\n      - run: ${task.argv.join(' ')}\n`,
    },
    {
      invariant_producers: {
        schemaVersion: '1.0.0',
        bindings: [
          {
            invariant_id: 'INV-ADOPTER-001',
            subject: 'native-playwright-subject',
            taskId: task.nodeId,
            population: task.outputContract.population,
            requiredTestIds: task.outputContract.resultPopulation.requiredTestIds,
          },
        ],
      },
    },
  );
  const playwright = join(ROOT, 'node_modules/playwright-native-fixture');
  expect(JSON.parse(readFileSync(join(playwright, 'package.json'), 'utf8'))['version']).toBe(
    '1.60.0',
  );
  mkdirSync(join(root, 'node_modules/@aarusso-nyx'), { recursive: true });
  installNativePlaywright(ROOT, root);
  symlinkSync(installedPackage, join(root, 'node_modules/@aarusso-nyx/devai'), 'dir');
  return root;
}

describe('installed optional audit interfaces and native task execution', () => {
  it.each([
    ['implicit', false, false],
    ['explicit', true, false],
    ['opaque Rust resolver', true, true],
  ] as const)(
    'enforces native SWC configuration provenance for %s options',
    (_mode, explicit, resolver) => {
      const root = nativeRepository();
      for (const [name, alias, version] of [
        ['@swc/core', 'swc-native-fixture', '1.16.2'],
        ['unplugin-swc', 'unplugin-swc-native-fixture', '1.5.9'],
      ]) {
        const source = join(ROOT, 'node_modules', String(alias));
        expect(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))['version']).toBe(
          version,
        );
        const target = join(root, 'node_modules', String(name));
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(source, target, 'dir');
      }
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Json;
      manifest['devDependencies'] = {
        ...(manifest['devDependencies'] as Json),
        vitest: '4.1.11',
        vite: '7.3.6',
        '@swc/core': '1.16.2',
        'unplugin-swc': '1.5.9',
      };
      put(root, 'package.json', manifest);
      put(root, '.swcrc', { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' } });
      const options = {
        jsc: {
          parser: { syntax: 'typescript' },
          target: 'es2022',
          ...(resolver ? { baseUrl: root, paths: { '@hidden/*': ['hidden/*'] } } : {}),
        },
        ...(explicit ? { swcrc: false, configFile: false, inputSourceMap: false } : {}),
      };
      const config = readFileSync(join(root, 'vitest.one.config.mjs'), 'utf8');
      put(
        root,
        'vitest.one.config.mjs',
        `import swc from 'unplugin-swc';\n${config.replace('export default {', `export default {plugins:[swc.vite(${JSON.stringify(options)})],`)}`,
      );
      commit(root);
      const result = reading(
        root,
        'unit_test',
        [
          '--input',
          JSON.stringify({ taskId: 'test:one', population: 'scope-one' }),
          '--as-role',
          'inspector',
          '--write',
        ],
        explicit && !resolver ? 'pass' : 'unknown',
      );
      if (explicit && !resolver)
        expect(result['metrics']).toMatchObject({ tests_passed: 1, tests_failed: 0 });
      else expect((result['metrics'] as Json)['tests_passed']).toBeUndefined();
    },
  );

  it('refuses a present external configuration discovered by the native runner', () => {
    const holder = mkdtempSync(join(tmpdir(), 'devai external config ç '));
    roots.push(holder);
    const root = nativeRepository(false, holder);
    const externalConfig = join(holder, 'node_modules/vitest.one.config.mjs');
    put(
      holder,
      'node_modules/vitest.one.config.mjs',
      "export default {test:{name:'external',include:[]}};\n",
    );
    const observed = reading(
      root,
      'unit_test',
      [
        '--input',
        JSON.stringify({ taskId: 'test:one', population: 'scope-one' }),
        '--as-role',
        'inspector',
        '--write',
      ],
      'unknown',
    );
    expect(
      (observed['metrics'] as Json)['tests_passed'],
      JSON.stringify({
        findings: observed['findings'],
        stdout: (observed['metrics'] as Json)['native_stdout'],
        stderr: (observed['metrics'] as Json)['native_stderr'],
        trace: (observed['metrics'] as Json)['native_input_trace'],
      }),
    ).toBeUndefined();
    expect(String((observed['metrics'] as Json)['native_input_trace'])).toContain(externalConfig);
    expect(observed['findings']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: expect.stringContaining('NATIVE_INPUT_EXTERNAL') }),
      ]),
    );
  });

  it('preserves resolved Vite defaults and declared worker environment overrides', () => {
    const root = nativeRepository();
    const config = readFileSync(join(root, 'vitest.one.config.mjs'), 'utf8');
    put(
      root,
      'vitest.one.config.mjs',
      config.replace('test:{', "test:{env:{BASE_URL:'/adopter/',MODE:'declared-adopter'},"),
    );
    put(
      root,
      'tests/one.test.ts',
      "import {describe,it,expect} from 'vitest'; describe('arithmetic',()=>{it('adds',()=>{expect(process.env.BASE_URL).toBe('/adopter/'); expect(process.env.MODE).toBe('declared-adopter'); expect(process.env.DEV).toBe('1'); expect(process.env.PROD).toBe('');});});\n",
    );
    commit(root);
    const observed = reading(
      root,
      'unit_test',
      [
        '--input',
        JSON.stringify({ taskId: 'test:one', population: 'scope-one' }),
        '--as-role',
        'inspector',
        '--write',
      ],
      'pass',
    );
    const metrics = observed['metrics'] as Json;
    const output = JSON.parse(String(metrics['native_stdout'])) as {
      devaiCollection: { resolvedSelection: Json[] };
    };
    expect(output.devaiCollection.resolvedSelection).toHaveLength(1);
    expect(output.devaiCollection.resolvedSelection[0]).toMatchObject({
      viteEnvironment: { BASE_URL: '/', MODE: 'test', DEV: true, PROD: false },
      testEnvironment: { BASE_URL: '/adopter/', MODE: 'declared-adopter' },
    });
    const trace = String(metrics['native_input_trace'])
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Json);
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'runtime-environment',
          environment: expect.objectContaining({
            BASE_URL: '/adopter/',
            MODE: 'declared-adopter',
            DEV: '1',
            PROD: '',
          }),
        }),
      ]),
    );
  });

  it('refuses configured native worker preload before its external side effect executes', () => {
    const root = nativeRepository();
    const holder = mkdtempSync(join(tmpdir(), 'devai forbidden preload ç '));
    roots.push(holder);
    const marker = join(holder, 'executed.txt');
    put(
      root,
      'injected.cjs',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`,
    );
    const config = readFileSync(join(root, 'vitest.one.config.mjs'), 'utf8');
    put(
      root,
      'vitest.one.config.mjs',
      config.replace(
        'test:{',
        `test:{execArgv:${JSON.stringify(['--require', join(root, 'injected.cjs')])},`,
      ),
    );
    commit(root);
    const observed = reading(
      root,
      'unit_test',
      [
        '--input',
        JSON.stringify({ taskId: 'test:one', population: 'scope-one' }),
        '--as-role',
        'inspector',
        '--write',
      ],
      'unknown',
    );
    expect((observed['metrics'] as Json)['tests_passed']).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(String((observed['metrics'] as Json)['native_input_trace'])).toContain(
      'child-node-preload',
    );
  });

  it('refuses eval workers before their untraced external side effect executes', () => {
    const root = nativeRepository();
    const holder = mkdtempSync(join(tmpdir(), 'devai forbidden worker ç '));
    roots.push(holder);
    const marker = join(holder, 'executed.txt');
    const payload = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`;
    put(
      root,
      'tests/one.test.ts',
      `import {describe,it} from 'vitest'; import {Worker} from 'node:worker_threads'; describe('arithmetic',()=>{it('adds',()=>{new Worker(${JSON.stringify(payload)},{eval:true});});});\n`,
    );
    commit(root);
    const observed = reading(
      root,
      'unit_test',
      [
        '--input',
        JSON.stringify({ taskId: 'test:one', population: 'scope-one' }),
        '--as-role',
        'inspector',
        '--write',
      ],
      'unknown',
    );
    expect((observed['metrics'] as Json)['tests_passed']).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(String((observed['metrics'] as Json)['native_input_trace'])).toContain('worker-eval');
  });

  it('executes pinned native Playwright without browser and discharges its exact logical subject', () => {
    const root = nativePlaywrightRepository();
    const observed = reading(
      root,
      'unit_test',
      [
        '--input',
        JSON.stringify({ taskId: 'test:playwright', population: 'native-playwright' }),
        '--as-role',
        'inspector',
        '--write',
      ],
      'pass',
    );
    expect(observed['metrics']).toMatchObject({
      tests_passed: 1,
      tests_failed: 0,
      native_result_project: 'audit-fixture',
    });
    const metrics = observed['metrics'] as Json;
    expect(metrics['native_input_trace_sha256']).toBe(hash(String(metrics['native_input_trace'])));
    const output = JSON.parse(String(metrics['native_stdout'])) as { devaiCollection: Json };
    const outputRoot = join(
      realpathSync(root),
      '.devai/state/native-config-traces',
      String(metrics['native_collection_nonce']),
      'runtime/playwright-results',
    );
    const task = JSON.parse(readFileSync(join(root, 'test-tasks.json'), 'utf8')).tasks[0];
    expect(JSON.parse(String(metrics['native_effective_command']))).toEqual({
      executable: realpathSync(process.execPath),
      argv: [
        realpathSync(join(root, 'node_modules/@playwright/test/cli.js')),
        ...task.argv.slice(1),
        '--output',
        outputRoot,
      ],
      outputRoot,
    });
    expect(metrics['native_effective_command_sha256']).toBe(
      hash(String(metrics['native_effective_command'])),
    );
    expect(output.devaiCollection['runtimeResultRoot']).toBe(outputRoot);
    expect(output.devaiCollection['resolvedSelection']).toEqual([
      expect.objectContaining({ outputDir: outputRoot }),
    ]);
    expect(existsSync(join(root, '.devai/state/playwright-results'))).toBe(false);
    expect(output.devaiCollection).toMatchObject({
      reporter: 'playwright-v1',
      tests: [
        {
          file: realpathSync(join(root, 'tests/native.spec.ts')),
          project: 'audit-native',
          ancestors: ['arithmetic'],
          title: 'adds',
        },
      ],
    });
    record(root, observed);
    expect(reading(root, 'harness_invariant_alignment', [], 'pass')['metrics']).toMatchObject({
      gate_invariants: 1,
      misaligned: 0,
    });
  });

  it.each(
    [
      ['--output', './caller-results'],
      ['--output=./caller-results'],
      ['-o', './caller-results'],
    ].map((argv) => ({ argv })),
  )('refuses caller Playwright result output arguments %j before native execution', ({ argv }) => {
    const root = nativePlaywrightRepository();
    const descriptor = JSON.parse(readFileSync(join(root, 'test-tasks.json'), 'utf8'));
    descriptor.tasks[0].argv.push(...argv);
    put(root, 'test-tasks.json', descriptor);
    commit(root);
    const result = run(root, [
      'sense',
      'run',
      'unit_test',
      '--input',
      JSON.stringify({ taskId: 'test:playwright', population: 'native-playwright' }),
      '--as-role',
      'inspector',
      '--write',
      '--format',
      'json',
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: 'SENSE_SELECTION_INVALID',
        class: 'routing-authority',
        exit: 2,
        context: { detail: 'SENSE_NATIVE_SELECTION_UNSUPPORTED' },
      },
    });
    expect(existsSync(join(root, '.devai/state/native-config-traces'))).toBe(false);
    expect(existsSync(join(root, 'caller-results'))).toBe(false);
  });

  it('refuses a present literal URL-encoded Playwright module probe outside the candidate', () => {
    const root = nativePlaywrightRepository();
    // Playwright 1.60 probes a literal URL pathname, including percent escapes.
    // Its exact negative absence may be replayed; present external bytes cannot.
    const encodedRoot = pathToFileURL(realpathSync(root)).pathname;
    expect(encodedRoot).not.toBe(realpathSync(root));
    expect(existsSync(encodedRoot)).toBe(false);
    roots.push(encodedRoot);
    put(encodedRoot, 'node_modules/playwright/test.js', 'export const external = true;\n');
    const observed = reading(
      root,
      'unit_test',
      [
        '--input',
        JSON.stringify({ taskId: 'test:playwright', population: 'native-playwright' }),
        '--as-role',
        'inspector',
        '--write',
      ],
      'unknown',
    );
    const metrics = observed['metrics'] as Json;
    expect(metrics['tests_passed']).toBeUndefined();
    expect(observed['findings']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: `NATIVE_INPUT_EXTERNAL_PATH:${join(encodedRoot, 'node_modules/playwright/test.js')}`,
        }),
      ]),
    );
    const rows = String(metrics['native_input_trace'])
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Json);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'observation',
          operation: 'exists',
          path: join(encodedRoot, 'node_modules/playwright/test.js'),
          observation: { value: true },
        }),
      ]),
    );
  });

  it('refuses an ambient selector imported by native Playwright configuration before execution origin', () => {
    const root = nativePlaywrightRepository();
    const config = readFileSync(join(root, 'playwright.config.mjs'), 'utf8');
    put(root, 'selector.mjs', 'export const selected = Date.now();\n');
    put(root, 'playwright.config.mjs', `import './selector.mjs';\n${config}`);
    commit(root);
    const chain = join(root, 'record/proofs/chain.json');
    const before = existsSync(chain) ? readFileSync(chain, 'utf8') : undefined;
    const result = run(root, [
      'sense',
      'run',
      'unit_test',
      '--input',
      JSON.stringify({ taskId: 'test:playwright', population: 'native-playwright' }),
      '--as-role',
      'inspector',
      '--write',
      '--format',
      'json',
    ]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr || result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'SENSE_SELECTION_INVALID',
        context: { detail: 'SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED' },
      },
    });
    expect(existsSync(chain) ? readFileSync(chain, 'utf8') : undefined).toBe(before);
  });

  it('does not grant execution origin to a coherent cloned native reading recorded generically', () => {
    const root = nativeRepository();
    const measured = reading(
      root,
      'unit_test',
      [
        '--input',
        JSON.stringify({ taskId: 'test:one', population: 'scope-one' }),
        '--as-role',
        'inspector',
        '--write',
      ],
      'pass',
    );
    const clone = structuredClone(measured);
    const id = String(measured['id']);
    clone['id'] = `${id.slice(0, -1)}${id.endsWith('0') ? '1' : '0'}`;
    expect(clone['id']).not.toBe(id);
    expect(clone['metrics']).toEqual(measured['metrics']);
    record(root, clone);
    expect(reading(root, 'harness_invariant_alignment', [], 'review')['metrics']).toMatchObject({
      misaligned: 1,
    });
  });

  it('invalidates recorded native execution after its isolated transitive runner bytes change', () => {
    const root = nativeRepository(true);
    put(root, 'record/proofs/retained-layout.json', {
      purpose: 'Tracked canonical evidence layout',
    });
    git(root, 'add', '--force', 'record/proofs/retained-layout.json');
    git(root, 'commit', '-qm', 'tracked evidence namespace');
    for (const name of ['one', 'two']) {
      record(
        root,
        reading(
          root,
          'unit_test',
          [
            '--input',
            JSON.stringify({ taskId: `test:${name}`, population: `scope-${name}` }),
            '--as-role',
            'inspector',
            '--write',
          ],
          'pass',
        ),
      );
    }
    expect(reading(root, 'harness_invariant_alignment', [], 'pass')['metrics']).toMatchObject({
      misaligned: 0,
    });
    const dependency = join(root, 'node_modules/vitest/node_modules/@vitest/runner/dist/index.js');
    const previous = readFileSync(dependency, 'utf8');
    writeFileSync(dependency, `${previous}\n// Isolated Inspector dependency mutation.\n`);
    expect(reading(root, 'harness_invariant_alignment', [], 'review')['metrics']).toMatchObject({
      misaligned: 1,
    });
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('preserves two independently executed same-kind tasks and discharges both exact subjects', () => {
    const root = nativeRepository();
    const first = reading(
      root,
      'unit_test',
      [
        '--input',
        JSON.stringify({ taskId: 'test:one', population: 'scope-one' }),
        '--as-role',
        'inspector',
        '--write',
      ],
      'pass',
    );
    record(root, first);
    expect(reading(root, 'harness_invariant_alignment', [], 'review')['metrics']).toMatchObject({
      gate_invariants: 1,
      misaligned: 1,
    });
    const second = reading(
      root,
      'unit_test',
      [
        '--input',
        JSON.stringify({ taskId: 'test:two', population: 'scope-two' }),
        '--as-role',
        'inspector',
        '--write',
      ],
      'pass',
    );
    expect(second['supersedes']).not.toBe(first['id']);
    record(root, second);
    expect(reading(root, 'harness_invariant_alignment', [], 'pass')['metrics']).toMatchObject({
      gate_invariants: 1,
      misaligned: 0,
    });
    const scorecardArgs = [
      'audit',
      'scorecard',
      '--repo-root',
      root,
      '--at',
      git(root, 'rev-parse', 'HEAD'),
      '--format',
      'json',
    ];
    const scorecard = run(root, scorecardArgs);
    expect(scorecard.status, scorecard.stderr || scorecard.stdout).toBe(0);
    expect(run(root, scorecardArgs).stdout).toBe(scorecard.stdout);
    for (const value of [first, second]) {
      const metrics = value['metrics'] as Json;
      const stdout = String(metrics['native_stdout']);
      expect(stdout.length).toBeGreaterThan(0);
      expect(metrics['stdout_sha256']).toBe(hash(stdout));
      const rawTrace = String(metrics['native_input_trace']);
      expect(rawTrace.length).toBeGreaterThan(0);
      expect(metrics['native_input_trace_sha256']).toBe(hash(rawTrace));
      const observations = rawTrace
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Json);
      expect(observations.every((row) => row['nonce'] === metrics['native_collection_nonce'])).toBe(
        true,
      );
      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'begin', scope: 'main' }),
          expect.objectContaining({ kind: 'end', scope: 'main' }),
          expect.objectContaining({ kind: 'observation', operation: 'readFile' }),
        ]),
      );
      expect(observations.some((row) => row['kind'] === 'unsupported')).toBe(false);
      expect(JSON.parse(String(metrics['native_result_population']))).toMatchObject({
        status: 'pass',
        skippedTestIds: [],
        failedTestIds: [],
      });
    }
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('binds reviewed workflow source, exact occurrence and transitive bytes through the installed CLI', () => {
    const main = "import { value } from './helper.mjs'; export const result = value;\n";
    const helper = 'export const value = 1;\n';
    const workflow =
      'name: Adopter check\non: push\nconcurrency:\n  group: adopter-check\n  cancel-in-progress: false\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Reviewed adopter check\n        run: node scripts/main.mjs\n';
    const entry = {
      sha256: hash(
        JSON.stringify({ name: 'Reviewed adopter check', run: 'node scripts/main.mjs' }),
      ),
      effect: 'read-only',
      workflow: '.github/workflows/ci.yml#verify[0]',
      step: 'Reviewed adopter check',
      review: 'Exact installed adopter closure.',
      files: [
        { path: 'scripts/helper.mjs', sha256: hash(helper) },
        { path: 'scripts/main.mjs', sha256: hash(main) },
      ],
    };
    const root = repository(
      {
        'scripts/main.mjs': main,
        'scripts/helper.mjs': helper,
        '.github/workflows/ci.yml': workflow,
      },
      { reviewed_workflow_steps: { schemaVersion: '1.0.0', steps: [entry] } },
    );
    const before = reading(root, 'harness_coherence');
    expect(JSON.stringify(before['findings'] ?? [])).not.toContain('whose effect is unknown');
    put(root, '.github/workflows/copied.yml', workflow);
    commit(root);
    const after = reading(root, 'harness_coherence');
    expect(JSON.stringify(after['findings'] ?? [])).toContain('whose effect is unknown');
  });
});
