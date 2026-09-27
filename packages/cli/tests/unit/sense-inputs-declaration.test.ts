// ADR-SCR-0005 IA-001 to IA-003 (CLI half): `sense run` reads the adopter declaration at
// .devai/config/sensor-inputs.json, delivers each declared key to its sensor, merges an
// explicit --input over the declaration for the same key and that run only, prints the
// effective inputs per member in a dry run, and refuses an undeclared key, a kind the
// registry does not hold, and a path that resolves outside the repository root with a
// structured error before any sensor executes.
//
// Interface assumptions the engineer (TASK-0223) must meet:
//   1. packages/cli/src/commands/sense/shared.ts exports
//        resolveDeclaredSensorInputs({ repoRoot, sensorKind, explicit? })
//      returning (or resolving to) the effective inputs for that kind: the declared keys
//      of `inputs[sensorKind]` with the keys of `explicit` merged over them, `{}` merged
//      with `explicit` when the file or the kind is absent. Path values may be returned
//      as declared (repository-relative) or resolved; the tests compare real paths.
//   2. It validates the whole declaration file (not only the entry for sensorKind) and
//      throws an Error carrying a string `code` property, with the code also present in
//      `message`:
//        SENSE_INPUTS_UNDECLARED_KEY     a key the schema does not list for that kind,
//                                        including any key under a registered kind that
//                                        takes no declared input (e.g. `lint`);
//        SENSE_INPUTS_UNKNOWN_KIND       a kind (in the file, or the sensorKind argument)
//                                        absent from the sensor registry;
//        SENSE_INPUTS_PATH_ESCAPES_ROOT  a declared path or test root that leaves the
//                                        repository root lexically (`..`, absolute) or
//                                        through a symlink, compared on real paths (the
//                                        temp root itself sits behind /var -> /private/var
//                                        on macOS, which must NOT count as escaping).
//      The tests load it with a dynamic import typed through a local signature, so the
//      type check passes before the export exists.
//   3. `sense run <kind>` and `sense run --preset ...` resolve every member's inputs
//      before any adapter runs; a refusal exits EXIT_USAGE (2) with the code on stderr
//      and nothing on stdout, in real and dry runs alike.
//   4. The dry-run JSON gives every entry of `members` an `effective_inputs` object
//      (`{}` for a kind with nothing declared or explicit).
//   5. Each declared key reaches its sensor function: testGlobs to the four test pattern
//      sensors, adrDir and invariantsDir to senseSpecDepth, coveragePath to the coverage
//      normalizer, tsconfigPath to senseActionEffectInference, argv to senseTypeCheck
//      (`{ cwd, argv }`), scriptName to sensePerfTest (`{ repoRoot, scriptName }`).
//      Real sensors run for the walkers, spec depth, and coverage depth; type check,
//      perf test, and effect inference are stubbed so nothing is spawned.
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
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SensorKind, SensorReading } from '@devai-nyx/sensors';

const adapterCalls = vi.hoisted(
  () => [] as { readonly kind: string; readonly inputs?: Readonly<Record<string, unknown>> }[],
);

const stubs = vi.hoisted(() => ({
  senseTypeCheck: vi.fn(),
  sensePerfTest: vi.fn(),
  senseActionEffectInference: vi.fn(),
}));

vi.mock('@devai-nyx/sensors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/sensors')>();
  const reading = (kind: SensorKind): SensorReading =>
    actual.buildSensorReading({
      sensorName: kind,
      sensorKind: kind,
      command: ['stub', kind],
      status: 'pass',
      deterministic: true,
    });
  stubs.senseTypeCheck.mockImplementation(() => ({
    aggregate: reading('type_check'),
    perProject: [],
  }));
  stubs.sensePerfTest.mockImplementation(() => reading('perf_test'));
  stubs.senseActionEffectInference.mockImplementation(() =>
    Promise.resolve({ report: {}, reading: reading('action_effect_inference') }),
  );
  return { ...actual, ...stubs };
});

vi.mock('../../src/commands/sense/adapters.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/sense/adapters.js')>();
  return {
    ...actual,
    sensorAdapter: (kind: SensorKind) => {
      const adapter = actual.sensorAdapter(kind);
      return (request: Parameters<typeof adapter>[0]) => {
        adapterCalls.push({
          kind,
          ...(request.inputs === undefined ? {} : { inputs: request.inputs }),
        });
        return adapter(request);
      };
    },
  };
});

const { senseRunSetCmd } = await import('../../src/commands/sense/run-set.js');

// ---------------------------------------------------------------------------
// Resolver shim: typed locally so the file type-checks before the export exists.
// ---------------------------------------------------------------------------

type Inputs = Readonly<Record<string, unknown>>;
type ResolveDeclaredSensorInputs = (args: {
  readonly repoRoot: string;
  readonly sensorKind: string;
  readonly explicit?: Inputs;
}) => Inputs | Promise<Inputs>;

async function loadResolver(): Promise<ResolveDeclaredSensorInputs> {
  const shared = (await import('../../src/commands/sense/shared.js')) as unknown as Record<
    string,
    unknown
  >;
  const resolver = shared['resolveDeclaredSensorInputs'];
  if (typeof resolver !== 'function') {
    throw new Error('resolveDeclaredSensorInputs is not exported from sense/shared.ts');
  }
  return resolver as ResolveDeclaredSensorInputs;
}

async function resolveInputs(
  repoRoot: string,
  sensorKind: string,
  explicit?: Inputs,
): Promise<Inputs> {
  const resolver = await loadResolver();
  return await resolver({ repoRoot, sensorKind, ...(explicit === undefined ? {} : { explicit }) });
}

async function refusal(
  repoRoot: string,
  sensorKind: string,
  explicit?: Inputs,
): Promise<{ readonly code: unknown; readonly message: string }> {
  const resolver = await loadResolver();
  try {
    await resolver({ repoRoot, sensorKind, ...(explicit === undefined ? {} : { explicit }) });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return {
      code: (error as { readonly code?: unknown }).code,
      message: (error as Error).message,
    };
  }
  throw new Error(`expected resolveDeclaredSensorInputs to refuse ${sensorKind}`);
}

// ---------------------------------------------------------------------------
// sense run harness (same registration seam as cli-shard09-sense-run-set-command).
// ---------------------------------------------------------------------------

interface Options {
  readonly preset?: string;
  readonly round?: string;
  readonly repoRoot?: string;
  readonly input?: string;
  readonly dryRun?: boolean;
  readonly human?: boolean;
}
type Action = (kind: string | undefined, options: Options) => Promise<void>;
interface Invocation {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;

function senseRunAction(): Action {
  let action: Action | undefined;
  const command = {
    option() {
      return command;
    },
    action(callback: Action) {
      action = callback;
      return command;
    },
  };
  senseRunSetCmd.register({ command: () => command } as unknown as CAC);
  if (action === undefined) throw new Error('SENSE_RUN_ACTION_NOT_REGISTERED');
  return action;
}

async function senseRun(kind: string | undefined, options: Options): Promise<Invocation> {
  let stdout = '';
  let stderr = '';
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await senseRunAction()(kind, options);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  const exit = Number(process.exitCode ?? 0);
  process.exitCode = originalExitCode;
  return { stdout, stderr, exit };
}

function readingOf(invocation: Invocation): SensorReading {
  expect(invocation.stderr).toBe('');
  const output = JSON.parse(invocation.stdout) as {
    readonly results: readonly { readonly stdout: string; readonly stderr: string }[];
  };
  expect(output.results).toHaveLength(1);
  const [result] = output.results;
  expect(result?.stderr).toBe('');
  return JSON.parse(result?.stdout ?? '') as SensorReading;
}

interface DryRunMember {
  readonly kind: string;
  readonly effective_inputs?: Inputs;
}

function dryRunMembers(invocation: Invocation): readonly DryRunMember[] {
  expect(invocation.exit).toBe(0);
  const output = JSON.parse(invocation.stdout) as {
    readonly dry_run: boolean;
    readonly members: readonly DryRunMember[];
  };
  expect(output.dry_run).toBe(true);
  return output.members;
}

// ---------------------------------------------------------------------------
// Temporary repositories.
// ---------------------------------------------------------------------------

const DECLARED = {
  schemaVersion: '1.0.0',
  inputs: {
    test_security_coverage: { testGlobs: ['packages/*/tests', 'tests'] },
    test_performance_coverage: { testGlobs: ['packages/*/tests', 'tests'] },
    test_robustness_coverage: { testGlobs: ['packages/*/tests', 'tests'] },
    test_idiomaticity: { testGlobs: ['packages/*/tests', 'tests'] },
    spec_depth: { adrDir: 'law/adr', invariantsDir: 'spec/invariants' },
    test_coverage_depth: { coveragePath: 'scratch/coverage/rc/coverage-final.json' },
    action_effect_inference: { tsconfigPath: 'tests/config/tsconfig.effects.json' },
    type_check: { argv: ['pnpm', 'run', 'typecheck'] },
    perf_test: { scriptName: 'bench:ci' },
  },
} as const;

const PATH_KEYS = new Set(['adrDir', 'invariantsDir', 'coveragePath', 'tsconfigPath']);
const cleanup: string[] = [];

function write(root: string, rel: string, content: string): void {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function declare(root: string, declaration: unknown): void {
  write(root, '.devai/config/sensor-inputs.json', `${JSON.stringify(declaration, null, 2)}\n`);
}

/** A repository laid out like the framework, with nothing at the sensor defaults. */
function makeRepo(declaration: unknown = DECLARED): string {
  // Deliberately not realpath'd: on macOS tmpdir() sits behind /var -> /private/var.
  const root = mkdtempSync(join(tmpdir(), 'devai-sense-inputs-'));
  cleanup.push(root);
  write(root, 'law/adr/ADR-0001-one.md', '# one\n');
  write(root, 'law/adr/ADR-0002-two.md', '# two\n');
  write(root, 'docs/other-adr/A.md', '# a\n');
  write(root, 'docs/other-adr/B.md', '# b\n');
  write(root, 'docs/other-adr/C.md', '# c\n');
  write(root, 'spec/invariants/INV-1.json', JSON.stringify({ scope: { components: ['core'] } }));
  write(
    root,
    'packages/alpha/tests/auth-bench.test.ts',
    "it('rejects auth under load', () => { expect(() => f()).toThrow(); });\n",
  );
  write(root, 'tests/contract/csrf-latency.spec.ts', "it('csrf p95 latency error', () => {});\n");
  write(
    root,
    'scratch/coverage/rc/coverage-final.json',
    JSON.stringify({ 'src/a.ts': { l: { '1': 1, '2': 1, '3': 0, '4': 1 } } }),
  );
  write(root, 'tests/config/tsconfig.effects.json', '{}\n');
  write(root, 'law/policy/subprocess-effects.json', JSON.stringify({ templates: [] }));
  write(
    root,
    'package.json',
    JSON.stringify({ name: 'fixture', scripts: { typecheck: 'tsc -b', 'bench:ci': 'node b.js' } }),
  );
  if (declaration !== null) declare(root, declaration);
  return root;
}

/** A directory outside every repository root, holding decision records. */
function makeOutside(): string {
  const outside = mkdtempSync(join(tmpdir(), 'devai-sense-outside-'));
  cleanup.push(outside);
  write(outside, 'ADR-0001-stolen.md', '# outside\n');
  write(outside, 'tests/stolen.test.ts', "it('auth', () => {});\n");
  write(outside, 'coverage-final.json', JSON.stringify({ 'x.ts': { l: { '1': 1 } } }));
  return outside;
}

function canonical(root: string, value: string): string {
  const realRoot = realpathSync(root);
  const abs = isAbsolute(value) ? value : resolve(realRoot, value);
  try {
    return realpathSync(abs);
  } catch {
    return abs.startsWith(root) ? realRoot + abs.slice(root.length) : abs;
  }
}

/** Compare effective inputs, treating path values as equal when they name the same path. */
function expectEffective(root: string, actual: Inputs | undefined, expected: Inputs): void {
  expect(actual, 'effective inputs are missing').toBeDefined();
  expect(Object.keys(actual ?? {}).sort()).toEqual(Object.keys(expected).sort());
  for (const [key, value] of Object.entries(expected)) {
    const got = actual?.[key];
    if (PATH_KEYS.has(key)) {
      expect(typeof got, key).toBe('string');
      expect(canonical(root, got as string), key).toBe(canonical(root, value as string));
    } else if (key === 'testGlobs') {
      expect(Array.isArray(got), key).toBe(true);
      expect((got as string[]).map((glob) => canonical(root, glob))).toEqual(
        (value as string[]).map((glob) => canonical(root, glob)),
      );
    } else {
      expect(got, key).toEqual(value);
    }
  }
}

function expectNoSensorExecuted(): void {
  expect(adapterCalls).toEqual([]);
  expect(stubs.senseTypeCheck).not.toHaveBeenCalled();
  expect(stubs.sensePerfTest).not.toHaveBeenCalled();
  expect(stubs.senseActionEffectInference).not.toHaveBeenCalled();
}

beforeEach(() => {
  adapterCalls.length = 0;
  stubs.senseTypeCheck.mockClear();
  stubs.sensePerfTest.mockClear();
  stubs.senseActionEffectInference.mockClear();
});

afterEach(() => {
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  process.exitCode = originalExitCode;
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// IA-001 / IA-002: the resolver merges the declaration and the explicit input.
// ---------------------------------------------------------------------------

describe('resolveDeclaredSensorInputs merges declaration and explicit input', () => {
  it('returns the declared keys for each declared kind', async () => {
    const root = makeRepo();
    for (const [kind, declared] of Object.entries(DECLARED.inputs)) {
      expectEffective(root, await resolveInputs(root, kind), declared);
    }
  });

  it('returns nothing for a registered kind with no declaration', async () => {
    const root = makeRepo();
    expect(await resolveInputs(root, 'lint')).toEqual({});
  });

  it('keeps sensor defaults when no declaration file exists, passing explicit input through', async () => {
    const root = makeRepo(null);
    expect(await resolveInputs(root, 'spec_depth')).toEqual({});
    expect(await resolveInputs(root, 'spec_depth', { adrDir: 'docs/other-adr' })).toEqual({
      adrDir: 'docs/other-adr',
    });
  });

  it('overrides only the explicit key and keeps every other declared key', async () => {
    const root = makeRepo();
    expectEffective(root, await resolveInputs(root, 'spec_depth', { adrDir: 'docs/other-adr' }), {
      adrDir: 'docs/other-adr',
      invariantsDir: 'spec/invariants',
    });
  });

  it('replaces a declared test root list instead of concatenating it', async () => {
    const root = makeRepo();
    expectEffective(
      root,
      await resolveInputs(root, 'test_security_coverage', { testGlobs: ['tests'] }),
      { testGlobs: ['tests'] },
    );
  });

  it('does not leak one kind’s declaration into another kind', async () => {
    const root = makeRepo();
    const effective = await resolveInputs(root, 'type_check');
    expect(Object.keys(effective)).toEqual(['argv']);
  });

  it('never writes the explicit override back to the declaration', async () => {
    const root = makeRepo();
    const path = join(root, '.devai/config/sensor-inputs.json');
    const before = readFileSync(path, 'utf8');
    await resolveInputs(root, 'spec_depth', { adrDir: 'docs/other-adr' });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expectEffective(root, await resolveInputs(root, 'spec_depth'), DECLARED.inputs.spec_depth);
  });

  it('accepts a symlink that stays inside the repository root', async () => {
    const root = makeRepo({ schemaVersion: '1.0.0', inputs: { spec_depth: { adrDir: 'adr' } } });
    symlinkSync(join(root, 'law/adr'), join(root, 'adr'), 'dir');
    const effective = await resolveInputs(root, 'spec_depth');
    expect(canonical(root, effective['adrDir'] as string)).toBe(canonical(root, 'law/adr'));
  });
});

// ---------------------------------------------------------------------------
// IA-003: structured refusal from the resolver.
// ---------------------------------------------------------------------------

describe('resolveDeclaredSensorInputs refuses with a structured error', () => {
  const withInputs = (inputs: unknown) => ({ schemaVersion: '1.0.0', inputs });

  const cases: readonly {
    readonly label: string;
    readonly code: string;
    readonly kind: string;
    readonly declaration?: unknown;
    readonly setup?: (root: string, outside: string) => unknown;
  }[] = [
    {
      label: 'an undeclared key under a declared kind',
      code: 'SENSE_INPUTS_UNDECLARED_KEY',
      kind: 'spec_depth',
      declaration: withInputs({ spec_depth: { adrDir: 'law/adr', adrRoot: 'law/adr' } }),
    },
    {
      label: 'a key under a registered kind that takes no declared input',
      code: 'SENSE_INPUTS_UNDECLARED_KEY',
      kind: 'lint',
      declaration: withInputs({ lint: { argv: ['eslint', '.'] } }),
    },
    {
      label: 'an undeclared key under another kind than the one resolved',
      code: 'SENSE_INPUTS_UNDECLARED_KEY',
      kind: 'spec_depth',
      declaration: withInputs({
        spec_depth: { adrDir: 'law/adr' },
        type_check: { command: 'tsc' },
      }),
    },
    {
      label: 'a kind absent from the registry',
      code: 'SENSE_INPUTS_UNKNOWN_KIND',
      kind: 'spec_depth',
      declaration: withInputs({ spec_depth: { adrDir: 'law/adr' }, spec_depht: { adrDir: 'x' } }),
    },
    {
      label: 'resolving a kind absent from the registry',
      code: 'SENSE_INPUTS_UNKNOWN_KIND',
      kind: 'not_a_sensor',
    },
    {
      label: 'a parent segment',
      code: 'SENSE_INPUTS_PATH_ESCAPES_ROOT',
      kind: 'spec_depth',
      declaration: withInputs({ spec_depth: { adrDir: '../outside' } }),
    },
    {
      label: 'an embedded parent segment',
      code: 'SENSE_INPUTS_PATH_ESCAPES_ROOT',
      kind: 'spec_depth',
      declaration: withInputs({ spec_depth: { invariantsDir: 'law/../../outside' } }),
    },
    {
      label: 'an absolute path outside the root',
      code: 'SENSE_INPUTS_PATH_ESCAPES_ROOT',
      kind: 'test_coverage_depth',
      setup: (_root, outside) =>
        withInputs({ test_coverage_depth: { coveragePath: join(outside, 'coverage-final.json') } }),
    },
    {
      label: 'a test root leaving the root',
      code: 'SENSE_INPUTS_PATH_ESCAPES_ROOT',
      kind: 'test_security_coverage',
      declaration: withInputs({ test_security_coverage: { testGlobs: ['tests', '../*/tests'] } }),
    },
    {
      label: 'a directory symlink that resolves outside the root',
      code: 'SENSE_INPUTS_PATH_ESCAPES_ROOT',
      kind: 'spec_depth',
      setup: (root, outside) => {
        symlinkSync(outside, join(root, 'linked-adr'), 'dir');
        return withInputs({ spec_depth: { adrDir: 'linked-adr' } });
      },
    },
    {
      label: 'a file symlink that resolves outside the root',
      code: 'SENSE_INPUTS_PATH_ESCAPES_ROOT',
      kind: 'test_coverage_depth',
      setup: (root, outside) => {
        mkdirSync(join(root, 'coverage'), { recursive: true });
        symlinkSync(join(outside, 'coverage-final.json'), join(root, 'coverage/linked.json'));
        return withInputs({ test_coverage_depth: { coveragePath: 'coverage/linked.json' } });
      },
    },
    {
      label: 'a symlinked parent of the tsconfig that resolves outside the root',
      code: 'SENSE_INPUTS_PATH_ESCAPES_ROOT',
      kind: 'action_effect_inference',
      setup: (root, outside) => {
        write(outside, 'tsconfig.effects.json', '{}\n');
        symlinkSync(outside, join(root, 'cfg'), 'dir');
        return withInputs({
          action_effect_inference: { tsconfigPath: 'cfg/tsconfig.effects.json' },
        });
      },
    },
    {
      label: 'a test root whose wildcard expansion crosses a symlink out of the root',
      code: 'SENSE_INPUTS_PATH_ESCAPES_ROOT',
      kind: 'test_idiomaticity',
      setup: (root, outside) => {
        symlinkSync(outside, join(root, 'packages/evil'), 'dir');
        return withInputs({ test_idiomaticity: { testGlobs: ['packages/*/tests'] } });
      },
    },
    {
      label: 'a plant_depth exclusion glob whose prefix is a symlink out of the root',
      code: 'SENSE_INPUTS_PATH_ESCAPES_ROOT',
      kind: 'plant_depth',
      setup: (root, outside) => {
        symlinkSync(outside, join(root, 'generated'), 'dir');
        return withInputs({ plant_depth: { excludeGlobs: ['generated/**'] } });
      },
    },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.label} with ${testCase.code}`, async () => {
      const root = makeRepo(null);
      const outside = makeOutside();
      const declaration = testCase.setup?.(root, outside) ?? testCase.declaration;
      if (declaration !== undefined) declare(root, declaration);
      const refused = await refusal(root, testCase.kind);
      expect(refused.code).toBe(testCase.code);
      expect(refused.message).toContain(testCase.code);
    });
  }

  it('refuses a declaration that does not match the schema shape', async () => {
    const root = makeRepo({ schemaVersion: '9.9.9', inputs: {} });
    const refused = await refusal(root, 'spec_depth');
    expect(String(refused.code)).toMatch(/^SENSE_INPUTS_[A-Z_]+$/u);
  });
});

// ---------------------------------------------------------------------------
// IA-001: each declared key reaches its sensor through `sense run`.
// ---------------------------------------------------------------------------

describe('sense run delivers each declared key to its sensor', () => {
  for (const kind of [
    'test_security_coverage',
    'test_performance_coverage',
    'test_robustness_coverage',
    'test_idiomaticity',
  ] as const) {
    it(`${kind} walks the declared test roots`, async () => {
      const root = makeRepo();
      const reading = readingOf(await senseRun(kind, { repoRoot: root }));
      expect(reading.sensor.kind).toBe(kind);
      // Two test files live under packages/*/tests and tests; the defaults hold none.
      expect(reading.metrics?.['test_files']).toBe(2);
    });
  }

  it('spec_depth counts the declared ADR directory and tallies the declared invariants', async () => {
    const root = makeRepo();
    const reading = readingOf(await senseRun('spec_depth', { repoRoot: root }));
    expect(reading.metrics?.['adr_count']).toBe(2);
    expect(reading.metrics?.['invariant_count']).toBe(1);
    expect(reading.status).toBe('pass');
  });

  it('test_coverage_depth reads the declared coverage path', async () => {
    const root = makeRepo();
    const reading = readingOf(await senseRun('test_coverage_depth', { repoRoot: root }));
    expect(reading.findings?.map((finding) => finding.code) ?? []).not.toContain(
      'TEST_COVERAGE_REPORT_MISSING',
    );
    expect(reading.metrics?.['lines_total']).toBe(4);
    expect(reading.metrics?.['lines_covered']).toBe(3);
  });

  it('action_effect_inference loads the declared effects tsconfig', async () => {
    const root = makeRepo();
    readingOf(await senseRun('action_effect_inference', { repoRoot: root }));
    expect(stubs.senseActionEffectInference).toHaveBeenCalledTimes(1);
    const [options] = stubs.senseActionEffectInference.mock.calls[0] as [
      { readonly tsconfigPath: string },
    ];
    expect(canonical(root, options.tsconfigPath)).toBe(
      canonical(root, 'tests/config/tsconfig.effects.json'),
    );
  });

  it('type_check executes the declared argv', async () => {
    const root = makeRepo();
    readingOf(await senseRun('type_check', { repoRoot: root }));
    expect(stubs.senseTypeCheck).toHaveBeenCalledTimes(1);
    const [options] = stubs.senseTypeCheck.mock.calls[0] as [
      { readonly cwd: string; readonly argv?: readonly string[] },
    ];
    expect(options.argv).toEqual(['pnpm', 'run', 'typecheck']);
    expect(canonical(root, options.cwd)).toBe(canonical(root, '.'));
  });

  it('perf_test runs the declared script', async () => {
    const root = makeRepo();
    readingOf(await senseRun('perf_test', { repoRoot: root }));
    expect(stubs.sensePerfTest).toHaveBeenCalledTimes(1);
    const [options] = stubs.sensePerfTest.mock.calls[0] as [{ readonly scriptName?: string }];
    expect(options.scriptName).toBe('bench:ci');
  });

  it('plant_depth leaves the declared exclusion globs out of the plant', async () => {
    const root = makeRepo({
      schemaVersion: '1.0.0',
      inputs: { plant_depth: { excludeGlobs: ['packages/cli/src/generated/**'] } },
    });
    write(root, 'packages/cli/src/main.ts', 'export const main = 1;\n');
    write(root, 'packages/cli/src/generated/registry.ts', 'export const x = 1;\n'.repeat(1200));
    const reading = readingOf(await senseRun('plant_depth', { repoRoot: root }));
    expect(reading.metrics?.['files_count']).toBe(1);
    expect(reading.status).toBe('pass');
  });

  it('keeps the sensor default when the repository declares nothing', async () => {
    const root = makeRepo(null);
    write(root, 'docs/meta/adr/ADR-9999-default.md', '# default\n');
    const reading = readingOf(await senseRun('spec_depth', { repoRoot: root }));
    expect(reading.metrics?.['adr_count']).toBe(1);
    expect(reading.metrics?.['invariant_count']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// IA-002: explicit --input overrides the same key for one run only.
// ---------------------------------------------------------------------------

describe('sense run --input overrides the declaration for the same key and run only', () => {
  it('overrides adrDir and keeps the declared invariantsDir', async () => {
    const root = makeRepo();
    const reading = readingOf(
      await senseRun('spec_depth', {
        repoRoot: root,
        input: JSON.stringify({ adrDir: 'docs/other-adr' }),
      }),
    );
    expect(reading.metrics?.['adr_count']).toBe(3);
    expect(reading.metrics?.['invariant_count']).toBe(1);
  });

  it('leaves the declaration in force for the next run and unchanged on disk', async () => {
    const root = makeRepo();
    const path = join(root, '.devai/config/sensor-inputs.json');
    const before = readFileSync(path, 'utf8');
    await senseRun('spec_depth', {
      repoRoot: root,
      input: JSON.stringify({ adrDir: 'docs/other-adr' }),
    });
    const next = readingOf(await senseRun('spec_depth', { repoRoot: root }));
    expect(next.metrics?.['adr_count']).toBe(2);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(join(root, '.devai/state'))).toBe(false);
  });

  it('overrides type_check argv without touching other declared kinds', async () => {
    const root = makeRepo();
    readingOf(
      await senseRun('type_check', {
        repoRoot: root,
        input: JSON.stringify({ argv: ['tsc', '-b'] }),
      }),
    );
    const [options] = stubs.senseTypeCheck.mock.calls[0] as [{ readonly argv?: readonly string[] }];
    expect(options.argv).toEqual(['tsc', '-b']);
  });
});

// ---------------------------------------------------------------------------
// IA-001 / IA-002: the dry run prints effective inputs per member.
// ---------------------------------------------------------------------------

describe('sense run --dry-run prints effective inputs per member', () => {
  it('lists the declared inputs for every sweep member and {} for the rest', async () => {
    const root = makeRepo();
    const members = dryRunMembers(
      await senseRun(undefined, { preset: 'sweep', round: 'R-0202', repoRoot: root, dryRun: true }),
    );
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) {
      expect(member, `${member.kind} lacks effective_inputs`).toHaveProperty('effective_inputs');
      const declared = (DECLARED.inputs as Readonly<Record<string, Inputs>>)[member.kind];
      if (declared === undefined) expect(member.effective_inputs).toEqual({});
      else expectEffective(root, member.effective_inputs, declared);
    }
    for (const kind of Object.keys(DECLARED.inputs)) {
      expect(members.map((member) => member.kind)).toContain(kind);
    }
    expectNoSensorExecuted();
  });

  it('shows the explicit override merged over the declaration', async () => {
    const root = makeRepo();
    const members = dryRunMembers(
      await senseRun('spec_depth', {
        repoRoot: root,
        dryRun: true,
        input: JSON.stringify({ adrDir: 'docs/other-adr' }),
      }),
    );
    expect(members).toHaveLength(1);
    expectEffective(root, members[0]?.effective_inputs, {
      adrDir: 'docs/other-adr',
      invariantsDir: 'spec/invariants',
    });
    expectNoSensorExecuted();
  });
});

// ---------------------------------------------------------------------------
// IA-003: sense run refuses before any sensor executes.
// ---------------------------------------------------------------------------

describe('sense run refuses a bad declaration before any sensor executes', () => {
  const bad: readonly {
    readonly label: string;
    readonly code: string;
    readonly setup: (root: string, outside: string) => unknown;
  }[] = [
    {
      label: 'an undeclared key',
      code: 'SENSE_INPUTS_UNDECLARED_KEY',
      setup: () => ({ schemaVersion: '1.0.0', inputs: { spec_depth: { adrRoot: 'law/adr' } } }),
    },
    {
      label: 'an unknown kind',
      code: 'SENSE_INPUTS_UNKNOWN_KIND',
      setup: () => ({ schemaVersion: '1.0.0', inputs: { not_a_sensor: { adrDir: 'law/adr' } } }),
    },
    {
      label: 'a parent-segment path',
      code: 'SENSE_INPUTS_PATH_ESCAPES_ROOT',
      setup: () => ({ schemaVersion: '1.0.0', inputs: { spec_depth: { adrDir: '../adr' } } }),
    },
    {
      label: 'a symlink out of the root',
      code: 'SENSE_INPUTS_PATH_ESCAPES_ROOT',
      setup: (root, outside) => {
        symlinkSync(outside, join(root, 'linked-adr'), 'dir');
        return { schemaVersion: '1.0.0', inputs: { spec_depth: { adrDir: 'linked-adr' } } };
      },
    },
  ];

  for (const testCase of bad) {
    it(`refuses ${testCase.label} on a real single-kind run`, async () => {
      const root = makeRepo(null);
      declare(root, testCase.setup(root, makeOutside()));
      const result = await senseRun('spec_depth', { repoRoot: root });
      expect(result.exit).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(testCase.code);
      expectNoSensorExecuted();
    });

    it(`refuses ${testCase.label} on a sweep dry run`, async () => {
      const root = makeRepo(null);
      declare(root, testCase.setup(root, makeOutside()));
      const result = await senseRun(undefined, {
        preset: 'sweep',
        round: 'R-0202',
        repoRoot: root,
        dryRun: true,
      });
      expect(result.exit).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(testCase.code);
      expectNoSensorExecuted();
    });
  }

  it('refuses a declaration error in a kind other than the one selected', async () => {
    const root = makeRepo({
      schemaVersion: '1.0.0',
      inputs: { spec_depth: { adrDir: 'law/adr' }, perf_test: { script: 'bench:ci' } },
    });
    const result = await senseRun('spec_depth', { repoRoot: root });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('SENSE_INPUTS_UNDECLARED_KEY');
    expectNoSensorExecuted();
  });
});
