import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactDiagnosticText } from './services/credential-probe.js';

/** Bounded, non-attesting log detail for the hosted affected partition only. */
export function hostedPartitionDiagnostics(
  argv: readonly string[],
  stdout: string,
): string | undefined {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'aarusso-nyx/devai' ||
    process.env.GITHUB_EVENT_NAME !== 'pull_request' ||
    process.env.GITHUB_WORKFLOW !== 'Pull request preflight' ||
    !process.env.GITHUB_WORKFLOW_REF?.startsWith(
      'aarusso-nyx/devai/.github/workflows/pull-request-checks.yml@',
    ) ||
    !argv.includes('check') ||
    !argv.includes('--affected') ||
    !argv.includes('--run') ||
    !argv.some(
      (arg, i) =>
        ((process.env.GITHUB_JOB === 'gate-cli' && arg === '--partition-include') ||
          (process.env.GITHUB_JOB === 'gate-rest' && arg === '--partition-exclude')) &&
        argv[i + 1] === 'test:cli',
    )
  )
    return undefined;
  try {
    const report = JSON.parse(stdout) as {
      partition?: unknown;
      execution?: Array<{
        nodeId: string;
        taskKey: string;
        outcome: string;
        partition?: string;
        diagnosticPath?: string;
      }>;
    };
    if (report.partition === undefined || !Array.isArray(report.execution)) return undefined;
    const tasks = report.execution.filter(
      (task) => task.outcome !== 'PASS' && task.partition !== 'partitioned-out',
    );
    const directory = join(realpathSync(process.cwd()), '.devai/state/check-cache/v1/diagnostics');
    const bounded = (value: unknown): string =>
      redactDiagnosticText(String(value ?? '')).slice(-2048);
    const failures = tasks.slice(0, 8).map((task) => {
      const base = { nodeId: bounded(task.nodeId), outcome: bounded(task.outcome) };
      try {
        const path = task.diagnosticPath;
        if (typeof path !== 'string' || dirname(path) !== directory || realpathSync(path) !== path)
          throw new Error('path');
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes: Buffer;
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > 65536) throw new Error('file');
          const buffer = Buffer.alloc(65537);
          let length = 0;
          while (length < buffer.length) {
            const count = readSync(fd, buffer, length, buffer.length - length, null);
            if (count === 0) break;
            length += count;
          }
          if (length > 65536) throw new Error('file');
          bytes = buffer.subarray(0, length);
        } finally {
          closeSync(fd);
        }
        const diagnostic = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        if (diagnostic.nodeId !== task.nodeId || diagnostic.taskKey !== task.taskKey)
          throw new Error('binding');
        return {
          ...base,
          stdoutTail: bounded(diagnostic.stdoutTail),
          stderrTail: bounded(diagnostic.stderrTail),
        };
      } catch {
        return { ...base, diagnostic: 'unavailable' };
      }
    });
    return `${JSON.stringify({ nonAttesting: true, failures, omitted: Math.max(0, tasks.length - failures.length) })}\n`;
  } catch {
    return undefined;
  }
}
