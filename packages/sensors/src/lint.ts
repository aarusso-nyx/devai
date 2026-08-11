import { runCommand } from './run-command.js';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

export interface LintOptions {
  readonly cwd: string;
  readonly target?: string;
  readonly timeoutMs?: number;
}

interface EslintMessage {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line?: number;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
  errorCount: number;
  warningCount: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function senseLint(opts: LintOptions): SensorReading {
  const args = ['npx', 'eslint', '--format=json', opts.target ?? '.'];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = runCommand(args, { cwd: opts.cwd, timeoutMs });

  const findings: SensorFinding[] = [];
  let errorCount = 0;
  let warningCount = 0;
  try {
    const parsed = JSON.parse(result.stdout) as EslintFileResult[];
    for (const file of parsed) {
      errorCount += file.errorCount;
      warningCount += file.warningCount;
      for (const msg of file.messages) {
        findings.push({
          severity: msg.severity === 2 ? 'error' : 'warning',
          code: msg.ruleId ?? 'unknown',
          message: msg.message,
          file: file.filePath,
          ...(msg.line !== undefined && { line: msg.line }),
        });
      }
    }
  } catch {
    // Non-JSON output (ESLint config error, etc.). Fall back to err head.
  }

  let status: SensorStatus;
  if (result.killed) {
    findings.push({
      severity: 'warning',
      code: 'LINT_TIMED_OUT',
      message: `eslint exceeded --timeout-ms ${String(timeoutMs)}; results may be partial`,
    });
    status = 'review';
  } else if (result.exit_code === 0) {
    status = 'pass';
  } else if (errorCount > 0) {
    status = 'fail';
  } else {
    status = 'review';
  }

  return buildSensorReading({
    sensorName: 'lint',
    sensorKind: 'lint',
    command: args,
    status,
    deterministic: true,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    out_head: result.stdout,
    err_head: result.stderr,
    killed: result.killed,
    findings,
    metrics: {
      error_count: errorCount,
      warning_count: warningCount,
      timeout_ms: timeoutMs,
    },
  });
}
