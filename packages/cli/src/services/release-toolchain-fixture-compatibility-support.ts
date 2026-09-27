import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
import type { ReleaseCandidateSnapshot } from './release-candidate-snapshot.js';
import type { VerifiedReleasePolicyResolution } from './release-policy-resolution.js';
import type { ContainerArchiveEntry } from './container-archive.js';
import type { ReleaseLifecycleRequest } from './release-lifecycle-execution.js';

export type Json = Readonly<Record<string, unknown>>;
const INVALID = 'release-toolchain-fixture-compatibility-invalid';
export const NODE = 'diagnostic:mutation-toolchain';
export const WORKSPACE = 'packages/fixture';
export const RAW = `${WORKSPACE}/reports/mutation/raw.json`;
export const COMPATIBILITY = `${WORKSPACE}/reports/mutation/compatibility.json`;
export const OUTPUTS = [COMPATIBILITY, RAW];
export const DYNAMIC_PATHS = [
  '.devai/config/adopter-policy-binding.json',
  '.devai/config/domains.json',
  '.devai/config/glob-guards.json',
  '.devai/config/project.json',
  '.devai/config/release-verification.json',
  '.devai/config/scorecard-na.json',
  '.devai/config/thresholds.json',
  '.devai/constitution.md',
  '.devai/pin/constitution.md',
  'host/devai.tgz',
  'pnpm-lock.yaml',
];
export const VERSIONS = {
  node: 'v24.20.0',
  pnpm: '9.15.0',
  vitest: '4.1.10',
  typescript: '5.9.3',
};
const RUNTIME_KEYS = [
  'protocol',
  'image',
  'engine_version',
  'node_version',
  'docker_binary_sha256',
  'executables',
  'network',
  'rootfs',
  'capabilities',
  'privilege_escalation',
  'pids_limit',
  'memory_bytes',
  'cpus',
];

/** Opaque host construction control, not a candidate document or execution grant. */
export interface ProtectedToolchainFixtureContext {
  readonly __fixture_context?: never;
}
/** Process-local compatibility only. Deliberately no receipt, read method, or reusable data. */
export interface ProtectedToolchainFixtureCompatibility {
  readonly __fixture_compatibility?: never;
}
export interface ContextData {
  identity: Json;
  readonly candidate: ReleaseCandidateSnapshot;
  readonly source: readonly ContainerArchiveEntry[];
  readonly descriptor: Json;
  readonly fixture_resolution: VerifiedReleasePolicyResolution;
  readonly production_resolution: VerifiedReleasePolicyResolution;
  readonly container: Json;
  readonly runtime: Json;
  readonly toolchain: Json;
  readonly template: Json;
  readonly subject: Buffer;
  readonly zero: Buffer;
  bound: boolean;
  attempted: boolean;
  observed: boolean;
  attached: boolean;
  request?: ReleaseLifecycleRequest;
  binding?: Json;
}
export const contexts = new WeakMap<object, ContextData>();
export const custodyContexts = new WeakMap<object, ContextData>();
export const attachedCustodies = new WeakSet<object>();
export const compatibilities = new WeakMap<object, ContextData>();
export function fail(): never {
  throw new Error(INVALID);
}
export function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : fail();
}
export function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
export function copy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
export function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
export function json(bytes: Buffer, maximum = 1024 * 1024): Json {
  if (bytes.length === 0 || bytes.length > maximum) fail();
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
export function opaque(): object {
  return Object.freeze(
    Object.defineProperty(Object.create(null) as object, 'toJSON', { value: fail }),
  );
}
export function runtime(container: Json): Json {
  const expected = [...RUNTIME_KEYS, 'dependencies', 'dependency_transport_sha256'];
  if (Object.hasOwn(container, 'local_image')) expected.push('local_image');
  if (!same(Object.keys(container).sort(), expected.sort())) fail();
  return copy(
    Object.fromEntries(
      Object.entries(container).filter(
        ([key]) => key !== 'dependencies' && key !== 'dependency_transport_sha256',
      ),
    ),
  );
}

/** Recover mode/object IDs only from an already verified complete Git tree proof. */
export function sourceCensus(candidate: ReleaseCandidateSnapshot) {
  const proof = candidate.readProof([]),
    width = candidate.repository.commit.length / 2;
  const pending = [{ id: candidate.repository.tree, prefix: '' }];
  const result: { path: string; mode: string; object_id: string; size: number; sha256: string }[] =
    [];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];
    if (!current) return fail();
    const tree = proof.get(current.id);
    if (tree?.type !== 'tree') return fail();
    const bytes = Buffer.from(tree.bytes);
    for (let offset = 0; offset < bytes.length;) {
      const space = bytes.indexOf(32, offset),
        nul = bytes.indexOf(0, space + 1);
      if (space <= offset || nul <= space + 1 || nul + 1 + width > bytes.length) fail();
      const mode = bytes.subarray(offset, space).toString('ascii');
      const path = current.prefix + bytes.subarray(space + 1, nul).toString('utf8');
      const id = bytes.subarray(nul + 1, nul + 1 + width).toString('hex');
      offset = nul + 1 + width;
      if (mode === '40000') pending.push({ id, prefix: path + '/' });
      else {
        if (mode !== '100644') fail();
        const content = candidate.read(path);
        result.push({ path, mode, object_id: id, size: content.length, sha256: hash(content) });
      }
    }
  }
  return result.sort((a, b) => compare(a.path, b.path));
}
