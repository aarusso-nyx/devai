import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { readReconciliationHostBinding } from '@devai-nyx/authority';
import type {
  ReconciliationApprovalPreview,
  ReconciliationApprovalResult,
  ReconciliationGrantPreview,
  ReconciliationGrantResult,
  ReconciliationDeadLeasePreview,
  ReconciliationDeadLeaseResult,
} from '@devai-nyx/authority/reconciliation-native';
import { getValidator } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';
import type { RegistryEntry } from './define-command.js';
import { cliError, type CliError } from './cli-error.js';
import { parseReconciliationHostInput } from './authority/reconciliation-host-input.js';
import { reconciliationOutputCustody } from './reconciliation-output-custody.js';
export type ReconciliationOwnerPreview =
  ReconciliationApprovalPreview | ReconciliationGrantPreview | ReconciliationDeadLeasePreview;
export type ReconciliationOwnerResult =
  ReconciliationApprovalResult | ReconciliationGrantResult | ReconciliationDeadLeaseResult;
interface OwnerOutput {
  ready(value: ReconciliationOwnerPreview): Promise<void>;
  finishOwnerReconciliation(value: ReconciliationOwnerResult): void;
  refuse(error: CliError): void;
}
const outputs = new AsyncLocalStorage<OwnerOutput>(),
  invocations = new WeakMap<OwnerOutput, readonly string[]>();
function invalid(): never {
  throw new Error('RECONCILIATION_APPROVAL_INVALID');
}
function terminal(): boolean {
  return (
    process.stdin.isTTY === true && process.stdout.isTTY === true && process.stderr.isTTY === true
  );
}
export function isReconciliationOwnerOutputInvocation(
  entry: RegistryEntry,
  commandName: string,
): boolean {
  if (
    entry.name !== 'evidence reconcile approve' ||
    commandName !== entry.internal_name ||
    !terminal()
  )
    return false;
  try {
    const index = process.argv.indexOf('--repo-root'),
      root = realpathSync(process.argv[index + 1] ?? '');
    return parseReconciliationHostInput(entry.name, process.argv, root, 'owner')?.write === true;
  } catch {
    return false;
  }
}
export function requireReconciliationOwnerOutput(): OwnerOutput {
  const output = outputs.getStore(),
    argv = output ? invocations.get(output) : undefined;
  if (
    !output ||
    !argv ||
    !terminal() ||
    argv.length !== process.argv.length ||
    !argv.every((value, index) => value === process.argv[index])
  )
    invalid();
  readReconciliationHostBinding();
  return output;
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
/** One exact direct-Owner ready/confirmation/result exchange; independent of P1 and provisioning. */
export async function runReconciliationOwnerOutput(
  entry: RegistryEntry,
  invoke: () => unknown,
  success: (entry: RegistryEntry, text: string, verdict?: 'pass' | 'review') => string,
  failure: (entry: RegistryEntry, text: string, exit: number) => string,
): Promise<void> {
  const stdout = process.stdout.write,
    stderr = process.stderr.write;
  let buffered = '',
    diagnostics = '',
    closed = false,
    ready: ReconciliationOwnerPreview | undefined,
    result: ReconciliationOwnerResult | undefined,
    custody: Readonly<Record<string, unknown>> | undefined,
    refusal: CliError | undefined;
  const validate = getValidator('reconciliation-owner-action.schema.json');
  const output: OwnerOutput = Object.freeze({
    async ready(value: ReconciliationOwnerPreview): Promise<void> {
      if (
        this !== output ||
        requireReconciliationOwnerOutput() !== output ||
        closed ||
        ready ||
        result ||
        !validate(value) ||
        !value.kind.endsWith('-review')
      )
        invalid();
      ready = JSON.parse(canonicalJson(value)) as ReconciliationOwnerPreview;
      await write(process.stdout, stdout, success(entry, canonicalJson(value), 'review'));
      await write(
        process.stderr,
        stderr,
        `Type ${value.confirmation}; EOF cancels this exact Owner review.\n`,
      );
    },
    finishOwnerReconciliation(value: ReconciliationOwnerResult): void {
      if (
        this !== output ||
        outputs.getStore() !== output ||
        closed ||
        custody ||
        refusal ||
        !ready
      )
        invalid();
      custody = reconciliationOutputCustody(value);
      if (
        !validate(value) ||
        !value.kind.endsWith('-result') ||
        value.approval_id !== ready.approval_id ||
        value.plan_sha256 !== ready.plan_sha256
      )
        invalid();
      result = JSON.parse(canonicalJson(value)) as ReconciliationOwnerResult;
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
  const failed = async (message: string, custody?: Readonly<Record<string, unknown>>) => {
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
              message,
              context: custody
                ? { reconciliation: { ...custody, outcome: 'indeterminate' } }
                : undefined,
            }),
          ),
          6,
        ),
      );
    } catch {
      /* Retain infrastructure/indeterminate standing when output also fails. */
    }
  };
  if (
    result?.outcome === 'indeterminate' ||
    (custody && (!result || thrown || buffered || diagnostics || exit !== 0))
  ) {
    await failed(
      'Owner reconciliation stopped with preserved custody; inspect the exact recorded state.',
      custody,
    );
    return;
  }
  if (result && !thrown && !buffered && !diagnostics && exit === 0) {
    try {
      await write(
        process.stdout,
        stdout,
        success(entry, canonicalJson(result), result.outcome === 'cancelled' ? 'review' : 'pass'),
      );
      process.exitCode = 0;
    } catch {
      await failed(
        'Owner reconciliation completed but its result could not be delivered; inspect before retrying.',
        custody,
      );
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
  await failed(
    'The exact Owner reconciliation exchange did not produce a complete result.',
    custody,
  );
}
