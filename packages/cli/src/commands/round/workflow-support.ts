import type { CAC } from 'cac';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { TaskServiceError } from '#runtime-core';

export interface RoundOptions {
  readonly repoRoot?: string;
  readonly round?: string;
  readonly human?: boolean;
}

export function root(options: RoundOptions): string {
  return options.repoRoot ?? process.cwd();
}

export function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function requiredRound(options: RoundOptions): string {
  if (options.round === undefined) throw new TaskServiceError('TASK_ROUND_REQUIRED', EXIT_USAGE);
  return options.round;
}

export function emit(value: unknown, human: boolean, text: string, ok = true): void {
  process.stdout.write(human ? `${text}\n` : `${JSON.stringify(value)}\n`);
  process.exitCode = ok ? 0 : 2;
}

export function failure(command: string, error: unknown): void {
  const code =
    error instanceof TaskServiceError
      ? error.code
      : error instanceof Error
        ? error.message
        : 'ROUND_OPERATION_FAILED';
  const exit = error instanceof TaskServiceError ? error.exitCode : 2;
  // A refusal that needs a human step (a stale lock) names it.
  const guidance = error as { readonly detail?: unknown; readonly removal?: unknown };
  process.stderr.write(
    `${JSON.stringify({
      code,
      operation: command,
      exit,
      ...(typeof guidance.detail === 'string' && { detail: guidance.detail }),
      ...(typeof guidance.removal === 'string' && { removal: guidance.removal }),
    })}\n`,
  );
  process.exitCode = exit;
}

export function withRoundOptions(command: ReturnType<CAC['command']>): ReturnType<CAC['command']> {
  return command
    .option('--repo-root <path>', 'Repository root (default: cwd)')
    .option('--round <round_id>', 'Explicit governed round')
    .option('--human', 'Human-readable output');
}
