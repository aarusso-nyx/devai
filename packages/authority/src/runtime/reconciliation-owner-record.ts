import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import { getValidator } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';
import type { ReconciliationAdmissionAnchor } from '../boundaries/host-reconciliation-admission.js';
import {
  validateReconciliationClockObservation,
  type ReconciliationClockObservation,
} from './reconciliation-clock.js';

export type ReconciliationOwnerRecordKind =
  'issuer' | 'approval' | 'renewal' | 'revocation' | 'lease' | 'phase-intent' | 'phase-completion';
type Phase = '01' | '02' | '03' | '04';
type PhaseAction =
  'evidence reconcile materialize' | 'evidence reconcile stage-proof' | 'sense bootstrap-inventory';

interface Base<K extends ReconciliationOwnerRecordKind> {
  readonly schemaVersion: '1.0.0';
  readonly kind: K;
  readonly domain: `devai.reconciliation.owner.v1/${K}`;
  readonly repository_id: string;
  readonly worktree_id: string;
  readonly clock: ReconciliationClockObservation;
  readonly mac: string;
}
interface InstallationBindings {
  readonly package_sha256: string;
  readonly module_sha256: string;
  readonly registry_sha256: string;
  readonly constitution_sha256: string;
  readonly policy_sha256: string;
}
interface Scope {
  readonly repository_id: string;
  readonly worktree_id: string;
  readonly host_identity_sha256: string;
  readonly binding_sha256: string;
  readonly plan_sha256: string;
  readonly source_manifest_sha256: string;
  readonly allowed_phases: readonly ['01', '02', '03', '04'];
}
interface Validity {
  readonly validity_ms: number;
  readonly expires_wall_ms: number;
  readonly expires_monotonic_ns: string;
}
interface Linked {
  readonly approval_id: string;
  readonly issuer_sha256: string;
  readonly approval_sha256: string;
  readonly scope_sha256: string;
}
interface Issuer extends Base<'issuer'> {
  readonly adapter_id: 'reconciliation-host-authority-boundary';
  readonly host_identity_sha256: string;
  readonly key_sha256: string;
  readonly seed_plan_sha256: string;
  readonly provision_context_sha256: string;
  readonly admission_anchor: ReconciliationAdmissionAnchor;
  readonly private_key_base64: string;
  readonly installation_bindings: InstallationBindings;
  readonly installed_at_head: string;
}
interface Approval extends Base<'approval'>, Validity {
  readonly approval_id: string;
  readonly issuer_sha256: string;
  readonly scope_sha256: string;
  readonly sequence: 1;
  readonly previous_grant_sha256: null;
  readonly scope: Scope;
}
interface Renewal extends Base<'renewal'>, Linked, Validity {
  readonly sequence: number;
  readonly previous_grant_sha256: string;
  readonly remaining_phases: readonly Phase[];
  readonly resumable_intent_sha256: string | null;
}
interface Revocation extends Base<'revocation'>, Linked {
  readonly sequence: number;
  readonly previous_grant_sha256: string;
}
interface Intent extends Base<'phase-intent'>, Linked {
  readonly grant_sha256: string;
  readonly before_witness_sha256: string;
  readonly output_plan_sha256: string;
  readonly lease_nonce: string;
  readonly invocation_id: string;
  readonly phase: Phase;
  readonly action_id: PhaseAction;
  readonly initiator: 'inspector' | 'architect';
  readonly predecessor_completion_sha256: string | null;
}
interface Completion extends Base<'phase-completion'>, Linked {
  readonly intent_sha256: string;
  readonly observed_grant_sha256: string;
  readonly final_witness_sha256: string;
  readonly outputs_manifest_sha256: string;
  readonly phase: Phase;
  readonly predecessor_completion_sha256: string | null;
  readonly durability: 'durable';
}
interface Lease extends Base<'lease'>, Linked {
  readonly grant_sha256: string;
  readonly original_intent_sha256: string;
  readonly invocation_id: string;
  readonly nonce: string;
  readonly host_identity_sha256: string;
  readonly phase: Phase;
  readonly action_id: PhaseAction;
  readonly initiator: 'inspector' | 'architect';
  readonly pid: number;
  readonly hostname: string;
}
/** Validated data only. Neither shape nor a MAC establishes host/action authority. */
export type ReconciliationOwnerRecord =
  Issuer | Approval | Renewal | Revocation | Intent | Completion | Lease;
type WithoutMac<T> = T extends unknown ? Omit<T, 'mac'> : never;
export type ReconciliationOwnerUnsignedRecord = WithoutMac<ReconciliationOwnerRecord>;

type RecordCode =
  | 'RECONCILIATION_OWNER_INVALID'
  | 'RECONCILIATION_OWNER_MAC_INVALID'
  | 'RECONCILIATION_OWNER_ENCODING_INVALID'
  | 'RECONCILIATION_OWNER_LIMIT_EXCEEDED';
export class ReconciliationOwnerRecordError extends Error {
  readonly code: RecordCode;
  constructor(code: RecordCode) {
    super(code);
    this.name = 'ReconciliationOwnerRecordError';
    this.code = code;
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const MAX_BYTES = 1048576;
const MAX_NS = 18446744073709551615n;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const byteSet = Uint8Array.prototype.set;

function fail(code: RecordCode = 'RECONCILIATION_OWNER_INVALID'): never {
  throw new ReconciliationOwnerRecordError(code);
}
function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ReconciliationOwnerRecordError) throw error;
    fail();
  }
}
function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function scalarString(value: string, maxLength: number): void {
  if (value.length > maxLength) fail('RECONCILIATION_OWNER_LIMIT_EXCEEDED');
  if (/[\uD800-\uDFFF]/u.test(value)) fail();
}
function copyJson(value: unknown): Json {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const charge = (count: number): void => {
    bytes += count;
    if (bytes > MAX_BYTES) fail('RECONCILIATION_OWNER_LIMIT_EXCEEDED');
  };
  const copy = (input: unknown, depth: number): Json => {
    if (++nodes > 16384 || depth > 32) fail('RECONCILIATION_OWNER_LIMIT_EXCEEDED');
    if (input === null || typeof input === 'boolean') {
      charge(input === null || input === true ? 4 : 5);
      return input;
    }
    if (typeof input === 'string') {
      scalarString(input, 262144);
      charge(Buffer.byteLength(JSON.stringify(input)));
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isSafeInteger(input) || Object.is(input, -0)) fail();
      charge(Buffer.byteLength(JSON.stringify(input)));
      return input;
    }
    if (typeof input !== 'object' || types.isProxy(input) || ancestors.has(input)) fail();
    const prototype: unknown = Object.getPrototypeOf(input);
    ancestors.add(input);
    if (Array.isArray(input)) {
      if (prototype !== Array.prototype && prototype !== null) fail();
      const length: unknown = Object.getOwnPropertyDescriptor(input, 'length')?.value;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) fail();
      if (length > 4096) fail('RECONCILIATION_OWNER_LIMIT_EXCEEDED');
      if (Reflect.ownKeys(input).length !== length + 1) fail();
      charge(2 + Math.max(0, length - 1));
      const result: Json[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) fail();
        result.push(copy(descriptor.value, depth + 1));
      }
      ancestors.delete(input);
      return result;
    }
    if (prototype !== null && prototype !== Object.prototype) fail();
    const keys = Reflect.ownKeys(input);
    if (keys.length > 128) fail('RECONCILIATION_OWNER_LIMIT_EXCEEDED');
    charge(2 + Math.max(0, keys.length - 1));
    const result = Object.create(null) as { [key: string]: Json };
    for (const key of keys) {
      if (typeof key !== 'string') fail();
      scalarString(key, 128);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) fail();
      charge(Buffer.byteLength(JSON.stringify(key)) + 1);
      result[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(input);
    return result;
  };
  return copy(value, 0);
}
function freezeData(value: Json): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
}
function keyBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/u.test(value))
    fail();
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    key.fill(0);
    fail();
  }
  return key;
}
function semantic(record: ReconciliationOwnerRecord): void {
  validateReconciliationClockObservation(record.clock);
  if (record.kind === 'issuer') {
    const key = keyBytes(record.private_key_base64);
    try {
      if (record.key_sha256 !== sha256(key)) fail();
    } finally {
      key.fill(0);
    }
    const context = {
      seed_plan_sha256: record.seed_plan_sha256,
      host_identity_sha256: record.host_identity_sha256,
      admission_anchor_sha256: sha256(canonicalJson(record.admission_anchor)),
      installation_bindings_sha256: sha256(canonicalJson(record.installation_bindings)),
      installed_at_head: record.installed_at_head,
    };
    if (record.provision_context_sha256 !== sha256(canonicalJson(context))) fail();
  }
  if (record.kind === 'approval') {
    if (
      record.scope.repository_id !== record.repository_id ||
      record.scope.worktree_id !== record.worktree_id ||
      record.scope_sha256 !== sha256(canonicalJson(record.scope))
    )
      fail();
  }
  if (record.kind === 'approval' || record.kind === 'renewal') {
    const expiresNs = BigInt(record.clock.monotonic_ns) + BigInt(record.validity_ms) * 1000000n;
    if (
      record.clock.wall_ms > Number.MAX_SAFE_INTEGER - record.validity_ms ||
      record.expires_wall_ms !== record.clock.wall_ms + record.validity_ms ||
      expiresNs > MAX_NS ||
      record.expires_monotonic_ns !== expiresNs.toString()
    )
      fail();
  }
  if (
    record.kind === 'renewal' &&
    record.remaining_phases.some((phase, index, phases) => {
      const previous = phases[index - 1];
      return previous !== undefined && phase <= previous;
    })
  )
    fail();
}

/** Shape and computable consistency only; not origin, live eligibility or authority. */
export function validateReconciliationOwnerRecord(value: unknown): ReconciliationOwnerRecord {
  return guarded(() => {
    const copy = copyJson(value);
    if (!getValidator('reconciliation-owner.schema.json')(copy)) fail();
    const record = copy as unknown as ReconciliationOwnerRecord;
    semantic(record);
    freezeData(copy);
    return record;
  });
}
function mac(record: ReconciliationOwnerRecord, key: Buffer): string {
  const unsigned = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(record)) if (name !== 'mac') unsigned[name] = value;
  return createHmac('sha256', key)
    .update(record.domain, 'utf8')
    .update(Buffer.from([0]))
    .update(canonicalJson(unsigned), 'utf8')
    .digest('hex');
}

/** Internal data signing helper, never an issuer-origin or mutation capability. */
export function signReconciliationOwnerRecord(
  unsigned: unknown,
  privateKeyBase64: string,
): ReconciliationOwnerRecord {
  return guarded(() => {
    const copy = copyJson(unsigned);
    if (
      copy === null ||
      typeof copy !== 'object' ||
      Array.isArray(copy) ||
      Object.hasOwn(copy, 'mac')
    )
      fail();
    const record = validateReconciliationOwnerRecord({ ...copy, mac: '0'.repeat(64) });
    const key = keyBytes(privateKeyBase64);
    try {
      if (record.kind === 'issuer' && record.private_key_base64 !== privateKeyBase64) fail();
      return validateReconciliationOwnerRecord({ ...record, mac: mac(record, key) });
    } finally {
      key.fill(0);
    }
  });
}

/** MAC equality only. Trusted key/namespace origin and fresh authority remain separate. */
export function verifyReconciliationOwnerRecord(
  value: unknown,
  privateKeyBase64: string,
): ReconciliationOwnerRecord {
  return guarded(() => {
    const record = validateReconciliationOwnerRecord(value);
    const key = keyBytes(privateKeyBase64);
    try {
      if (!timingSafeEqual(Buffer.from(record.mac, 'hex'), Buffer.from(mac(record, key), 'hex')))
        fail('RECONCILIATION_OWNER_MAC_INVALID');
      return record;
    } finally {
      key.fill(0);
    }
  });
}

/** Private signed-file encoding; callers may not serialize this as public output. */
export function encodeReconciliationOwnerRecord(value: unknown): Uint8Array {
  return guarded(() => {
    const record = validateReconciliationOwnerRecord(value);
    const bytes = Buffer.from(`${canonicalJson(record)}\n`, 'utf8');
    if (bytes.length > MAX_BYTES) fail('RECONCILIATION_OWNER_LIMIT_EXCEEDED');
    return bytes;
  });
}
function copyBytes(value: unknown): Uint8Array {
  if (
    types.isProxy(value) ||
    !types.isUint8Array(value) ||
    byteLengthGetter === undefined ||
    bufferGetter === undefined
  )
    fail('RECONCILIATION_OWNER_ENCODING_INVALID');
  try {
    const length: unknown = Reflect.apply(byteLengthGetter, value, []);
    const buffer: unknown = Reflect.apply(bufferGetter, value, []);
    if (types.isSharedArrayBuffer(buffer) || typeof length !== 'number' || length === 0)
      fail('RECONCILIATION_OWNER_ENCODING_INVALID');
    if (length > MAX_BYTES) fail('RECONCILIATION_OWNER_LIMIT_EXCEEDED');
    const copy = new Uint8Array(length);
    Reflect.apply(byteSet, copy, [value]);
    return copy;
  } catch (error) {
    if (error instanceof ReconciliationOwnerRecordError) throw error;
    fail('RECONCILIATION_OWNER_ENCODING_INVALID');
  }
}

/** Canonical bounded ingress. Parsing is not MAC or origin verification. */
export function decodeReconciliationOwnerRecord(bytes: Uint8Array): ReconciliationOwnerRecord {
  return guarded(() => {
    const copy = copyBytes(bytes);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(copy));
    } catch {
      fail('RECONCILIATION_OWNER_ENCODING_INVALID');
    }
    const record = validateReconciliationOwnerRecord(value);
    const canonical = encodeReconciliationOwnerRecord(record);
    if (!Buffer.from(copy).equals(Buffer.from(canonical)))
      fail('RECONCILIATION_OWNER_ENCODING_INVALID');
    return record;
  });
}

/** Closed safe projection, without private record bytes or an authority marker. */
export function summarizeReconciliationOwnerRecord(value: unknown): Readonly<{
  schemaVersion: '1.0.0';
  kind: 'reconciliation-owner-record-summary';
  record_kind: ReconciliationOwnerRecordKind;
  repository_id: string;
  worktree_id: string;
  record_sha256: string;
  size_bytes: number;
  approval_id: string | null;
  scope_sha256: string | null;
  grants_authority: false;
}> {
  return guarded(() => {
    const record = validateReconciliationOwnerRecord(value);
    const bytes = encodeReconciliationOwnerRecord(record);
    return Object.freeze({
      schemaVersion: '1.0.0',
      kind: 'reconciliation-owner-record-summary',
      record_kind: record.kind,
      repository_id: record.repository_id,
      worktree_id: record.worktree_id,
      record_sha256: sha256(bytes),
      size_bytes: bytes.length,
      approval_id: record.kind === 'issuer' ? null : record.approval_id,
      scope_sha256: record.kind === 'issuer' ? null : record.scope_sha256,
      grants_authority: false,
    });
  });
}
