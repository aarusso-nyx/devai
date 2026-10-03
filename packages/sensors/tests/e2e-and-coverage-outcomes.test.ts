// ADR-SCR-0007, Inspector Adversarial Acceptance IA-001, IA-003 and IA-004: the e2e and
// coverage sensors read measured outcomes.
//
// IA-001: the declared e2e argv (`pnpm vitest run --config tests/config/rc.e2e.config.ts`,
// no test path) reads FAIL carrying the failed count from the vitest summary when a file
// fails, PASS when every file passes, and `error` only when vitest itself does not run.
//
// IA-003: with no report at the declared coveragePath the coverage sensor runs the local
// producer, then reads the measured ratio; a producer that exits non-zero reads FAIL with
// its exit code and stderr head; a report still missing after a zero exit reads FAIL with
// COVERAGE_REPORT_MISSING. None of them reads `error`, and none reads REVIEW for a missing
// prerequisite.
//
// IA-004: a report whose population.json sidecar names another population, or lists another
// exclusion set, is rejected with the mismatch named, never read as the local measurement.
// Every measured reading states its population in `metrics`.
//
// Interface assumptions (TASK-0416 implements them in packages/sensors/src/test-coverage-depth.ts):
//   - `measureTestCoverageDepth({ repoRoot, coveragePath, population, exclusions,
//     thresholds?, now? })` returns a SensorReading. `coveragePath` is repository-relative
//     (or absolute) as declared in .devai/config/sensor-inputs.json.
//   - The producer is `pnpm vitest run --config tests/config/local.coverage.config.ts`, the
//     governed shape the broker admits, run through `runCommand` from `src/run-command.js`
//     with `cwd` at the repository root; tests replace that seam and never spawn vitest.
//   - The sidecar is `population.json` beside the report with `population` and `exclusions`.
//   - `metrics.population` carries the declared population of every measured reading.
// The pure `senseTestCoverageDepth({ summary })` keeps its contract.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand, type RunOptions, type RunResult } from '../src/run-command.js';
import type { SensorReading } from '../src/sensor-reading.js';
import * as coverageDepth from '../src/test-coverage-depth.js';
import { senseTest } from '../src/test.js';

vi.mock('../src/run-command.js', () => ({ runCommand: vi.fn() }));

const runCommandMock = vi.mocked(runCommand);

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..');
const DECLARATION = JSON.parse(
  readFileSync(join(REPOSITORY_ROOT, '.devai/config/sensor-inputs.json'), 'utf8'),
) as {
  readonly inputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};
const E2E_ARGV = DECLARATION.inputs['e2e_test']?.['argv'] as readonly string[];
const COVERAGE_INPUT = DECLARATION.inputs['test_coverage_depth'] as {
  readonly coveragePath: string;
  readonly population: string;
  readonly exclusions: readonly string[];
};
const PRODUCER_ARGV = [
  'pnpm',
  'vitest',
  'run',
  '--config',
  'tests/config/local.coverage.config.ts',
] as const;
const NOW = '2026-10-01T00:00:00.000Z';

function ran(stdout: string, exit_code: number, stderr = ''): RunResult {
  return { stdout, stderr, exit_code, duration_ms: 1, killed: false };
}

interface MeasureOptions {
  readonly repoRoot: string;
  readonly coveragePath: string;
  readonly population: string;
  readonly exclusions: readonly string[];
  readonly thresholds?: { readonly pass: number; readonly review: number };
  readonly now?: string;
}

function measure(options: MeasureOptions): SensorReading {
  const exported = (coverageDepth as Readonly<Record<string, unknown>>)['measureTestCoverageDepth'];
  if (typeof exported !== 'function') {
    throw new Error(
      'measureTestCoverageDepth is not exported from packages/sensors/src/test-coverage-depth.ts',
    );
  }
  return (exported as (options: MeasureOptions) => SensorReading)(options);
}

function messages(reading: SensorReading): string {
  return (reading.findings ?? [])
    .map((finding) => `${finding.code}: ${finding.message}`)
    .join('\n');
}

function codes(reading: SensorReading): readonly string[] {
  return (reading.findings ?? []).map((finding) => finding.code);
}

describe('e2e_test reads the measured outcome of the declared argv (IA-001)', () => {
  beforeEach(() => runCommandMock.mockReset());

  it('runs exactly the declared rc.e2e argv with no test path appended', () => {
    expect(E2E_ARGV).toEqual([
      'pnpm',
      'vitest',
      'run',
      '--config',
      'tests/config/rc.e2e.config.ts',
    ]);
    runCommandMock.mockReturnValue(
      ran(' Test Files  5 passed (5)\n      Tests  21 passed (21)\n', 0),
    );
    senseTest({ cwd: REPOSITORY_ROOT, suite: 'e2e', argv: E2E_ARGV });
    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock.mock.calls[0]?.[0]).toEqual([...E2E_ARGV]);
    expect((runCommandMock.mock.calls[0]?.[1] as RunOptions | undefined)?.cwd).toBe(
      REPOSITORY_ROOT,
    );
  });

  it('reads FAIL carrying the failed count when one e2e file fails', () => {
    runCommandMock.mockReturnValue(
      ran(
        ' FAIL  tests/e2e/usage-exit-codes.e2e.test.ts\n' +
          ' Test Files  1 failed | 4 passed (5)\n' +
          '      Tests  2 failed | 19 passed (21)\n',
        1,
      ),
    );
    const reading = senseTest({ cwd: REPOSITORY_ROOT, suite: 'e2e', argv: E2E_ARGV });
    expect(reading.sensor.kind).toBe('e2e_test');
    expect(reading.status).toBe('fail');
    expect(reading.metrics?.['tests_failed']).toBe(2);
    expect(reading.metrics?.['tests_passed']).toBe(19);
  });

  it('reads PASS when every e2e file passes', () => {
    runCommandMock.mockReturnValue(
      ran(' Test Files  5 passed (5)\n      Tests  21 passed (21)\n', 0),
    );
    const reading = senseTest({ cwd: REPOSITORY_ROOT, suite: 'e2e', argv: E2E_ARGV });
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.['tests_failed']).toBe(0);
    expect(reading.metrics?.['tests_passed']).toBe(21);
  });

  it('reads FAIL from a summary carrying ANSI colour on stderr', () => {
    runCommandMock.mockReturnValue(
      ran('', 1, '\u001b[2m      Tests \u001b[22m\u001b[31m1 failed\u001b[39m | 20 passed (21)\n'),
    );
    const reading = senseTest({ cwd: REPOSITORY_ROOT, suite: 'e2e', argv: E2E_ARGV });
    expect(reading.status).toBe('fail');
    expect(reading.metrics?.['tests_failed']).toBe(1);
  });

  it('reads error only when vitest itself does not run', () => {
    runCommandMock.mockReturnValue(ran('', 127, 'spawnSync pnpm ENOENT'));
    const reading = senseTest({ cwd: REPOSITORY_ROOT, suite: 'e2e', argv: E2E_ARGV });
    expect(reading.status).toBe('error');
    expect(reading.metrics?.['tests_failed']).toBe(0);
  });
});

// ---- coverage fixtures --------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-local-coverage-'));
  roots.push(root);
  return root;
}

/** An Istanbul per-file report with `covered` of `total` lines hit, one statement per line. */
function istanbulReport(root: string, covered: number, total: number): string {
  const file = join(root, 'packages/fixture/src/index.ts');
  const statementMap: Record<string, object> = {};
  const s: Record<string, number> = {};
  const l: Record<string, number> = {};
  for (let index = 0; index < total; index += 1) {
    const line = index + 1;
    statementMap[String(index)] = {
      start: { line, column: 0 },
      end: { line, column: 10 },
    };
    const hits = index < covered ? 1 : 0;
    s[String(index)] = hits;
    l[String(line)] = hits;
  }
  return `${JSON.stringify(
    {
      [file]: {
        path: file,
        statementMap,
        fnMap: {},
        branchMap: {},
        s,
        f: {},
        b: {},
        l,
      },
    },
    null,
    2,
  )}\n`;
}

function sidecar(population: string, exclusions: readonly string[]): string {
  return `${JSON.stringify(
    {
      schemaVersion: '1.0.0',
      population,
      include: [
        'packages/*/tests/**/*.test.ts',
        'packages/*/tests/**/*.spec.ts',
        'tests/contract/**/*.test.ts',
        'tests/integration/**/*.test.ts',
      ],
      exclusions: [...exclusions],
      filesMeasured: 1,
      testFiles: 1,
    },
    null,
    2,
  )}\n`;
}

function writeAt(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

const SIDECAR_PATH = join(dirname(COVERAGE_INPUT.coveragePath), 'population.json');

function writeProduced(
  root: string,
  covered: number,
  total: number,
  population = COVERAGE_INPUT.population,
  exclusions: readonly string[] = COVERAGE_INPUT.exclusions,
): void {
  writeAt(root, COVERAGE_INPUT.coveragePath, istanbulReport(root, covered, total));
  writeAt(root, SIDECAR_PATH, sidecar(population, exclusions));
}

function declared(root: string): MeasureOptions {
  return {
    repoRoot: root,
    coveragePath: COVERAGE_INPUT.coveragePath,
    population: COVERAGE_INPUT.population,
    exclusions: COVERAGE_INPUT.exclusions,
    now: NOW,
  };
}

describe('test_coverage_depth runs the local producer and reads the measured ratio (IA-003)', () => {
  beforeEach(() => runCommandMock.mockReset());

  it('pins the declaration it measures', () => {
    expect(COVERAGE_INPUT).toEqual({
      coveragePath: 'scratch/coverage/local/coverage-final.json',
      population: 'local',
      exclusions: [
        'packages/authority/tests/unit/authority-resource-boundaries.red.test.ts',
        'packages/skills/tests/recipes/adapters.test.ts',
        'tests/integration/authority-effect-postgres.db.test.ts',
        'tests/integration/runtime-probe-data.integration.test.ts',
      ],
    });
  });

  it('runs the governed producer when the report is absent and records the measured ratio', () => {
    const root = fixtureRoot();
    runCommandMock.mockImplementation((_argv, options) => {
      writeProduced(options?.cwd ?? root, 9, 10);
      return ran(' Test Files  1 passed (1)\n', 0);
    });
    const reading = measure(declared(root));
    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock.mock.calls[0]?.[0]).toEqual([...PRODUCER_ARGV]);
    expect(runCommandMock.mock.calls[0]?.[1]?.cwd).toBe(root);
    expect(runCommandMock.mock.calls[0]?.[1]?.env?.['DEVAI_DB_TESTS']).toBeUndefined();
    expect(reading.sensor.kind).toBe('test_coverage_depth');
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.['lines_total']).toBe(10);
    expect(reading.metrics?.['lines_covered']).toBe(9);
    expect(reading.metrics?.['lines_pct']).toBe(90);
    expect(reading.metrics?.['population']).toBe('local');
  });

  it('marks the producer and never starts a nested producer from inside one (#242)', () => {
    const root = fixtureRoot();
    runCommandMock.mockImplementation((_argv, options) => {
      writeProduced(options?.cwd ?? root, 9, 10);
      return ran(' Test Files  1 passed (1)\n', 0);
    });
    measure(declared(root));
    expect(runCommandMock.mock.calls[0]?.[1]?.env).toEqual({
      DEVAI_COVERAGE_PRODUCER_ACTIVE: '1',
    });

    runCommandMock.mockReset();
    const nested = fixtureRoot();
    const previous = process.env['DEVAI_COVERAGE_PRODUCER_ACTIVE'];
    process.env['DEVAI_COVERAGE_PRODUCER_ACTIVE'] = '1';
    try {
      const reading = measure(declared(nested));
      expect(runCommandMock).not.toHaveBeenCalled();
      expect(reading.status).toBe('unknown');
      expect(reading.findings?.[0]?.code).toBe('COVERAGE_PRODUCER_RECURSION');
    } finally {
      if (previous === undefined) delete process.env['DEVAI_COVERAGE_PRODUCER_ACTIVE'];
      else process.env['DEVAI_COVERAGE_PRODUCER_ACTIVE'] = previous;
    }
  });

  it('reads a present report without running the producer and states the population', () => {
    const root = fixtureRoot();
    writeProduced(root, 6, 10);
    const reading = measure(declared(root));
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(reading.status).toBe('review');
    expect(reading.metrics?.['lines_pct']).toBe(60);
    expect(reading.metrics?.['population']).toBe('local');
    expect(messages(reading)).toMatch(/\blocal\b/u);
  });

  it('reads FAIL below the review threshold and states the population', () => {
    const root = fixtureRoot();
    writeProduced(root, 2, 10);
    const reading = measure(declared(root));
    expect(reading.status).toBe('fail');
    expect(codes(reading)).toContain('TEST_COVERAGE_BELOW_THRESHOLD');
    expect(reading.metrics?.['population']).toBe('local');
    expect(messages(reading)).toMatch(/\blocal\b/u);
  });

  it('reads FAIL with the exit code and stderr head when the producer exits non-zero', () => {
    const root = fixtureRoot();
    runCommandMock.mockReturnValue(ran('', 2, 'producer exploded: config load failed'));
    const reading = measure(declared(root));
    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(reading.status).toBe('fail');
    expect(reading.status).not.toBe('error');
    const text = `${messages(reading)}\n${reading.err_head ?? ''}`;
    expect(reading.exit_code === 2 || /exit(?:ed)?(?: with)?(?: code)? 2\b/u.test(text)).toBe(true);
    expect(text).toContain('producer exploded');
    expect(codes(reading)).not.toContain('TEST_COVERAGE_REPORT_MISSING');
    expect(reading.metrics?.['population']).toBe('local');
  });

  it('reads FAIL with COVERAGE_REPORT_MISSING when the report is missing after a zero exit', () => {
    const root = fixtureRoot();
    runCommandMock.mockReturnValue(ran(' Test Files  1 passed (1)\n', 0));
    const reading = measure(declared(root));
    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, COVERAGE_INPUT.coveragePath))).toBe(false);
    expect(reading.status).toBe('fail');
    expect(codes(reading)).toContain('COVERAGE_REPORT_MISSING');
    expect(codes(reading)).not.toContain('TEST_COVERAGE_REPORT_MISSING');
    expect(reading.metrics?.['population']).toBe('local');
  });
});

describe('test_coverage_depth refuses a report over another population (IA-004)', () => {
  beforeEach(() => runCommandMock.mockReset());

  it('rejects a sidecar naming another population, naming both', () => {
    const root = fixtureRoot();
    writeProduced(root, 10, 10, 'rc');
    const reading = measure(declared(root));
    expect(reading.status).not.toBe('pass');
    expect(reading.status).not.toBe('error');
    const text = messages(reading);
    expect(text).toMatch(/population/u);
    expect(text).toMatch(/\brc\b/u);
    expect(text).toMatch(/\blocal\b/u);
    expect(reading.metrics?.['population']).toBe('local');
  });

  it('rejects a sidecar whose exclusion list omits a declared exclusion, naming it', () => {
    const root = fixtureRoot();
    const [dropped, ...kept] = COVERAGE_INPUT.exclusions;
    writeProduced(root, 10, 10, 'local', kept);
    const reading = measure(declared(root));
    expect(reading.status).not.toBe('pass');
    expect(reading.status).not.toBe('error');
    expect(messages(reading)).toContain(String(dropped));
  });

  it('rejects a sidecar whose exclusion list adds an undeclared suite, naming it', () => {
    const root = fixtureRoot();
    const extra = 'tests/integration/extra-undeclared.test.ts';
    writeProduced(root, 10, 10, 'local', [...COVERAGE_INPUT.exclusions, extra]);
    const reading = measure(declared(root));
    expect(reading.status).not.toBe('pass');
    expect(reading.status).not.toBe('error');
    expect(messages(reading)).toContain(extra);
  });

  it('accepts the same exclusions in another order', () => {
    const root = fixtureRoot();
    writeProduced(root, 10, 10, 'local', [...COVERAGE_INPUT.exclusions].reverse());
    const reading = measure(declared(root));
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.['population']).toBe('local');
  });
});

describe('the pure summary reading keeps its contract', () => {
  it('grades a supplied summary without running a producer', () => {
    runCommandMock.mockReset();
    const reading = coverageDepth.senseTestCoverageDepth({
      summary: { lines_total: 10, lines_covered: 9 },
      now: NOW,
    });
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.['lines_pct']).toBe(90);
  });
});
