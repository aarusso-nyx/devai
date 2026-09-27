import {
  deepFreeze,
  failure,
  isRecord,
  opaque,
  success,
  type AnyRecord,
} from '../runtime/contracts.js';
import { selectorMatches } from '../runtime/policy-resolver.js';
import { adapterId, classifyAuthorityResource, logical } from './resource-classification.js';
import {
  domainAdapter,
  exactTargets,
  matchingTarget,
  snapshotTarget,
  subjectMatchesPlan,
  type BatchRecord,
  type PlanRecord,
  type PreparedRecord,
  type PreparedUnitRecord,
} from './boundary-runtime-targets.js';

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
