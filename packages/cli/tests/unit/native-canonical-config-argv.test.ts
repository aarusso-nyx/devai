// Independent Inspector: real canonical recipe and packaged CLI; no authored execution standing.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installNativeVitest,
  linkRuntimePackageDependencies,
} from '../fixtures/native-test-results/native-runner-fixture.js';
import {
  nativeExecutionCommand,
  assertNativeRunnerDeclaration,
} from '../../src/commands/sense/native-runner-selection.js';
import type { PlannedTask } from '../../src/services/check-runner/types.js';
import {
  nativeTestId,
  type NativeTestResultContract,
} from '../../src/commands/sense/native-test-results.js';

const { npmPackOutput } = (await import(
  new URL('../../../../scripts/npm-pack-output.mjs', import.meta.url).href
)) as {
  npmPackOutput: (
    value: unknown,
    expected: { name: string; version: string },
  ) => { filename: string };
};
const roots: string[] = [];
const report = '@aarusso-nyx/devai/native-vitest-reporter';
const config = './tools/security/invariants/semantic.config.mjs';
const population: NativeTestResultContract = {
  schemaVersion: '1.0.0',
  format: 'vitest-json',
  projectId: 'canonical-config-fixture',
  selectionEvidence: {
    kind: 'devai-native-collection',
    reporter: 'vitest-v1',
    projectName: 'canonical-config-fixture',
  },
  transport: { kind: 'direct' },
  executableFiles: ['backend/tests/one.test.ts'],
  requiredTestIds: [
    nativeTestId(
      'canonical-config-fixture',
      'backend/tests/one.test.ts',
      [],
      'executes the original semantic assertion',
    ),
  ],
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function put(root: string, file: string, bytes: string | object) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(
    join(root, file),
    typeof bytes === 'string' ? bytes : `${JSON.stringify(bytes, null, 2)}\n`,
  );
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-config-argv-')));
  roots.push(root);
  put(root, 'package.json', { private: true, type: 'module' });
  put(
    root,
    config,
    "export default {root:'./backend',test:{name:'canonical-config-fixture',include:['tests/*.test.ts']}};\n",
  );
  return root;
}
function task(words: string[], cwd = '.'): PlannedTask {
  // A recipe-only test value; it is never used to mint a binding, execute or claim a reading.
  const argv = ['runner', ...words];
  const executablePath = realpathSync(process.execPath);
  return {
    nodeId: 'canonical-config-recipe-fixture',
    taskKey: 'canonical-config-recipe-fixture',
    dependencies: [],
    argv,
    cwd,
    executable: {
      path: executablePath,
      sha256: createHash('sha256').update(readFileSync(executablePath)).digest('hex'),
    },
    inputDigest: createHash('sha256').update(JSON.stringify({ argv, cwd })).digest('hex'),
    inputPaths: [],
    matchedChangedPaths: [],
    cacheState: 'execute',
    reason: 'Recipe-only unit fixture; no execution or reading standing.',
    outputContract: { kind: 'command-result', resultPopulation: population },
  };
}
const words = (flag = '--config', value = config) => [
  'run',
  flag,
  value,
  '--configLoader',
  'native',
  '--reporter',
  report,
];
const recipe = (root: string, plan: PlannedTask) =>
  nativeExecutionCommand(root, plan, randomBytes(32).toString('hex'));

describe('native canonical config argv independent contract', () => {
  it.each(['--config', '-c'])(
    'canonicalizes only the semantic %s value while preserving authored argv',
    (flag) => {
      const root = fixture(),
        plan = task(words(flag)),
        original = [...plan.argv];
      const command = recipe(root, plan);
      expect(command.argv).toEqual([
        realpathSync(process.execPath),
        'run',
        flag,
        realpathSync(join(root, config)),
        '--configLoader',
        'native',
        '--reporter',
        report,
      ]);
      expect(plan.argv).toEqual(original);
      expect(assertNativeRunnerDeclaration(root, plan, population)).toEqual(
        assertNativeRunnerDeclaration(root, task(original.slice(1)), population),
      );
    },
  );
  it('preserves reporter and config option positions instead of replacing matching substrings', () => {
    const root = fixture();
    const plan = task([
      'run',
      '--reporter',
      report,
      '--no-cache',
      '--configLoader',
      'native',
      '-c',
      config,
      '--no-file-parallelism',
    ]);
    expect(recipe(root, plan).argv).toEqual([
      realpathSync(process.execPath),
      'run',
      '--reporter',
      report,
      '--no-cache',
      '--configLoader',
      'native',
      '-c',
      realpathSync(join(root, config)),
      '--no-file-parallelism',
    ]);
  });
  it('resolves a regular internal config relative to the actual task cwd', () => {
    const root = fixture();
    put(root, 'backend/local.config.mjs', 'export default {test:{include:["tests/*.test.ts"]}};\n');
    expect(recipe(root, task(words('-c', './local.config.mjs'), 'backend')).argv[3]).toBe(
      realpathSync(join(root, 'backend/local.config.mjs')),
    );
  });
  it.each([
    ['missing config', ['run', '--configLoader', 'native', '--reporter', report]],
    ['duplicate config', [...words(), '-c', config]],
    [
      'equals config',
      ['run', `--config=${config}`, '--configLoader', 'native', '--reporter', report],
    ],
    ['implicit path', words('--config', 'tools/security/invariants/semantic.config.mjs')],
    ['absolute authored path', words('--config', '/tmp/semantic.config.mjs')],
    ['external traversal', words('--config', './../external.config.mjs')],
    ['missing value', ['run', '--config']],
    ['arbitrary positional filter', [...words(), 'one.test.ts']],
    [
      'unsupported loader',
      ['run', '--config', config, '--configLoader', 'runner', '--reporter', report],
    ],
    [
      'foreign reporter',
      ['run', '--config', config, '--configLoader', 'native', '--reporter', 'json'],
    ],
    ['extra flag', [...words(), '--passWithNoTests']],
  ])('rejects %s through the same strict declaration rules', (_label, args) => {
    const root = fixture();
    expect(() => recipe(root, task(args as string[]))).toThrow();
  });
  it('rejects a symlink config even when the target is internal', () => {
    const root = fixture();
    put(root, 'regular.mjs', 'export default {};\n');
    symlinkSync(join(root, 'regular.mjs'), join(root, 'alias.mjs'));
    expect(() => recipe(root, task(words('-c', './alias.mjs')))).toThrow(/LINK|link/u);
  });
  it('rejects a config inside the mutable native-state namespace', () => {
    const root = fixture();
    put(root, '.devai/state/native.config.mjs', 'export default {};\n');
    expect(() => recipe(root, task(words('--config', './.devai/state/native.config.mjs')))).toThrow(
      'SENSE_NATIVE_CONFIG_IN_MUTATED_NAMESPACE',
    );
  });
  it('rejects symlink substitution after a valid declaration', () => {
    const root = fixture(),
      plan = task(words());
    assertNativeRunnerDeclaration(root, plan, population);
    const path = join(root, config);
    rmSync(path);
    put(root, 'replacement.mjs', 'export default {};\n');
    symlinkSync(join(root, 'replacement.mjs'), path);
    expect(() => recipe(root, plan)).toThrow(/LINK|link/u);
  });
  it('does not accept a forged result context with an unsupported runner selection', () => {
    const root = fixture(),
      plan = task(words());
    const forged = {
      ...plan,
      outputContract: {
        kind: 'command-result',
        resultPopulation: {
          ...population,
          selectionEvidence: { ...population.selectionEvidence, reporter: 'caller-trusted-runner' },
        },
      },
    } as PlannedTask;
    expect(() => recipe(root, forged)).toThrow();
  });
});

// This is the public packaged route. Bindings, nonces and execution origin come only from the CLI.
describe('packaged native config resolution regression', () => {
  it('executes a tools/config path over a separate backend collection without ancestral package probes', () => {
    const repository = resolve(import.meta.dirname, '../../../..');
    // Retain authentic packaged output, fixture chain and raw streams for independent review.
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'devai-config-cli-')));
    const artifacts = join(output, 'pack');
    mkdirSync(artifacts);
    const environment: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith('GIT_') &&
            !key.startsWith('DEVAI_NATIVE_') &&
            !/^(https?|all|no)_proxy$/iu.test(key) &&
            key !== 'FORCE_COLOR',
        ),
      ),
      NO_COLOR: '1',
    };
    const invoke = (label: string, executable: string, args: string[], cwd: string) => {
      const result = spawnSync(executable, args, {
        cwd,
        env: environment,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 128 * 1024 * 1024,
      });
      writeFileSync(join(output, `${label}.stdout`), result.stdout ?? '');
      writeFileSync(join(output, `${label}.stderr`), result.stderr ?? '');
      writeFileSync(
        join(output, `${label}.command.json`),
        JSON.stringify({
          executable,
          args,
          cwd,
          status: result.status,
          signal: result.signal,
          error: result.error?.message,
        }),
      );
      if (result.error !== undefined) throw result.error;
      return result;
    };
    expect(
      existsSync(join(repository, 'packages/cli/dist/runtime/index/bin.js')),
      'Build the exact candidate before the packaged regression',
    ).toBe(true);
    const pack = invoke(
      'pack',
      'npm',
      ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', artifacts],
      join(repository, 'packages/cli'),
    );
    expect(pack.status, pack.stderr).toBe(0);
    const sourcePackage = JSON.parse(
      readFileSync(join(repository, 'packages/cli/package.json'), 'utf8'),
    ) as { name: string; version: string };
    const packedItem = npmPackOutput(JSON.parse(pack.stdout), sourcePackage);
    const archive = join(artifacts, packedItem.filename);
    const extracted = join(output, 'installed');
    mkdirSync(extracted);
    expect(invoke('extract', 'tar', ['-xzf', archive, '-C', extracted], repository).status).toBe(0);
    const packaged = join(extracted, 'package');
    linkRuntimePackageDependencies(join(repository, 'packages/cli'), packaged);
    const adopter = join(output, 'adopter');
    mkdirSync(adopter);
    const title = 'executes the original semantic assertion';
    const file = 'backend/tests/one.test.ts';
    const id = `test:v1:${encodeURIComponent(JSON.stringify([population.projectId, file, [], title]))}`;
    put(adopter, '.gitignore', 'node_modules/\n.devai/state/\nrecord/\nscratch/\n');
    put(adopter, 'package.json', {
      name: 'canonical-config-adopter',
      version: '0.0.0',
      private: true,
      type: 'module',
      devDependencies: {
        vitest: '4.1.11',
        vite: '7.3.6',
        '@aarusso-nyx/devai': JSON.parse(readFileSync(join(packaged, 'package.json'), 'utf8'))
          .version,
      },
    });
    put(adopter, 'backend/package.json', { private: true, type: 'module' });
    put(
      adopter,
      file,
      `import {it,expect} from 'vitest'; it('${title}',()=>expect(6*7).toBe(42));\n`,
    );
    put(
      adopter,
      config,
      "import {fileURLToPath} from 'node:url'; export default {root:fileURLToPath(new URL('../../../backend',import.meta.url)),test:{name:'canonical-config-fixture',include:['tests/*.test.ts'],pool:'forks',maxWorkers:1,watch:false,coverage:{enabled:false}}};\n",
    );
    installNativeVitest(repository, adopter);
    mkdirSync(join(adopter, 'node_modules/@aarusso-nyx'), { recursive: true });
    symlinkSync(packaged, join(adopter, 'node_modules/@aarusso-nyx/devai'), 'dir');
    const aliases = join(output, 'native-bin');
    mkdirSync(aliases);
    const manifest = JSON.parse(
      readFileSync(join(adopter, 'node_modules/vitest/package.json'), 'utf8'),
    ) as { bin: { vitest: string } };
    const runner = realpathSync(join(adopter, 'node_modules/vitest', manifest.bin.vitest));
    symlinkSync(runner, join(aliases, 'canonical-native-vitest'));
    environment.PATH = `${aliases}:${environment.PATH ?? ''}`;
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Independent Inspector',
          '-c',
          'user.email=inspector@example.invalid',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ],
        { cwd: adopter, env: environment, encoding: 'utf8' },
      ).trim();
    git('init', '-q', '-b', 'main');
    const bin = join(packaged, 'dist/runtime/index/bin.js');
    for (const [label, flags] of [
      ['constitution', ['--constitution', '--tier', 'tier1']],
      ['operational', ['--operational-law']],
      ['subprocess', ['--subprocess-effects']],
      ['default', []],
    ] as const) {
      const result = invoke(
        `bind-${label}`,
        process.execPath,
        [
          bin,
          'init',
          'bind',
          ...flags,
          '--target',
          '.',
          '--as-role',
          'architect',
          '--write',
          '--format',
          'json',
        ],
        adopter,
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).ok).toBe(true);
    }
    put(adopter, 'test-tasks.json', {
      schemaVersion: '1.0.0',
      descriptorVersion: 'canonical-config-v1',
      repositoryId: 'canonical-config-fixture',
      fallbackNodeId: 'native',
      dynamicFallbackSelectors: [],
      profiles: [],
      tasks: [
        {
          nodeId: 'native',
          sensorKinds: ['unit_test'],
          dependencies: [],
          cwd: '.',
          runner: 'exec-v1',
          argv: ['canonical-native-vitest', ...words(), '--no-cache'],
          inputSelectors: [{ kind: 'glob', pattern: '**/*' }],
          toolchainKeys: [],
          allowlistedEnv: [],
          outputContract: {
            kind: 'command-result',
            population: 'canonical-config-v1',
            resultPopulation: { ...population, requiredTestIds: [id] },
          },
        },
      ],
    });
    git('add', '-A');
    git('commit', '-qm', 'test: original semantic collection and tools config');
    const commit = git('rev-parse', 'HEAD');
    const run = invoke(
      'native-execute',
      process.execPath,
      [
        bin,
        'sense',
        'run',
        'unit_test',
        '--input',
        JSON.stringify({ taskId: 'native', population: 'canonical-config-v1' }),
        '--repo-root',
        '.',
        '--as-role',
        'inspector',
        '--write',
        '--format',
        'json',
      ],
      adopter,
    );
    // Parse the entire original JSON envelope; no line filtering, forged nonce or synthetic origin.
    const envelope = JSON.parse(run.stdout);
    const body = envelope.result?.value;
    const result = body?.results?.[0];
    const reading = result?.stdout === undefined ? undefined : JSON.parse(result.stdout);
    const outcome = {
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8',
      }).trim(),
      sourceNativeRunnerSha256: createHash('sha256')
        .update(
          readFileSync(
            join(repository, 'packages/cli/src/commands/sense/native-runner-selection.ts'),
          ),
        )
        .digest('hex'),
      sourceTrackedChanges: execFileSync('git', ['diff', '--name-only'], {
        cwd: repository,
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .filter(Boolean),
      adopterCommit: commit,
      tarball: archive,
      tarballSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
      status: run.status,
      envelope,
      rawOutputDirectory: output,
    };
    writeFileSync(
      join(tmpdir(), 'devai-canonical-config-argv-packaged-latest.json'),
      JSON.stringify(outcome, null, 2),
    );
    expect(run.status, JSON.stringify(reading?.findings ?? envelope)).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(reading.status).toBe('pass');
    expect(reading.metrics.native_collection_nonce).toMatch(/^[a-f0-9]{64}$/u);
    expect(reading.metrics.candidate_commit).toBe(commit);
    const effective = JSON.parse(reading.metrics.native_effective_command) as { argv: string[] };
    const configIndex = effective.argv.indexOf('--config');
    expect(configIndex).toBeGreaterThan(0);
    expect(effective.argv[configIndex + 1]).toBe(realpathSync(join(adopter, config)));
    const originalDescriptor = JSON.parse(readFileSync(join(adopter, 'test-tasks.json'), 'utf8'));
    expect(originalDescriptor.tasks[0].argv).toEqual([
      'canonical-native-vitest',
      ...words(),
      '--no-cache',
    ]);
    const nativePopulation = JSON.parse(reading.metrics.native_result_population);
    expect(nativePopulation.executedTestIds).toEqual([id]);
    expect(nativePopulation.failedTestIds).toEqual([]);
    expect(nativePopulation.skippedTestIds).toEqual([]);

    expect(
      reading.findings.some((finding: { code: string }) =>
        finding.code.startsWith('NATIVE_INPUT_EXTERNAL_PATH'),
      ),
    ).toBe(false);
    const chain = JSON.parse(readFileSync(join(adopter, 'record/proofs/chain.json'), 'utf8')) as {
      records: { action: string; status: string; context: { git: { head_sha: string } } }[];
    };
    expect(
      chain.records.some(
        (record) =>
          record.action === 'sense.task.execute' &&
          record.status === 'completed' &&
          record.context.git.head_sha === commit,
      ),
    ).toBe(true);
    expect(chain.records.some((record) => record.action === 'sense.readings.record')).toBe(false);
    put(output, 'outside.txt', 'controlled external fixture bytes\n');
    put(
      adopter,
      file,
      `import {it,expect} from 'vitest'; import {readFileSync} from 'node:fs'; it('${title}',()=>expect(readFileSync(${JSON.stringify(join(output, 'outside.txt'))},'utf8')).toBe('controlled external fixture bytes\\n'));\n`,
    );
    git('add', '-A');
    git('commit', '-qm', 'test: actual external read remains refused');
    const negative = invoke(
      'native-external-negative',
      process.execPath,
      [
        bin,
        'sense',
        'run',
        'unit_test',
        '--input',
        JSON.stringify({ taskId: 'native', population: 'canonical-config-v1' }),
        '--repo-root',
        '.',
        '--as-role',
        'inspector',
        '--write',
        '--format',
        'json',
      ],
      adopter,
    );
    const negativeEnvelope = JSON.parse(negative.stdout);
    const negativeReading = JSON.parse(negativeEnvelope.result.value.results[0].stdout);
    expect(negative.status).not.toBe(0);
    expect(negativeReading.status).toBe('unknown');
    expect(
      negativeReading.findings.some((finding: { code: string }) =>
        finding.code.startsWith('NATIVE_INPUT_EXTERNAL_PATH'),
      ),
    ).toBe(true);
  }, 240_000);
});
