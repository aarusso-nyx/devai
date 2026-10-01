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
import {
  existsSync,
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
} from '../config/local.coverage.config.js';
import rcE2eConfig from '../config/rc.e2e.config.js';

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

  it('writes the population sidecar beside the report after a passing run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devai-local-coverage-sidecar-'));
    try {
      const sidecarPath = join(directory, 'local', 'population.json');
      const reporter = new PopulationSidecarReporter(sidecarPath);
      reporter.onInit();
      reporter.onCoverage({ files: () => ['a.ts', 'b.ts', 'c.ts'] });
      reporter.onTestRunEnd([{}, {}] as never, [], 'passed');
      const written = readFileSync(sidecarPath, 'utf8');
      expect(JSON.parse(written)).toEqual({
        schemaVersion: '1.0.0',
        population: 'local',
        include: [...LOCAL_INCLUDE],
        exclusions: input['exclusions'],
        filesMeasured: 3,
        testFiles: 2,
      });
      expect(written).toBe(
        `${JSON.stringify(localCoverageSidecar({ filesMeasured: 3, testFiles: 2 }), null, 2)}\n`,
      );
      expect(LOCAL_COVERAGE_SIDECAR).toBe(
        `${dirname(input['coveragePath'] as string)}/population.json`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes a stale sidecar and writes none after a failed run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devai-local-coverage-sidecar-'));
    try {
      const sidecarPath = join(directory, 'population.json');
      writeFileSync(sidecarPath, '{"population":"rc"}\n', 'utf8');
      const reporter = new PopulationSidecarReporter(sidecarPath);
      reporter.onInit();
      expect(existsSync(sidecarPath)).toBe(false);
      reporter.onCoverage({ 'a.ts': {} });
      reporter.onTestRunEnd([], [], 'failed');
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
    expect(readJson<Declaration>(ADOPTER_DEFAULT_PATH).inputs).toEqual({});
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
