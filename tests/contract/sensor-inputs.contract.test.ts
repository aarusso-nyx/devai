// ADR-SCR-0005: DEVAI's own .devai/config/sensor-inputs.json is a declaration under
// law/schemas/sensor-inputs.schema.json. This contract pins that the committed file and
// the empty adopter default validate, that every kind they (and the schema) name is a
// registered sensor kind in law/policy/sensor-registry.json, and that the schema itself
// refuses the shapes sense run must refuse: an undeclared key, a kind the registry does
// not hold, a kind that takes no input, and a path that leaves the repository root.
//
// Interface assumptions: none beyond the committed files. The registry is read from
// law/policy/sensor-registry.json, the Architect source the runtime registry is
// generated from. ADR-SCR-0007 adds the governed e2e argv, the local coverage population and
// exclusions, the LOCAL_INCLUDE population contract, and the local coverage producer, whose
// exports tests/config/local.coverage.config.ts defines.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LOCAL_INCLUDE, RC_ONLY } from '../config/local.config.js';
import localCoverageConfig, {
  LOCAL_COVERAGE_EXCLUSIONS,
  LOCAL_COVERAGE_POPULATION,
  LOCAL_COVERAGE_REPORT,
  LOCAL_COVERAGE_SIDECAR,
  PopulationSidecarReporter,
  localCoverageSidecar,
  measuredFileCount,
  runSelector,
} from '../config/local.coverage.config.js';
import rcE2eConfig from '../config/rc.e2e.config.js';

const FAKE_COMMIT = 'c'.repeat(40);

const FAKE_TEST_FILES = ['packages/a/tests/a.test.ts', 'packages/b/tests/b.test.ts'] as const;

/** A repository whose declared population is exactly `FAKE_TEST_FILES`. */
function fakeRepository(directory: string): string {
  const root = join(directory, 'repository');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), `${FAKE_COMMIT}\n`, 'utf8');
  for (const file of FAKE_TEST_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '', 'utf8');
  }
  return root;
}

function fakeModules(root: string, files: readonly string[]): never {
  return files.map((file) => ({ moduleId: join(root, file) })) as never;
}

/** A vitest whose resolved configuration is the producer's own, with `config` overriding it. */
function fakeVitest(config: Readonly<Record<string, unknown>> = {}): never {
  return {
    config: {
      filters: [],
      include: [...LOCAL_INCLUDE],
      exclude: [...(localCoverageConfig.test?.exclude ?? [])],
      project: [],
      ...config,
    },
    version: '9.9.9',
  } as never;
}

const ROOT = resolve(import.meta.dirname, '../..');
const SCHEMA_PATH = resolve(ROOT, 'law/schemas/sensor-inputs.schema.json');
const DECLARATION_PATH = resolve(ROOT, '.devai/config/sensor-inputs.json');
const ADOPTER_DEFAULT_PATH = resolve(ROOT, 'law/policy/adopter-defaults/sensor-inputs.json');
const REGISTRY_PATH = resolve(ROOT, 'law/policy/sensor-registry.json');

interface Declaration {
  readonly schemaVersion: string;
  readonly inputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const schema = readJson<{
  readonly properties: {
    readonly inputs: { readonly properties: Readonly<Record<string, unknown>> };
  };
  readonly examples?: readonly unknown[];
}>(SCHEMA_PATH);
const declaration = readJson<Declaration>(DECLARATION_PATH);
const registry = readJson<{ readonly entries: readonly { readonly kind: string }[] }>(
  REGISTRY_PATH,
);
const registeredKinds = new Set(registry.entries.map((entry) => entry.kind));

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(schema);

function valid(instance: unknown): boolean {
  return validate(instance);
}

describe('DEVAI sensor inputs declaration', () => {
  it('validates against law/schemas/sensor-inputs.schema.json', () => {
    const ok = validate(declaration);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('names only registered sensor kinds', () => {
    const kinds = Object.keys(declaration.inputs);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(registeredKinds.has(kind), `${kind} is not in sensor-registry.json`).toBe(true);
    }
  });

  it('declares the framework layout the ADR records', () => {
    expect(declaration.inputs['spec_depth']).toEqual({
      adrDir: 'law/adr',
      invariantsDir: 'law/invariants',
    });
    for (const kind of [
      'test_security_coverage',
      'test_performance_coverage',
      'test_robustness_coverage',
      'test_idiomaticity',
    ]) {
      expect(declaration.inputs[kind]).toEqual({ testGlobs: ['packages/*/tests', 'tests'] });
    }
    expect(declaration.inputs['action_effect_inference']).toEqual({
      tsconfigPath: 'tests/config/tsconfig.effects.json',
    });
    expect(declaration.inputs['type_check']).toEqual({
      argv: ['npx', 'tsc', '--noEmit', '-p', 'tsconfig.typecheck.json'],
    });
  });

  it('declares directories and projects that exist inside the repository', () => {
    const spec = declaration.inputs['spec_depth'] ?? {};
    for (const dir of [spec['adrDir'], spec['invariantsDir']]) {
      expect(typeof dir).toBe('string');
      expect(statSync(resolve(ROOT, dir as string)).isDirectory()).toBe(true);
    }
    const tsconfig = declaration.inputs['action_effect_inference']?.['tsconfigPath'];
    expect(existsSync(resolve(ROOT, tsconfig as string))).toBe(true);

    // Every declared test root expands to at least one directory; a wildcard segment
    // expands against the directory before it.
    const globs = declaration.inputs['test_security_coverage']?.['testGlobs'] as string[];
    for (const glob of globs) {
      const [before, after] = glob.split('/*/');
      const expanded =
        after === undefined
          ? [resolve(ROOT, glob)]
          : readdirSync(resolve(ROOT, before as string)).map((entry) =>
              resolve(ROOT, before as string, entry, after),
            );
      expect(
        expanded.some((dir) => existsSync(dir) && statSync(dir).isDirectory()),
        `${glob} expands to no directory`,
      ).toBe(true);
    }
  });

  it('declares a type check argv that names an existing typecheck project', () => {
    const argv = declaration.inputs['type_check']?.['argv'] as string[];
    expect(argv.slice(0, 4)).toEqual(['npx', 'tsc', '--noEmit', '-p']);
    expect(existsSync(resolve(ROOT, argv[4] as string))).toBe(true);
  });

  it('declares a performance argv whose vitest configuration and scope exist', () => {
    const argv = declaration.inputs['perf_test']?.['argv'] as string[];
    expect(argv.slice(0, 3)).toEqual(['pnpm', 'vitest', 'run']);
    const config = argv[argv.indexOf('--config') + 1] as string;
    expect(existsSync(resolve(ROOT, config))).toBe(true);
    expect(statSync(resolve(ROOT, argv[argv.length - 1] as string)).isDirectory()).toBe(true);
  });

  it.each([
    ['unit_test', 'tests/contract'],
    ['integration_test', 'tests/integration'],
  ])('declares the %s suite argv in the governed vitest shape over %s', (kind, dir) => {
    const argv = declaration.inputs[kind]?.['argv'] as string[];
    expect(argv).toEqual([
      'pnpm',
      'vitest',
      'run',
      '--config',
      'tests/config/local.config.ts',
      dir,
    ]);
    expect(existsSync(resolve(ROOT, argv[4] as string))).toBe(true);
    expect(statSync(resolve(ROOT, dir)).isDirectory()).toBe(true);
  });

  // ADR-SCR-0007: the e2e argv names the governed e2e configuration and appends no test
  // path; the configuration's own include selects the population.
  it('declares the e2e_test argv as the governed rc.e2e configuration with no test path', () => {
    const argv = declaration.inputs['e2e_test']?.['argv'] as string[];
    expect(argv).toEqual(['pnpm', 'vitest', 'run', '--config', 'tests/config/rc.e2e.config.ts']);
    expect(existsSync(resolve(ROOT, argv[4] as string))).toBe(true);
    expect(rcE2eConfig.test?.include).toEqual(['tests/e2e/**/*.test.ts']);
    expect(rcE2eConfig.test?.exclude).toContain('tests/e2e/inventory-sensors.smoke.test.ts');
  });

  // ADR-SCR-0007: the coverage input names the local report, its population, and the
  // RC-only suites the local producer leaves out, one by one.
  it('declares the local coverage population and its exclusions', () => {
    expect(declaration.inputs['test_coverage_depth']).toEqual({
      coveragePath: 'scratch/coverage/local/coverage-final.json',
      population: 'local',
      exclusions: [
        'packages/authority/tests/unit/authority-resource-boundaries.red.test.ts',
        'packages/skills/tests/recipes/adapters.test.ts',
        'tests/integration/authority-effect-postgres.db.test.ts',
        'tests/integration/runtime-probe-data.integration.test.ts',
      ],
    });
    const input = declaration.inputs['test_coverage_depth'] ?? {};
    expect(input['exclusions']).toEqual([...RC_ONLY]);
    expect(input['exclusions']).toEqual([...LOCAL_COVERAGE_EXCLUSIONS]);
    expect(input['population']).toBe(LOCAL_COVERAGE_POPULATION);
    expect(input['coveragePath']).toBe(LOCAL_COVERAGE_REPORT);
    for (const excluded of input['exclusions'] as string[]) {
      expect(existsSync(resolve(ROOT, excluded)), `${excluded} does not exist`).toBe(true);
    }
  });
});

// ADR-SCR-0007 IA-005: LOCAL_INCLUDE is the population of pnpm test, test:local-full, and the
// local coverage producer. It selects nothing under tests/e2e or tests/regression; a change
// that adds either fails this contract.
const OUT_OF_POPULATION = [
  'tests/e2e/usage-exit-codes.e2e.test.ts',
  'tests/e2e/nested/fixture.test.ts',
  'tests/regression/evidence-chain-100-event.regression.test.ts',
  'tests/regression/nested/fixture.test.ts',
] as const;

function populationDefects(include: readonly string[]): readonly string[] {
  return OUT_OF_POPULATION.flatMap((file) =>
    include
      .filter((glob) => matchesGlob(file, glob))
      .map((glob) => `${glob} selects ${file}, outside the local population`),
  );
}

describe('local test population (ADR-SCR-0007 IA-005)', () => {
  it('selects nothing under tests/e2e or tests/regression', () => {
    expect(populationDefects(LOCAL_INCLUDE)).toEqual([]);
  });

  it('still selects the declared local suites', () => {
    for (const file of [
      'packages/cli/tests/unit/fixture.test.ts',
      'packages/sensors/tests/fixture.spec.ts',
      'tests/contract/fixture.test.ts',
      'tests/integration/fixture.test.ts',
    ]) {
      expect(
        LOCAL_INCLUDE.some((glob) => matchesGlob(file, glob)),
        file,
      ).toBe(true);
    }
  });

  it.each([['tests/e2e/**/*.test.ts'], ['tests/regression/**/*.test.ts'], ['tests/**/*.test.ts']])(
    'fails the population contract when LOCAL_INCLUDE gains %s',
    (glob) => {
      const defects = populationDefects([...LOCAL_INCLUDE, glob]);
      expect(defects.length).toBeGreaterThan(0);
      expect(defects.every((defect) => defect.startsWith(glob))).toBe(true);
    },
  );
});

// ADR-SCR-0007: tests/config/local.coverage.config.ts is the database-free producer of the
// declared report. It runs LOCAL_INCLUDE, excludes exactly the declared exclusions, writes
// the JSON report into the declared directory, enforces no threshold, and never reads
// DEVAI_DB_TESTS. Its population.json sidecar names the population, the include globs, the
// excluded suites, and the count of files measured.
describe('local coverage producer configuration (ADR-SCR-0007)', () => {
  const COVERAGE_CONFIG_PATH = resolve(ROOT, 'tests/config/local.coverage.config.ts');
  const test = localCoverageConfig.test ?? {};
  const coverage = (test.coverage ?? {}) as Readonly<Record<string, unknown>>;
  const input = declaration.inputs['test_coverage_depth'] ?? {};

  it('runs LOCAL_INCLUDE and excludes exactly the declared exclusions', () => {
    expect(test.include).toEqual([...LOCAL_INCLUDE]);
    const exclude = (test.exclude ?? []).filter(
      (glob) => glob !== '**/node_modules/**' && glob !== '**/dist/**',
    );
    expect(exclude).toEqual(input['exclusions']);
    expect(test.passWithNoTests).toBe(false);
  });

  it('writes the JSON report into the directory of the declared coveragePath', () => {
    expect(coverage['enabled']).toBe(true);
    expect(coverage['provider']).toBe('v8');
    expect(coverage['reporter']).toContain('json');
    expect(`${String(coverage['reportsDirectory'])}/coverage-final.json`).toBe(
      input['coveragePath'],
    );
    expect(coverage['thresholds']).toBeUndefined();
  });

  it('has no DEVAI_DB_TESTS gate and selects nothing under tests/e2e or tests/regression', () => {
    const source = readFileSync(COVERAGE_CONFIG_PATH, 'utf8');
    expect(source).not.toMatch(/process\.env/u);
    expect(populationDefects(test.include ?? [])).toEqual([]);
  });

  it('writes the population sidecar beside the report after a passing run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'devai-local-coverage-sidecar-'));
    try {
      const repoRoot = fakeRepository(directory);
      const sidecarPath = join(directory, 'local', 'population.json');
      const reportPath = join(directory, 'local', 'coverage-final.json');
      const reporter = new PopulationSidecarReporter(sidecarPath, reportPath, repoRoot);
      reporter.onInit(fakeVitest({}));
      reporter.onCoverage({ files: () => ['a.ts', 'b.ts', 'c.ts'] });
      await reporter.onTestRunEnd(fakeModules(repoRoot, FAKE_TEST_FILES), [], 'passed');
      // Vitest writes the report after the run ends; the sidecar waits for it.
      expect(existsSync(sidecarPath)).toBe(false);
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, '{}\n', 'utf8');
      reporter.onFinishedReportCoverage();
      const written = readFileSync(sidecarPath, 'utf8');
      const binding = {
        commit: FAKE_COMMIT,
        producer: { name: 'devai-local-coverage-producer', version: '9.9.9' },
        selector: 'full-suite',
        reportSha256: createHash('sha256').update('{}\n').digest('hex'),
      };
      expect(JSON.parse(written)).toEqual({
        schemaVersion: '1.0.0',
        population: 'local',
        include: [...LOCAL_INCLUDE],
        exclusions: input['exclusions'],
        filesMeasured: 3,
        testFiles: 2,
        binding,
      });
      expect(written).toBe(
        `${JSON.stringify(localCoverageSidecar({ filesMeasured: 3, testFiles: 2, binding }), null, 2)}\n`,
      );
      expect(LOCAL_COVERAGE_SIDECAR).toBe(
        `${dirname(input['coveragePath'] as string)}/population.json`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records a narrowed run by what narrowed it, never as the full suite (#336)', () => {
    expect(runSelector({ filters: [] })).toBe('full-suite');
    expect(runSelector({ filters: ['packages/cli/tests/unit/a.test.ts'] })).toBe(
      'files packages/cli/tests/unit/a.test.ts',
    );
    expect(runSelector({ filters: [], testNamePattern: /x/u })).toBe('test name pattern');
    expect(runSelector({ filters: [], shard: { index: 1, count: 2 } })).toBe('shard');
    expect(runSelector({ filters: [], changed: true })).toBe('changed files');
    expect(runSelector({ filters: [], changed: false })).toBe('full-suite');
    expect(runSelector({ filters: [], project: ['unit'] })).toBe('project unit');
    expect(runSelector({ filters: [], exclude: ['**/node_modules/**'] })).toBe(
      'exclude differs from the declared exclusions',
    );
    expect(runSelector({ filters: [], include: ['tests/unit/**'] })).toBe(
      'include differs from the declared population',
    );
  });

  it('records a run that executed fewer files than the population as a subset (#336)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'devai-local-coverage-sidecar-'));
    try {
      const sidecarPath = join(directory, 'population.json');
      const reportPath = join(directory, 'coverage-final.json');
      writeFileSync(reportPath, '{}\n', 'utf8');
      const repoRoot = fakeRepository(directory);
      const selectorOf = async (
        files: readonly string[],
        config: Readonly<Record<string, unknown>> = {},
      ): Promise<string> => {
        const reporter = new PopulationSidecarReporter(sidecarPath, reportPath, repoRoot);
        reporter.onInit(fakeVitest(config));
        reporter.onCoverage({ 'a.ts': {} });
        await reporter.onTestRunEnd(fakeModules(repoRoot, files), [], 'passed');
        reporter.onFinishedReportCoverage();
        return (JSON.parse(readFileSync(sidecarPath, 'utf8')) as { binding: { selector: string } })
          .binding.selector;
      };
      expect(await selectorOf(FAKE_TEST_FILES)).toBe('full-suite');
      // A file left out, whatever left it out (`--exclude`, `--project`, a shard, a filter).
      expect(await selectorOf(FAKE_TEST_FILES.slice(0, 1))).toBe('1 of 2 declared test files');
      // A run narrowed with `--exclude` records the extra exclusion even before files differ.
      expect(
        await selectorOf(FAKE_TEST_FILES, {
          exclude: [...(localCoverageConfig.test?.exclude ?? []), 'packages/b/**'],
        }),
      ).toBe('exclude differs from the declared exclusions');
      expect(await selectorOf(FAKE_TEST_FILES, { project: ['unit'] })).toBe('project unit');
      expect(await selectorOf(FAKE_TEST_FILES, { testNamePattern: /x/u })).toBe(
        'test name pattern',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes a stale sidecar and writes none after a failed run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'devai-local-coverage-sidecar-'));
    try {
      const sidecarPath = join(directory, 'population.json');
      writeFileSync(sidecarPath, '{"population":"rc"}\n', 'utf8');
      const reporter = new PopulationSidecarReporter(
        sidecarPath,
        join(directory, 'coverage-final.json'),
        fakeRepository(directory),
      );
      reporter.onInit(fakeVitest());
      expect(existsSync(sidecarPath)).toBe(false);
      reporter.onCoverage({ 'a.ts': {} });
      await reporter.onTestRunEnd([], [], 'failed');
      reporter.onFinishedReportCoverage();
      expect(existsSync(sidecarPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('counts the per-file entries of a coverage map or a plain report', () => {
    expect(measuredFileCount({ files: () => ['a.ts', 'b.ts'] })).toBe(2);
    expect(measuredFileCount({ 'a.ts': {}, 'b.ts': {}, 'c.ts': {} })).toBe(3);
    expect(measuredFileCount(null)).toBe(0);
  });
});

// ADR-AUT-0002 IA-005 and template pnpm-recursive-build (argv_precedence, conflict_code):
// a test-tasks.json build node is the build sensor's command, and a build declaration whose
// argv differs from that node is a declaration defect this contract rejects naming both argv.
const DESCRIPTOR_PATH = resolve(ROOT, 'test-tasks.json');

function descriptorBuildArgv(descriptor: unknown): readonly string[] | undefined {
  const tasks = (descriptor as { readonly tasks?: readonly Record<string, unknown>[] }).tasks;
  const node = tasks?.find((task) => task['nodeId'] === 'build');
  return Array.isArray(node?.['argv']) ? (node['argv'] as readonly string[]) : undefined;
}

function buildDeclarationDefect(descriptor: unknown, candidate: Declaration): string | undefined {
  const declared = candidate.inputs['build']?.['argv'];
  const node = descriptorBuildArgv(descriptor);
  if (!Array.isArray(declared) || node === undefined) return undefined;
  if (JSON.stringify(declared) === JSON.stringify(node)) return undefined;
  return (
    `BUILD_ARGV_CONFLICT: test-tasks.json build node argv ${JSON.stringify(node)} differs ` +
    `from the declared build argv ${JSON.stringify(declared)}`
  );
}

describe('build declaration precedence (ADR-AUT-0002 IA-005)', () => {
  const descriptor = readJson<unknown>(DESCRIPTOR_PATH);

  it('pins the descriptor build node and DEVAI declaring no build input', () => {
    expect(descriptorBuildArgv(descriptor)).toEqual(['pnpm', '-r', 'build']);
    expect(declaration.inputs['build']).toBeUndefined();
  });

  it('finds no build declaration defect in the committed declaration', () => {
    const defect = buildDeclarationDefect(descriptor, declaration);
    expect(defect, defect).toBeUndefined();
  });

  it('accepts a schema-valid build input beside a node with the same argv', () => {
    const same: Declaration = {
      schemaVersion: '1.0.0',
      inputs: { build: { argv: ['pnpm', '-r', 'build'] } },
    };
    expect(valid(same)).toBe(true);
    expect(buildDeclarationDefect(descriptor, same)).toBeUndefined();
  });

  it.each([
    ['another script', ['pnpm', '-r', 'compile']],
    ['an extra argument', ['pnpm', '-r', 'build', '--filter', 'cli']],
    ['another executable', ['npm', 'run', 'build']],
  ] as const)('rejects a schema-valid build input with %s, naming both argv', (_label, argv) => {
    const conflicting: Declaration = {
      schemaVersion: '1.0.0',
      inputs: { build: { argv: [...argv] } },
    };
    expect(valid(conflicting)).toBe(true);
    const defect = buildDeclarationDefect(descriptor, conflicting);
    expect(defect).toContain('BUILD_ARGV_CONFLICT');
    expect(defect).toContain(JSON.stringify(['pnpm', '-r', 'build']));
    expect(defect).toContain(JSON.stringify(argv));
  });

  it('admits a build input when the descriptor has no build node', () => {
    const adopter: Declaration = {
      schemaVersion: '1.0.0',
      inputs: { build: { argv: ['pnpm', '-r', 'compile'], cwd: 'app' } },
    };
    expect(valid(adopter)).toBe(true);
    expect(buildDeclarationDefect({ tasks: [] }, adopter)).toBeUndefined();
  });
});

describe('sensor inputs schema', () => {
  it('keys only registered sensor kinds', () => {
    for (const kind of Object.keys(schema.properties.inputs.properties)) {
      expect(registeredKinds.has(kind), `${kind} is not in sensor-registry.json`).toBe(true);
    }
  });

  it('accepts the empty adopter default and its own examples', () => {
    expect(valid(readJson(ADOPTER_DEFAULT_PATH))).toBe(true);
    expect(readJson<Declaration>(ADOPTER_DEFAULT_PATH).inputs).toEqual(ADOPTER_HARNESS_POPULATIONS);
    for (const example of schema.examples ?? []) expect(valid(example)).toBe(true);
  });

  const refused: readonly (readonly [string, unknown])[] = [
    ['an undeclared key', { schemaVersion: '1.0.0', inputs: { spec_depth: { adrRoot: 'x' } } }],
    [
      'a kind that is not registered',
      { schemaVersion: '1.0.0', inputs: { not_a_sensor: { testGlobs: ['tests'] } } },
    ],
    [
      'a registered kind that takes no input',
      { schemaVersion: '1.0.0', inputs: { lint: { argv: ['eslint', '.'] } } },
    ],
    ['a kind with no key', { schemaVersion: '1.0.0', inputs: { spec_depth: {} } }],
    ['a parent segment', { schemaVersion: '1.0.0', inputs: { spec_depth: { adrDir: '../adr' } } }],
    [
      'an embedded parent segment',
      { schemaVersion: '1.0.0', inputs: { spec_depth: { adrDir: 'law/../../adr' } } },
    ],
    [
      'an absolute path',
      { schemaVersion: '1.0.0', inputs: { test_coverage_depth: { coveragePath: '/etc/passwd' } } },
    ],
    [
      'a test root leaving the repository',
      { schemaVersion: '1.0.0', inputs: { test_idiomaticity: { testGlobs: ['../*/tests'] } } },
    ],
    [
      'a wildcard in a plain path',
      { schemaVersion: '1.0.0', inputs: { action_effect_inference: { tsconfigPath: '*.json' } } },
    ],
    ['an empty argv', { schemaVersion: '1.0.0', inputs: { type_check: { argv: [] } } }],
    [
      'a shell-joined script name',
      { schemaVersion: '1.0.0', inputs: { perf_test: { scriptName: 'bench && rm -rf .' } } },
    ],
    ['an unknown schema version', { schemaVersion: '2.0.0', inputs: {} }],
    ['an extra top-level key', { schemaVersion: '1.0.0', inputs: {}, overrides: {} }],
  ];

  for (const [label, instance] of refused) {
    it(`refuses ${label}`, () => {
      expect(valid(instance)).toBe(false);
    });
  }
});

// ADR-SCR-0010 IA-004: a harness population names its workflow, event, and minimum sample, and
// names only an event the workflow carries under its on: block and only jobs it defines.
const POPULATION_KINDS = [
  'harness_green_main',
  'harness_performance',
  'harness_robustness',
] as const;
const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');

const EXCLUDED_RELEASE_JOBS = [
  { workflow: 'release.yml', job: 'verify-ledger' },
  { workflow: 'release.yml', job: 'build-release' },
  { workflow: 'release.yml', job: 'finalize-release' },
  { workflow: 'release.yml', job: 'deploy-pages' },
];

function devaiPopulation(minimumSample: number): Record<string, unknown> {
  return {
    workflow: 'pull-request-checks.yml',
    event: 'pull_request',
    headBranch: '*',
    baseBranch: 'main',
    attempts: 'last',
    includeCancelled: false,
    lookbackDays: 30,
    minimumSample,
    excludedJobs: EXCLUDED_RELEASE_JOBS,
  };
}

const DEVAI_HARNESS_POPULATIONS = {
  // ADR-SCR-0014: DEVAI counts one gate outcome per pull request on its final head.
  harness_green_main: { ...devaiPopulation(20), outcomeUnit: 'pull-request-final-head' },
  harness_performance: devaiPopulation(10),
  harness_robustness: devaiPopulation(20),
};

function adopterPopulation(minimumSample: number): Record<string, unknown> {
  return {
    workflow: 'ci.yml',
    event: 'pull_request',
    headBranch: '*',
    baseBranch: 'main',
    attempts: 'last',
    includeCancelled: false,
    lookbackDays: 30,
    minimumSample,
    excludedJobs: [],
  };
}

const ADOPTER_HARNESS_POPULATIONS = {
  harness_green_main: adopterPopulation(20),
  harness_performance: adopterPopulation(10),
  harness_robustness: adopterPopulation(20),
};

interface WorkflowShape {
  readonly events: readonly string[];
  readonly jobs: readonly string[];
}

function workflowShape(file: string): WorkflowShape | undefined {
  const path = join(WORKFLOWS_DIR, file);
  if (!existsSync(path)) return undefined;
  const doc = parseYaml(readFileSync(path, 'utf8')) as {
    readonly on?: unknown;
    readonly jobs?: Readonly<Record<string, unknown>>;
  };
  const on = doc.on;
  let events: string[] = [];
  if (typeof on === 'string') events = [on];
  else if (Array.isArray(on)) events = on.map(String);
  else if (on !== null && typeof on === 'object') events = Object.keys(on);
  return { events, jobs: Object.keys(doc.jobs ?? {}) };
}

/** The declared-inputs contract: defects of one harness population against the workflow files. */
function harnessPopulationDefects(
  kind: string,
  input: Readonly<Record<string, unknown>>,
): string[] {
  const defects: string[] = [];
  for (const key of ['workflow', 'event', 'minimumSample'] as const) {
    if (input[key] === undefined) defects.push(`${kind}: ${key} is required`);
  }
  const workflow = input['workflow'];
  if (typeof workflow !== 'string') return defects;
  const shape = workflowShape(workflow);
  if (shape === undefined) return [...defects, `${kind}: workflow ${workflow} does not exist`];
  const event = input['event'];
  if (typeof event === 'string' && !shape.events.includes(event)) {
    defects.push(`${kind}: ${workflow} does not carry the ${event} event`);
  }
  const excluded = (input['excludedJobs'] ?? []) as readonly { workflow: string; job: string }[];
  for (const pair of excluded) {
    const owner = workflowShape(pair.workflow);
    if (owner === undefined || !owner.jobs.includes(pair.job)) {
      defects.push(`${kind}: ${pair.workflow} defines no job ${pair.job}`);
    }
  }
  return defects;
}

describe('harness population declaration (ADR-SCR-0010)', () => {
  it('declares DEVAI gate population for the three harness sensors', () => {
    for (const kind of POPULATION_KINDS) {
      expect(declaration.inputs[kind]).toEqual(DEVAI_HARNESS_POPULATIONS[kind]);
    }
  });

  it('declares a minimum sample of twenty, ten successful runs, and twenty', () => {
    expect(declaration.inputs['harness_green_main']?.['minimumSample']).toBe(20);
    expect(declaration.inputs['harness_performance']?.['minimumSample']).toBe(10);
    expect(declaration.inputs['harness_robustness']?.['minimumSample']).toBe(20);
  });

  it('declares a population that is the pull request gate, never main pushes', () => {
    for (const kind of POPULATION_KINDS) {
      const input = declaration.inputs[kind] ?? {};
      expect(input['workflow']).toBe('pull-request-checks.yml');
      expect(input['event']).toBe('pull_request');
      expect(input['headBranch']).toBe('*');
      expect(input['includeCancelled']).toBe(false);
    }
  });

  it('declares only an event its workflow carries and only jobs the workflows define', () => {
    for (const kind of POPULATION_KINDS) {
      expect(harnessPopulationDefects(kind, declaration.inputs[kind] ?? {})).toEqual([]);
    }
  });

  it('leaves the environment-gated release jobs out of every population by identity', () => {
    for (const kind of POPULATION_KINDS) {
      expect(declaration.inputs[kind]?.['excludedJobs']).toEqual(EXCLUDED_RELEASE_JOBS);
    }
  });

  it('declares the adopter default gate population for the three harness sensors', () => {
    const adopter = readJson<Declaration>(ADOPTER_DEFAULT_PATH);
    expect(valid(adopter)).toBe(true);
    for (const kind of POPULATION_KINDS) {
      expect(adopter.inputs[kind]).toEqual(ADOPTER_HARNESS_POPULATIONS[kind]);
    }
  });

  it('flags an event the workflow does not carry', () => {
    const defects = harnessPopulationDefects('harness_green_main', {
      ...devaiPopulation(20),
      event: 'schedule',
    });
    expect(defects).toEqual([
      'harness_green_main: pull-request-checks.yml does not carry the schedule event',
    ]);
  });

  it('flags an excluded job the workflow does not define and a missing workflow file', () => {
    expect(
      harnessPopulationDefects('harness_performance', {
        ...devaiPopulation(10),
        excludedJobs: [{ workflow: 'release.yml', job: 'no-such-job' }],
      }),
    ).toEqual(['harness_performance: release.yml defines no job no-such-job']);
    expect(
      harnessPopulationDefects('harness_robustness', {
        ...devaiPopulation(20),
        workflow: 'absent.yml',
      }),
    ).toEqual(['harness_robustness: workflow absent.yml does not exist']);
  });

  for (const key of ['workflow', 'event', 'minimumSample'] as const) {
    for (const kind of POPULATION_KINDS) {
      it(`rejects a ${kind} declaration that omits ${key}, in the schema and the contract`, () => {
        const { [key]: _omitted, ...rest } = devaiPopulation(20);
        void _omitted;
        expect(valid({ schemaVersion: '1.0.0', inputs: { [kind]: rest } })).toBe(false);
        expect(harnessPopulationDefects(kind, rest)).toContain(`${kind}: ${key} is required`);
      });
    }
  }

  const populationRefused: readonly (readonly [string, Record<string, unknown>])[] = [
    ['an event outside the closed set', { ...devaiPopulation(20), event: 'issues' }],
    ['a workflow with a directory', { ...devaiPopulation(20), workflow: '.github/ci.yml' }],
    ['a workflow that is not a yml file', { ...devaiPopulation(20), workflow: 'ci.txt' }],
    ['a zero minimum sample', { ...devaiPopulation(20), minimumSample: 0 }],
    ['a lookback of zero days', { ...devaiPopulation(20), lookbackDays: 0 }],
    ['a lookback beyond a year', { ...devaiPopulation(20), lookbackDays: 366 }],
    ['attempts other than last or all', { ...devaiPopulation(20), attempts: 'first' }],
    ['a head branch with a parent segment', { ...devaiPopulation(20), headBranch: 'a/../b' }],
    ['a head branch with a leading hyphen', { ...devaiPopulation(20), headBranch: '-x' }],
    ['a base branch of *', { ...devaiPopulation(20), baseBranch: '*' }],
    ['an undeclared population key', { ...devaiPopulation(20), branch: 'main' }],
    [
      'an excluded job with no job key',
      { ...devaiPopulation(20), excludedJobs: [{ workflow: 'release.yml' }] },
    ],
    [
      'a duplicate excluded pair',
      {
        ...devaiPopulation(20),
        excludedJobs: [
          { workflow: 'release.yml', job: 'build-release' },
          { workflow: 'release.yml', job: 'build-release' },
        ],
      },
    ],
  ];

  for (const [label, population] of populationRefused) {
    it(`refuses ${label}`, () => {
      expect(valid({ schemaVersion: '1.0.0', inputs: { harness_green_main: population } })).toBe(
        false,
      );
    });
  }

  it('accepts the minimal population of workflow, event, and minimum sample', () => {
    for (const kind of POPULATION_KINDS) {
      expect(
        valid({
          schemaVersion: '1.0.0',
          inputs: {
            [kind]: { workflow: 'ci.yml', event: 'push', minimumSample: 5 },
          },
        }),
      ).toBe(true);
    }
  });
});

describe('harness_green_main outcomeUnit (ADR-SCR-0014)', () => {
  const minimal = { workflow: 'ci.yml', event: 'pull_request', minimumSample: 5 };

  it.each(['run', 'pull-request-final-head'])(
    'accepts outcomeUnit %s on harness_green_main',
    (unit) => {
      expect(
        valid({
          schemaVersion: '1.0.0',
          inputs: { harness_green_main: { ...minimal, outcomeUnit: unit } },
        }),
      ).toBe(true);
    },
  );

  it.each(['pull-request', 'final-head', 'Run', '', 'per-run'])(
    'refuses outcomeUnit %j on harness_green_main',
    (unit) => {
      expect(
        valid({
          schemaVersion: '1.0.0',
          inputs: { harness_green_main: { ...minimal, outcomeUnit: unit } },
        }),
      ).toBe(false);
    },
  );

  it.each(['harness_performance', 'harness_robustness'])(
    'refuses outcomeUnit on %s, even run',
    (kind) => {
      for (const unit of ['run', 'pull-request-final-head']) {
        expect(
          valid({ schemaVersion: '1.0.0', inputs: { [kind]: { ...minimal, outcomeUnit: unit } } }),
          `${kind} with ${unit}`,
        ).toBe(false);
      }
      expect(valid({ schemaVersion: '1.0.0', inputs: { [kind]: minimal } })).toBe(true);
    },
  );

  it('defaults to run when omitted, and DEVAI declares pull-request-final-head', () => {
    const unit = (
      schema as unknown as {
        $defs: { harness_population_inputs: { properties: { outcomeUnit: { default: string } } } };
      }
    ).$defs.harness_population_inputs.properties.outcomeUnit.default;
    expect(unit).toBe('run');
    expect(declaration.inputs['harness_green_main']?.['outcomeUnit']).toBe(
      'pull-request-final-head',
    );
    expect(declaration.inputs['harness_performance']).not.toHaveProperty('outcomeUnit');
    expect(declaration.inputs['harness_robustness']).not.toHaveProperty('outcomeUnit');
  });
});

// #364 and #365: the harness populations are read through gh argv the subprocess-effects
// policy admits exactly, and DEVAI's materialized copy declares the same templates.
describe('harness gh argv templates (ADR-SCR-0014 IA-006, IA-007)', () => {
  interface Template {
    readonly template_id: string;
    readonly argv_shape: readonly string[];
  }
  const templates = (path: string): Map<string, readonly string[]> =>
    new Map(
      readJson<{ templates: readonly Template[] }>(resolve(path))
        .templates.filter((template) => template.template_id.startsWith('gh-'))
        .map((template) => [template.template_id, template.argv_shape]),
    );
  const law = templates('law/policy/subprocess-effects.json');
  const materialized = templates('.devai/config/subprocess-effects.json');

  it('fixes every run-list shape to the literal limit 1000', () => {
    const runLists = [...law.keys()].filter((id) => id.startsWith('gh-run-list')).sort();
    expect(runLists).toEqual([
      'gh-run-list',
      'gh-run-list-branch',
      'gh-run-list-branch-created',
      'gh-run-list-created',
    ]);
    for (const id of runLists) {
      const argv = law.get(id) ?? [];
      expect(argv.slice(argv.indexOf('--limit'), argv.indexOf('--limit') + 2), id).toEqual([
        '--limit',
        '1000',
      ]);
    }
  });

  it('admits gh pr list only with the base, lifetime and final-head fields', () => {
    expect(law.get('gh-pr-list-all')).toEqual([
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      '1000',
      '--json',
      'baseRefName,closedAt,createdAt,headRefName,headRefOid,mergedAt,number,state',
    ]);
  });

  it('materializes the same gh templates DEVAI law declares', () => {
    expect(materialized).toEqual(law);
  });
});
