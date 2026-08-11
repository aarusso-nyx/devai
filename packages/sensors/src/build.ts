import { runCommand } from './run-command.js';
import { buildSensorReading, type SensorReading, type SensorStatus } from './sensor-reading.js';

export interface BuildOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export function senseBuild(opts: BuildOptions): SensorReading {
  const args = ['pnpm', '-r', 'build'];
  const result = runCommand(args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 300_000 });
  const status: SensorStatus = result.exit_code === 0 ? 'pass' : 'fail';
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
  });
}
