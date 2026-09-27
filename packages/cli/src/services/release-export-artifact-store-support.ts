import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
import type { OpaqueArtifactIdentity } from './release-lifecycle-execution.js';
import type { ReleaseExportArtifactObjectReceipt } from './release-export-artifact-store-types.js';

const INVALID = 'release-export-artifact-sink-protocol-invalid';
export const COMMIT_UNKNOWN = 'release-export-artifact-sink-commit-unknown';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const HANDLE = new RegExp(`^(${UUID}):(${UUID}):([0-9a-f]{64})$`, 'u');

export function fail(): never {
  throw new Error(INVALID);
}
export function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function bytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}
export function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
export function closed(value: unknown, keys: readonly string[]): void {
  const record = object(value);
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(record) as object | null) ||
    Reflect.ownKeys(record).length !== keys.length
  )
    fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
  }
}
export function copy<T>(value: T): T {
  // Reject accessors/hidden members before canonicalization; controls cannot mutate while awaiting a reader.
  const inspect = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (
        Object.getPrototypeOf(node) !== Array.prototype ||
        Reflect.ownKeys(node).length !== node.length + 1
      )
        fail();
      for (let i = 0; i < node.length; i += 1) {
        const entry = Object.getOwnPropertyDescriptor(node, String(i));
        if (!entry?.enumerable || !('value' in entry)) fail();
        inspect(entry.value);
      }
    } else if (node !== null && typeof node === 'object') {
      closed(node, Object.keys(node));
      for (const entry of Object.values(node)) inspect(entry);
    } else if (
      !['string', 'boolean'].includes(typeof node) &&
      node !== null &&
      !(typeof node === 'number' && Number.isFinite(node))
    )
      fail();
  };
  inspect(value);
  return JSON.parse(bytes(value).toString('utf8')) as T;
}
export function parse<T>(value: Buffer): T {
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as T;
  if (!value.equals(bytes(parsed))) fail();
  return parsed;
}
function failure(error: unknown): never {
  if (
    error instanceof Error &&
    (/^AUTHORITY_[A-Z0-9_]+$/u.test(error.message) ||
      /^release-export-capacity-(?:unavailable|insufficient)$/u.test(error.message) ||
      error.message === COMMIT_UNKNOWN)
  )
    throw error;
  return fail();
}
export async function guarded<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return failure(error);
  }
}
export function order<T extends OpaqueArtifactIdentity>(artifacts: readonly T[]): T[] {
  const key = (a: OpaqueArtifactIdentity) =>
    Buffer.from(`${a.kind}\0${a.sink_id}\0${a.opaque_handle}\0${a.sha256}\0${a.size_bytes}`);
  return [...artifacts].sort((a, b) => Buffer.compare(key(a), key(b)));
}
export function identity(receipt: ReleaseExportArtifactObjectReceipt): OpaqueArtifactIdentity {
  if (receipt.kind === 'committed-manifest') return fail();
  return {
    kind: receipt.kind,
    sink_id: receipt.sink_id,
    opaque_handle: receipt.opaque_handle,
    sha256: receipt.sha256,
    size_bytes: receipt.size_bytes,
  };
}
