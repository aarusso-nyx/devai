import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { readReconciliationHostBinding } from '@devai-nyx/authority';
import type {
  ReconciliationHostProvisionReady,
  ReconciliationHostProvisionResult,
} from '@devai-nyx/authority';
import { canonicalJson } from '@devai-nyx/utils';
import { createHash } from 'node:crypto';
import type { RegistryEntry } from './define-command.js';
import { cliError, type CliError } from './cli-error.js';
import { parseReconciliationHostInput } from './authority/reconciliation-host-input.js';

interface ProvisionOutput {
  ready(value: ReconciliationHostProvisionReady): Promise<void>;
  complete(value: ReconciliationHostProvisionResult): void;
  refuse(error: CliError): void;
}
const outputs = new AsyncLocalStorage<ProvisionOutput>();
const invocations = new WeakMap<ProvisionOutput, readonly string[]>();
const logicalTargets = new Set([
  'worktree-host/devai',
  'worktree-host/devai/reconciliation',
  'worktree-host/devai/reconciliation/admission.sqlite',
  'worktree-host/devai/reconciliation/issuer.json',
]);
const sha = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function invalid(): never {
  throw new Error('RECONCILIATION_PROVISION_REVIEW_INVALID');
}
function exact(value: object, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
export function isReconciliationProvisionOutputInvocation(
  entry: RegistryEntry,
  commandName: string,
): boolean {
  if (
    entry.name !== 'init bind' ||
    commandName !== entry.internal_name ||
    !process.argv.includes('--reconciliation-host') ||
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true ||
    process.stderr.isTTY !== true
  )
    return false;
  try {
    const index = process.argv.indexOf('--target');
    const root = realpathSync(process.argv[index + 1] ?? '');
    const parsed = parseReconciliationHostInput('init bind', process.argv, root, 'architect');
    return parsed?.operation === 'provision' && parsed.write;
  } catch {
    return false;
  }
}
export function requireReconciliationProvisionOutput(): ProvisionOutput {
  const output = outputs.getStore();
  const argv = output === undefined ? undefined : invocations.get(output);
  if (
    !output ||
    !argv ||
    argv.length !== process.argv.length ||
    !argv.every((value, index) => value === process.argv[index]) ||
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true ||
    process.stderr.isTTY !== true
  )
    invalid();
  // Requires the actual live broker, exact original argv and current B5; no serialized handle.
  readReconciliationHostBinding();
  return output;
}
function validReady(value: ReconciliationHostProvisionReady): boolean {
  const { plan_sha256, confirmation, ...basis } = value;
  return (
    exact(value, [
      'kind',
      'action_id',
      'stage',
      'repository_id',
      'worktree_id',
      'host_identity_sha256',
      'binding_sha256',
      'namespace_sha256',
      'plan_sha256',
      'artifact',
      'effects',
      'confirmation',
      'lifetime_ms',
      'grants_authority',
    ]) &&
    value.kind === 'reconciliation-provision-review' &&
    value.action_id === 'init bind' &&
    ['seed', 'issuer'].includes(value.stage) &&
    value.grants_authority === false &&
    value.lifetime_ms === 300000 &&
    [value.host_identity_sha256, value.binding_sha256, value.namespace_sha256, plan_sha256].every(
      digest,
    ) &&
    typeof value.repository_id === 'string' &&
    typeof value.worktree_id === 'string' &&
    exact(value.artifact, ['sha256', 'size_bytes']) &&
    digest(value.artifact.sha256) &&
    Number.isSafeInteger(value.artifact.size_bytes) &&
    value.artifact.size_bytes > 0 &&
    Array.isArray(value.effects) &&
    value.effects.length > 0 &&
    value.effects.length <= 4 &&
    value.effects.every(
      (effect) =>
        exact(effect, ['target', 'operation', 'mode']) &&
        logicalTargets.has(effect.target) &&
        ['create-directory', 'publish-seed', 'sync-precursor', 'publish-issuer'].includes(
          effect.operation,
        ) &&
        ['0700', '0600'].includes(effect.mode),
    ) &&
    plan_sha256 === sha(basis) &&
    confirmation ===
      `${value.stage === 'seed' ? 'PREPARE' : 'BIND'} RECONCILIATION-HOST ${plan_sha256}`
  );
}
function validResult(value: ReconciliationHostProvisionResult): boolean {
  return (
    exact(value, [
      'kind',
      'action_id',
      'outcome',
      'stage',
      'repository_id',
      'worktree_id',
      'issuer_sha256',
      'owned',
      'grants_authority',
    ]) &&
    value.kind === 'reconciliation-provision-result' &&
    value.action_id === 'init bind' &&
    ['created', 'existing', 'cancelled', 'indeterminate'].includes(value.outcome) &&
    (value.stage === null || ['seed', 'issuer'].includes(value.stage)) &&
    value.grants_authority === false &&
    typeof value.repository_id === 'string' &&
    typeof value.worktree_id === 'string' &&
    (value.issuer_sha256 === null || digest(value.issuer_sha256)) &&
    Array.isArray(value.owned) &&
    value.owned.length <= 4 &&
    value.owned.every(
      (owned) =>
        exact(owned, ['target', 'dev', 'ino', 'birthtime_ns']) &&
        logicalTargets.has(owned.target) &&
        [owned.dev, owned.ino, owned.birthtime_ns].every((v) => /^\d+$/u.test(v)),
    )
  );
}
type Write = typeof process.stdout.write;
function write(stream: NodeJS.WriteStream, original: Write, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      stream.removeListener('error', fail);
      reject(error);
    };
    stream.once('error', fail);
    try {
      original.call(stream, text, 'utf8', (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        stream.removeListener('error', fail);
        resolve();
      });
    } catch (error) {
      stream.removeListener('error', fail);
      reject(error);
    }
  });
}

/** Exact two-stage native exchange, outside the unchanged P1 output transport. */
export async function runReconciliationProvisionOutput(
  entry: RegistryEntry,
  invoke: () => unknown,
  success: (entry: RegistryEntry, text: string, verdict?: 'pass' | 'review') => string,
  failure: (entry: RegistryEntry, text: string, exit: number) => string,
): Promise<void> {
  const stdout = process.stdout.write,
    stderr = process.stderr.write;
  let buffered = '',
    diagnostics = '';
  let ready: ReconciliationHostProvisionReady | undefined;
  let terminal: ReconciliationHostProvisionResult | undefined;
  let refused: CliError | undefined;
  let closed = false;
  const output: ProvisionOutput = Object.freeze({
    async ready(value: ReconciliationHostProvisionReady): Promise<void> {
      if (
        this !== output ||
        requireReconciliationProvisionOutput() !== output ||
        closed ||
        terminal ||
        !validReady(value) ||
        (ready !== undefined && (ready.stage !== 'seed' || value.stage !== 'issuer'))
      )
        invalid();
      if (
        ready &&
        (ready.repository_id !== value.repository_id ||
          ready.worktree_id !== value.worktree_id ||
          ready.binding_sha256 !== value.binding_sha256)
      )
        invalid();
      ready = JSON.parse(JSON.stringify(value)) as ReconciliationHostProvisionReady;
      await write(process.stdout, stdout, success(entry, JSON.stringify(value), 'review'));
      await write(
        process.stderr,
        stderr,
        `Type ${value.confirmation}; EOF stops this exchange and preserves completed precursor effects.\n`,
      );
    },
    complete(value: ReconciliationHostProvisionResult): void {
      if (
        this !== output ||
        outputs.getStore() !== output ||
        closed ||
        terminal ||
        refused ||
        !validResult(value) ||
        (!ready && value.outcome !== 'existing')
      )
        invalid();
      if (
        ready &&
        (ready.repository_id !== value.repository_id || ready.worktree_id !== value.worktree_id)
      )
        invalid();
      terminal = JSON.parse(JSON.stringify(value)) as ReconciliationHostProvisionResult;
    },
    refuse(error: CliError): void {
      if (this !== output || outputs.getStore() !== output || closed || terminal || refused)
        invalid();
      refused = error;
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
  if (
    terminal?.outcome === 'indeterminate' ||
    (terminal && (thrown || diagnostics || buffered || exit !== 0))
  ) {
    const custody = { ...terminal, outcome: 'indeterminate' };
    process.exitCode = 6;
    try {
      await write(
        process.stderr,
        stderr,
        failure(
          entry,
          JSON.stringify(
            cliError({
              code: 'ACTION_INFRASTRUCTURE_FAILURE',
              class: 'infrastructure',
              exit: 6,
              message:
                'Reconciliation provisioning stopped with preserved custody; inspect before retrying.',
              context: { provisioning: custody },
            }),
          ),
          6,
        ),
      );
    } catch {
      /* Preserve indeterminate standing when the error channel also fails. */
    }
    return;
  }
  if (terminal && !thrown && !buffered && !diagnostics && exit === 0) {
    process.exitCode = 0;
    try {
      await write(process.stdout, stdout, success(entry, JSON.stringify(terminal)));
    } catch {
      process.exitCode = 6;
      try {
        await write(
          process.stderr,
          stderr,
          failure(
            entry,
            JSON.stringify(
              cliError({
                code: 'ACTION_INFRASTRUCTURE_FAILURE',
                class: 'infrastructure',
                exit: 6,
                message:
                  'Provisioning terminal output failed; preserve known custody before retrying.',
                context: { provisioning: { ...terminal, outcome: 'indeterminate' } },
              }),
            ),
            6,
          ),
        );
      } catch {
        /* Both channels failed; exit 6 never represents clean completion. */
      }
    }
    return;
  }
  const error =
    refused ??
    cliError({
      code: 'ACTION_INFRASTRUCTURE_FAILURE',
      class: 'infrastructure',
      exit: 6,
      message: 'Reconciliation provisioning did not complete its exact public exchange.',
    });
  process.exitCode = error.exit;
  await write(process.stderr, stderr, failure(entry, JSON.stringify(error), error.exit));
}
