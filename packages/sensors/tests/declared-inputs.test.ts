// ADR-SCR-0005 IA-001 (sensor half): every key the sensor-inputs schema declares is
// honored by the sensor that reads it, and a declared value replaces the sensor
// default instead of being added to it. The CLI half (declaration file, merge, and
// refusal) lives in packages/cli/tests/unit/sense-inputs-declaration.test.ts.
//
// Interface assumptions the engineer (TASK-0223) must meet in packages/sensors/src:
//   - senseTestSecurityCoverage / senseTestPerformanceCoverage /
//     senseTestRobustnessCoverage / senseTestIdiomaticity accept
//     `{ repoRoot, testGlobs }` and walk only the declared roots (exists today).
//   - senseSpecDepth accepts `{ repoRoot, adrDir, invariantsDir }` (exists today).
//   - senseTestCoverageDepth accepts `{ summary, coveragePath }` and names the declared
//     path when the report is missing (exists today).
//   - senseActionEffectInference forwards `tsconfigPath` to analyzeEffectProgram
//     (exists today).
//   - senseTypeCheck accepts `{ cwd, argv }` where `argv` is the exact vector passed to
//     runCommand (executable first, never joined through a shell), and parses its
//     stdout for tsc diagnostics the same way the default command is parsed. NEW:
//     today TypeCheckOptions has no `argv`, so the option is passed through a widened
//     local type and the argv cases fail until the sensor honors it.
//   - sensePerfTest accepts `{ repoRoot, scriptName }` and runs that root script
//     through runCommand (exists today).
//   - senseHarnessIdiomaticity accepts `{ repoRoot, minWorkflowsForReusableCheck }`
//     and drops the reusable-workflow signal from both the score and its
//     denominator when workflow_count is below the declared threshold
//     (exists today, TASK-0254/Phase 35.D). TASK-0255 wires the declared
//     key through the adapter; the sensor's own default of 1 is unchanged.
// runCommand is mocked so no compiler or package manager is ever spawned.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('../src/run-command.js', () => run);

const effects = vi.hoisted(() => ({ analyzeEffectProgram: vi.fn() }));
vi.mock('@devai-nyx/effects-check', () => effects);

import { senseActionEffectInference } from '../src/action-effect-inference.js';
import { senseHarnessIdiomaticity } from '../src/harness-idiomaticity.js';
import { sensePerfTest } from '../src/perf-test.js';
import { senseSpecDepth } from '../src/spec-depth.js';
import { senseTestCoverageDepth } from '../src/test-coverage-depth.js';
import { senseTestIdiomaticity } from '../src/test-idiomaticity.js';
import { senseTestPerformanceCoverage } from '../src/test-performance-coverage.js';
import { senseTestRobustnessCoverage } from '../src/test-robustness-coverage.js';
import { senseTestSecurityCoverage } from '../src/test-security-coverage.js';
import { senseTypeCheck, type TypeCheckOptions } from '../src/type-check.js';

/** TypeCheckOptions widened by the declared `argv` input (ADR-SCR-0005). */
type DeclaredTypeCheckOptions = TypeCheckOptions & { readonly argv?: readonly string[] };

const DEVAI_TEST_GLOBS = ['packages/*/tests', 'tests'] as const;

let root: string;

function write(rel: string, content: string): void {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function metric(reading: { readonly metrics?: Readonly<Record<string, unknown>> }, key: string) {
  return reading.metrics?.[key];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-declared-inputs-'));
  run.runCommand.mockReset();
  effects.analyzeEffectProgram.mockReset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('declared testGlobs reach the four test pattern sensors', () => {
  beforeEach(() => {
    // The framework layout: tests under packages/*/tests and tests, nothing under the
    // sensor defaults packages/*/test and packages/*/src.
    write(
      'packages/alpha/tests/auth-bench.test.ts',
      "it('rejects auth under load', () => { expect(() => f()).toThrow(); vi.fn(); vi.fn(); });\n",
    );
    write(
      'tests/contract/csrf-latency.spec.ts',
      "it('csrf p95 latency', () => { expect(g()).rejects.toThrow('error'); });\n",
    );
    write('tests/contract/helper.ts', 'export const notATest = 1;\n');
    // A file under the sensor default that the declaration must NOT add back in.
    write('packages/alpha/test/default-root.test.ts', "it('auth', () => {});\n");
  });

  const cases = [
    ['test_security_coverage', senseTestSecurityCoverage, 'security_tests'],
    ['test_performance_coverage', senseTestPerformanceCoverage, 'perf_tests'],
    ['test_robustness_coverage', senseTestRobustnessCoverage, 'robust_tests'],
  ] as const;

  for (const [kind, sense, matchedMetric] of cases) {
    it(`${kind} walks exactly the declared roots, replacing the default roots`, () => {
      const declared = sense({ repoRoot: root, testGlobs: [...DEVAI_TEST_GLOBS] });
      expect(metric(declared, 'test_files')).toBe(2);
      expect(metric(declared, matchedMetric)).toBe(2);

      const defaults = sense({ repoRoot: root });
      expect(metric(defaults, 'test_files')).toBe(1);
    });
  }

  it('test_idiomaticity walks exactly the declared roots, replacing the default roots', () => {
    const declared = senseTestIdiomaticity({ repoRoot: root, testGlobs: [...DEVAI_TEST_GLOBS] });
    expect(metric(declared, 'test_files')).toBe(2);
    expect(metric(declared, 'mock_calls')).toBeGreaterThanOrEqual(2);

    const defaults = senseTestIdiomaticity({ repoRoot: root });
    expect(metric(defaults, 'test_files')).toBe(1);
  });

  it('a declared root that holds nothing reads as absent, never as the default', () => {
    const reading = senseTestSecurityCoverage({ repoRoot: root, testGlobs: ['nowhere/*/tests'] });
    expect(metric(reading, 'test_files')).toBe(0);
    expect(reading.findings?.map((f) => f.code)).toContain('TEST_SECURITY_NO_TESTS');
  });
});

describe('declared adrDir and invariantsDir reach spec_depth', () => {
  beforeEach(() => {
    write('law/adr/ADR-0001-one.md', '# one\n');
    write('law/adr/ADR-0002-two.md', '# two\n');
    write('law/adr/README.md', '# not a record\n');
    write(
      'spec/invariants/INV-1.json',
      JSON.stringify({ id: 'INV-1', scope: { components: ['core'] } }),
    );
    // Sensor defaults hold one record and no invariants; the declaration must win.
    write('docs/meta/adr/ADR-9999-default.md', '# default\n');
  });

  it('counts decision records in the declared ADR directory instead of docs/meta/adr', () => {
    const { reading, body } = senseSpecDepth({ repoRoot: root, adrDir: 'law/adr' });
    expect(body.adr_count).toBe(2);
    expect(metric(reading, 'adr_count')).toBe(2);
  });

  it('tallies invariants in the declared invariants directory', () => {
    const { reading, body } = senseSpecDepth({
      repoRoot: root,
      adrDir: 'law/adr',
      invariantsDir: 'spec/invariants',
    });
    expect(body.invariant_count).toBe(1);
    expect(body.components).toEqual([{ name: 'core', invariant_count: 1 }]);
    expect(reading.status).toBe('pass');
  });

  it('keeps the sensor defaults when nothing is declared', () => {
    const { body } = senseSpecDepth({ repoRoot: root });
    expect(body.adr_count).toBe(1);
    expect(body.invariant_count).toBe(0);
  });
});

describe('declared coveragePath reaches test_coverage_depth', () => {
  it('names the declared path when the report is missing', () => {
    const declared = join(root, 'scratch/coverage/rc/coverage-final.json');
    const reading = senseTestCoverageDepth({ summary: null, coveragePath: declared });
    expect(reading.status).toBe('review');
    const finding = reading.findings?.find((f) => f.code === 'TEST_COVERAGE_REPORT_MISSING');
    expect(finding?.message).toContain(declared);
  });
});

describe('declared tsconfigPath reaches action_effect_inference', () => {
  it('loads the declared effects project, not the root default', async () => {
    const tsconfigPath = join(root, 'tests/config/tsconfig.effects.json');
    effects.analyzeEffectProgram.mockResolvedValue({
      actions: {},
      findings: [],
      subprocess_templates: [],
      advisory_patterns: { violations: 0, dispositions: [] },
      metrics: {
        program_files: 1,
        catalog_actions: 0,
        extracted_actions: 0,
        unresolved_edges: 0,
        dispositioned_edges: 0,
        duration_ms: 1,
      },
    });
    await senseActionEffectInference({
      tsconfigPath,
      catalog: [],
      contracts: [],
      subprocessRegistry: { templates: [] },
    });
    expect(effects.analyzeEffectProgram).toHaveBeenCalledTimes(1);
    expect(effects.analyzeEffectProgram.mock.calls[0]?.[0]).toMatchObject({ tsconfigPath });
  });
});

describe('declared argv reaches type_check', () => {
  const argv = ['pnpm', 'run', 'typecheck'] as const;

  it('executes exactly the declared argv from the repository root', () => {
    run.runCommand.mockReturnValue({
      stdout: '',
      stderr: '',
      exit_code: 0,
      duration_ms: 3,
      killed: false,
    });
    const options: DeclaredTypeCheckOptions = { cwd: root, argv: [...argv] };
    const result = senseTypeCheck(options);

    expect(run.runCommand).toHaveBeenCalledTimes(1);
    const [executed, runOptions] = run.runCommand.mock.calls[0] ?? [];
    expect(executed).toEqual([...argv]);
    expect(runOptions).toMatchObject({ cwd: root });
    expect(result.aggregate.status).toBe('pass');
    expect(result.aggregate.command).toBe(argv.join(' '));
  });

  it('parses diagnostics from the declared command the same way as the default', () => {
    run.runCommand.mockReturnValue({
      stdout:
        "packages/a/src/x.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
      stderr: '',
      exit_code: 2,
      duration_ms: 3,
      killed: false,
    });
    const options: DeclaredTypeCheckOptions = { cwd: root, argv: [...argv] };
    const result = senseTypeCheck(options);

    expect(run.runCommand.mock.calls[0]?.[0]).toEqual([...argv]);
    expect(result.aggregate.status).toBe('fail');
    expect(result.aggregate.findings).toEqual([
      expect.objectContaining({ code: 'TS2322', file: 'packages/a/src/x.ts', line: 3 }),
    ]);
  });

  it('keeps npx tsc --noEmit when no argv is declared', () => {
    run.runCommand.mockReturnValue({
      stdout: '',
      stderr: '',
      exit_code: 0,
      duration_ms: 1,
      killed: false,
    });
    senseTypeCheck({ cwd: root });
    expect(run.runCommand.mock.calls[0]?.[0]).toEqual(['npx', 'tsc', '--noEmit']);
  });
});

describe('declared scriptName reaches perf_test', () => {
  it('runs the declared root script and never the default test:perf', () => {
    write(
      'package.json',
      JSON.stringify({ name: 'fixture', scripts: { 'bench:ci': 'node bench.js' } }),
    );
    run.runCommand.mockReturnValue({
      stdout: `${JSON.stringify({ p50_ms: 1, p95_ms: 2, throughput_rps: 1000 })}\n`,
      stderr: '',
      exit_code: 0,
      duration_ms: 5,
      killed: false,
    });
    const reading = sensePerfTest({ repoRoot: root, scriptName: 'bench:ci' });

    expect(run.runCommand).toHaveBeenCalledTimes(1);
    const executed = run.runCommand.mock.calls[0]?.[0] as readonly string[];
    expect(executed).toContain('bench:ci');
    expect(executed).not.toContain('test:perf');
    expect(metric(reading, 'script_name')).toBe('bench:ci');
    expect(reading.findings?.map((f) => f.code)).not.toContain('PERF_TEST_NO_PERF_SCRIPT');
  });

  it('reads a declared script that the package lacks as unmeasurable, naming it', () => {
    write('package.json', JSON.stringify({ name: 'fixture', scripts: { 'test:perf': 'x' } }));
    const reading = sensePerfTest({ repoRoot: root, scriptName: 'bench:ci' });
    expect(run.runCommand).not.toHaveBeenCalled();
    expect(reading.status).toBe('unknown');
    expect(metric(reading, 'script_name')).toBe('bench:ci');
  });
});

describe('declared minWorkflowsForReusableCheck reaches harness_idiomaticity', () => {
  // Two workflows, each with a composite-action use and a cache use but no
  // reusable-workflow use: everything the DEVAI declaration (5) describes,
  // short of the threshold.
  beforeEach(() => {
    write(
      '.github/workflows/first.yml',
      `name: first
jobs:
  check:
    steps:
      - uses: ./.github/actions/build
      - uses: actions/cache@v4
`,
    );
    write(
      '.github/workflows/second.yml',
      `name: second
jobs:
  check:
    steps:
      - uses: ./.github/actions/test
      - uses: actions/cache@v4
`,
    );
  });

  it('drops the reusable-workflow signal from the score when the declared threshold is above the workflow count', () => {
    const reading = senseHarnessIdiomaticity({ repoRoot: root, minWorkflowsForReusableCheck: 5 });

    expect(reading).toMatchObject({
      status: 'pass',
      metrics: {
        workflow_count: 2,
        reusable_workflow_uses: 0,
        idiomaticity_score: 2,
      },
    });
    expect(reading.findings?.map((f) => f.code)).not.toContain(
      'HARNESS_IDIOMATICITY_NO_REUSABLE_WORKFLOWS',
    );
  });

  it('keeps today’s behavior when the threshold is undeclared', () => {
    const reading = senseHarnessIdiomaticity({ repoRoot: root });

    expect(reading).toMatchObject({
      status: 'review',
      metrics: {
        workflow_count: 2,
        reusable_workflow_uses: 0,
        idiomaticity_score: 2,
      },
    });
    expect(reading.findings?.map((f) => f.code)).toContain(
      'HARNESS_IDIOMATICITY_NO_REUSABLE_WORKFLOWS',
    );
  });
});
