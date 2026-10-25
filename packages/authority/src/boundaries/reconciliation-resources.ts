import { types as nodeTypes } from 'node:util';

/** Logical shape only: these values are neither permissions nor host operation handles. */
export interface ProofIndexResourceTarget {
  readonly kind: 'proof-index';
  readonly id: string;
  readonly repository_id: string;
  readonly worktree_id: string;
  readonly operation: 'chain-cas';
  readonly proof_path: 'record/proofs/chain.json';
  readonly approval_id: string;
  readonly plan_sha256: string;
  readonly phase_sha256: string;
  readonly before_index_sha256: string;
  readonly other_entries_sha256: string;
  readonly verified_chain_sha256: string;
}

interface ReconciliationHostResourceBase {
  readonly kind: 'reconciliation-host';
  readonly id: string;
  readonly repository_id: string;
  readonly worktree_id: string;
  readonly binding_sha256: string;
  readonly plan_sha256: string;
}

export type ReconciliationHostResourceTarget = ReconciliationHostResourceBase &
  (
    | {
        readonly operation: 'provision';
        readonly approval_id?: never;
        readonly phase?: never;
      }
    | {
        readonly operation: 'consume-phase';
        readonly approval_id: string;
        readonly phase: '01' | '02' | '03' | '04';
      }
    | {
        readonly operation: 'approve' | 'renew' | 'revoke' | 'recover-owned-lease';
        readonly approval_id: string;
        readonly phase?: never;
      }
  );

const PROOF_PATH = 'record/proofs/chain.json';
const PROOF_KEYS = [
  'kind',
  'id',
  'repository_id',
  'worktree_id',
  'operation',
  'proof_path',
  'approval_id',
  'plan_sha256',
  'phase_sha256',
  'before_index_sha256',
  'other_entries_sha256',
  'verified_chain_sha256',
] as const;
const HOST_KEYS = [
  'kind',
  'id',
  'repository_id',
  'worktree_id',
  'operation',
  'binding_sha256',
  'plan_sha256',
] as const;
const APPROVAL_OPERATIONS = new Set(['approve', 'renew', 'revoke', 'recover-owned-lease']);
const PHASES = new Set(['01', '02', '03', '04']);

/** Inspect descriptors before reading values; untrusted accessors/traps must not execute. */
function dataRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const data = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return undefined;
    data[key] = descriptor.value;
  }
  return data;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function logicalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9]/u.test(value) &&
    !/[^A-Za-z0-9_-]/u.test(value)
  );
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/u.test(value);
}

/** Validate one exact logical proof-index target, without performing or granting an effect. */
export function isProofIndexResourceTarget(value: unknown): value is ProofIndexResourceTarget {
  const target = dataRecord(value);
  if (
    target === undefined ||
    !exactKeys(target, PROOF_KEYS) ||
    target.kind !== 'proof-index' ||
    target.operation !== 'chain-cas' ||
    target.proof_path !== PROOF_PATH ||
    !logicalId(target.repository_id) ||
    !logicalId(target.worktree_id) ||
    !digest(target.approval_id) ||
    !digest(target.plan_sha256) ||
    !digest(target.phase_sha256) ||
    !digest(target.before_index_sha256) ||
    !digest(target.other_entries_sha256) ||
    !digest(target.verified_chain_sha256)
  ) {
    return false;
  }
  return target.id === `proof-index:${target.repository_id}:${target.worktree_id}:${PROOF_PATH}`;
}

/** Validate host target shape only; even a valid forged approval ID confers no authority. */
export function isReconciliationHostResourceTarget(
  value: unknown,
): value is ReconciliationHostResourceTarget {
  const target = dataRecord(value);
  if (
    target === undefined ||
    target.kind !== 'reconciliation-host' ||
    !logicalId(target.repository_id) ||
    !logicalId(target.worktree_id) ||
    !digest(target.binding_sha256) ||
    !digest(target.plan_sha256)
  ) {
    return false;
  }
  const prefix = `reconciliation-host:${target.repository_id}:${target.worktree_id}`;
  if (target.operation === 'provision') {
    return exactKeys(target, HOST_KEYS) && target.id === `${prefix}:provision`;
  }
  if (!digest(target.approval_id)) return false;
  if (target.operation === 'consume-phase') {
    return (
      exactKeys(target, [...HOST_KEYS, 'approval_id', 'phase']) &&
      typeof target.phase === 'string' &&
      PHASES.has(target.phase) &&
      target.id === `${prefix}:consume-phase:${target.approval_id}:${target.phase}`
    );
  }
  return (
    typeof target.operation === 'string' &&
    APPROVAL_OPERATIONS.has(target.operation) &&
    exactKeys(target, [...HOST_KEYS, 'approval_id']) &&
    target.id === `${prefix}:${target.operation}:${target.approval_id}`
  );
}
