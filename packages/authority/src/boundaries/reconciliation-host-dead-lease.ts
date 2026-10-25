import { hostname } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { checkReconciliationClockWindow } from '../runtime/reconciliation-clock.js';
import { decodeReconciliationOwnerRecord } from '../runtime/reconciliation-owner-record.js';
import { withReconciliationAdmissionSteps } from './host-reconciliation-admission.js';
import { removeEntryIfIdentitySteps } from './host-remove.js';
import { requireScope } from './host-operation.js';
import { scopes } from './host-scope.js';
import {
  captureReconciliationHostContext,
  disposeReconciliationHostContext,
  readReconciliationHostIdentity,
  readReconciliationHostPaths,
} from './reconciliation-host-context.js';
import {
  invokeReconciliationHostOperation,
  readReconciliationHostBinding,
  readReconciliationExistingApprovalInput,
} from './reconciliation-host-operation.js';
import {
  provisionSha,
  readNativePrivateFile,
  readNativeReconciliationNamespace,
  syncNativeDirectory,
} from './reconciliation-host-namespace.js';
import { readReconciliationHostApproval } from './reconciliation-host-owner.js';
import { readExistingReconciliationPlan } from './reconciliation-plan.js';
import { ReconciliationApprovalError } from './reconciliation-host-approve.js';

export interface ReconciliationDeadLeasePreview {
  readonly kind: 'reconciliation-dead-lease-review';
  readonly approval_id: string;
  readonly plan_sha256: string;
  readonly expected_lease_sha256: string;
  readonly lease_witness: Readonly<{ dev: string; ino: string; birthtime_ns: string }> | null;
  readonly effects: readonly Readonly<{ target: string; operation: string }>[];
  readonly confirmation: string;
  readonly lifetime_ms: 300000;
  readonly grants_authority: false;
}
export interface ReconciliationDeadLeaseResult {
  readonly kind: 'reconciliation-dead-lease-result';
  readonly outcome: 'recovered' | 'absent' | 'cancelled' | 'indeterminate';
  readonly approval_id: string;
  readonly plan_sha256: string;
  readonly expected_lease_sha256: string;
  readonly lease_witness: ReconciliationDeadLeasePreview['lease_witness'];
  readonly grants_authority: false;
}
export interface ReconciliationDeadLeaseReview {
  preview(): ReconciliationDeadLeasePreview;
  confirm(token: string): ReconciliationDeadLeaseResult;
  interrupt(): ReconciliationDeadLeaseResult;
}
function fail(stale = false): never {
  throw new ReconciliationApprovalError(
    stale ? 'RECONCILIATION_APPROVAL_STALE' : 'RECONCILIATION_APPROVAL_INVALID',
  );
}
function assertEsrch(pid: number, leaseHostname: string): void {
  if (leaseHostname !== hostname() || !Number.isSafeInteger(pid) || pid < 1 || pid === process.pid)
    fail();
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    fail();
  }
  fail();
}

/** Exact Owner recovery of one authenticated lease after actual same-host ESRCH; never by age. */
export function createReconciliationDeadLeaseReview(
  repositoryRoot: string,
): ReconciliationDeadLeaseReview {
  if (typeof repositoryRoot !== 'string' || realpathSync(repositoryRoot) !== repositoryRoot) fail();
  const buffers: Uint8Array[] = [];
  let context: ReturnType<typeof captureReconciliationHostContext> | undefined;
  try {
    const scope = requireScope('process');
    const input = readReconciliationExistingApprovalInput();
    if (
      input.action_id !== 'evidence reconcile approve' ||
      input.operation !== 'recover-owned-lease' ||
      input.expected_lease_sha256 === undefined
    )
      fail();
    const expectedLease = input.expected_lease_sha256;
    const plan = readExistingReconciliationPlan(repositoryRoot);
    const snapshot = readReconciliationHostApproval(repositoryRoot, input.approval_id);
    const state = snapshot.state;
    if (
      !snapshot.binding_matches_approval ||
      state.plan_sha256 !== input.plan_sha256 ||
      state.source_manifest_sha256 !== plan.source_manifest_sha256 ||
      state.binding_sha256 !== plan.binding_sha256 ||
      provisionSha(snapshot.identity) !== provisionSha(plan.identity) ||
      (state.lease_sha256 ?? 'ABSENT') !== expectedLease
    )
      fail(true);
    const binding = readReconciliationHostBinding();
    context = captureReconciliationHostContext(repositoryRoot, binding.identity.repository_id);
    if (
      provisionSha(readReconciliationHostIdentity(context)) !== provisionSha(snapshot.identity) ||
      binding.binding_sha256 !== state.binding_sha256
    )
      fail(true);
    const paths = readReconciliationHostPaths(context);
    const namespace = readNativeReconciliationNamespace(paths, binding.identity);
    if (namespace.issuer) buffers.push(namespace.issuer.bytes);
    const anchor = namespace.anchor;
    if (!namespace.issuer || !anchor || namespace.sha256 !== snapshot.namespace_sha256) fail(true);
    const leasePath = join(paths.private_root, 'approvals', state.approval_id, 'lease.json');
    const lease = expectedLease === 'ABSENT' ? null : readNativePrivateFile(leasePath);
    if (lease) buffers.push(lease.bytes);
    const decoded = lease === null ? null : decodeReconciliationOwnerRecord(lease.bytes);
    if (decoded !== null) {
      if (
        decoded.kind !== 'lease' ||
        lease?.sha256 !== expectedLease ||
        decoded.approval_id !== state.approval_id ||
        decoded.host_identity_sha256 !== state.host_identity_sha256
      )
        fail(true);
      assertEsrch(decoded.pid, decoded.hostname);
    }
    const witness =
      lease === null
        ? null
        : Object.freeze({
            dev: lease.identity.dev,
            ino: lease.identity.ino,
            birthtime_ns: lease.identity.birthtime_ns,
          });
    const issued = readReconciliationHostBinding().clock;
    const logical = `worktree-host/devai/reconciliation/approvals/${state.approval_id}/lease.json`;
    const preview: ReconciliationDeadLeasePreview = Object.freeze({
      kind: 'reconciliation-dead-lease-review',
      approval_id: state.approval_id,
      plan_sha256: state.plan_sha256,
      expected_lease_sha256: expectedLease,
      lease_witness: witness,
      effects: Object.freeze(
        lease === null
          ? []
          : [
              Object.freeze({
                target: logical,
                operation: 'opaque-quarantine-identity-recheck-remove-or-restore-fsync-parent',
              }),
            ],
      ),
      confirmation: `RECOVER RECONCILIATION-LEASE ${state.approval_id} ${expectedLease}`,
      lifetime_ms: 300000,
      grants_authority: false,
    });
    let terminal = false;
    let interrupted = false;
    let entered = false;
    const close = (): void => {
      terminal = true;
      for (const buffer of buffers) buffer.fill(0);
    };
    const member = (receiver: unknown): void => {
      if (receiver !== handle || terminal || scopes.getStore() !== scope) fail();
    };
    const assertHost = (): void => {
      const current = readReconciliationHostBinding();
      checkReconciliationClockWindow(issued, current.clock, 'review');
      if (
        scopes.getStore() !== scope ||
        current.binding_sha256 !== state.binding_sha256 ||
        provisionSha(current.identity) !== provisionSha(snapshot.identity)
      )
        fail(true);
    };
    const assertPlan = (): void => {
      assertHost();
      if (provisionSha(readExistingReconciliationPlan(repositoryRoot)) !== provisionSha(plan))
        fail(true);
    };
    const result = (
      outcome: ReconciliationDeadLeaseResult['outcome'],
    ): ReconciliationDeadLeaseResult =>
      Object.freeze({
        kind: 'reconciliation-dead-lease-result',
        outcome,
        approval_id: state.approval_id,
        plan_sha256: state.plan_sha256,
        expected_lease_sha256: expectedLease,
        lease_witness: witness,
        grants_authority: false,
      });
    const handle: ReconciliationDeadLeaseReview = Object.freeze({
      preview: function (this: unknown) {
        member(this);
        assertHost();
        return preview;
      },
      confirm: function (this: unknown, token: string) {
        member(this);
        if (token !== preview.confirmation) {
          const output = result('cancelled');
          close();
          return output;
        }
        try {
          assertPlan();
          invokeReconciliationHostOperation(
            {
              kind: 'reconciliation-host',
              id: `reconciliation-host:${state.repository_id}:${state.worktree_id}:recover-owned-lease:${state.approval_id}`,
              repository_id: state.repository_id,
              worktree_id: state.worktree_id,
              operation: 'recover-owned-lease',
              binding_sha256: state.binding_sha256,
              plan_sha256: state.plan_sha256,
              approval_id: state.approval_id,
            },
            (host) => {
              if (
                provisionSha(host.identity) !== provisionSha(snapshot.identity) ||
                provisionSha(host.bindings) !== state.binding_sha256
              )
                fail(true);
              withReconciliationAdmissionSteps(host.paths.private_root, anchor, () => {
                const current = readNativeReconciliationNamespace(
                  host.paths,
                  host.identity,
                  anchor,
                );
                try {
                  if (current.sha256 !== namespace.sha256) fail(true);
                  assertPlan();
                  if (lease !== null && witness !== null && decoded?.kind === 'lease') {
                    assertEsrch(decoded.pid, decoded.hostname);
                    const actual = readNativePrivateFile(leasePath);
                    try {
                      if (
                        actual.sha256 !== expectedLease ||
                        actual.identity.dev !== witness.dev ||
                        actual.identity.ino !== witness.ino ||
                        actual.identity.birthtime_ns !== witness.birthtime_ns
                      )
                        fail(true);
                    } finally {
                      actual.bytes.fill(0);
                    }
                    assertPlan();
                    entered = true;
                    const outcome = removeEntryIfIdentitySteps(leasePath, {
                      dev: BigInt(witness.dev),
                      ino: BigInt(witness.ino),
                      birthtimeNs: BigInt(witness.birthtime_ns),
                    });
                    if (outcome !== 'removed') fail(true);
                    syncNativeDirectory(
                      join(host.paths.private_root, 'approvals', state.approval_id),
                    );
                  }
                  assertPlan();
                } finally {
                  current.issuer?.bytes.fill(0);
                }
              });
            },
          );
          const after = readReconciliationHostApproval(repositoryRoot, state.approval_id);
          if (after.state.lease_sha256 !== null) fail(true);
          assertPlan();
          const output = result(lease === null ? 'absent' : 'recovered');
          close();
          return output;
        } catch (error) {
          if (entered) {
            const output = result('indeterminate');
            close();
            return output;
          }
          close();
          throw error;
        }
      },
      interrupt: function (this: unknown) {
        if (this !== handle || scopes.getStore() !== scope || interrupted) fail();
        interrupted = true;
        const output = result(entered ? 'indeterminate' : 'cancelled');
        close();
        return output;
      },
    });
    return handle;
  } catch (error) {
    for (const buffer of buffers) buffer.fill(0);
    throw error;
  } finally {
    if (context) disposeReconciliationHostContext(context);
  }
}
