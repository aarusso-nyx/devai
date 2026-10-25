import { types } from 'node:util';

/** Validated time data only. Trusted host origin is a separate requirement. */
export interface ReconciliationClockObservation {
  readonly clock_source: 'node-uv-hrtime-ns-v1';
  readonly boot_id: string;
  readonly monotonic_ns: string;
  readonly wall_ms: number;
}

type ClockCode =
  | 'RECONCILIATION_CLOCK_INVALID'
  | 'RECONCILIATION_CLOCK_BOOT_CHANGED'
  | 'RECONCILIATION_CLOCK_ROLLBACK'
  | 'RECONCILIATION_CLOCK_DIVERGED'
  | 'RECONCILIATION_CLOCK_EXPIRED';

export class ReconciliationClockError extends Error {
  readonly code: ClockCode;
  constructor(code: ClockCode) {
    super(code);
    this.name = 'ReconciliationClockError';
    this.code = code;
  }
}

const FIELDS = ['clock_source', 'boot_id', 'monotonic_ns', 'wall_ms'];
const MAX_NS = 18446744073709551615n;
const NS_PER_MS = 1000000n;
const MAX_DISAGREEMENT_NS = 2000000000n;

function invalid(): never {
  throw new ReconciliationClockError('RECONCILIATION_CLOCK_INVALID');
}

/** Copies a closed observation without invoking input accessors or coercions. */
export function validateReconciliationClockObservation(
  value: unknown,
): ReconciliationClockObservation {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== FIELDS.length ||
    !keys.every((field) => typeof field === 'string' && FIELDS.includes(field))
  )
    invalid();
  const data = Object.create(null) as Record<string, unknown>;
  for (const field of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) invalid();
    data[field] = descriptor.value;
  }
  if (
    data.clock_source !== 'node-uv-hrtime-ns-v1' ||
    typeof data.boot_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(data.boot_id) ||
    data.boot_id.length !== 36 ||
    typeof data.monotonic_ns !== 'string' ||
    data.monotonic_ns.length > 20 ||
    !/^[1-9][0-9]*$/u.test(data.monotonic_ns) ||
    /[^0-9]/u.test(data.monotonic_ns) ||
    BigInt(data.monotonic_ns) > MAX_NS ||
    typeof data.wall_ms !== 'number' ||
    !Number.isSafeInteger(data.wall_ms) ||
    data.wall_ms < 0 ||
    Object.is(data.wall_ms, -0)
  )
    invalid();
  return Object.freeze({
    clock_source: 'node-uv-hrtime-ns-v1',
    boot_id: data.boot_id,
    monotonic_ns: data.monotonic_ns,
    wall_ms: data.wall_ms,
  });
}

function diverged(
  earlier: ReconciliationClockObservation,
  observed: ReconciliationClockObservation,
): boolean {
  const difference =
    BigInt(observed.wall_ms - earlier.wall_ms) * NS_PER_MS -
    (BigInt(observed.monotonic_ns) - BigInt(earlier.monotonic_ns));
  return difference > MAX_DISAGREEMENT_NS || difference < -MAX_DISAGREEMENT_NS;
}

/** Eligibility metadata only; this neither samples a clock nor grants authority. */
export function checkReconciliationClockWindow(
  issued: unknown,
  observed: unknown,
  kind: 'review' | 'grant',
  predecessor?: unknown,
): Readonly<{ wall_elapsed_ms: number; monotonic_elapsed_ns: string }> {
  if (kind !== 'review' && kind !== 'grant') invalid();
  const issue = validateReconciliationClockObservation(issued);
  const current = validateReconciliationClockObservation(observed);
  const previous =
    predecessor === undefined ? undefined : validateReconciliationClockObservation(predecessor);
  const lifetimeMs = kind === 'review' ? 300000 : 900000;
  const lifetimeNs = BigInt(lifetimeMs) * NS_PER_MS;
  const issueNs = BigInt(issue.monotonic_ns);
  const currentNs = BigInt(current.monotonic_ns);
  if (issueNs > MAX_NS - lifetimeNs || issue.wall_ms > Number.MAX_SAFE_INTEGER - lifetimeMs)
    invalid();
  if (
    current.boot_id !== issue.boot_id ||
    (previous !== undefined && previous.boot_id !== issue.boot_id)
  )
    throw new ReconciliationClockError('RECONCILIATION_CLOCK_BOOT_CHANGED');
  if (
    current.wall_ms < issue.wall_ms ||
    currentNs < issueNs ||
    (previous !== undefined &&
      (current.wall_ms < previous.wall_ms || currentNs < BigInt(previous.monotonic_ns)))
  )
    throw new ReconciliationClockError('RECONCILIATION_CLOCK_ROLLBACK');
  if (diverged(issue, current) || (previous !== undefined && diverged(previous, current)))
    throw new ReconciliationClockError('RECONCILIATION_CLOCK_DIVERGED');
  const wallElapsed = current.wall_ms - issue.wall_ms;
  const monotonicElapsed = currentNs - issueNs;
  if (wallElapsed >= lifetimeMs || monotonicElapsed >= lifetimeNs)
    throw new ReconciliationClockError('RECONCILIATION_CLOCK_EXPIRED');
  return Object.freeze({
    wall_elapsed_ms: wallElapsed,
    monotonic_elapsed_ns: monotonicElapsed.toString(),
  });
}
