import { isRecord, type AnyRecord } from '../runtime/contracts.js';

export interface PlanRecord {
  subject: AnyRecord;
  digest: string;
  invocation: string;
  recovery: AnyRecord;
  recoveryBound: boolean;
}

export interface BatchRecord {
  plan: object;
  batch: AnyRecord;
  targetDigest: string;
  used: boolean;
}

export interface PreparedRecord {
  target: AnyRecord;
  snapshot?: unknown;
  batch?: object;
  plan: object;
  targetDigest: string;
  used: boolean;
}

export interface PreparedUnitRecord {
  targets: readonly AnyRecord[];
  snapshots: readonly unknown[];
  adapterId: string;
  batch?: object;
  plan: object;
  targetDigest: string;
  used: boolean;
}

export function exactTargets(subject: AnyRecord): readonly AnyRecord[] | undefined {
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

export function matchingTarget(
  subject: AnyRecord,
  target: AnyRecord,
  canonicalSha256: (value: unknown) => string,
): AnyRecord | undefined {
  return exactTargets(subject)?.find(
    (candidate) =>
      candidate.id === target.id && canonicalSha256(candidate) === canonicalSha256(target),
  );
}

export function subjectMatchesPlan(
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

export function domainAdapter(target: AnyRecord, dependencies: AnyRecord): AnyRecord | undefined {
  if (target.kind === 'fs' || target.kind === 'fs-rename') return dependencies.fs;
  if (target.kind === 'git-ref') return dependencies.git;
  if (target.kind === 'db') return dependencies.db;
  if (target.kind === 'remote') return dependencies.remote;
  return undefined;
}

export function snapshotTarget(target: AnyRecord, fsAdapter: AnyRecord | undefined): unknown {
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
