import { runCommand } from './run-command.js';
import { buildSensorReading, type SensorReading, type SensorStatus } from './sensor-reading.js';

export type TestSuite = 'unit' | 'integration' | 'regression' | 'e2e' | 'all';

export interface TestOptions {
  readonly cwd: string;
  readonly suite: TestSuite;
  readonly timeoutMs?: number;
}

function defaultCommand(suite: TestSuite): readonly string[] {
  switch (suite) {
    case 'unit':
      return ['pnpm', 'vitest', 'run', '--config', 'tests/config/t1.unit.config.ts'];
    case 'integration':
      return ['pnpm', 'vitest', 'run', '--config', 'tests/config/t3.integration.config.ts'];
    case 'regression':
      return ['pnpm', 'vitest', 'run', '--config', 'tests/config/t4.regression.config.ts'];
    case 'e2e':
      return ['pnpm', 'vitest', 'run', '--config', 'tests/config/t5.e2e.config.ts'];
    case 'all':
      return ['pnpm', 'vitest', 'run'];
  }
}

const VITEST_SUMMARY = /Tests\s+(\d+) passed(?:\s+\|\s+(\d+) failed)?/;
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

export interface VitestSummary {
  readonly passed: number;
  readonly failed: number;
}

export function parseVitestSummary(output: string): VitestSummary | null {
  const match = VITEST_SUMMARY.exec(output.replace(ANSI_SEQUENCE, ''));
  if (match === null) return null;
  return {
    passed: Number(match[1] ?? 0),
    failed: Number(match[2] ?? 0),
  };
}

export function senseTest(opts: TestOptions): SensorReading {
  const args = [...defaultCommand(opts.suite)];
  const result = runCommand(args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 600_000 });

  const summary = parseVitestSummary(result.stdout) ?? parseVitestSummary(result.stderr);
  const passed = summary?.passed ?? 0;
  const failed = summary?.failed ?? 0;

  const status: SensorStatus = result.exit_code === 0 ? 'pass' : failed > 0 ? 'fail' : 'error';

  // Map suite → SensorKind. 'regression' and 'all' both surface as unit_test
  // since the schema's enum doesn't include those granularities.
  const sensorKind =
    opts.suite === 'integration'
      ? 'integration_test'
      : opts.suite === 'e2e'
        ? 'e2e_test'
        : 'unit_test';
  // Determinism by suite (Phase-6 scorecard's F3×T9 cell depends on this):
  // - unit + regression tests are expected deterministic; flake = bug.
  // - integration/e2e suites depend on external substrates and are not.
  // - 'all' is a mix; conservatively mark non-deterministic.
  const deterministic = opts.suite === 'unit' || opts.suite === 'regression';
  return buildSensorReading({
    sensorName: `test.${opts.suite}`,
    sensorKind,
    command: args,
    status,
    deterministic,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    out_head: result.stdout,
    err_head: result.stderr,
    killed: result.killed,
    metrics: { tests_passed: passed, tests_failed: failed },
  });
}
