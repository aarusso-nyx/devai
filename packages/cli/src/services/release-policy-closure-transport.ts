import { canonicalJson } from '@devai-nyx/utils';
import { canonicalContainerPath } from './container-archive.js';
import type { ReleaseGitObject } from './release-candidate-snapshot.js';
import type { ReleasePolicyClosure } from './release-policy-closure.js';

/** Host-owned data transport, not a trust statement or an executable bundle. */
export interface ReleasePolicyClosureTransportLimits {
  readonly maximum_transport_bytes: number;
  readonly maximum_decoded_bytes: number;
  readonly maximum_entries: number;
}

const FORMAT = 'devai.release-policy-closure-json.v1';
const INVALID = 'rpl-policy-resolution-mismatch';
function fail(): never {
  throw new Error(INVALID);
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail();
}
function budget(limits: ReleasePolicyClosureTransportLimits) {
  keys(object(limits), ['maximum_transport_bytes', 'maximum_decoded_bytes', 'maximum_entries']);
  if (
    Object.values(limits).length !== 3 ||
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)
  )
    return fail();
  let bytes = 0;
  let entries = 0;
  return (size: number): void => {
    bytes += size;
    entries += 1;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > limits.maximum_decoded_bytes ||
      entries > limits.maximum_entries
    )
      fail();
  };
}
function compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Encode copied raw bytes deterministically. Semantic authority is checked separately. */
export function encodeReleasePolicyClosure(
  closure: ReleasePolicyClosure,
  limits: ReleasePolicyClosureTransportLimits,
): Buffer {
  try {
    const account = budget(limits);
    if (closure.format !== 'devai.release-policy-closure.v1') return fail();
    keys(object(closure), ['format', 'plan', 'evidence']);
    keys(object(closure.evidence), [
      'archive',
      'candidate_objects',
      ...(closure.evidence.producer === undefined ? [] : ['producer']),
    ]);
    const data = (bytes: Uint8Array): string => {
      if (!(bytes instanceof Uint8Array)) return fail();
      account(bytes.byteLength);
      return Buffer.from(bytes).toString('base64');
    };
    const objects = (values: ReadonlyMap<string, ReleaseGitObject>) => {
      if (!(values instanceof Map)) return fail();
      return [...values]
        .sort(([a], [b]) => compare(a, b))
        .map(([id, value]) => {
          if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(id)) return fail();
          keys(object(value), ['type', 'bytes']);
          if (!['commit', 'tree', 'blob'].includes(value.type)) return fail();
          return { id, type: value.type, data: data(value.bytes) };
        });
    };
    const producer = closure.evidence.producer;
    if (producer !== undefined) {
      keys(object(producer), ['files', 'source_objects', 'build_provenance']);
      if (!(producer.files instanceof Map)) return fail();
    }
    const wire = {
      format: FORMAT,
      plan: object(closure.plan),
      archive: data(closure.evidence.archive),
      candidate_objects: objects(closure.evidence.candidate_objects),
      ...(producer === undefined
        ? {}
        : {
            producer: {
              files: [...producer.files]
                .sort(([a], [b]) => compare(a, b))
                .map(([path, bytes]) => {
                  if (!canonicalContainerPath(path) || /^[A-Za-z]:/u.test(path)) return fail();
                  return { path, data: data(bytes) };
                }),
              source_objects: objects(producer.source_objects),
              build_provenance: data(producer.build_provenance),
            },
          }),
    };
    const bytes = Buffer.from(canonicalJson(wire));
    if (bytes.byteLength > limits.maximum_transport_bytes) return fail();
    return bytes;
  } catch {
    return fail();
  }
}

/**
 * Decode bounded canonical data only. Never load its package code or trust claims.
 * The caller must run verifyReleasePolicyClosure with external expected identities
 * and its genuine checked implementation before using any returned evidence.
 */
export function decodeReleasePolicyClosure(
  bytes: Uint8Array,
  limits: ReleasePolicyClosureTransportLimits,
): ReleasePolicyClosure {
  try {
    const account = budget(limits);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > limits.maximum_transport_bytes)
      return fail();
    const captured = Buffer.from(bytes);
    const wire = object(JSON.parse(captured.toString('utf8')) as unknown);
    // Also rejects duplicate JSON members, invalid UTF-8 and alternate encodings.
    if (!captured.equals(Buffer.from(canonicalJson(wire)))) return fail();
    keys(wire, [
      'format',
      'plan',
      'archive',
      'candidate_objects',
      ...('producer' in wire ? ['producer'] : []),
    ]);
    if (wire['format'] !== FORMAT) return fail();
    const data = (value: unknown): Buffer => {
      if (typeof value !== 'string' || value.length % 4 !== 0) return fail();
      const size =
        (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
      account(size);
      const decoded = Buffer.from(value, 'base64');
      if (decoded.toString('base64') !== value) return fail();
      return decoded;
    };
    const list = (value: unknown): readonly unknown[] => {
      if (!Array.isArray(value) || value.length > limits.maximum_entries) return fail();
      return value;
    };
    const objects = (value: unknown): ReadonlyMap<string, ReleaseGitObject> => {
      const result = new Map<string, ReleaseGitObject>();
      let previous: string | undefined;
      for (const item of list(value)) {
        const entry = object(item);
        keys(entry, ['id', 'type', 'data']);
        const id = entry['id'];
        const type = entry['type'];
        if (
          typeof id !== 'string' ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(id) ||
          (previous !== undefined && compare(previous, id) >= 0) ||
          (type !== 'commit' && type !== 'tree' && type !== 'blob')
        )
          return fail();
        result.set(id, { type, bytes: data(entry['data']) });
        previous = id;
      }
      return result;
    };
    const archive = data(wire['archive']);
    const candidateObjects = objects(wire['candidate_objects']);
    const producer = wire['producer'] === undefined ? undefined : object(wire['producer']);
    let producerEvidence: NonNullable<ReleasePolicyClosure['evidence']['producer']> | undefined;
    if (producer !== undefined) {
      keys(producer, ['files', 'source_objects', 'build_provenance']);
      const files = new Map<string, Uint8Array>();
      let previous: string | undefined;
      for (const item of list(producer['files'])) {
        const entry = object(item);
        keys(entry, ['path', 'data']);
        const path = entry['path'];
        if (
          typeof path !== 'string' ||
          !canonicalContainerPath(path) ||
          /^[A-Za-z]:/u.test(path) ||
          (previous !== undefined && compare(previous, path) >= 0)
        )
          return fail();
        files.set(path, data(entry['data']));
        previous = path;
      }
      producerEvidence = {
        files,
        source_objects: objects(producer['source_objects']),
        build_provenance: data(producer['build_provenance']),
      };
    }
    return {
      format: 'devai.release-policy-closure.v1',
      plan: object(wire['plan']),
      evidence: {
        archive,
        candidate_objects: candidateObjects,
        ...(producerEvidence === undefined ? {} : { producer: producerEvidence }),
      },
    };
  } catch {
    return fail();
  }
}
