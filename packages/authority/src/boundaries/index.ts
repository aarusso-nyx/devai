import { resolve as resolvePath, sep } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import ts from 'typescript';
import {
  deepFreeze,
  failure,
  isRecord,
  opaque,
  success,
  type AnyRecord,
} from '../runtime/contracts.js';
import { selectorMatches } from '../runtime/policy-resolver.js';

const MUTATORS = new Set([
  'appendFile',
  'appendFileSync',
  'chmodSync',
  'closeSync',
  'copyFileSync',
  'cpSync',
  'execFile',
  'execFileSync',
  'fsyncSync',
  'mkdir',
  'mkdirSync',
  'mkdtempSync',
  'openSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'spawn',
  'spawnSync',
  'symlinkSync',
  'unlink',
  'unlinkSync',
  'writeFile',
  'writeFileSync',
  'writeSync',
]);
const HOST_SCOPE_CONTROLLER = 'runWithAuthorityHostEffects';
const HOST_SCOPE_OWNERS = new Set([
  'packages/cli/src/authority/index.ts',
  'packages/cli/src/authority/broker.ts',
]);
const ATOMIC_HOST_EFFECTS_CONTROLLER = 'applyAuthorityHostEffectsAtomically';
const ATOMIC_HOST_EFFECTS_OWNER = 'packages/cli/src/authority/broker.ts';
const READ_PROCESS_EXCEPTION = 'readProcessSync';
const READ_PROCESS_OWNERS = new Set([
  'packages/cli/src/version.ts',
  'packages/loop/src/governance-ledger/index.ts',
]);
const GOVERNANCE_PROJECTION_EXCEPTION = 'writeGovernanceProjectionSync';
const GOVERNANCE_PROJECTION_OWNER = 'packages/cli/src/commands/docs/governance-render.ts';
const HOST_EFFECTS_MODULE = '@devai-nyx/authority';
const CANONICAL_SOURCE_ROOTS = [
  'packages/adapters/src',
  'packages/authority/src',
  'packages/cli/src',
  'packages/effects-check/src',
  'packages/evidence/src',
  'packages/examples/src',
  'packages/loop/src',
  'packages/sensors/src',
  'packages/skills/src',
  'packages/spec/src',
  'packages/utils/src',
] as const;

function logical(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.includes('://') &&
    !value.includes('@')
  );
}

function relativePath(value: unknown): value is string {
  return (
    logical(value) &&
    !value.endsWith('/') &&
    !value.includes('//') &&
    !value.split('/').some((part) => part === '.' || part === '..')
  );
}

function adapterId(target: AnyRecord): string {
  if (target.kind === 'fs-rename') return 'fs-authority-boundary';
  return `${String(target.kind)}-authority-boundary`;
}

export function classifyAuthorityResource(input: unknown, deps: unknown = {}) {
  if (!isRecord(input)) return failure('usage-error', 'AUTHORITY_RESOURCE_TARGET_INVALID');
  const dependencies = isRecord(deps) ? deps : {};
  if (input.kind === 'fs-rename') {
    if (
      !logical(input.repository_id) ||
      input.operation !== 'rename' ||
      !isRecord(input.source) ||
      !isRecord(input.destination) ||
      !logical(input.source.id) ||
      !logical(input.destination.id) ||
      !relativePath(input.source.canonical_relative_path) ||
      !relativePath(input.destination.canonical_relative_path)
    ) {
      return failure('usage-error', 'AUTHORITY_FS_TARGET_INVALID');
    }
    if (
      !String(input.source.canonical_relative_path).startsWith('packages/') ||
      !String(input.destination.canonical_relative_path).startsWith('packages/')
    ) {
      return failure('refused', 'AUTHORITY_RENAME_DESTINATION_DENIED');
    }
    return success(
      deepFreeze({ target: input, atomicity: 'whole-plan', adapter_id: 'fs-authority-boundary' }),
    );
  }
  if (input.kind === 'fs') {
    if (
      !relativePath(input.canonical_relative_path) ||
      !logical(input.repository_id) ||
      !['create', 'update', 'delete', 'rename'].includes(input.operation)
    ) {
      return failure('usage-error', 'AUTHORITY_FS_TARGET_INVALID');
    }
    if (
      typeof dependencies.realpath === 'function' &&
      typeof dependencies.repository_root === 'string'
    ) {
      const resolved = dependencies.realpath(input.canonical_relative_path);
      if (typeof resolved === 'string' && resolved.startsWith('/')) {
        const root = resolvePath(dependencies.repository_root);
        const candidate = resolvePath(resolved);
        if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
          return failure('refused', 'AUTHORITY_FS_SYMLINK_ESCAPE');
        }
      }
    }
    return success(
      deepFreeze({ target: input, atomicity: 'whole-plan', adapter_id: 'fs-authority-boundary' }),
    );
  }
  if (input.kind === 'git-ref') {
    if (input.protected === true && ['delete', 'force-push'].includes(input.operation)) {
      return failure('refused', 'AUTHORITY_GIT_PROTECTED_REF_DENIED');
    }
    if (
      !logical(input.repository_id) ||
      typeof input.ref !== 'string' ||
      !input.ref.startsWith('refs/')
    ) {
      return failure('refused', 'AUTHORITY_GIT_REF_INVALID');
    }
    if (
      input.merge === true ||
      !['create', 'update', 'delete', 'merge', 'push'].includes(input.operation)
    ) {
      return failure('refused', 'AUTHORITY_GIT_OPERATION_INVALID');
    }
    return success(
      deepFreeze({
        target: input,
        adapter_id: 'git-ref-authority-boundary',
        protected: input.protected === true,
      }),
    );
  }
  if (input.kind === 'db') {
    if (
      Object.hasOwn(input, 'password') ||
      Object.hasOwn(input, 'sql') ||
      !logical(input.connection_id) ||
      !logical(input.database_id) ||
      !logical(input.object_id)
    ) {
      return failure('usage-error', 'AUTHORITY_DB_TARGET_SECRET_OR_PAYLOAD');
    }
    if (!['insert', 'update', 'delete', 'ddl', 'execute'].includes(input.operation)) {
      return failure('usage-error', 'AUTHORITY_DB_TARGET_INVALID');
    }
    return success(deepFreeze({ target: input, adapter_id: 'db-authority-boundary' }));
  }
  if (input.kind === 'remote') {
    if (
      Object.hasOwn(input, 'operation') ||
      !logical(input.system_id) ||
      !logical(input.endpoint_id) ||
      !logical(input.operation_id) ||
      typeof input.publication !== 'boolean'
    ) {
      return failure('usage-error', 'AUTHORITY_REMOTE_TARGET_INVALID');
    }
    if (
      input.publication &&
      Object.hasOwn(dependencies, 'consent') &&
      (!isRecord(dependencies.consent) || dependencies.consent.allow_publish !== true)
    ) {
      return failure('refused', 'AUTHORITY_PUBLISH_CONSENT_REQUIRED');
    }
    return success(deepFreeze({ target: input, adapter_id: 'remote-authority-boundary' }));
  }
  return failure('usage-error', 'AUTHORITY_RESOURCE_TARGET_INVALID');
}

interface PlanRecord {
  subject: AnyRecord;
  digest: string;
  invocation: string;
  recovery: AnyRecord;
  recoveryBound: boolean;
}

interface BatchRecord {
  plan: object;
  batch: AnyRecord;
  targetDigest: string;
  used: boolean;
}

interface PreparedRecord {
  target: AnyRecord;
  snapshot?: unknown;
  batch?: object;
  plan: object;
  targetDigest: string;
  used: boolean;
}

interface PreparedUnitRecord {
  targets: readonly AnyRecord[];
  snapshots: readonly unknown[];
  adapterId: string;
  batch?: object;
  plan: object;
  targetDigest: string;
  used: boolean;
}

function exactTargets(subject: AnyRecord): readonly AnyRecord[] | undefined {
  const plan = subject.plan;
  if (!isRecord(plan)) return undefined;
  if (plan.strategy === 'exact-plan') {
    return Array.isArray(plan.targets) && plan.targets.every(isRecord) ? plan.targets : undefined;
  }
  const batch = subject.batch;
  return plan.strategy === 'bounded-batches' &&
    isRecord(batch) &&
    Array.isArray(batch.targets) &&
    batch.targets.every(isRecord)
    ? batch.targets
    : undefined;
}

function matchingTarget(
  subject: AnyRecord,
  target: AnyRecord,
  canonicalSha256: (value: unknown) => string,
): AnyRecord | undefined {
  return exactTargets(subject)?.find(
    (candidate) =>
      candidate.id === target.id && canonicalSha256(candidate) === canonicalSha256(target),
  );
}

function subjectMatchesPlan(
  registered: AnyRecord,
  candidate: unknown,
  canonicalSha256: (value: unknown) => string,
): candidate is AnyRecord {
  if (!isRecord(candidate) || !isRecord(candidate.plan) || !isRecord(registered.plan)) {
    return false;
  }
  if (canonicalSha256(candidate.plan) !== canonicalSha256(registered.plan)) return false;
  return (
    registered.plan.strategy === 'bounded-batches' ||
    canonicalSha256(candidate) === canonicalSha256(registered)
  );
}

function domainAdapter(target: AnyRecord, dependencies: AnyRecord): AnyRecord | undefined {
  if (target.kind === 'fs' || target.kind === 'fs-rename') return dependencies.fs;
  if (target.kind === 'git-ref') return dependencies.git;
  if (target.kind === 'db') return dependencies.db;
  if (target.kind === 'remote') return dependencies.remote;
  return undefined;
}

function snapshotTarget(target: AnyRecord, fsAdapter: AnyRecord | undefined): unknown {
  if (!fsAdapter || typeof fsAdapter.lstat !== 'function') return undefined;
  if (target.kind === 'fs') return fsAdapter.lstat(target.canonical_relative_path);
  if (target.kind === 'fs-rename') {
    return {
      source: fsAdapter.lstat(target.source.canonical_relative_path),
      destination: fsAdapter.lstat(target.destination.canonical_relative_path),
    };
  }
  return undefined;
}

export function createAuthorityBoundaryRuntime(deps: unknown) {
  if (!isRecord(deps) || !isRecord(deps.receiptStore))
    throw new Error('trusted boundary dependencies are required');
  const dependencies = deps;
  const plans = new WeakMap<object, PlanRecord>();
  const batches = new WeakMap<object, BatchRecord>();
  const preparedRecords = new WeakMap<object, PreparedRecord>();
  const preparedUnitRecords = new WeakMap<object, PreparedUnitRecord>();
  let closed = false;

  const plannerRegistry = {
    registerPlan(input: unknown) {
      if (closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
      if (
        !isRecord(input) ||
        !isRecord(input.subject) ||
        !isRecord(input.subject.plan) ||
        input.invocation_id !== dependencies.invocation_id
      ) {
        return failure('refused', 'AUTHORITY_PLAN_BINDING_MISMATCH');
      }
      const handle = opaque();
      plans.set(handle, {
        subject: input.subject,
        digest: dependencies.canonicalSha256(input.subject.plan),
        invocation: input.invocation_id,
        recovery: {
          applied_batch_ids: [],
          applied_target_count: 0,
          partial_effect_evidence_refs: [],
        },
        recoveryBound: false,
      });
      return success(handle);
    },
    registerBatch(input: unknown) {
      if (closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
      if (
        !isRecord(input) ||
        !isRecord(input.plan_handle) ||
        !plans.has(input.plan_handle) ||
        !isRecord(input.batch) ||
        !isRecord(input.recovery)
      ) {
        return failure('refused', 'AUTHORITY_BATCH_BINDING_MISMATCH');
      }
      const plan = plans.get(input.plan_handle);
      if (
        !plan ||
        input.invocation_id !== plan.invocation ||
        input.plan_digest_sha256 !== plan.digest
      ) {
        return failure('refused', 'AUTHORITY_BATCH_BINDING_MISMATCH');
      }
      const targetIds = Array.isArray(input.batch.targets)
        ? input.batch.targets.map((target: AnyRecord) => target.id)
        : [];
      const bounds = plan.subject.plan.bounds;
      const selectors = plan.subject.plan.selectors;
      if (
        input.batch.plan_id !== plan.subject.plan.plan_id ||
        targetIds.length === 0 ||
        new Set(targetIds).size !== targetIds.length ||
        !isRecord(bounds) ||
        !Array.isArray(selectors) ||
        !input.batch.targets.every(
          (target: unknown) =>
            isRecord(target) &&
            selectors.some((selector: unknown) => selectorMatches(selector, target)),
        ) ||
        targetIds.length > bounds.max_targets_per_batch
      ) {
        return failure('refused', 'AUTHORITY_BATCH_BINDING_MISMATCH');
      }
      if (input.target_digest_sha256 !== dependencies.canonicalSha256(targetIds)) {
        return failure('refused', 'AUTHORITY_BATCH_TARGET_DRIFT');
      }
      if (
        !Array.isArray(input.recovery.applied_batch_ids) ||
        !Array.isArray(input.recovery.partial_effect_evidence_refs) ||
        input.recovery.applied_batch_ids.some((id: unknown) => !logical(id)) ||
        new Set(input.recovery.applied_batch_ids).size !==
          input.recovery.applied_batch_ids.length ||
        input.recovery.partial_effect_evidence_refs.some((ref: unknown) => !logical(ref)) ||
        input.recovery.partial_effect_evidence_refs.length !==
          input.recovery.applied_batch_ids.length ||
        !Number.isSafeInteger(input.recovery.applied_target_count) ||
        input.recovery.applied_target_count < input.recovery.applied_batch_ids.length ||
        (input.recovery.applied_batch_ids.length > 0 &&
          !logical(input.recovery.recovery_checkpoint_ref))
      ) {
        return failure('refused', 'AUTHORITY_BATCH_RECOVERY_STALE');
      }
      if (
        plan.recoveryBound &&
        dependencies.canonicalSha256(input.recovery) !== dependencies.canonicalSha256(plan.recovery)
      ) {
        return failure('refused', 'AUTHORITY_BATCH_RECOVERY_STALE');
      }
      plan.recovery = deepFreeze({ ...input.recovery });
      plan.recoveryBound = true;
      if (input.recovery.applied_batch_ids.includes(input.batch.batch_id)) {
        return failure('refused', 'AUTHORITY_BATCH_REPLAYED');
      }
      if (
        input.recovery.applied_batch_ids.length + 1 > bounds.max_batches ||
        input.recovery.applied_target_count + targetIds.length > bounds.max_total_targets
      ) {
        return failure('refused', 'AUTHORITY_BATCH_CUMULATIVE_LIMIT_EXCEEDED');
      }
      const declaredOrdinal = Object.hasOwn(input, 'ordinal') ? input.ordinal : input.batch.ordinal;
      if (
        declaredOrdinal !== input.batch.ordinal ||
        input.batch.ordinal !== input.recovery.applied_batch_ids.length + 1
      ) {
        return failure('refused', 'AUTHORITY_BATCH_ORDER_INVALID');
      }
      const handle = deepFreeze({
        invocation_id: input.invocation_id,
        plan_id: input.batch.plan_id,
        batch_id: input.batch.batch_id,
        ordinal: input.batch.ordinal,
      });
      batches.set(handle, {
        plan: input.plan_handle,
        batch: input.batch,
        targetDigest: input.target_digest_sha256,
        used: false,
      });
      return success(handle);
    },
    recovery(input: unknown) {
      if (!isRecord(input) || !isRecord(input.plan_handle))
        return failure('refused', 'AUTHORITY_PLAN_BINDING_MISMATCH');
      const plan = plans.get(input.plan_handle);
      return plan ? success(plan.recovery) : failure('refused', 'AUTHORITY_PLAN_BINDING_MISMATCH');
    },
  };

  function prepare(input: unknown) {
    if (closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    if (!isRecord(input)) return failure('refused', 'AUTHORITY_DECISION_RECEIPT_UNKNOWN');
    if (Object.hasOwn(input, 'now'))
      return failure('usage-error', 'AUTHORITY_CALLER_TIME_FORBIDDEN');
    if (!isRecord(input.plan_handle) || !plans.has(input.plan_handle))
      return failure('refused', 'AUTHORITY_PLAN_REGISTRY_MEMBERSHIP_REQUIRED');
    const plan = plans.get(input.plan_handle);
    if (!plan || !subjectMatchesPlan(plan.subject, input.subject, dependencies.canonicalSha256)) {
      return failure('refused', 'AUTHORITY_PLAN_BINDING_MISMATCH');
    }
    if (plan.subject.plan.strategy === 'bounded-batches') {
      if (!isRecord(input.batch_handle) || !batches.has(input.batch_handle)) {
        return failure('refused', 'AUTHORITY_BATCH_REGISTRY_MEMBERSHIP_REQUIRED');
      }
      const batch = batches.get(input.batch_handle);
      if (
        !batch ||
        batch.plan !== input.plan_handle ||
        batch.used ||
        dependencies.canonicalSha256(input.batch) !== dependencies.canonicalSha256(batch.batch) ||
        !isRecord(input.subject.batch) ||
        dependencies.canonicalSha256(input.subject.batch) !==
          dependencies.canonicalSha256(batch.batch)
      ) {
        return failure('refused', 'AUTHORITY_BATCH_BINDING_MISMATCH');
      }
    }
    const targets = exactTargets(input.subject);
    if (!targets || targets.length !== 1) {
      return failure('refused', 'AUTHORITY_EXECUTION_UNIT_REQUIRED');
    }
    if (
      !isRecord(input.target) ||
      !matchingTarget(input.subject, input.target, dependencies.canonicalSha256)
    ) {
      return failure('refused', 'AUTHORITY_PLAN_TARGET_BINDING_MISMATCH');
    }
    const classified = classifyAuthorityResource(input.target, {
      repository_root: dependencies.repository_root,
      realpath: dependencies.fs?.realpath,
      consent: plan.subject.plan.envelope?.request?.consent,
    });
    if (classified.ok !== true) return classified;
    const expectedAdapter = adapterId(input.target);
    if (input.adapter_id !== expectedAdapter) {
      return failure('refused', 'AUTHORITY_DECISION_RECEIPT_BINDING_MISMATCH');
    }
    const consumed = dependencies.receiptStore.consume({
      receipt: input.decision_receipt,
      subject: input.subject,
      invocation_id: dependencies.invocation_id,
      adapter_id: input.adapter_id,
    });
    if (consumed.ok !== true) return consumed;
    const prepared = opaque();
    const snapshot = snapshotTarget(input.target, dependencies.fs);
    preparedRecords.set(prepared, {
      target: input.target,
      snapshot,
      batch: input.batch_handle,
      plan: input.plan_handle,
      targetDigest: dependencies.canonicalSha256(input.target),
      used: false,
    });
    return success(prepared);
  }

  function prepareUnit(input: unknown) {
    if (closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    if (!isRecord(input)) return failure('refused', 'AUTHORITY_DECISION_RECEIPT_UNKNOWN');
    if (Object.hasOwn(input, 'now'))
      return failure('usage-error', 'AUTHORITY_CALLER_TIME_FORBIDDEN');
    if (!isRecord(input.plan_handle) || !plans.has(input.plan_handle)) {
      return failure('refused', 'AUTHORITY_PLAN_REGISTRY_MEMBERSHIP_REQUIRED');
    }
    const plan = plans.get(input.plan_handle);
    if (!plan || !subjectMatchesPlan(plan.subject, input.subject, dependencies.canonicalSha256)) {
      return failure('refused', 'AUTHORITY_PLAN_BINDING_MISMATCH');
    }
    let batchHandle: object | undefined;
    if (plan.subject.plan.strategy === 'bounded-batches') {
      if (!isRecord(input.batch_handle) || !batches.has(input.batch_handle)) {
        return failure('refused', 'AUTHORITY_BATCH_REGISTRY_MEMBERSHIP_REQUIRED');
      }
      const batch = batches.get(input.batch_handle);
      if (
        !batch ||
        batch.plan !== input.plan_handle ||
        batch.used ||
        dependencies.canonicalSha256(input.batch) !== dependencies.canonicalSha256(batch.batch) ||
        !isRecord(input.subject.batch) ||
        dependencies.canonicalSha256(input.subject.batch) !==
          dependencies.canonicalSha256(batch.batch)
      ) {
        return failure('refused', 'AUTHORITY_BATCH_BINDING_MISMATCH');
      }
      batchHandle = input.batch_handle;
    }
    const targets = exactTargets(input.subject);
    if (
      !targets ||
      targets.length === 0 ||
      !Array.isArray(input.targets) ||
      !input.targets.every(isRecord) ||
      dependencies.canonicalSha256(input.targets) !== dependencies.canonicalSha256(targets)
    ) {
      return failure('refused', 'AUTHORITY_EXECUTION_UNIT_TARGET_MISMATCH');
    }
    const adapterIds = new Set(targets.map(adapterId));
    if (adapterIds.size !== 1 || !adapterIds.has(String(input.adapter_id))) {
      return failure('refused', 'AUTHORITY_EXECUTION_UNIT_ADAPTER_MISMATCH');
    }
    const firstTarget = targets[0];
    if (!firstTarget) return failure('refused', 'AUTHORITY_EXECUTION_UNIT_TARGET_MISMATCH');
    const adapter = domainAdapter(firstTarget, dependencies);
    if (!adapter || typeof adapter.applyAtomic !== 'function') {
      return failure('dependency-error', 'AUTHORITY_ATOMIC_UNIT_ADAPTER_REQUIRED');
    }
    const snapshots: unknown[] = [];
    for (const target of targets) {
      const classified = classifyAuthorityResource(target, {
        repository_root: dependencies.repository_root,
        realpath: dependencies.fs?.realpath,
        consent: plan.subject.plan.envelope?.request?.consent,
      });
      if (classified.ok !== true) return classified;
      snapshots.push(snapshotTarget(target, dependencies.fs));
    }
    const consumed = dependencies.receiptStore.consume({
      receipt: input.decision_receipt,
      subject: input.subject,
      invocation_id: dependencies.invocation_id,
      adapter_id: input.adapter_id,
    });
    if (consumed.ok !== true) return consumed;
    const prepared = opaque();
    preparedUnitRecords.set(prepared, {
      targets: deepFreeze([...targets]),
      snapshots: deepFreeze(snapshots),
      adapterId: String(input.adapter_id),
      batch: batchHandle,
      plan: input.plan_handle,
      targetDigest: dependencies.canonicalSha256(targets),
      used: false,
    });
    return success(prepared);
  }

  function apply(input: unknown) {
    if (closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    if (!isRecord(input) || !isRecord(input.prepared) || !preparedRecords.has(input.prepared)) {
      return failure('refused', 'AUTHORITY_PREPARED_MUTATION_UNKNOWN');
    }
    const record = preparedRecords.get(input.prepared);
    if (!record) return failure('refused', 'AUTHORITY_PREPARED_MUTATION_UNKNOWN');
    if (record.used) return failure('refused', 'AUTHORITY_PREPARED_MUTATION_REPLAYED');
    record.used = true;
    const target = record.target;
    if (dependencies.canonicalSha256(target) !== record.targetDigest) {
      return failure('refused', 'AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE');
    }
    const plan = plans.get(record.plan);
    const classified = classifyAuthorityResource(target, {
      repository_root: dependencies.repository_root,
      realpath: dependencies.fs?.realpath,
      consent: plan?.subject.plan.envelope?.request?.consent,
    });
    if (classified.ok !== true) return classified;
    const currentSnapshot = snapshotTarget(target, dependencies.fs);
    if (
      dependencies.canonicalSha256(currentSnapshot) !==
      dependencies.canonicalSha256(record.snapshot)
    ) {
      return failure('refused', 'AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE');
    }
    let effectResult: unknown;
    if (target.kind === 'fs')
      effectResult = dependencies.fs.writeAtomic(target.canonical_relative_path);
    else if (target.kind === 'fs-rename')
      effectResult = dependencies.fs.renameAtomic(
        target.source.canonical_relative_path,
        target.destination.canonical_relative_path,
      );
    else if (target.kind === 'git-ref') {
      if (target.operation === 'delete') effectResult = dependencies.git.deleteRef(target.ref);
      else if (target.operation === 'push') effectResult = dependencies.git.push(target.ref);
      else effectResult = dependencies.git.updateRef(target.ref);
    } else if (target.kind === 'db')
      effectResult = dependencies.db.execute(target.connection_id, target.operation);
    else if (target.kind === 'remote')
      effectResult = dependencies.remote.invoke(
        target.system_id,
        target.endpoint_id,
        target.operation_id,
      );
    if (record.batch) {
      const batch = batches.get(record.batch);
      if (batch) {
        batch.used = true;
        const batchPlan = plans.get(batch.plan);
        if (batchPlan) {
          const effectEvidenceRef =
            typeof effectResult === 'string'
              ? effectResult
              : `authority-boundary:${String(batch.batch.batch_id)}`;
          batchPlan.recovery = deepFreeze({
            ...batchPlan.recovery,
            applied_batch_ids: [...batchPlan.recovery.applied_batch_ids, batch.batch.batch_id],
            applied_target_count:
              batchPlan.recovery.applied_target_count + batch.batch.targets.length,
            partial_effect_evidence_refs: [
              ...batchPlan.recovery.partial_effect_evidence_refs,
              effectEvidenceRef,
            ],
            recovery_checkpoint_ref: `authority-boundary:${String(batch.batch.batch_id)}:applied`,
          });
        }
      }
    }
    return success({ applied: true as const });
  }

  function applyUnit(input: unknown) {
    if (closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
    if (!isRecord(input) || !isRecord(input.prepared) || !preparedUnitRecords.has(input.prepared)) {
      return failure('refused', 'AUTHORITY_PREPARED_UNIT_UNKNOWN');
    }
    const record = preparedUnitRecords.get(input.prepared);
    if (!record) return failure('refused', 'AUTHORITY_PREPARED_UNIT_UNKNOWN');
    if (record.used) return failure('refused', 'AUTHORITY_PREPARED_UNIT_REPLAYED');
    record.used = true;
    if (dependencies.canonicalSha256(record.targets) !== record.targetDigest) {
      return failure('refused', 'AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE');
    }
    const plan = plans.get(record.plan);
    for (const [index, target] of record.targets.entries()) {
      const classified = classifyAuthorityResource(target, {
        repository_root: dependencies.repository_root,
        realpath: dependencies.fs?.realpath,
        consent: plan?.subject.plan.envelope?.request?.consent,
      });
      if (classified.ok !== true) return classified;
      if (
        dependencies.canonicalSha256(snapshotTarget(target, dependencies.fs)) !==
        dependencies.canonicalSha256(record.snapshots[index])
      ) {
        return failure('refused', 'AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE');
      }
    }
    const firstTarget = record.targets[0];
    if (!firstTarget) return failure('refused', 'AUTHORITY_EXECUTION_UNIT_TARGET_MISMATCH');
    if (adapterId(firstTarget) !== record.adapterId) {
      return failure('refused', 'AUTHORITY_EXECUTION_UNIT_ADAPTER_MISMATCH');
    }
    const adapter = domainAdapter(firstTarget, dependencies);
    if (!adapter || typeof adapter.applyAtomic !== 'function') {
      return failure('dependency-error', 'AUTHORITY_ATOMIC_UNIT_ADAPTER_REQUIRED');
    }
    const effectResult = adapter.applyAtomic(record.targets);
    if (isRecord(effectResult) && effectResult.ok === false) return effectResult;
    if (record.batch) {
      const batch = batches.get(record.batch);
      if (batch) {
        batch.used = true;
        const batchPlan = plans.get(batch.plan);
        if (batchPlan) {
          const effectEvidenceRef =
            typeof effectResult === 'string'
              ? effectResult
              : `authority-boundary:${String(batch.batch.batch_id)}`;
          batchPlan.recovery = deepFreeze({
            ...batchPlan.recovery,
            applied_batch_ids: [...batchPlan.recovery.applied_batch_ids, batch.batch.batch_id],
            applied_target_count:
              batchPlan.recovery.applied_target_count + batch.batch.targets.length,
            partial_effect_evidence_refs: [
              ...batchPlan.recovery.partial_effect_evidence_refs,
              effectEvidenceRef,
            ],
            recovery_checkpoint_ref: `authority-boundary:${String(batch.batch.batch_id)}:applied`,
          });
        }
      }
    }
    return success({ applied: true as const, target_count: record.targets.length });
  }

  return {
    plannerRegistry,
    prepare,
    prepareUnit,
    apply,
    applyUnit,
    dispose() {
      if (closed) return failure('refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
      closed = true;
      return dependencies.receiptStore.dispose();
    },
  };
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (relative: string): void => {
    const absolute = resolvePath(root, relative);
    for (const entry of readdirSync(absolute).sort()) {
      const child = relative.length === 0 ? entry : `${relative}/${entry}`;
      const childAbsolute = resolvePath(root, child);
      if (statSync(childAbsolute).isDirectory()) visit(child);
      else if (entry.endsWith('.ts')) files.push(child);
    }
  };
  visit('');
  return files;
}

function unauthorizedMutatorCalls(
  source: string,
  fileName: string,
): Array<{ line: number; symbol: string }> {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imported = new Map<string, string>();
  const importedNames = new Map<string, string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause
    )
      continue;
    const moduleName = statement.moduleSpecifier.text;
    const bindings = statement.importClause.namedBindings;
    if (statement.importClause.name) imported.set(statement.importClause.name.text, moduleName);
    if (bindings && ts.isNamespaceImport(bindings)) imported.set(bindings.name.text, moduleName);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imported.set(element.name.text, moduleName);
        importedNames.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
  }
  const calls: Array<{ line: number; symbol: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const symbol = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined;
      if (symbol && MUTATORS.has(symbol)) {
        const owner = ts.isIdentifier(expression)
          ? imported.get(expression.text)
          : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
            ? imported.get(expression.expression.text)
            : undefined;
        if (owner !== HOST_EFFECTS_MODULE) {
          calls.push({
            line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            symbol,
          });
        }
      }
      const importedSymbol = ts.isIdentifier(expression)
        ? (importedNames.get(expression.text) ?? expression.text)
        : symbol;
      if (
        importedSymbol === HOST_SCOPE_CONTROLLER &&
        (!HOST_SCOPE_OWNERS.has(fileName) ||
          (ts.isIdentifier(expression) && imported.get(expression.text) !== HOST_EFFECTS_MODULE))
      ) {
        calls.push({
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          symbol: HOST_SCOPE_CONTROLLER,
        });
      }
      if (
        importedSymbol === ATOMIC_HOST_EFFECTS_CONTROLLER &&
        (fileName !== ATOMIC_HOST_EFFECTS_OWNER ||
          (ts.isIdentifier(expression) && imported.get(expression.text) !== HOST_EFFECTS_MODULE))
      ) {
        calls.push({
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          symbol: ATOMIC_HOST_EFFECTS_CONTROLLER,
        });
      }
      if (
        importedSymbol === READ_PROCESS_EXCEPTION &&
        (!READ_PROCESS_OWNERS.has(fileName) ||
          (ts.isIdentifier(expression) && imported.get(expression.text) !== HOST_EFFECTS_MODULE))
      ) {
        calls.push({
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          symbol: READ_PROCESS_EXCEPTION,
        });
      }
      if (
        importedSymbol === GOVERNANCE_PROJECTION_EXCEPTION &&
        (fileName !== GOVERNANCE_PROJECTION_OWNER ||
          (ts.isIdentifier(expression) && imported.get(expression.text) !== HOST_EFFECTS_MODULE))
      ) {
        calls.push({
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          symbol: GOVERNANCE_PROJECTION_EXCEPTION,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

export function validateDirectMutatorInventory(input: unknown) {
  if (!isRecord(input) || !isRecord(input.inventory) || !Array.isArray(input.inventory.entries)) {
    return failure('usage-error', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_INVALID');
  }
  const unauthorized: Array<{ path: string; line: number; symbol: string }> = [];
  if (typeof input.repo_root === 'string') {
    for (const sourceRoot of CANONICAL_SOURCE_ROOTS) {
      const absoluteRoot = resolvePath(input.repo_root, sourceRoot);
      if (!existsSync(absoluteRoot)) continue;
      for (const relative of sourceFiles(absoluteRoot)) {
        const path = `${sourceRoot}/${relative}`;
        const source = readFileSync(resolvePath(absoluteRoot, relative), 'utf8');
        for (const call of unauthorizedMutatorCalls(source, path)) {
          unauthorized.push({ path, ...call });
        }
      }
    }
  }
  if (isRecord(input.virtual_sources)) {
    for (const [path, source] of Object.entries(input.virtual_sources)) {
      if (typeof source !== 'string') continue;
      for (const call of unauthorizedMutatorCalls(source, path))
        unauthorized.push({ path, ...call });
    }
  }
  if (unauthorized.length > 0) {
    return { ...failure('refused', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE'), unauthorized };
  }
  return success({
    unauthorized_call_sites: 0,
    wildcard_exemptions: input.inventory.totals?.exemptions ?? 0,
  });
}
