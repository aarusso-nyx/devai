import { isRecord, type AnyRecord } from '../runtime/contracts.js';
import { types as nodeTypes } from 'node:util';
import { typedResourceAdapter, typedResourceKind } from './resource-classification.js';

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
  typedAdapter?: object;
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
  if (typedResourceKind(target) !== undefined) return typedResourceAdapter(target, dependencies);
  if (target.kind === 'fs' || target.kind === 'fs-rename') return dependencies.fs;
  if (target.kind === 'git-ref') return dependencies.git;
  if (target.kind === 'db') return dependencies.db;
  if (target.kind === 'remote') return dependencies.remote;
  return undefined;
}

/** Bounded descriptor-only copy; a mutable adapter snapshot cannot rewrite prepared history. */
function snapshotCopy(value: unknown): unknown {
  const seen = new Set<object>();
  let nodes = 0,
    textSize = 0;
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 16384 || depth > 32) throw new Error();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      textSize += item.length;
      if (
        textSize > 1048576 ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)
      )
        throw new Error();
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return item;
    if (typeof item !== 'object' || nodeTypes.isProxy(item) || seen.has(item)) throw new Error();
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      throw new Error();
    seen.add(item);
    const keys = Reflect.ownKeys(item);
    const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    if (array && (item.length > 4096 || keys.length !== item.length + 1)) throw new Error();
    if (!array && keys.length > 128) throw new Error();
    const fields = array ? Array.from({ length: item.length }, (_, i) => String(i)) : keys;
    for (const key of fields) {
      if (
        typeof key !== 'string' ||
        key.length > 128 ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(key)
      )
        throw new Error();
      textSize += key.length;
      if (textSize > 1048576) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) throw new Error();
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    seen.delete(item);
    return Object.freeze(result);
  };
  if (nodeTypes.isProxy(value) || !isRecord(value) || Array.isArray(value)) throw new Error();
  return copy(value, 0);
}

export function snapshotTarget(target: AnyRecord, dependencies: AnyRecord): unknown {
  if (typedResourceKind(target) !== undefined) {
    const adapter = typedResourceAdapter(target, dependencies);
    if (adapter === undefined) throw new Error('AUTHORITY_TYPED_RESOURCE_ADAPTER_REQUIRED');
    try {
      return snapshotCopy(adapter.snapshot(target));
    } catch {
      throw new Error('AUTHORITY_TYPED_RESOURCE_SNAPSHOT_INVALID');
    }
  }
  const fsAdapter = dependencies.fs;
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
