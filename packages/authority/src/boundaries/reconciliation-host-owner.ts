import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkReconciliationClockWindow,
  type ReconciliationClockObservation,
} from '../runtime/reconciliation-clock.js';
import {
  readReconciliationOwnerState,
  type ReconciliationOwnerState,
} from '../runtime/reconciliation-owner-state.js';
import { requireScope } from './host-operation.js';
import { scopes } from './host-scope.js';
import {
  captureReconciliationHostContext,
  disposeReconciliationHostContext,
  readReconciliationHostIdentity,
  readReconciliationHostPaths,
  type ReconciliationHostIdentity,
} from './reconciliation-host-context.js';
import {
  provisionSha,
  ReconciliationProvisionError,
  readNativePrivateFile,
  readNativeReconciliationNamespace,
  type NativeDirectoryIdentity,
  type NativeFileIdentity,
} from './reconciliation-host-namespace.js';
import { readReconciliationHostBinding } from './reconciliation-host-operation.js';
import type { ReconciliationAdmissionAnchor } from './host-reconciliation-admission.js';

import { readReconciliationObservationBinding } from './reconciliation-observation.js';

type Code = 'RECONCILIATION_OWNER_HOST_INVALID' | 'RECONCILIATION_OWNER_HOST_STALE';
export class ReconciliationOwnerHostError extends Error {
  constructor(readonly code: Code) {
    super(code);
    this.name = 'ReconciliationOwnerHostError';
  }
}
export interface ReconciliationHostApprovalSnapshot {
  readonly kind: 'reconciliation-host-approval-snapshot';
  readonly identity: ReconciliationHostIdentity;
  readonly current_binding_sha256: string;
  readonly namespace_sha256: string;
  readonly approval_namespace_sha256: string;
  readonly binding_matches_approval: boolean;
  readonly clock: ReconciliationClockObservation;
  readonly state: ReconciliationOwnerState;
  readonly grants_authority: false;
}
interface FileWitness {
  readonly identity: NativeFileIdentity;
  readonly sha256: string;
}
interface ApprovalWitness {
  readonly identity: NativeDirectoryIdentity;
  readonly files: Readonly<Record<string, FileWitness>>;
}
interface ApprovalsWitness {
  readonly identity: NativeDirectoryIdentity;
  readonly entries: Readonly<Record<string, ApprovalWitness>>;
}
const ACTIONS = new Set([
  'evidence reconcile approve',
  'evidence reconcile materialize',
  'evidence reconcile stage-proof',
  'sense bootstrap-inventory',
]);
const MAX_BYTES = 33554432;
function invalid(): never {
  throw new ReconciliationOwnerHostError('RECONCILIATION_OWNER_HOST_INVALID');
}
function stale(): never {
  throw new ReconciliationOwnerHostError('RECONCILIATION_OWNER_HOST_STALE');
}
function recheck<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    return stale();
  }
}

/**
 * Actual protected-host observations only. This is not an apply handle, a write
 * grant, a transaction, or verification of the plan/source/output witnesses.
 * Never call this raw-anchor reader from an admitted native write callback.
 */
export function readReconciliationHostApproval(
  repositoryRoot: string,
  approvalId: string,
): ReconciliationHostApprovalSnapshot {
  return readApproval(repositoryRoot, approvalId);
}

/** Internal read-only census using the already-held native admission anchor. */
export function readReconciliationHostApprovalUnderAdmission(
  repositoryRoot: string,
  approvalId: string,
  anchor: ReconciliationAdmissionAnchor,
): ReconciliationHostApprovalSnapshot {
  return readApproval(repositoryRoot, approvalId, anchor);
}

/** Internal checkpoint observation; separate capsule, never the mutating action matrix. */
export function readReconciliationObservedApproval(
  repositoryRoot: string,
  approvalId: string,
): ReconciliationHostApprovalSnapshot {
  return readApproval(repositoryRoot, approvalId, undefined, true);
}

function readApproval(
  repositoryRoot: string,
  approvalId: string,
  anchor?: ReconciliationAdmissionAnchor,
  observation = false,
): ReconciliationHostApprovalSnapshot {
  const privateBuffers: Uint8Array[] = [];
  let context: ReturnType<typeof captureReconciliationHostContext> | undefined;
  try {
    if (
      typeof repositoryRoot !== 'string' ||
      !repositoryRoot.startsWith('/') ||
      typeof approvalId !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(approvalId) ||
      realpathSync(repositoryRoot) !== repositoryRoot
    )
      invalid();
    const scope = requireScope('process');
    if (!observation && !ACTIONS.has(scope.action_id)) invalid();
    const readBinding = () =>
      observation
        ? readReconciliationObservationBinding(repositoryRoot)
        : readReconciliationHostBinding();
    const first = readBinding();
    const actualContext = captureReconciliationHostContext(
      repositoryRoot,
      first.identity.repository_id,
    );
    context = actualContext;
    if (
      provisionSha(readReconciliationHostIdentity(actualContext)) !== provisionSha(first.identity)
    )
      stale();
    const paths = readReconciliationHostPaths(actualContext);
    const namespace = readNativeReconciliationNamespace(paths, first.identity, anchor);
    if (namespace.issuer === null) invalid();
    privateBuffers.push(namespace.issuer.bytes);
    // These witnesses are created by the fixed native namespace census, never
    // supplied by the caller. The census already checked every name/kind/MAC.
    const approvals = namespace.witness['approvals'] as ApprovalsWitness | null;
    const selected = approvals?.entries[approvalId];
    if (selected === undefined) invalid();
    const names = Object.keys(selected.files).sort();
    let total = namespace.issuer.bytes.length;
    const files = new Map<string, Uint8Array>();
    for (const name of names) {
      const expected = selected.files[name];
      if (expected === undefined) invalid();
      const count = Number(expected.identity.size_bytes);
      if (!Number.isSafeInteger(count) || count < 1 || count > 1048576 || total + count > MAX_BYTES)
        invalid();
      total += count;
      const file = recheck(() =>
        readNativePrivateFile(join(paths.private_root, 'approvals', approvalId, name)),
      );
      privateBuffers.push(file.bytes);
      if (
        file.bytes.length !== count ||
        provisionSha({ identity: file.identity, sha256: file.sha256 }) !== provisionSha(expected)
      )
        stale();
      files.set(name, file.bytes);
    }
    const approval = files.get('approval.json');
    if (approval === undefined) invalid();
    const grants: Uint8Array[] = [];
    const intents: Uint8Array[] = [];
    const completions: Uint8Array[] = [];
    for (const name of names) {
      const bytes = files.get(name);
      if (bytes === undefined) invalid();
      if (/^grant-[0-9]{6}\.json$/u.test(name)) grants.push(bytes);
      else if (/^intent-0[1-4]\.json$/u.test(name)) intents.push(bytes);
      else if (/^phase-0[1-4]\.json$/u.test(name)) completions.push(bytes);
      else if (name !== 'approval.json' && name !== 'lease.json') invalid();
    }
    const state = readReconciliationOwnerState({
      issuer_bytes: namespace.issuer.bytes,
      approval_bytes: approval,
      grant_bytes: grants,
      intent_bytes: intents,
      completion_bytes: completions,
      lease_bytes: files.get('lease.json') ?? null,
    });
    if (
      state.repository_id !== first.identity.repository_id ||
      state.worktree_id !== first.identity.worktree_id ||
      state.host_identity_sha256 !== first.identity.host_identity_sha256
    )
      invalid();
    const latest = recheck(() => {
      const second = readNativeReconciliationNamespace(paths, first.identity, anchor);
      if (second.issuer !== null) privateBuffers.push(second.issuer.bytes);
      if (second.sha256 !== namespace.sha256) stale();
      if (
        provisionSha(readReconciliationHostIdentity(actualContext)) !== provisionSha(first.identity)
      )
        stale();
      const binding = readBinding();
      if (
        scopes.getStore() !== scope ||
        provisionSha(binding.identity) !== provisionSha(first.identity) ||
        binding.binding_sha256 !== first.binding_sha256
      )
        stale();
      checkReconciliationClockWindow(first.clock, binding.clock, 'review');
      return binding;
    });
    return Object.freeze({
      kind: 'reconciliation-host-approval-snapshot',
      identity: latest.identity,
      current_binding_sha256: latest.binding_sha256,
      namespace_sha256: namespace.sha256,
      approval_namespace_sha256: provisionSha(selected),
      binding_matches_approval: state.binding_sha256 === latest.binding_sha256,
      clock: latest.clock,
      state,
      grants_authority: false,
    });
  } catch (error) {
    if (error instanceof ReconciliationOwnerHostError) throw error;
    if (
      error instanceof ReconciliationProvisionError &&
      error.code === 'RECONCILIATION_PROVISION_STALE'
    )
      return stale();
    return invalid();
  } finally {
    for (const bytes of privateBuffers) Uint8Array.prototype.fill.call(bytes, 0);
    if (context !== undefined) disposeReconciliationHostContext(context);
  }
}
