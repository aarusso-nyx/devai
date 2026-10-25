import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { checkReconciliationClockWindow } from '../runtime/reconciliation-clock.js';
import {
  encodeReconciliationOwnerRecord,
  signReconciliationOwnerRecord,
} from '../runtime/reconciliation-owner-record.js';
import { withReconciliationAdmissionSteps } from './host-reconciliation-admission.js';
import { publishPrivateNoReplacePreparedSteps, PublishIndeterminateError } from './host-publish.js';
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
  provisionBytesSha,
  readNativePrivateFile,
  readNativeDirectory,
  readNativeReconciliationNamespace,
  syncNativeDirectory,
  type NativeDirectoryIdentity,
} from './reconciliation-host-namespace.js';
import { readReconciliationHostApproval } from './reconciliation-host-owner.js';
import { readExistingReconciliationPlan } from './reconciliation-plan.js';
import { ReconciliationApprovalError } from './reconciliation-host-approve.js';

type Owned = Readonly<{ target: string; dev: string; ino: string; birthtime_ns: string }>;
export interface ReconciliationGrantPreview {
  readonly kind: 'reconciliation-grant-review';
  readonly operation: 'renew' | 'revoke';
  readonly approval_id: string;
  readonly plan_sha256: string;
  readonly prior_grant_sha256: string;
  readonly record_sha256: string;
  readonly record_bytes: number;
  readonly sequence: number;
  readonly namespace_sha256: string;
  readonly effects: readonly Readonly<{ target: string; operation: string; mode: '0600' }>[];
  readonly confirmation: string;
  readonly lifetime_ms: 300000;
  readonly grants_authority: false;
}
export interface ReconciliationGrantResult {
  readonly kind: 'reconciliation-grant-result';
  readonly operation: 'renew' | 'revoke';
  readonly outcome: 'renewed' | 'revoked' | 'cancelled' | 'indeterminate';
  readonly approval_id: string;
  readonly plan_sha256: string;
  readonly record_sha256: string;
  readonly sequence: number;
  readonly owned: readonly Owned[];
  readonly grants_authority: false;
}
export interface ReconciliationGrantReview {
  preview(): ReconciliationGrantPreview;
  confirm(token: string): ReconciliationGrantResult;
  interrupt(): ReconciliationGrantResult;
}
function fail(stale = false): never {
  throw new ReconciliationApprovalError(
    stale ? 'RECONCILIATION_APPROVAL_STALE' : 'RECONCILIATION_APPROVAL_INVALID',
  );
}

/** Internal renewal/revocation only. Original approval scope is retained verbatim. */
export function createReconciliationGrantReview(repositoryRoot: string): ReconciliationGrantReview {
  if (typeof repositoryRoot !== 'string' || realpathSync(repositoryRoot) !== repositoryRoot) fail();
  const buffers: Uint8Array[] = [];
  let context: ReturnType<typeof captureReconciliationHostContext> | undefined;
  try {
    const scope = requireScope('process');
    const input = readReconciliationExistingApprovalInput();
    if (
      input.action_id !== 'evidence reconcile approve' ||
      (input.operation !== 'renew' && input.operation !== 'revoke')
    )
      fail();
    const operation = input.operation;
    const plan = readExistingReconciliationPlan(repositoryRoot);
    const snapshot = readReconciliationHostApproval(repositoryRoot, input.approval_id);
    const state = snapshot.state;
    if (input.expected_grant_sha256 !== state.grant_sha256) fail(true);
    if (
      !snapshot.binding_matches_approval ||
      state.grant_kind === 'revocation' ||
      state.plan_sha256 !== input.plan_sha256 ||
      state.source_manifest_sha256 !== plan.source_manifest_sha256 ||
      state.binding_sha256 !== plan.binding_sha256 ||
      provisionSha(snapshot.identity) !== provisionSha(plan.identity) ||
      state.grant_sequence >= 999999
    )
      fail();
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
    const issuer = namespace.issuer;
    const anchor = namespace.anchor;
    if (
      !issuer ||
      !anchor ||
      namespace.sha256 !== snapshot.namespace_sha256 ||
      issuer.sha256 !== state.issuer_sha256
    )
      fail(true);
    const issued = readReconciliationHostBinding().clock;
    const sequence = state.grant_sequence + 1;
    const linked = {
      repository_id: state.repository_id,
      worktree_id: state.worktree_id,
      clock: issued,
      approval_id: state.approval_id,
      issuer_sha256: state.issuer_sha256,
      approval_sha256: state.approval_sha256,
      scope_sha256: state.scope_sha256,
      sequence,
      previous_grant_sha256: state.grant_sha256,
    };
    const remaining = state.phases.filter((phase) => phase.completion_sha256 === null);
    if (operation === 'renew' && remaining.length === 0) fail();
    const unsigned =
      operation === 'revoke'
        ? {
            schemaVersion: '1.0.0',
            kind: 'revocation',
            domain: 'devai.reconciliation.owner.v1/revocation',
            ...linked,
          }
        : {
            schemaVersion: '1.0.0',
            kind: 'renewal',
            domain: 'devai.reconciliation.owner.v1/renewal',
            ...linked,
            validity_ms: 900000,
            expires_wall_ms: issued.wall_ms + 900000,
            expires_monotonic_ns: (BigInt(issued.monotonic_ns) + 900000000000n).toString(),
            remaining_phases: remaining.map((phase) => phase.phase),
            resumable_intent_sha256: remaining[0]?.intent_sha256 ?? null,
          };
    const bytes = encodeReconciliationOwnerRecord(
      signReconciliationOwnerRecord(unsigned, issuer.record.private_key_base64),
    );
    buffers.push(bytes);
    const recordSha = provisionBytesSha(bytes);
    const name = `grant-${String(sequence).padStart(6, '0')}.json`;
    const stagedName = `.${name}.${String(process.pid)}-${randomUUID()}.publish-staged`;
    const directory = join(paths.private_root, 'approvals', state.approval_id);
    const approvalsWitness = namespace.witness['approvals'] as {
      identity: NativeDirectoryIdentity;
      entries: Readonly<Record<string, { identity: NativeDirectoryIdentity }>>;
    } | null;
    const directoryWitness = approvalsWitness?.entries[state.approval_id];
    if (!approvalsWitness || !directoryWitness || !namespace.root) fail(true);
    const logical = `worktree-host/devai/reconciliation/approvals/${state.approval_id}`;
    const preview: ReconciliationGrantPreview = Object.freeze({
      kind: 'reconciliation-grant-review',
      operation,
      approval_id: state.approval_id,
      plan_sha256: input.plan_sha256,
      prior_grant_sha256: state.grant_sha256,
      record_sha256: recordSha,
      record_bytes: bytes.length,
      sequence,
      namespace_sha256: namespace.sha256,
      effects: Object.freeze([
        Object.freeze({
          target: `${logical}/${stagedName}`,
          operation: 'publish-private-scratch-and-owned-cleanup',
          mode: '0600' as const,
        }),
        Object.freeze({
          target: `${logical}/${name}`,
          operation: 'publish-grant-no-replace',
          mode: '0600' as const,
        }),
      ]),
      confirmation: `${operation === 'renew' ? 'RENEW' : 'REVOKE'} RECONCILIATION ${state.approval_id} ${recordSha}`,
      lifetime_ms: 300000,
      grants_authority: false,
    });
    let terminal = false;
    let interrupted = false;
    let entered = false;
    const owned: Owned[] = [];
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
    const result = (outcome: ReconciliationGrantResult['outcome']): ReconciliationGrantResult =>
      Object.freeze({
        kind: 'reconciliation-grant-result',
        operation,
        outcome,
        approval_id: state.approval_id,
        plan_sha256: input.plan_sha256,
        record_sha256: recordSha,
        sequence,
        owned: Object.freeze([...owned]),
        grants_authority: false,
      });
    const handle: ReconciliationGrantReview = Object.freeze({
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
          assertHost();
          // The original saved file stays exact; partial phase outputs are checked by their own adapters.
          if (provisionSha(readExistingReconciliationPlan(repositoryRoot)) !== provisionSha(plan))
            fail(true);
          invokeReconciliationHostOperation(
            {
              kind: 'reconciliation-host',
              id: `reconciliation-host:${state.repository_id}:${state.worktree_id}:${operation}:${state.approval_id}`,
              repository_id: state.repository_id,
              worktree_id: state.worktree_id,
              operation,
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
                  const guard = (): void => {
                    assertHost();
                    if (
                      provisionSha(readExistingReconciliationPlan(repositoryRoot)) !==
                      provisionSha(plan)
                    )
                      fail(true);
                    // The publisher owns one in-flight staged sibling; census
                    // completed records only before and after that publication.
                    if (
                      provisionSha(readNativeDirectory(host.paths.private_root)) !==
                        provisionSha(namespace.root) ||
                      provisionSha(
                        readNativeDirectory(join(host.paths.private_root, 'approvals')),
                      ) !== provisionSha(approvalsWitness.identity) ||
                      provisionSha(readNativeDirectory(directory)) !==
                        provisionSha(directoryWitness.identity)
                    )
                      fail(true);
                  };
                  guard();
                  entered = true;
                  try {
                    const identity = publishPrivateNoReplacePreparedSteps(
                      join(directory, name),
                      stagedName,
                      bytes,
                      { verifyPrepared: guard },
                    );
                    owned.push(
                      Object.freeze({
                        target: `${logical}/${name}`,
                        dev: String(identity.dev),
                        ino: String(identity.ino),
                        birthtime_ns: String(identity.birthtimeNs),
                      }),
                    );
                    const readback = readNativePrivateFile(join(directory, name));
                    try {
                      if (
                        readback.sha256 !== recordSha ||
                        readback.identity.dev !== String(identity.dev) ||
                        readback.identity.ino !== String(identity.ino) ||
                        readback.identity.birthtime_ns !== String(identity.birthtimeNs)
                      )
                        fail(true);
                    } finally {
                      readback.bytes.fill(0);
                    }
                  } catch (error) {
                    if (error instanceof PublishIndeterminateError)
                      owned.push(
                        Object.freeze({
                          target: `${logical}/${name}`,
                          dev: String(error.identity.dev),
                          ino: String(error.identity.ino),
                          birthtime_ns: String(error.identity.birthtimeNs),
                        }),
                      );
                    throw error;
                  }
                  syncNativeDirectory(directory);
                  assertHost();
                } finally {
                  current.issuer?.bytes.fill(0);
                }
              });
            },
          );
          readReconciliationHostApproval(repositoryRoot, state.approval_id);
          assertHost();
          if (provisionSha(readExistingReconciliationPlan(repositoryRoot)) !== provisionSha(plan))
            fail(true);
          const output = result(operation === 'renew' ? 'renewed' : 'revoked');
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
