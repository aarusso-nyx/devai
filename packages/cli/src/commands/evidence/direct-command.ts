import type { CAC } from 'cac';
import type { CommandDefinition } from '../../define-command.js';

type CommandAction = (...args: unknown[]) => unknown;

interface CommandCapture {
  option(): CommandCapture;
  action(callback: CommandAction): CommandCapture;
}

export interface DirectCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function commandAction(definition: CommandDefinition): CommandAction {
  let action: CommandAction | undefined;
  const command: CommandCapture = {
    option(): CommandCapture {
      return command;
    },
    action(callback: CommandAction): CommandCapture {
      action = callback;
      return command;
    },
  };
  const cli = {
    command(): CommandCapture {
      return command;
    },
  };
  definition.register(cli as unknown as CAC);
  if (action === undefined) throw new Error(`EVIDENCE_SERVICE_ACTION_MISSING:${definition.name}`);
  return action;
}

/**
 * Invoke an existing in-process command implementation as a service adapter.
 *
 * This deliberately does not spawn the CLI. Output is captured so the evidence
 * writer can bind the produced record to its proof epoch before exposing one result.
 */
export async function invokeCommandService(
  definition: CommandDefinition,
  args: readonly unknown[],
): Promise<DirectCommandResult> {
  const action = commandAction(definition);
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  let stdout = '';
  let stderr = '';
  let explicitExit: number | undefined;

  process.stdout.write = ((chunk: unknown) => {
    stdout += chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number | string | null) => {
    explicitExit = typeof code === 'number' ? code : Number(code ?? 0);
    process.exitCode = explicitExit;
    return undefined as never;
  }) as typeof process.exit;
  process.exitCode = undefined;

  try {
    await action(...args);
    return {
      exitCode:
        explicitExit ??
        (typeof process.exitCode === 'number' ? process.exitCode : Number(process.exitCode ?? 0)),
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      exitCode: explicitExit ?? 2,
      stdout,
      stderr:
        stderr.length > 0 ? stderr : `${error instanceof Error ? error.message : String(error)}\n`,
    };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
  }
}
