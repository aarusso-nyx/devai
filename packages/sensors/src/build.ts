import { runCommand } from './run-command.js';
import { buildSensorReading, type SensorReading, type SensorStatus } from './sensor-reading.js';

export interface BuildOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export function senseBuild(opts: BuildOptions): SensorReading {
  const args = ['pnpm', '-r', 'build'];
  const result = runCommand(args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 300_000 });
  const emptyPopulation =
    result.exit_code === 0 &&
    /No projects (?:found|matched the filters)/u.test(`${result.stdout}\n${result.stderr}`);
  const status: SensorStatus = emptyPopulation
    ? 'review'
    : result.exit_code === 0
      ? 'pass'
      : 'fail';
  return buildSensorReading({
    sensorName: 'build',
    sensorKind: 'build',
    command: args,
    status,
    deterministic: true,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    out_head: result.stdout,
    err_head: result.stderr,
    killed: result.killed,
    ...(emptyPopulation && {
      findings: [
        {
          severity: 'warning' as const,
          code: 'BUILD_POPULATION_EMPTY',
          message: 'The configured build command exited successfully without finding a project.',
        },
      ],
    }),
  });
}
