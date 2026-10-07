import type { CAC } from 'cac';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { TaskServiceError } from '#runtime-core';
import { commandRefusal } from '../../cli-error.js';

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

/**
 * #338: a round failure is a schema-valid refusal envelope carrying the round or task code, so
 * the action wrapper passes it through under --format json. A TaskServiceError keeps its exit; an
 * Error raised with a code (or `CODE:detail`) as its message keeps that code and the usage exit (2);
 * anything else is unanticipated: ROUND_OPERATION_FAILED, infrastructure (6).
 */
export function failure(command: string, error: unknown): void {
  const known = error instanceof TaskServiceError;
  const raw = known ? error.code : error instanceof Error ? error.message : '';
  const exit = known ? error.exitCode : EXIT_USAGE;
  // A refusal that needs a human step (a stale lock) names it in the envelope context.
  const guidance = error as { readonly detail?: unknown; readonly removal?: unknown };
  const envelope = commandRefusal(
    raw,
    exit,
    {
      operation: command,
      ...(typeof guidance.detail === 'string' && { detail: guidance.detail }),
      ...(typeof guidance.removal === 'string' && { removal: guidance.removal }),
    },
    typeof guidance.removal === 'string'
      ? `Remove ${guidance.removal} once you have confirmed its holder is gone, then rerun.`
      : `Resolve the condition the code names, then rerun devai round ${command}.`,
    'ROUND_OPERATION_FAILED',
  );
  process.stderr.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = envelope.exit;
}

export function withRoundOptions(command: ReturnType<CAC['command']>): ReturnType<CAC['command']> {
  return command
    .option('--repo-root <path>', 'Repository root (default: cwd)')
    .option('--round <round_id>', 'Explicit governed round')
    .option('--human', 'Human-readable output');
}
