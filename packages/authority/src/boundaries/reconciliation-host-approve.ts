import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
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
  readReconciliationInitialApprovalInput,
} from './reconciliation-host-operation.js';
import {
  provisionSha,
  provisionBytesSha,
  readNativeDirectory,
  readNativePrivateFile,
  readNativeReconciliationNamespace,
  syncNativeDirectory,
  type NativeDirectoryIdentity,
  type NativeReconciliationPaths,
} from './reconciliation-host-namespace.js';
import { readInitialReconciliationPlan } from './reconciliation-plan.js';

type Owned = Readonly<{ target: string; dev: string; ino: string; birthtime_ns: string }>;
export interface ReconciliationApprovalPreview {
  readonly kind: 'reconciliation-approval-review';
  readonly action_id: 'evidence reconcile approve';
  readonly approval_id: string;
  readonly plan_sha256: string;
  readonly source_manifest_sha256: string;
  readonly effect_plan_sha256: string;
  readonly approval_sha256: string;
  readonly approval_bytes: number;
  readonly issuer_sha256: string;
  readonly namespace_sha256: string;
  readonly effects: readonly Readonly<{
    target: string;
    operation: string;
    mode: '0600' | '0700';
  }>[];
  readonly confirmation: string;
  readonly lifetime_ms: 300000;
  readonly grants_authority: false;
}
export interface ReconciliationApprovalResult {
  readonly kind: 'reconciliation-approval-result';
  readonly action_id: 'evidence reconcile approve';
  readonly outcome: 'approved' | 'cancelled' | 'indeterminate';
  readonly approval_id: string;
  readonly approval_sha256: string;
  readonly plan_sha256: string;
  readonly owned: readonly Owned[];
  readonly grants_authority: false;
}
export interface ReconciliationApprovalReview {
  preview(): ReconciliationApprovalPreview;
  confirm(token: string): ReconciliationApprovalResult;
  interrupt(): ReconciliationApprovalResult;
}

export class ReconciliationApprovalError extends Error {
  constructor(readonly code: 'RECONCILIATION_APPROVAL_INVALID' | 'RECONCILIATION_APPROVAL_STALE') {
    super(code);
    this.name = 'ReconciliationApprovalError';
  }
}
function fail(stale = false): never {
  throw new ReconciliationApprovalError(
    stale ? 'RECONCILIATION_APPROVAL_STALE' : 'RECONCILIATION_APPROVAL_INVALID',
  );
}
function observe(root: string) {
  const binding = readReconciliationHostBinding();
  const context = captureReconciliationHostContext(root, binding.identity.repository_id);
  let namespace: ReturnType<typeof readNativeReconciliationNamespace> | undefined;
  try {
    if (provisionSha(readReconciliationHostIdentity(context)) !== provisionSha(binding.identity))
      fail(true);
    const paths = readReconciliationHostPaths(context);
    namespace = readNativeReconciliationNamespace(paths, binding.identity);
    if (namespace.issuer === null || namespace.anchor === null) fail();
    if (provisionSha(readReconciliationHostIdentity(context)) !== provisionSha(binding.identity))
      fail(true);
    return { binding, paths, namespace };
  } catch (error) {
    namespace?.issuer?.bytes.fill(0);
    throw error;
  } finally {
    disposeReconciliationHostContext(context);
  }
}

/** Internal initial approval only. No caller-supplied record, source provider or physical path. */
export function createReconciliationApprovalReview(
  repositoryRoot: string,
): ReconciliationApprovalReview {
  if (typeof repositoryRoot !== 'string' || realpathSync(repositoryRoot) !== repositoryRoot) fail();
  const preparedBuffers: Uint8Array[] = [];
  try {
    const scope = requireScope('process');
    const input = readReconciliationInitialApprovalInput();
    const plan = readInitialReconciliationPlan(repositoryRoot);
    const observation = observe(repositoryRoot);
    const issuer = observation.namespace.issuer;
    if (issuer) preparedBuffers.push(issuer.bytes);
    const anchor = observation.namespace.anchor;
    if (
      !issuer ||
      !anchor ||
      provisionSha(plan.identity) !== provisionSha(observation.binding.identity) ||
      plan.binding_sha256 !== observation.binding.binding_sha256
    )
      fail(true);
    const issued = observation.binding.clock;
    const recordScope = {
      repository_id: plan.identity.repository_id,
      worktree_id: plan.identity.worktree_id,
      host_identity_sha256: plan.identity.host_identity_sha256,
      binding_sha256: plan.binding_sha256,
      plan_sha256: input.plan_sha256,
      source_manifest_sha256: plan.source_manifest_sha256,
      allowed_phases: ['01', '02', '03', '04'] as const,
    };
    const approvalId = provisionSha({ scope: recordScope, clock: issued, nonce: randomUUID() });
    const record = signReconciliationOwnerRecord(
      {
        schemaVersion: '1.0.0',
        kind: 'approval',
        domain: 'devai.reconciliation.owner.v1/approval',
        repository_id: plan.identity.repository_id,
        worktree_id: plan.identity.worktree_id,
        clock: issued,
        approval_id: approvalId,
        issuer_sha256: issuer.sha256,
        scope_sha256: provisionSha(recordScope),
        sequence: 1,
        previous_grant_sha256: null,
        scope: recordScope,
        validity_ms: 900000,
        expires_wall_ms: issued.wall_ms + 900000,
        expires_monotonic_ns: (BigInt(issued.monotonic_ns) + 900000000000n).toString(),
      },
      issuer.record.private_key_base64,
    );
    const bytes = encodeReconciliationOwnerRecord(record);
    preparedBuffers.push(bytes);
    const recordSha = provisionBytesSha(bytes);
    const logical = `worktree-host/devai/reconciliation/approvals/${approvalId}`;
    const stagedName = `.approval.json.${String(process.pid)}-${randomUUID()}.publish-staged`;
    const approvalsPath = join(observation.paths.private_root, 'approvals');
    const approvalsBefore = readNativeDirectory(approvalsPath);
    const effects = [
      ...(approvalsBefore
        ? []
        : [
            {
              target: 'worktree-host/devai/reconciliation/approvals',
              operation: 'create-directory',
              mode: '0700' as const,
            },
          ]),
      { target: logical, operation: 'create-directory', mode: '0700' as const },
      {
        target: `${logical}/${stagedName}`,
        operation: 'publish-private-scratch-and-owned-cleanup',
        mode: '0600' as const,
      },
      {
        target: `${logical}/approval.json`,
        operation: 'publish-initial-approval-no-replace',
        mode: '0600' as const,
      },
    ];
    const preview: ReconciliationApprovalPreview = Object.freeze({
      kind: 'reconciliation-approval-review',
      action_id: 'evidence reconcile approve',
      approval_id: approvalId,
      plan_sha256: input.plan_sha256,
      source_manifest_sha256: plan.source_manifest_sha256,
      effect_plan_sha256: plan.effect_plan_sha256,
      approval_sha256: recordSha,
      approval_bytes: bytes.length,
      issuer_sha256: issuer.sha256,
      namespace_sha256: observation.namespace.sha256,
      effects: Object.freeze(effects.map((effect) => Object.freeze(effect))),
      confirmation: `APPROVE RECONCILIATION ${input.plan_sha256} ${recordSha}`,
      lifetime_ms: 300000,
      grants_authority: false,
    });
    let state: 'ready' | 'terminal' = 'ready';
    let entered = false;
    let interruptUsed = false;
    const owned: Owned[] = [];
    const member = (receiver: unknown): void => {
      if (receiver !== handle || state !== 'ready' || scopes.getStore() !== scope) fail();
    };
    const close = (): void => {
      state = 'terminal';
      bytes.fill(0);
      issuer.bytes.fill(0);
    };
    const result = (
      outcome: ReconciliationApprovalResult['outcome'],
    ): ReconciliationApprovalResult =>
      Object.freeze({
        kind: 'reconciliation-approval-result',
        action_id: 'evidence reconcile approve',
        outcome,
        approval_id: approvalId,
        approval_sha256: recordSha,
        plan_sha256: input.plan_sha256,
        owned: Object.freeze([...owned]),
        grants_authority: false,
      });
    const assertHost = (): void => {
      if (scopes.getStore() !== scope) fail(true);
      const current = readReconciliationHostBinding();
      checkReconciliationClockWindow(issued, current.clock, 'review');
      if (
        current.binding_sha256 !== observation.binding.binding_sha256 ||
        provisionSha(current.identity) !== provisionSha(plan.identity)
      )
        fail(true);
    };
    const assertSource = (): void => {
      assertHost();
      const actual = readInitialReconciliationPlan(repositoryRoot);
      if (canonicalJson(actual) !== canonicalJson(plan)) fail(true);
    };
    const sameDirectory = (path: string, expected: NativeDirectoryIdentity): void => {
      if (provisionSha(readNativeDirectory(path)) !== provisionSha(expected)) fail(true);
    };
    const addDirectory = (path: string, target: string): NativeDirectoryIdentity => {
      assertHost();
      entered = true;
      mkdirSync(path, { mode: 0o700 });
      const identity = readNativeDirectory(path);
      if (!identity) fail(true);
      owned.push(
        Object.freeze({
          target,
          dev: identity.dev,
          ino: identity.ino,
          birthtime_ns: identity.birthtime_ns,
        }),
      );
      syncNativeDirectory(path);
      syncNativeDirectory(dirname(path));
      return identity;
    };
    const apply = (paths: NativeReconciliationPaths): void => {
      const before = readNativeReconciliationNamespace(paths, observation.binding.identity, anchor);
      try {
        if (before.sha256 !== observation.namespace.sha256) fail(true);
        assertSource();
        const approvals =
          approvalsBefore ??
          addDirectory(approvalsPath, 'worktree-host/devai/reconciliation/approvals');
        sameDirectory(approvalsPath, approvals);
        const directoryPath = join(approvalsPath, approvalId);
        const directory = addDirectory(directoryPath, logical);
        const guard = (): void => {
          assertHost();
          sameDirectory(approvalsPath, approvals);
          sameDirectory(directoryPath, directory);
        };
        guard();
        entered = true;
        try {
          const identity = publishPrivateNoReplacePreparedSteps(
            join(directoryPath, 'approval.json'),
            stagedName,
            bytes,
            { verifyPrepared: guard },
          );
          owned.push(
            Object.freeze({
              target: `${logical}/approval.json`,
              dev: String(identity.dev),
              ino: String(identity.ino),
              birthtime_ns: String(identity.birthtimeNs),
            }),
          );
          const readback = readNativePrivateFile(join(directoryPath, 'approval.json'));
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
                target: `${logical}/approval.json`,
                dev: String(error.identity.dev),
                ino: String(error.identity.ino),
                birthtime_ns: String(error.identity.birthtimeNs),
              }),
            );
          throw error;
        }
        syncNativeDirectory(approvalsPath);
        guard();
        assertSource();
      } finally {
        before.issuer?.bytes.fill(0);
      }
    };
    const handle: ReconciliationApprovalReview = Object.freeze({
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
          assertSource();
          invokeReconciliationHostOperation(
            {
              kind: 'reconciliation-host',
              id: `reconciliation-host:${plan.identity.repository_id}:${plan.identity.worktree_id}:approve:${approvalId}`,
              repository_id: plan.identity.repository_id,
              worktree_id: plan.identity.worktree_id,
              operation: 'approve',
              binding_sha256: plan.binding_sha256,
              plan_sha256: input.plan_sha256,
              approval_id: approvalId,
            },
            (host) => {
              if (
                provisionSha(host.identity) !== provisionSha(plan.identity) ||
                provisionSha(host.bindings) !== plan.binding_sha256
              )
                fail(true);
              withReconciliationAdmissionSteps(host.paths.private_root, anchor, () =>
                apply(host.paths),
              );
            },
          );
          const after = observe(repositoryRoot);
          try {
            assertHost();
          } finally {
            after.namespace.issuer?.bytes.fill(0);
          }
          const output = result('approved');
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
        if (this !== handle || scopes.getStore() !== scope || interruptUsed) fail();
        interruptUsed = true;
        const output = result(entered ? 'indeterminate' : 'cancelled');
        close();
        return output;
      },
    });
    return handle;
  } catch (error) {
    for (const buffer of preparedBuffers) buffer.fill(0);
    throw error;
  }
}
