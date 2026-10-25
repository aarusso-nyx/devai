import {
  isReconciliationOwnerOutputInvocation,
  runReconciliationOwnerOutput,
} from './reconciliation-owner-output.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  isReconciliationPhaseOutputInvocation,
  runReconciliationPhaseOutput,
} from './reconciliation-phase-output.js';
import {
  isReconciliationProvisionOutputInvocation,
  runReconciliationProvisionOutput,
} from './reconciliation-provision-output.js';
import { isExactAuthorityPolicyReviewInvocation } from './command-router.js';
import type { Command } from 'cac';
import { getValidator, type SchemaName, validators } from '@devai-nyx/schemas';
import { basename } from 'node:path';
import { cliError, type CliError } from './cli-error.js';
import type { RegistryEntry } from './define-command.js';

interface AuthorityPolicyReviewOutput {
  ready(payload: Readonly<Record<string, unknown>>): void;
  prompt(text: string): void;
  complete(payload: Readonly<Record<string, unknown>>): void;
  refuse(error: CliError): void;
  publicationFailure(error: unknown): boolean;
}

const reviewOutput = new AsyncLocalStorage<AuthorityPolicyReviewOutput>();
const reviewInvocations = new WeakMap<AuthorityPolicyReviewOutput, readonly string[]>();

/** No constructor or serialized token: only an admitted live boundary owns this transport. */
export function requireAuthorityPolicyReviewOutput(): AuthorityPolicyReviewOutput {
  const transport = reviewOutput.getStore();
  const argv = transport === undefined ? undefined : reviewInvocations.get(transport);
  if (
    transport === undefined ||
    argv === undefined ||
    argv.length !== process.argv.length ||
    !argv.every((value, index) => value === process.argv[index]) ||
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true ||
    process.stderr.isTTY !== true
  )
    throw new Error(
      'AUTHORITY_POLICY_REVIEW_INPUTS_UNSUPPORTED:an admitted live output boundary is required',
    );
  return transport;
}

/** Preserve the existing publisher's post-link uncertainty without a new exit class. */
function publicationFailure(error: unknown): CliError | undefined {
  if (!(error instanceof Error)) return undefined;
  const failure = error as Error & {
    code?: unknown;
    path?: unknown;
    staged_remaining?: unknown;
    identity?: unknown;
  };
  if (
    failure.code !== 'AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE' ||
    typeof failure.path !== 'string' ||
    typeof failure.staged_remaining !== 'boolean' ||
    failure.identity === null ||
    typeof failure.identity !== 'object'
  )
    return undefined;
  const identity = failure.identity as Record<string, unknown>;
  if (
    typeof identity.dev !== 'bigint' ||
    typeof identity.ino !== 'bigint' ||
    typeof identity.birthtimeNs !== 'bigint'
  )
    return undefined;
  return cliError({
    code: errorCode(6),
    class: errorClass(6),
    exit: 6,
    message: failure.message,
    remediation:
      'Inspect the preserved target and publisher-owned staged entry before any separately authorized recovery.',
    context: {
      publication: {
        code: failure.code,
        path: failure.path,
        staged_remaining: failure.staged_remaining,
        identity: {
          dev: identity.dev.toString(),
          ino: identity.ino.toString(),
          birthtimeNs: identity.birthtimeNs.toString(),
        },
        status: 'indeterminate',
        durability: 'unknown',
      },
    },
  });
}

function isPublicationFailure(error: CliError): boolean {
  const publication = error.context?.['publication'];
  return (
    error.code === errorCode(6) &&
    error.class === errorClass(6) &&
    error.exit === 6 &&
    publication !== null &&
    typeof publication === 'object' &&
    (publication as Record<string, unknown>)['code'] === 'AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE'
  );
}

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
      if (isReconciliationOwnerOutputInvocation(entry, command.name)) {
        return runReconciliationOwnerOutput(
          entry,
          () => original.apply(command, args),
          renderActionSuccess,
          renderActionFailure,
        );
      }
      if (isReconciliationPhaseOutputInvocation(entry, command.name)) {
        return runReconciliationPhaseOutput(
          entry,
          () => original.apply(command, args),
          renderActionSuccess,
          renderActionFailure,
        );
      }
      if (isReconciliationProvisionOutputInvocation(entry, command.name)) {
        return runReconciliationProvisionOutput(
          entry,
          () => original(...args),
          renderActionSuccess,
          renderActionFailure,
        );
      }
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

      const streaming =
        entry.name === 'init bind' &&
        command.name === entry.internal_name &&
        isExactAuthorityPolicyReviewInvocation(process.argv) &&
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true &&
        process.stderr.isTTY === true;
      let phase: 'initial' | 'ready' | 'prompted' | 'terminal' | 'closed' = 'initial';
      let finalizationException: string | undefined;
      let terminal:
        | { kind: 'complete'; payload: Readonly<Record<string, unknown>> }
        | { kind: 'refused'; error: CliError }
        | undefined;
      const assertOwned = (receiver: unknown): void => {
        if (receiver !== transport || reviewOutput.getStore() !== transport || phase === 'closed')
          throw new Error('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
        try {
          requireAuthorityPolicyReviewOutput();
        } catch {
          throw new Error('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
        }
      };
      const transport: AuthorityPolicyReviewOutput = Object.freeze({
        ready(payload: Readonly<Record<string, unknown>>): void {
          assertOwned(this);
          if (
            phase !== 'initial' ||
            payload.kind !== 'authority-policy-create-review' ||
            payload.schema_version !== '1.0.0' ||
            payload.status !== 'awaiting-exact-confirmation' ||
            payload.grants_authority !== false ||
            payload.target !== '.devai/config/authority-policy.json' ||
            payload.operation !== 'create'
          )
            throw new Error('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
          const output = renderActionSuccess(entry, JSON.stringify(payload), 'review');
          phase = 'ready';
          originalStdout.call(process.stdout, output);
        },
        prompt(text: string): void {
          assertOwned(this);
          if (phase !== 'ready') throw new Error('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
          phase = 'prompted';
          originalStderr.call(process.stderr, text);
        },
        complete(payload: Readonly<Record<string, unknown>>): void {
          assertOwned(this);
          if (phase !== 'prompted' || !['created', 'cancelled'].includes(String(payload.status)))
            throw new Error('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
          terminal = {
            kind: 'complete',
            payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
          };
          phase = 'terminal';
        },
        publicationFailure(error: unknown): boolean {
          assertOwned(this);
          if (phase === 'terminal') throw new Error('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
          const failure = publicationFailure(error);
          if (failure === undefined) return false;
          terminal = { kind: 'refused', error: failure };
          phase = 'terminal';
          return true;
        },
        refuse(error: CliError): void {
          assertOwned(this);
          if (
            phase === 'terminal' ||
            !validators.error(error) ||
            error.exit !== 2 ||
            error.class !== 'routing-authority'
          )
            throw new Error('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
          terminal = { kind: 'refused', error: JSON.parse(JSON.stringify(error)) as CliError };
          phase = 'terminal';
        },
      });
      if (streaming) reviewInvocations.set(transport, Object.freeze([...process.argv]));
      const finish = (): void => {
        const exit = explicitExit ?? (typeof process.exitCode === 'number' ? process.exitCode : 0);
        if (!streaming) {
          restoreAndEmit(entry, stdout, stderr, exit, originalStdout, originalStderr, originalExit);
          return;
        }
        phase = 'closed';
        reviewInvocations.delete(transport);
        process.stdout.write = originalStdout;
        process.stderr.write = originalStderr;
        process.exit = originalExit;
        // Once a linked publication is indeterminate, no later exit or diagnostic
        // may erase its custody evidence or recast it as a clean refusal.
        if (terminal?.kind === 'refused' && isPublicationFailure(terminal.error)) {
          const pending = terminal.error;
          const finalization =
            exit !== 6 || stdout !== '' || stderr !== '' || finalizationException !== undefined;
          const failure = finalization
            ? cliError({
                code: pending.code,
                class: 'infrastructure',
                exit: 6,
                message: pending.message,
                ...(pending.remediation === undefined ? {} : { remediation: pending.remediation }),
                context: {
                  ...pending.context,
                  finalization_failure: {
                    exit,
                    ...(stdout === '' ? {} : { stdout }),
                    ...(stderr === '' ? {} : { stderr }),
                    ...(finalizationException === undefined
                      ? {}
                      : { message: finalizationException }),
                  },
                },
              })
            : pending;
          originalStderr.call(
            process.stderr,
            renderActionFailure(entry, JSON.stringify(failure), 6),
          );
          process.exitCode = 6;
          return;
        }
        if (exit === 0 && terminal?.kind === 'complete' && stdout === '' && stderr === '') {
          originalStdout.call(
            process.stdout,
            renderActionSuccess(entry, JSON.stringify(terminal.payload)),
          );
          process.exitCode = 0;
          return;
        }
        if (
          terminal?.kind === 'refused' &&
          exit === terminal.error.exit &&
          stdout === '' &&
          stderr === ''
        ) {
          originalStderr.call(
            process.stderr,
            renderActionFailure(entry, JSON.stringify(terminal.error), exit),
          );
          process.exitCode = exit;
          return;
        }
        const failureExit = exit === 0 ? 7 : normalizeExit(exit);
        const diagnostic = stderr || stdout || 'exact review did not produce one terminal outcome';
        originalStderr.call(process.stderr, renderActionFailure(entry, diagnostic, failureExit));
        process.exitCode = failureExit;
      };
      const fail = (error: unknown): void => {
        if (!(error instanceof CommandExit)) {
          const message = error instanceof Error ? error.message : String(error);
          const pendingPublication =
            streaming && terminal?.kind === 'refused' && isPublicationFailure(terminal.error)
              ? terminal.error
              : undefined;
          if (pendingPublication !== undefined) finalizationException = message;
          const publication = streaming ? publicationFailure(error) : undefined;
          const optionalDependency = /^OPTIONAL_DEPENDENCY_MISSING:([A-Za-z0-9@/._-]+)$/u.exec(
            message,
          );
          explicitExit = publication !== undefined || optionalDependency === null ? 6 : 5;
          stderr =
            publication !== undefined
              ? JSON.stringify(publication)
              : optionalDependency === null
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
        const value = streaming
          ? reviewOutput.run(transport, () => original(...args))
          : original(...args);
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
