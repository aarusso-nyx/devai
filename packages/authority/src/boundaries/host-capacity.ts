import { AsyncLocalStorage } from 'node:async_hooks';
import { issuerState } from '../runtime/contracts.js';
import {
  scopes,
  type AuthorityHostEffectScope,
  type ProtectedReleaseExportCapacity,
  type ProtectedReleaseExportCapacityBinding,
  type ProtectedReleasePrepareCapacity,
  type ProtectedReleasePrepareCapacityBinding,
} from './host-scope.js';

interface PrepareCapacitySequence {
  readonly scope: AuthorityHostEffectScope;
  readonly binding: ProtectedReleasePrepareCapacityBinding;
  readonly reader: NonNullable<AuthorityHostEffectScope['read_prepare_capacity']>;
  active: boolean;
}

const prepareCapacityContexts = new AsyncLocalStorage<PrepareCapacitySequence>();
const prepareCapacityAccounts = new WeakMap<object, PrepareCapacitySequence>();

function capacityRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !Object.hasOwn(descriptor, 'value'),
    )
  )
    throw new Error('release-prepare-capacity-unavailable');
  return value as Record<string, unknown>;
}

function prepareCapacityBinding(value: unknown): ProtectedReleasePrepareCapacityBinding {
  try {
    const binding = capacityRecord(value, [
      'action_id',
      'repository',
      'candidate',
      'plan_receipt_digest_sha256',
    ]);
    const repository = capacityRecord(binding['repository'], ['id', 'commit', 'tree']);
    const candidate = capacityRecord(binding['candidate'], ['commit', 'tree']);
    const objects = [
      repository['commit'],
      repository['tree'],
      candidate['commit'],
      candidate['tree'],
    ];
    if (
      binding['action_id'] !== 'release prepare' ||
      typeof repository['id'] !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(repository['id']) ||
      objects.some(
        (value) => typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value),
      ) ||
      new Set(objects.map((value) => (value as string).length)).size !== 1 ||
      typeof binding['plan_receipt_digest_sha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(binding['plan_receipt_digest_sha256'])
    )
      throw new Error('release-prepare-capacity-unavailable');
    return Object.freeze({
      action_id: 'release prepare',
      repository: Object.freeze({
        id: repository['id'],
        commit: repository['commit'] as string,
        tree: repository['tree'] as string,
      }),
      candidate: Object.freeze({
        commit: candidate['commit'] as string,
        tree: candidate['tree'] as string,
      }),
      plan_receipt_digest_sha256: binding['plan_receipt_digest_sha256'],
    });
  } catch {
    throw new Error('release-prepare-capacity-unavailable');
  }
}

function readPrepareCapacity(sequence: PrepareCapacitySequence): ProtectedReleasePrepareCapacity {
  try {
    const capacity = capacityRecord(sequence.reader(sequence.binding), [
      'remaining_batches',
      'remaining_targets',
    ]);
    const batches = capacity['remaining_batches'];
    const targets = capacity['remaining_targets'];
    if (
      typeof batches !== 'number' ||
      !Number.isSafeInteger(batches) ||
      batches < 0 ||
      batches > 256 ||
      typeof targets !== 'number' ||
      !Number.isSafeInteger(targets) ||
      targets < 0 ||
      targets > 8192
    )
      throw new Error('release-prepare-capacity-unavailable');
    return Object.freeze({ remaining_batches: batches, remaining_targets: targets });
  } catch {
    throw new Error('release-prepare-capacity-unavailable');
  }
}

/** Final host/broker guard: exclusivity grants no target, effect, or publication authority. */
export function assertProtectedReleasePrepareCapacityEffect(receiptStore: object): void {
  const sequence = prepareCapacityAccounts.get(receiptStore);
  if (
    sequence !== undefined &&
    (!sequence.active ||
      prepareCapacityContexts.getStore() !== sequence ||
      scopes.getStore() !== sequence.scope ||
      issuerState(receiptStore)?.closed !== false)
  )
    throw new Error('release-prepare-capacity-unavailable');
}

/** One prepare sequence per live account, including terminal bookkeeping and lock cleanup. */
export async function withProtectedReleasePrepareCapacity<T>(
  binding: ProtectedReleasePrepareCapacityBinding,
  callback: () => Promise<T>,
): Promise<T> {
  const scope = scopes.getStore();
  const selected = prepareCapacityBinding(binding);
  if (
    scope?.action_id !== 'release prepare' ||
    scope.effect !== 'local-write' ||
    typeof callback !== 'function' ||
    typeof scope.read_prepare_capacity !== 'function' ||
    issuerState(scope.receipt_store)?.closed !== false ||
    issuerState(scope.receipt_store)?.invocation_id !== scope.invocation_id ||
    prepareCapacityAccounts.has(scope.receipt_store)
  )
    throw new Error('release-prepare-capacity-unavailable');
  const sequence: PrepareCapacitySequence = {
    scope,
    binding: selected,
    reader: scope.read_prepare_capacity,
    active: true,
  };
  // Validate the broker/account binding without caching an allowance. The kernel reads again
  // after startup and complete package verification, immediately before its first sink effect.
  readPrepareCapacity(sequence);
  prepareCapacityAccounts.set(scope.receipt_store, sequence);
  try {
    return await prepareCapacityContexts.run(sequence, callback);
  } finally {
    // Retain the closed account marker: escaped descendants cannot reuse or reset its budget.
    sequence.active = false;
  }
}

/** Fresh read of the protected account, available only inside its exact live sequence. */
export function readProtectedReleasePrepareCapacity(
  binding: ProtectedReleasePrepareCapacityBinding,
): ProtectedReleasePrepareCapacity {
  const selected = prepareCapacityBinding(binding);
  const sequence = prepareCapacityContexts.getStore();
  if (
    sequence === undefined ||
    prepareCapacityAccounts.get(sequence.scope.receipt_store) !== sequence ||
    JSON.stringify(selected) !== JSON.stringify(sequence.binding)
  )
    throw new Error('release-prepare-capacity-unavailable');
  assertProtectedReleasePrepareCapacityEffect(sequence.scope.receipt_store);
  return readPrepareCapacity(sequence);
}

interface ExportCapacitySequence {
  readonly scope: AuthorityHostEffectScope;
  readonly binding: ProtectedReleaseExportCapacityBinding;
  readonly reader: NonNullable<AuthorityHostEffectScope['read_export_capacity']>;
  active: boolean;
}

const exportCapacityContexts = new AsyncLocalStorage<ExportCapacitySequence>();
const exportCapacityAccounts = new WeakMap<object, ExportCapacitySequence>();

function exportCapacityBinding(value: unknown): ProtectedReleaseExportCapacityBinding {
  try {
    const binding = capacityRecord(value, [
      'action_id',
      'repository',
      'candidate',
      'plan_receipt_digest_sha256',
    ]);
    if (binding['action_id'] !== 'release export') throw new Error();
    // Reuse only the closed locator validation, never the prepare action/account.
    const checked = prepareCapacityBinding({ ...binding, action_id: 'release prepare' });
    if (
      checked.repository.commit !== checked.candidate.commit ||
      checked.repository.tree !== checked.candidate.tree
    )
      throw new Error();
    return Object.freeze({ ...checked, action_id: 'release export' });
  } catch {
    throw new Error('release-export-capacity-unavailable');
  }
}

function readExportCapacity(sequence: ExportCapacitySequence): ProtectedReleaseExportCapacity {
  try {
    const value = capacityRecord(sequence.reader(sequence.binding), [
      'remaining_batches',
      'remaining_targets',
    ]);
    const batches = value['remaining_batches'];
    const targets = value['remaining_targets'];
    if (
      typeof batches !== 'number' ||
      !Number.isSafeInteger(batches) ||
      batches < 0 ||
      batches > 128 ||
      typeof targets !== 'number' ||
      !Number.isSafeInteger(targets) ||
      targets < 0 ||
      targets > 8192
    )
      throw new Error();
    return Object.freeze({ remaining_batches: batches, remaining_targets: targets });
  } catch {
    throw new Error('release-export-capacity-unavailable');
  }
}

export function assertProtectedReleaseExportCapacityEffect(receiptStore: object): void {
  const sequence = exportCapacityAccounts.get(receiptStore);
  if (
    sequence !== undefined &&
    (!sequence.active ||
      exportCapacityContexts.getStore() !== sequence ||
      scopes.getStore() !== sequence.scope ||
      issuerState(receiptStore)?.closed !== false)
  )
    throw new Error('release-export-capacity-unavailable');
}

/** One immutable export sequence includes terminal bookkeeping and execution-lock cleanup. */
export async function withProtectedReleaseExportCapacity<T>(
  binding: ProtectedReleaseExportCapacityBinding,
  callback: () => Promise<T>,
): Promise<T> {
  const scope = scopes.getStore();
  const selected = exportCapacityBinding(binding);
  if (
    scope?.action_id !== 'release export' ||
    scope.effect !== 'local-write' ||
    typeof callback !== 'function' ||
    typeof scope.read_export_capacity !== 'function' ||
    issuerState(scope.receipt_store)?.closed !== false ||
    issuerState(scope.receipt_store)?.invocation_id !== scope.invocation_id ||
    exportCapacityAccounts.has(scope.receipt_store)
  )
    throw new Error('release-export-capacity-unavailable');
  const sequence: ExportCapacitySequence = {
    scope,
    binding: selected,
    reader: scope.read_export_capacity,
    active: true,
  };
  readExportCapacity(sequence);
  exportCapacityAccounts.set(scope.receipt_store, sequence);
  try {
    return await exportCapacityContexts.run(sequence, callback);
  } finally {
    sequence.active = false;
  }
}

/** Fresh live-account read only; absent readers and prior-invocation credit always refuse. */
export function readProtectedReleaseExportCapacity(
  binding: ProtectedReleaseExportCapacityBinding,
): ProtectedReleaseExportCapacity {
  const selected = exportCapacityBinding(binding);
  const sequence = exportCapacityContexts.getStore();
  if (
    sequence === undefined ||
    exportCapacityAccounts.get(sequence.scope.receipt_store) !== sequence ||
    JSON.stringify(selected) !== JSON.stringify(sequence.binding)
  )
    throw new Error('release-export-capacity-unavailable');
  assertProtectedReleaseExportCapacityEffect(sequence.scope.receipt_store);
  return readExportCapacity(sequence);
}
