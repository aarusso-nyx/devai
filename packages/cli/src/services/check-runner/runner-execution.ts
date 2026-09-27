import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from '@devai-nyx/authority';
import { sha256Hex } from './canonical.js';
import { bindReleaseTaskProcessOptions } from './authority-process.js';
import type { PlannedTask, TaskExecutionResult, TaskOutcome } from './types.js';

export function defaultExecute(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  environment: Readonly<Record<string, string>>,
  releaseBinding?: Parameters<typeof bindReleaseTaskProcessOptions>[1],
): TaskExecutionResult {
  const executionEnvironment: NodeJS.ProcessEnv = {
    ...(process.env.PATH !== undefined && { PATH: process.env.PATH }),
    ...(process.env.HOME !== undefined && { HOME: process.env.HOME }),
    ...(process.env.TMPDIR !== undefined && { TMPDIR: process.env.TMPDIR }),
    CI: '1',
    NO_COLOR: '1',
    ...environment,
  };
  const spawnOptions = {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: executionEnvironment,
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
