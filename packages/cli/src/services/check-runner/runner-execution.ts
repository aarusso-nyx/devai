import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from '@devai-nyx/authority';
import { sha256Hex } from './canonical.js';
import { bindReleaseTaskProcessOptions } from './authority-process.js';
import type { PlannedTask, TaskExecutionResult, TaskOutcome } from './types.js';

const MAX_TASK_OUTPUT_BYTES = 64 * 1024 * 1024;

function executionEnvironment(environment: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH !== undefined && { PATH: process.env.PATH }),
    ...(process.env.HOME !== undefined && { HOME: process.env.HOME }),
    ...(process.env.TMPDIR !== undefined && { TMPDIR: process.env.TMPDIR }),
    CI: '1',
    NO_COLOR: '1',
    ...environment,
  };
}

export function defaultExecute(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  environment: Readonly<Record<string, string>>,
  releaseBinding?: Parameters<typeof bindReleaseTaskProcessOptions>[1],
): TaskExecutionResult {
  const spawnOptions = {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_TASK_OUTPUT_BYTES,
    env: executionEnvironment(environment),
    shell: false,
  } as const;
  const result = spawnSync(
    argv[0] ?? '',
    argv.slice(1),
    releaseBinding === undefined
      ? spawnOptions
      : bindReleaseTaskProcessOptions({ ...spawnOptions }, releaseBinding),
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    ...(result.error !== undefined && {
      errorCode:
        'code' in result.error && typeof result.error.code === 'string'
          ? result.error.code
          : result.error.name,
    }),
  };
}

/**
 * The parallel runner's executor: the same process, cwd, environment, timeout, and output
 * bound as `defaultExecute`, started without blocking so sibling nodes can run. Its output
 * is buffered per task, never streamed. A timeout still reports ETIMEDOUT and output past
 * the bound still fails with ENOBUFS, so every outcome classifies as it does sequentially.
 */
export async function defaultExecuteAsync(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  environment: Readonly<Record<string, string>>,
  releaseBinding?: Parameters<typeof bindReleaseTaskProcessOptions>[1],
  onUnconfirmedTermination?: () => void,
): Promise<TaskExecutionResult> {
  const spawnOptions = {
    cwd,
    timeout: timeoutMs,
    maxOutputBytes: MAX_TASK_OUTPUT_BYTES,
    env: executionEnvironment(environment),
    shell: false,
  } as const;
  const result = await spawn(
    argv[0] ?? '',
    argv.slice(1),
    releaseBinding === undefined
      ? spawnOptions
      : bindReleaseTaskProcessOptions({ ...spawnOptions }, releaseBinding),
  ).result;
  // A process group that outlived its termination may still write shared output. The
  // node's own outcome stays what the blocking executor reports (TIMEOUT for a timeout);
  // the caller stops admitting concurrent nodes so nothing conflicting overlaps it.
  if (result.termination_error !== undefined) onUnconfirmedTermination?.();
  const errorCode =
    result.spawn_error ??
    (result.timed_out
      ? 'ETIMEDOUT'
      : result.stdout_truncated || result.stderr_truncated
        ? 'ENOBUFS'
        : undefined);
  return {
    status: result.exit_code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(errorCode !== undefined && { errorCode }),
  };
}

export function executionOutcome(result: TaskExecutionResult): TaskOutcome {
  if (result.status === 0 && result.errorCode === undefined && result.signal === null)
    return 'PASS';
  if (result.errorCode === 'ETIMEDOUT') return 'TIMEOUT';
  if (result.signal !== null) return 'KILLED';
  return 'FAIL';
}

export function outputDigests(
  repoRoot: string,
  task: PlannedTask,
  execution: TaskExecutionResult,
  readTaskOutput?: (path: string) => Buffer,
  capturedTaskOutputPaths?: (task: PlannedTask) => readonly string[],
): Readonly<Record<string, string>> {
  const digests: Record<string, string> = {
    stdout: sha256Hex(Buffer.from(execution.stdout, 'utf8')),
    stderr: sha256Hex(Buffer.from(execution.stderr, 'utf8')),
  };
  const paths = task.outputContract.paths ?? [];
  if (paths !== undefined) {
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string'))
      throw new Error(`CHECK_RUNNER_OUTPUT_CONTRACT: ${task.nodeId} has malformed paths`);
    for (const path of new Set([
      ...(paths as string[]),
      ...(capturedTaskOutputPaths?.(task) ?? []),
    ])) {
      try {
        digests[path] = sha256Hex(
          readTaskOutput === undefined ? readFileSync(join(repoRoot, path)) : readTaskOutput(path),
        );
      } catch {
        throw new Error(`CHECK_RUNNER_OUTPUT_MISSING: ${task.nodeId}: ${path}`);
      }
    }
  }
  return digests;
}

export type TaskExecutionEffect = () => TaskExecutionResult | Promise<TaskExecutionResult>;

/**
 * A probe process the host refuses or cannot start is an observation that could
 * not be made: it resolves to an error result (BLOCKED), never to a crashed run.
 */
export function probeEffect(effect: TaskExecutionEffect): TaskExecutionEffect {
  const refused = (error: unknown): TaskExecutionResult => ({
    status: null,
    signal: null,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
    errorCode: 'PROBE_PROCESS_REFUSED',
  });
  return () => {
    try {
      const result = effect();
      return result instanceof Promise ? result.catch(refused) : result;
    } catch (error) {
      return refused(error);
    }
  };
}
