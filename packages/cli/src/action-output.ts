import type { Command } from 'cac';
import { getValidator, type SchemaName, validators } from '@devai-nyx/schemas';
import { basename } from 'node:path';
import { cliError, type CliError } from './cli-error.js';
import type { RegistryEntry } from './define-command.js';

type Write = typeof process.stdout.write;

class CommandExit extends Error {
  constructor(readonly code: number) {
    super(`command exited ${String(code)}`);
  }
}

export function isActionOutputExit(error: unknown): boolean {
  return error instanceof CommandExit;
}

function wantsMachineJson(argv: readonly string[]): boolean {
  const format = argv.lastIndexOf('--format');
  return argv.includes('--json') || (format >= 0 && argv[format + 1] === 'json');
}

function chunkText(chunk: unknown, _encoding?: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString('utf8');
  }
  return String(chunk);
}

function payloadFrom(text: string): Readonly<{ media_type: string; value: unknown }> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { media_type: 'none', value: null };
  try {
    return { media_type: 'application/json', value: JSON.parse(trimmed) as unknown };
  } catch {
    return { media_type: 'text/plain', value: text.replace(/\n$/u, '') };
  }
}

function errorClass(exit: number): CliError['class'] {
  if (exit === 2) return 'routing-authority';
  if (exit === 3) return 'gate-fail';
  if (exit === 4) return 'invalid-input';
  if (exit === 5) return 'precondition';
  if (exit === 6) return 'infrastructure';
  return 'contract-violation';
}

function normalizeExit(exit: number): 2 | 3 | 4 | 5 | 6 | 7 {
  return exit >= 2 && exit <= 7 ? (exit as 2 | 3 | 4 | 5 | 6 | 7) : 7;
}

function errorCode(exit: 2 | 3 | 4 | 5 | 6 | 7): string {
  if (exit === 3) return 'ACTION_GATE_FAILED';
  if (exit === 5) return 'ACTION_PRECONDITION_UNSATISFIED';
  if (exit === 7) return 'ACTION_OUTPUT_CONTRACT_VIOLATION';
  return 'ACTION_INVOCATION_REFUSED';
}

function errorRemediation(exit: 2 | 3 | 4 | 5 | 6 | 7): string {
  if (exit === 3) return 'Resolve the reported gate findings, then rerun the action.';
  if (exit === 5) return 'Satisfy the reported precondition, then retry.';
  return 'Correct the invocation or satisfy the reported precondition, then retry.';
}

function errorFrom(text: string, exit: number): CliError {
  const trimmed = text.trim();
  let parsedPayload: unknown;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    parsedPayload = parsed;
    if (validators.error(parsed)) return parsed as CliError;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      validators.error((parsed as { error?: unknown }).error)
    ) {
      return (parsed as { error: CliError }).error;
    }
  } catch {
    // Unstructured service output is normalized below.
  }
  const normalized = normalizeExit(exit);
  const message =
    parsedPayload === undefined
      ? trimmed.replace(/^devai(?: [^:]+)?:\s*/u, '') || 'action failed'
      : normalized === 3
        ? 'The action completed with a failing gate outcome.'
        : normalized === 5
          ? 'The action precondition was not satisfied.'
          : 'The action returned a structured failure payload.';
  return cliError({
    code: errorCode(normalized),
    class: errorClass(normalized),
    exit: normalized,
    message,
    remediation: errorRemediation(normalized),
    ...(parsedPayload === undefined ? {} : { context: { payload: parsedPayload } }),
  });
}

function validatePayload(entry: RegistryEntry, payload: ReturnType<typeof payloadFrom>): void {
  const schema = entry.output_contract.payload_schema;
  if (schema === null || payload.media_type !== 'application/json') return;
  const name = basename(schema) as SchemaName;
  const validate = getValidator(name);
  if (!validate(payload.value)) {
    throw new Error(`ACTION_PAYLOAD_CONTRACT_VIOLATION:${entry.name}:${schema}`);
  }
}

export function renderActionSuccess(
  entry: RegistryEntry,
  stdout: string,
  verdict: 'pass' | 'review' = 'pass',
): string {
  const result = payloadFrom(stdout);
  validatePayload(entry, result);
  const envelope = {
    schemaVersion: '1.0.0',
    action_id: entry.name,
    ok: true,
    result: { verdict, ...result },
  };
  if (!validators.actionResult(envelope)) {
    throw new Error(`ACTION_RESULT_CONTRACT_VIOLATION:${entry.name}`);
  }
  return `${JSON.stringify(envelope)}\n`;
}

export function renderActionFailure(entry: RegistryEntry, stderr: string, exit: number): string {
  const error = errorFrom(stderr, exit);
  const envelope = { schemaVersion: '1.0.0', action_id: entry.name, ok: false, error };
  if (!validators.actionResult(envelope)) {
    throw new Error(`ACTION_ERROR_CONTRACT_VIOLATION:${entry.name}`);
  }
  return `${JSON.stringify(envelope)}\n`;
}

export function publicActionForArgv(
  argv: readonly string[],
  entries: readonly RegistryEntry[],
): RegistryEntry | undefined {
  if (!wantsMachineJson(argv)) return undefined;
  const words = argv.slice(2).filter((value) => !value.startsWith('-'));
  return entries
    .filter((entry) => entry.path.every((part, index) => words[index] === part))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

export function emitPreDispatchActionResult(
  entry: RegistryEntry | undefined,
  result: Readonly<{ exit: number; stdout: string; stderr: string }>,
): boolean {
  if (entry === undefined) return false;
  if (result.exit === 0 && result.stderr.length === 0) {
    process.stdout.write(renderActionSuccess(entry, result.stdout));
    process.exitCode = 0;
    return true;
  }
  if (result.exit === 1 && result.stderr.length === 0) {
    process.stdout.write(renderActionSuccess(entry, result.stdout, 'review'));
    process.exitCode = 1;
    return true;
  }
  process.stderr.write(
    renderActionFailure(
      entry,
      result.stderr.length > 0 ? result.stderr : result.stdout,
      result.exit,
    ),
  );
  process.exitCode = result.exit === 0 ? 7 : normalizeExit(result.exit);
  return true;
}

export type CliExecutionStage =
  'initialization' | 'registry-validation' | 'authorization' | 'routing' | 'handler-dispatch';

export type CliStageResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; stage: CliExecutionStage }>;

/**
 * Execute one real CLI orchestration stage inside the selected public
 * machine boundary. The explicit stage seam lets acceptance inject an
 * ordinary non-allowlisted throw at every boundary without introducing
 * test-only production behavior.
 */
export function runCliStage<T>(
  entry: RegistryEntry | undefined,
  stage: CliExecutionStage,
  operation: () => T,
): CliStageResult<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    const usage = error instanceof Error && error.name === 'CACError';
    const message = error instanceof Error ? error.message : String(error);
    const optionalDependency = /^OPTIONAL_DEPENDENCY_MISSING:([A-Za-z0-9@/._-]+)$/u.exec(message);
    const exit = usage ? 2 : optionalDependency === null ? 6 : 5;
    if (entry === undefined) {
      process.stderr.write(`devai: ${message}\n`);
      process.exitCode = exit;
      return { ok: false, stage };
    }
    if (
      optionalDependency !== null &&
      entry !== undefined &&
      emitPreDispatchActionResult(entry, {
        exit,
        stdout: '',
        stderr: `${JSON.stringify(
          cliError({
            code: 'SENSOR_OPTIONAL_DEPENDENCY_MISSING',
            class: 'precondition',
            exit: 5,
            message: `Optional dependency '${optionalDependency[1]}' is required for this feature.`,
            remediation: `Install '${optionalDependency[1]}' to use this feature: pnpm add ${optionalDependency[1]}`,
            context: { package: optionalDependency[1], stage },
          }),
        )}\n`,
      })
    ) {
      return { ok: false, stage };
    }
    if (
      !emitPreDispatchActionResult(entry, {
        exit,
        stdout: '',
        stderr: `devai: ${message}\n`,
      })
    ) {
      throw error;
    }
    return { ok: false, stage };
  }
}

function restoreAndEmit(
  entry: RegistryEntry,
  stdout: string,
  stderr: string,
  exit: number,
  originalStdout: Write,
  originalStderr: Write,
  originalExit: typeof process.exit,
): void {
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  process.exit = originalExit;
  if (exit === 0 && stderr.length === 0) {
    originalStdout.call(process.stdout, renderActionSuccess(entry, stdout));
    process.exitCode = 0;
    return;
  }
  if (exit === 1 && stderr.length === 0) {
    originalStdout.call(process.stdout, renderActionSuccess(entry, stdout, 'review'));
    process.exitCode = 1;
    return;
  }
  const effectiveExit = exit === 0 ? 7 : normalizeExit(exit);
  const diagnostic =
    exit === 0 && stdout.length > 0 && stderr.length > 0
      ? `action wrote to both success and error channels; stdout=${JSON.stringify(stdout.trim())}; stderr=${JSON.stringify(stderr.trim())}`
      : stderr.length > 0
        ? stderr
        : stdout.length > 0
          ? stdout
          : 'action failed without a diagnostic';
  originalStderr.call(process.stderr, renderActionFailure(entry, diagnostic, effectiveExit));
  process.exitCode = effectiveExit;
}

export function attachActionOutputBoundaries(
  commands: readonly Command[],
  entries: readonly RegistryEntry[],
): void {
  const entry = publicActionForArgv(process.argv, entries);
  if (entry === undefined) return;
  for (const command of commands) {
    const original = command?.commandAction;
    if (!command || !original) continue;
    command.commandAction = function actionOutputBoundary(...args: unknown[]) {
      if (!wantsMachineJson(process.argv)) return original(...args);
      let stdout = '';
      let stderr = '';
      let explicitExit: number | undefined;
      const originalStdout = process.stdout.write;
      const originalStderr = process.stderr.write;
      const originalExit = process.exit;
      process.exitCode = undefined;
      process.stdout.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        stdout += chunkText(chunk, encoding);
        if (typeof callback === 'function') callback();
        return true;
      }) as Write;
      process.stderr.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        stderr += chunkText(chunk, encoding);
        if (typeof callback === 'function') callback();
        return true;
      }) as Write;
      process.exit = ((code?: number | string | null): never => {
        explicitExit = typeof code === 'number' ? code : Number(code ?? 0);
        throw new CommandExit(explicitExit);
      }) as typeof process.exit;

      const finish = (): void => {
        const exit = explicitExit ?? (typeof process.exitCode === 'number' ? process.exitCode : 0);
        restoreAndEmit(entry, stdout, stderr, exit, originalStdout, originalStderr, originalExit);
      };
      const fail = (error: unknown): void => {
        if (!(error instanceof CommandExit)) {
          const message = error instanceof Error ? error.message : String(error);
          const optionalDependency = /^OPTIONAL_DEPENDENCY_MISSING:([A-Za-z0-9@/._-]+)$/u.exec(
            message,
          );
          explicitExit = optionalDependency === null ? 6 : 5;
          stderr =
            optionalDependency === null
              ? message
              : JSON.stringify(
                  cliError({
                    code: 'SENSOR_OPTIONAL_DEPENDENCY_MISSING',
                    class: 'precondition',
                    exit: 5,
                    message: `Optional dependency '${optionalDependency[1]}' is required for this feature.`,
                    remediation: `Install '${optionalDependency[1]}' to use this feature: pnpm add ${optionalDependency[1]}`,
                    context: { package: optionalDependency[1], stage: 'handler-dispatch' },
                  }),
                );
        }
        finish();
      };

      try {
        const value = original(...args);
        if (value && typeof (value as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(value).then(finish, fail);
        }
        finish();
        return value;
      } catch (error) {
        fail(error);
        return undefined;
      }
    };
  }
}
