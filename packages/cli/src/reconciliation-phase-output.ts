import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { readReconciliationHostBinding } from '@devai-nyx/authority';
import { getValidator } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';
import type { RegistryEntry } from './define-command.js';
import { cliError, type CliError } from './cli-error.js';
import { parseReconciliationHostInput } from './authority/reconciliation-host-input.js';
import { reconciliationOutputCustody } from './reconciliation-output-custody.js';

const actions = {
  'evidence reconcile materialize': ['inspector', 'reconciliation-materialize-result.schema.json'],
  'evidence reconcile stage-proof': ['inspector', 'reconciliation-proof-index-result.schema.json'],
  'sense bootstrap-inventory': ['architect', 'reconciliation-inventory-result.schema.json'],
} as const;
type Action = keyof typeof actions;
interface PhaseOutput {
  finishReconciliationPhase(value: object): void;
  refuse(error: CliError): void;
}
const outputs = new AsyncLocalStorage<PhaseOutput>();
const invocations = new WeakMap<PhaseOutput, readonly string[]>();
function invalid(): never {
  throw new Error('RECONCILIATION_PHASE_INVALID');
}
export function isReconciliationPhaseOutputInvocation(
  entry: RegistryEntry,
  commandName: string,
): boolean {
  if (!Object.hasOwn(actions, entry.name) || commandName !== entry.internal_name) return false;
  try {
    const root = realpathSync(process.argv[process.argv.indexOf('--repo-root') + 1] ?? '');
    return (
      parseReconciliationHostInput(entry.name, process.argv, root, actions[entry.name as Action][0])
        ?.write === true
    );
  } catch {
    return false;
  }
}
/** Obtain transport and actual B5 before calling any effectful native phase. */
export function requireReconciliationPhaseOutput(): PhaseOutput {
  const output = outputs.getStore(),
    argv = output && invocations.get(output);
  if (
    !output ||
    !argv ||
    argv.length !== process.argv.length ||
    !argv.every((arg, i) => arg === process.argv[i])
  )
    invalid();
  readReconciliationHostBinding();
  return output;
}
export function refuseReconciliationPhaseOutput(error: CliError): boolean {
  const output = outputs.getStore();
  if (!output) return false;
  output.refuse(error);
  return true;
}
type Write = typeof process.stdout.write;
function write(stream: NodeJS.WriteStream, original: Write, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const error = (cause: Error) => {
      stream.removeListener('error', error);
      reject(cause);
    };
    stream.once('error', error);
    try {
      original.call(stream, text, 'utf8', (cause?: Error | null) => {
        if (cause) {
          // Native Writable invokes its failed write callback before emitting
          // 'error'. Keep the listener through that next-tick emission. The
          // fallback also cleans up callback-only streams without leaking it.
          setImmediate(() => {
            stream.removeListener('error', error);
            reject(cause);
          });
        } else {
          stream.removeListener('error', error);
          resolve();
        }
      });
    } catch (cause) {
      stream.removeListener('error', error);
      reject(cause);
    }
  });
}
/** Exact three machine phases only; retain native custody through finalization and delivery. */
export async function runReconciliationPhaseOutput(
  entry: RegistryEntry,
  invoke: () => unknown,
  success: (entry: RegistryEntry, text: string, verdict?: 'pass' | 'review') => string,
  failure: (entry: RegistryEntry, text: string, exit: number) => string,
): Promise<void> {
  if (!Object.hasOwn(actions, entry.name)) invalid();
  const validate = getValidator(actions[entry.name as Action][1]);
  const stdout = process.stdout.write,
    stderr = process.stderr.write;
  let buffered = '',
    diagnostics = '',
    closed = false,
    result: object | undefined,
    custody: Readonly<Record<string, unknown>> | undefined,
    refusal: CliError | undefined;
  const output: PhaseOutput = Object.freeze({
    finishReconciliationPhase(value: object): void {
      if (this !== output || outputs.getStore() !== output || closed || custody || refusal)
        invalid();
      // Capture a closed diagnostic projection before schema/serialization can fail.
      custody = reconciliationOutputCustody(value);
      if (!validate(value)) invalid();
      result = JSON.parse(canonicalJson(value)) as object;
    },
    refuse(value: CliError): void {
      if (this !== output || outputs.getStore() !== output || closed || refusal) invalid();
      refusal = value;
    },
  });
  invocations.set(output, Object.freeze([...process.argv]));
  process.stdout.write = ((chunk: unknown) => {
    buffered += String(chunk);
    return true;
  }) as Write;
  process.stderr.write = ((chunk: unknown) => {
    diagnostics += String(chunk);
    return true;
  }) as Write;
  process.exitCode = undefined;
  let thrown: unknown;
  try {
    await outputs.run(output, invoke);
  } catch (error) {
    thrown = error;
  }
  closed = true;
  invocations.delete(output);
  process.stdout.write = stdout;
  process.stderr.write = stderr;
  const exit = typeof process.exitCode === 'number' ? process.exitCode : 0;
  const failed = async () => {
    process.exitCode = 6;
    try {
      await write(
        process.stderr,
        stderr,
        failure(
          entry,
          canonicalJson(
            cliError({
              code: 'ACTION_INFRASTRUCTURE_FAILURE',
              class: 'infrastructure',
              exit: 6,
              message:
                'Reconciliation delivery or finalization failed; inspect preserved native custody before retrying.',
              ...(custody ? { context: { reconciliation: custody } } : {}),
            }),
          ),
          6,
        ),
      );
    } catch {
      /* Keep indeterminate standing when the diagnostic stream also fails. */
    }
  };
  if (
    custody &&
    (!result ||
      thrown ||
      buffered ||
      diagnostics ||
      exit !== 0 ||
      (result as { outcome?: unknown }).outcome === 'indeterminate')
  ) {
    await failed();
    return;
  }
  if (result && !thrown && !buffered && !diagnostics && exit === 0) {
    try {
      await write(process.stdout, stdout, success(entry, canonicalJson(result)));
      process.exitCode = 0;
    } catch {
      await failed();
    }
    return;
  }
  if (refusal && !custody && !thrown && !buffered && !diagnostics) {
    process.exitCode = refusal.exit;
    try {
      await write(process.stderr, stderr, failure(entry, canonicalJson(refusal), refusal.exit));
    } catch {
      process.exitCode = 6;
    }
    return;
  }
  await failed();
}
