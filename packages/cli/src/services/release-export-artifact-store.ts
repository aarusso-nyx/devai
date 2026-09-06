import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import {
  createProtectedExportSinkAdapter,
  readProtectedReleaseExportCapacity,
  createProtectedReleaseSinkOwner,
} from '@devai-nyx/authority';
import { createReleaseArtifactStore } from './release-artifact-store.js';
import {
  createDurableReleaseContentStore,
  type DurableReleaseContentStoreOptions,
} from './release-content-store.js';
import {
  verifyReleaseStateIdentity,
  type ArtifactSinkCommitIdentity,
  type OpaqueArtifactIdentity,
  type ReleaseLifecycleStateV2,
  type TrustedArtifactReader,
} from './release-lifecycle-execution.js';
import {
  RELEASE_PACK_SPEC_DIGEST,
  verifyPreparedPackageManifest,
  reverifySinkArtifacts,
  type ArtifactSinkCommitReceipt,
} from './release-prepare-kernel.js';
import { assertBoundReleaseHostPackageSnapshot } from './release-host-package-binding.js';
import type { ReleasePackageIdentity, ReleasePackageSnapshot } from './release-package-snapshot.js';
import {
  verifyReleasePolicyClosure,
  type ReleasePolicyClosureLimits,
} from './release-policy-closure.js';
import {
  decodeReleasePolicyClosure,
  type ReleasePolicyClosureTransportLimits,
} from './release-policy-closure-transport.js';
import type { ReleasePolicyExpectedIdentity } from './release-policy-resolution.js';
import {
  RELEASE_EXPORT_SPEC_ID,
  RELEASE_EXPORT_SPEC_DIGEST,
  encodeReleaseExportTranscript,
  verifyReleaseExportProviderResult,
  type ReleaseExportProviderResult,
  type ReleaseExportTranscript,
  type ReleaseExportTranscriptBinding,
  type ReleaseExportTranscriptLimits,
} from './release-export-transcript.js';
import {
  RELEASE_EXPORT_SPEC_V3_ID,
  RELEASE_EXPORT_SPEC_V3_DIGEST,
  RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
  encodeReleaseExportTranscriptV2,
  verifyReleaseExportProviderResultV2,
  verifyReleaseExportProviderResultSetV2,
} from './release-export-transcript-v2.js';
import {
  readReleaseExportMutationEvidence,
  reverifyReleaseExportMutationEvidence,
  type ReleaseExportMutationEvidence,
} from './release-export-mutation-evidence.js';
import type { ReleaseExportMutationUnitProjection } from './release-export-mutation-contract.js';
import {
  readReleaseExportCertificationEvidence,
  reverifyReleaseExportCertificationEvidence,
  type ReleaseExportCertificationEvidence,
  type ReleaseExportCertificationUnitProjection,
} from './release-export-certification-evidence.js';
import {
  encodeReleaseExportTranscriptV3,
  RELEASE_EXPORT_SPEC_V4_DIGEST,
  RELEASE_EXPORT_SPEC_V4_ID,
  RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT,
} from './release-export-transcript-v3.js';

export { RELEASE_EXPORT_SPEC_ID, RELEASE_EXPORT_SPEC_DIGEST } from './release-export-transcript.js';
const INVALID = 'release-export-artifact-sink-protocol-invalid';
const COMMIT_UNKNOWN = 'release-export-artifact-sink-commit-unknown';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const HANDLE = new RegExp(`^(${UUID}):(${UUID}):([0-9a-f]{64})$`, 'u');
type ExportKind = 'evidence-manifest' | 'provider-result';
type ReadInput = Parameters<TrustedArtifactReader['readArtifact']>[0];

/** Portable host data contract. The private authority adapter independently validates it. */
export interface LegacyProtectedReleaseExportBinding extends ReleaseExportTranscriptBinding {
  readonly export_spec_digest_sha256: string;
  readonly closure_inputs: readonly {
    readonly package_id: string;
    readonly sha256: string;
    readonly size_bytes: number;
    readonly expected_installed_package: ReleasePackageIdentity;
    readonly policy_resolution_digest_sha256: string;
  }[];
}
/**
 * Portable copy of the sealed mutation projection contract.  The authority package
 * independently validates this value at the runtime boundary; keeping the public
 * declaration structural prevents the private workspace package from leaking into
 * the installed CLI's declaration closure.
 */
export interface ProtectedReleaseExportBindingV3 extends Omit<
  LegacyProtectedReleaseExportBinding,
  'closure_inputs'
> {
  readonly closure_inputs: readonly (LegacyProtectedReleaseExportBinding['closure_inputs'][number] & {
    readonly release_unit: string;
  })[];
  readonly mutation_units: readonly ReleaseExportMutationUnitProjection[];
}
export interface ProtectedReleaseExportBindingV4 extends ProtectedReleaseExportBindingV3 {
  readonly certification_units: readonly ReleaseExportCertificationUnitProjection[];
}
export type ProtectedReleaseExportBinding =
  | LegacyProtectedReleaseExportBinding
  | ProtectedReleaseExportBindingV3
  | ProtectedReleaseExportBindingV4;

export interface ReleaseExportArtifactObjectReceipt {
  readonly sink_id: string;
  readonly transaction_handle: string;
  readonly opaque_handle: string;
  readonly kind: ExportKind | 'committed-manifest';
  readonly package_id: string | null;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly export_spec_id:
    | typeof RELEASE_EXPORT_SPEC_ID
    | typeof RELEASE_EXPORT_SPEC_V3_ID
    | typeof RELEASE_EXPORT_SPEC_V4_ID;
  readonly export_spec_digest_sha256: string;
}

export type ReleaseExportArtifactObject = {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly size_bytes: number;
} & (
  | { readonly kind: ExportKind; readonly package_id: string }
  | { readonly kind: 'committed-manifest'; readonly package_id: null }
);

export interface ReleaseExportArtifactCommitManifest {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'release-artifact-sink-commit-manifest';
  readonly sink_id: string;
  readonly transaction_handle: string;
  readonly repository: ProtectedReleaseExportBinding['repository'];
  readonly candidate: ProtectedReleaseExportBinding['candidate'];
  readonly export_spec_id:
    | typeof RELEASE_EXPORT_SPEC_ID
    | typeof RELEASE_EXPORT_SPEC_V3_ID
    | typeof RELEASE_EXPORT_SPEC_V4_ID;
  readonly export_spec_digest_sha256: string;
  readonly parent_artifact_sink: ArtifactSinkCommitIdentity;
  readonly binding: ProtectedReleaseExportBinding;
  readonly artifacts: readonly OpaqueArtifactIdentity[];
}

export interface TrustedExportArtifactSinkTransaction extends TrustedArtifactReader {
  readonly sink_id: string;
  readonly transaction_handle: string;
  readonly put: (input: ReleaseExportArtifactObject) => Promise<ReleaseExportArtifactObjectReceipt>;
  /** The sole canonical signing preimage. No signing or trust assertion occurs here. */
  readonly readTranscript: () => Promise<Buffer>;
  /** Call immediately before external signer dispatch. This permanently disables abort. */
  readonly markSigningStarted: () => Promise<Buffer>;
  readonly readCommitManifest: () => Promise<Buffer>;
  readonly commit: (
    manifest: ReleaseExportArtifactObjectReceipt,
  ) => Promise<ArtifactSinkCommitReceipt>;
  readonly abort: () => Promise<void>;
  /** Pure terminalization for unknown outcomes; retains every allocated handle and all disk evidence. */
  readonly preserve: () => readonly ReleaseExportArtifactObjectReceipt[];
}

export interface TrustedExportArtifactSink extends TrustedArtifactReader {
  readonly begin: () => Promise<TrustedExportArtifactSinkTransaction>;
}

/** All controls are externally selected before candidate input; there is no default root or signer. */
export interface ReleaseExportArtifactStoreOptions extends DurableReleaseContentStoreOptions {
  readonly binding: ProtectedReleaseExportBinding;
  readonly prepared_state: ReleaseLifecycleStateV2;
  readonly parent_reader: TrustedArtifactReader;
  readonly implementation: ReleasePackageSnapshot;
  readonly closures: readonly {
    readonly package_id: string;
    readonly bytes: Buffer;
    readonly expected: ReleasePolicyExpectedIdentity;
  }[];
  readonly closure_limits: ReleasePolicyClosureLimits;
  readonly transport_limits: ReleasePolicyClosureTransportLimits;
  readonly transcript_limits: ReleaseExportTranscriptLimits;
  /** Required only in the exact forward v3 branch; legacy export rejects it. */
  readonly mutation_evidence?: ReleaseExportMutationEvidence;
  /** Required only in the exact forward v4 branch; earlier branches reject it. */
  readonly certification_evidence?: ReleaseExportCertificationEvidence;
}

function fail(): never {
  throw new Error(INVALID);
}
function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function bytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function closed(value: unknown, keys: readonly string[]): void {
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
function copy<T>(value: T): T {
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
function parse<T>(value: Buffer): T {
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
async function guarded<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return failure(error);
  }
}
function order<T extends OpaqueArtifactIdentity>(artifacts: readonly T[]): T[] {
  const key = (a: OpaqueArtifactIdentity) =>
    Buffer.from(`${a.kind}\0${a.sink_id}\0${a.opaque_handle}\0${a.sha256}\0${a.size_bytes}`);
  return [...artifacts].sort((a, b) => Buffer.compare(key(a), key(b)));
}
function identity(receipt: ReleaseExportArtifactObjectReceipt): OpaqueArtifactIdentity {
  if (receipt.kind === 'committed-manifest') return fail();
  return {
    kind: receipt.kind,
    sink_id: receipt.sink_id,
    opaque_handle: receipt.opaque_handle,
    sha256: receipt.sha256,
    size_bytes: receipt.size_bytes,
  };
}

/**
 * A dedicated append-only extension, not a reopened prepare transaction. Construction and every
 * begin reverify immutable parent/closure inputs without writing. The enclosing provider/broker
 * supplies the live bounded account and verifies the single external signature. This store checks
 * 2*N+34 against that account after full roster/parent verification and before begin; it never
 * accepts a self-asserted capacity number or performs signing. No public read credits an
 * uncommitted export. Pending transaction reads are explicitly separate from that committed reader.
 */
export async function createReleaseExportArtifactStore(
  options: ReleaseExportArtifactStoreOptions,
): Promise<TrustedExportArtifactSink> {
  return guarded(async () => {
    const binding = copy(options.binding);
    const forward = binding.export_spec_digest_sha256 === RELEASE_EXPORT_SPEC_V4_DIGEST;
    const current = forward || binding.export_spec_digest_sha256 === RELEASE_EXPORT_SPEC_V3_DIGEST;
    closed(options, [
      'root',
      'sink_id',
      'repository_roots',
      'max_blob_bytes',
      'binding',
      'prepared_state',
      'parent_reader',
      'implementation',
      'closures',
      'closure_limits',
      'transport_limits',
      'transcript_limits',
      ...(current ? ['mutation_evidence'] : []),
      ...(forward ? ['certification_evidence'] : []),
    ]);
    assertBoundReleaseHostPackageSnapshot(options.implementation);
    const implementation = options.implementation;
    const adapter = createProtectedExportSinkAdapter(binding);
    const specId = forward
      ? RELEASE_EXPORT_SPEC_V4_ID
      : current
        ? RELEASE_EXPORT_SPEC_V3_ID
        : RELEASE_EXPORT_SPEC_ID;
    const specDigest = forward
      ? RELEASE_EXPORT_SPEC_V4_DIGEST
      : current
        ? RELEASE_EXPORT_SPEC_V3_DIGEST
        : RELEASE_EXPORT_SPEC_DIGEST;
    const mutationEvidence = current ? (options.mutation_evidence ?? fail()) : undefined;
    const certificationEvidence = forward ? (options.certification_evidence ?? fail()) : undefined;
    const physical = copy({
      root: options.root,
      sink_id: options.sink_id,
      repository_roots: options.repository_roots,
      max_blob_bytes: options.max_blob_bytes,
    });
    const state = verifyReleaseStateIdentity(copy(options.prepared_state));
    const limits = copy(options.closure_limits);
    closed(limits, [
      'maximum_archive_bytes',
      'maximum_unpacked_bytes',
      'maximum_git_bytes',
      'maximum_git_entries',
    ]);
    if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) fail();
    const transport = copy(options.transport_limits);
    const transcriptLimits = copy(options.transcript_limits);
    closed(transcriptLimits, [
      'maximum_transcript_bytes',
      'maximum_provider_result_bytes',
      'maximum_packages',
    ]);
    if (
      Object.values(transcriptLimits).some(
        (value) => !Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff,
      )
    )
      fail();
    const effectiveTranscriptLimits = {
      ...transcriptLimits,
      maximum_provider_result_bytes: Math.min(
        transcriptLimits.maximum_provider_result_bytes,
        physical.max_blob_bytes,
      ),
    };
    const readParent = options.parent_reader.readArtifact.bind(options.parent_reader);
    if (
      state.schemaVersion !== '2.1.0' ||
      state.state !== 'prepared' ||
      state.action_id !== 'release prepare' ||
      !same(state.repository, binding.repository) ||
      !same({ commit: state.candidate.commit, tree: state.candidate.tree }, binding.candidate) ||
      !same(state.artifact_sink, binding.parent_artifact_sink) ||
      physical.sink_id !== binding.sink_id ||
      binding.export_spec_digest_sha256 !== specDigest
    )
      fail();
    const plans = state['bound_receipts'];
    if (!Array.isArray(plans)) fail();
    const boundPlans = plans.filter(
      (entry: unknown) => object(entry)['kind'] === 'release-plan-receipt',
    );
    if (
      boundPlans.length !== 1 ||
      !same(boundPlans[0], {
        kind: 'release-plan-receipt',
        receipt_id: `RPL-${binding.plan_receipt_digest_sha256.slice(0, 16)}`,
        receipt_digest_sha256: binding.plan_receipt_digest_sha256,
        verdict: 'pass',
      })
    )
      fail();
    const packages = state.release_units
      .flatMap((unit) =>
        unit.packages.map((pkg) => ({
          unit: unit.release_unit,
          version: unit.version,
          pkg,
        })),
      )
      .sort((a, b) => Buffer.compare(Buffer.from(a.pkg.package_id), Buffer.from(b.pkg.package_id)));
    if (
      packages.length === 0 ||
      packages.length > transcriptLimits.maximum_packages ||
      new Set(packages.map(({ pkg }) => pkg.package_id)).size !== packages.length
    )
      fail();
    const parent: OpaqueArtifactIdentity[] = [];
    for (const { pkg } of packages) {
      if (pkg.evidence_manifest !== null || pkg.provider_result !== null || pkg.trust !== null)
        fail();
      for (const [kind, entry] of [
        ['package-manifest', pkg.package_manifest],
        ['package-tarball', pkg.package_tarball],
        ['package-sbom', pkg.package_sbom],
      ] as const) {
        if (entry == null || entry.kind !== kind || entry.sink_id !== binding.sink_id) fail();
        parent.push(entry);
      }
    }
    const parents = order(parent);
    if (
      new Set(parents.map((entry) => entry.opaque_handle)).size !== parents.length ||
      !same(state['artifacts'], parents)
    )
      fail();
    const parentIdentities = new Map(parents.map((entry) => [entry.opaque_handle, entry]));
    const owner = createProtectedReleaseSinkOwner('export', binding.sink_id);
    const store = createDurableReleaseContentStore(physical, fail, owner);
    // This independently checks durable prepare commit/receipt membership. Its mutation methods
    // are deliberately not retained or invoked: only the dedicated export adapter writes below.
    const committedParentReader = createReleaseArtifactStore({
      ...physical,
      binding: {
        action_id: 'release prepare',
        repository: binding.repository,
        plan_receipt_digest_sha256: binding.plan_receipt_digest_sha256,
        pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
        sink_id: binding.sink_id,
      },
    }).readArtifact;
    const checkedParentReader: TrustedArtifactReader = {
      async readArtifact(input) {
        const expected =
          input.opaque_handle === binding.parent_artifact_sink.committed_manifest_handle
            ? {
                sha256: binding.parent_artifact_sink.committed_manifest_sha256,
                size_bytes: binding.parent_artifact_sink.committed_manifest_size_bytes,
              }
            : parentIdentities.get(input.opaque_handle);
        if (input.sink_id !== binding.sink_id || expected === undefined) fail();
        const suppliedValue = await readParent(copy(input));
        const committedValue = await committedParentReader(copy(input));
        if (!Buffer.isBuffer(suppliedValue) || !Buffer.isBuffer(committedValue)) fail();
        const supplied = Buffer.from(suppliedValue);
        const committed = Buffer.from(committedValue);
        if (
          !supplied.equals(committed) ||
          supplied.length !== expected.size_bytes ||
          hash(supplied) !== expected.sha256
        )
          fail();
        return supplied;
      },
    };
    const verifyMutation = async () => {
      if (mutationEvidence === undefined) {
        // Historical bytes are readable, but never silently discard required current evidence.
        if (state.release_units.some((unit) => unit.mutation_evidence != null)) fail();
        return;
      }
      const snapshot = readReleaseExportMutationEvidence(mutationEvidence, {
        repository: binding.repository,
        plan_receipt_digest_sha256: binding.plan_receipt_digest_sha256,
        release_units: state.release_units,
        inputs: state[
          'inputs'
        ] as import('./release-lifecycle-execution.js').ReleaseStateMaterial['inputs'],
      });
      if (!('mutation_units' in binding) || !same(snapshot.mutation_units, binding.mutation_units))
        fail();
      await reverifyReleaseExportMutationEvidence(mutationEvidence);
      if (certificationEvidence === undefined) return;
      const certification = readReleaseExportCertificationEvidence(certificationEvidence, {
        repository: binding.repository,
        release_units: state.release_units,
      });
      if (
        !('certification_units' in binding) ||
        !same(certification.certification_units, binding.certification_units)
      )
        fail();
      await reverifyReleaseExportCertificationEvidence(certificationEvidence);
    };
    const verifyParent = async (withMutation = true) => {
      if (withMutation) await verifyMutation();
      await reverifySinkArtifacts(state, checkedParentReader);
      for (const { pkg, version } of packages) {
        const manifestIdentity = pkg.package_manifest;
        if (manifestIdentity == null) fail();
        verifyPreparedPackageManifest({
          bytes: await checkedParentReader.readArtifact({
            sink_id: manifestIdentity.sink_id,
            opaque_handle: manifestIdentity.opaque_handle,
          }),
          package: pkg,
          version,
          candidate: binding.candidate,
        });
      }
      store.checkRoot();
    };
    if (
      !Array.isArray(options.closures) ||
      Object.getPrototypeOf(options.closures) !== Array.prototype ||
      options.closures.length !== packages.length ||
      Reflect.ownKeys(options.closures).length !== options.closures.length + 1
    )
      fail();
    for (let i = 0; i < options.closures.length; i += 1) {
      const entry = Object.getOwnPropertyDescriptor(options.closures, String(i));
      if (!entry?.enumerable || !('value' in entry)) fail();
    }
    const closures = options.closures.map((entry, index) => {
      closed(entry, ['package_id', 'bytes', 'expected']);
      if (
        !Buffer.isBuffer(entry.bytes) ||
        entry.bytes.length > store.limit ||
        entry.package_id !== packages[index]?.pkg.package_id
      )
        fail();
      return {
        package_id: entry.package_id,
        bytes: Buffer.from(entry.bytes),
        expected: copy(entry.expected),
      };
    });
    const verifyClosures = () => {
      const observed = closures.map((entry, index) => {
        if (
          !same(entry.expected.repository, binding.repository) ||
          entry.expected.release_unit !== packages[index]?.unit
        )
          fail();
        const closure = decodeReleasePolicyClosure(entry.bytes, transport);
        const resolution = verifyReleasePolicyClosure({
          closure,
          expected: entry.expected,
          implementation,
          limits,
        });
        if (closure.plan['receipt_digest_sha256'] !== binding.plan_receipt_digest_sha256) fail();
        if (!current && object(closure.plan['determination'])['mutation'] !== 'none') fail();
        const policy = object(resolution.readInput('release-lifecycle-policy'));
        const execution = object(policy['execution_contract']);
        const prepare = object(execution['prepare_kernel']);
        const extension = object(prepare['export_extension']);
        const spec = object(extension['artifact_spec']);
        if (
          spec['artifact_spec_id'] !== specId ||
          spec['artifact_spec_digest_sha256'] !== specDigest ||
          typeof spec['artifact_spec_canonical_bytes'] !== 'string' ||
          hash(Buffer.from(spec['artifact_spec_canonical_bytes'])) !== specDigest
        )
          fail();
        return {
          package_id: entry.package_id,
          ...(current ? { release_unit: entry.expected.release_unit } : {}),
          sha256: hash(entry.bytes),
          size_bytes: entry.bytes.length,
          expected_installed_package: entry.expected.installed_package,
          policy_resolution_digest_sha256: hash(bytes(resolution.resolution)),
        };
      });
      if (!same(observed, binding.closure_inputs)) fail();
    };
    verifyClosures();
    await verifyParent();

    const split = (handle: string) => {
      const match = typeof handle === 'string' ? HANDLE.exec(handle) : null;
      const transaction = match?.[1],
        id = match?.[2],
        sha256 = match?.[3];
      if (transaction === undefined || id === undefined || sha256 === undefined) return fail();
      return { transaction, id, sha256 };
    };
    const directoryFor = (transaction: string) => join(store.root, 'exports', transaction);
    // The attempt alone keys the reservation: changing destination, trust or closure cannot reopen it.
    const reservationPath = join(store.root, 'exports', 'attempts', `${binding.attempt_id}.json`);
    const receiptFor = (handle: string): ReleaseExportArtifactObjectReceipt => {
      const parts = split(handle);
      const receipt = parse<ReleaseExportArtifactObjectReceipt>(
        store.read(join(directoryFor(parts.transaction), 'receipts', `${parts.id}.json`)),
      );
      if (
        !same(receipt, {
          sink_id: binding.sink_id,
          transaction_handle: parts.transaction,
          opaque_handle: handle,
          kind: receipt.kind,
          package_id: receipt.package_id,
          sha256: parts.sha256,
          size_bytes: receipt.size_bytes,
          export_spec_id: specId,
          export_spec_digest_sha256: specDigest,
        }) ||
        !Number.isSafeInteger(receipt.size_bytes) ||
        receipt.size_bytes < 1 ||
        (receipt.kind === 'committed-manifest'
          ? receipt.package_id !== null
          : !['evidence-manifest', 'provider-result'].includes(receipt.kind) ||
            !packages.some(({ pkg }) => pkg.package_id === receipt.package_id))
      )
        fail();
      return receipt;
    };
    const readObject = (receipt: ReleaseExportArtifactObjectReceipt): Buffer => {
      const value = store.read(store.objectPath(receipt.sha256));
      if (value.length !== receipt.size_bytes || hash(value) !== receipt.sha256) fail();
      return value;
    };
    const transcriptFor = (receipts: readonly ReleaseExportArtifactObjectReceipt[]): Buffer => {
      const transcript: ReleaseExportTranscript = {
        version: 'devai.release-export-transcript-json.v1',
        binding: {
          action_id: binding.action_id,
          repository: binding.repository,
          candidate: binding.candidate,
          plan_receipt_digest_sha256: binding.plan_receipt_digest_sha256,
          parent_artifact_sink: binding.parent_artifact_sink,
          sink_id: binding.sink_id,
          destination: binding.destination,
          trust: binding.trust,
          attempt_id: binding.attempt_id,
        },
        parent: parents,
        closures: binding.closure_inputs.map((entry) => {
          const matches = receipts.filter(
            (r) => r.kind === 'evidence-manifest' && r.package_id === entry.package_id,
          );
          const receipt = matches[0];
          if (
            matches.length !== 1 ||
            receipt === undefined ||
            receipt.sha256 !== entry.sha256 ||
            receipt.size_bytes !== entry.size_bytes
          )
            return fail();
          const closureBytes = closures.find((c) => c.package_id === entry.package_id)?.bytes;
          if (closureBytes === undefined || !readObject(receipt).equals(closureBytes)) fail();
          return {
            package_id: entry.package_id,
            evidence_manifest: identity(receipt),
            expected_installed_package: entry.expected_installed_package,
            policy_resolution_digest_sha256: entry.policy_resolution_digest_sha256,
          };
        }),
        destination: binding.destination,
        trust: binding.trust,
      };
      if (current) {
        if (!('mutation_units' in binding)) fail();
        const shared = {
          ...transcript,
          closures: transcript.closures.map((entry, index) => ({
            ...entry,
            release_unit:
              (binding as ProtectedReleaseExportBindingV3).closure_inputs[index]?.release_unit ??
              fail(),
          })),
          mutation_units: binding.mutation_units,
        };
        if (forward) {
          if (!('certification_units' in binding)) fail();
          return encodeReleaseExportTranscriptV3(
            {
              ...shared,
              version: RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT,
              certification_units: binding.certification_units,
            },
            effectiveTranscriptLimits,
          );
        }
        return encodeReleaseExportTranscriptV2(
          { ...shared, version: RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT },
          effectiveTranscriptLimits,
        );
      }
      return encodeReleaseExportTranscript(transcript, effectiveTranscriptLimits);
    };
    const manifestFor = (
      transaction: string,
      receipts: readonly ReleaseExportArtifactObjectReceipt[],
    ) => {
      const transcript = transcriptFor(receipts);
      let signature: string | undefined;
      for (const { pkg } of packages) {
        const matches = receipts.filter(
          (r) => r.kind === 'provider-result' && r.package_id === pkg.package_id,
        );
        const receipt = matches[0];
        if (matches.length !== 1 || receipt === undefined) fail();
        const value = readObject(receipt);
        const result = parse<ReleaseExportProviderResult>(value);
        signature ??= result.signature;
        (current ? verifyReleaseExportProviderResultV2 : verifyReleaseExportProviderResult)(
          value,
          { package_id: pkg.package_id, transcript, signature },
          effectiveTranscriptLimits,
        );
      }
      if (current)
        verifyReleaseExportProviderResultSetV2(
          receipts.filter((entry) => entry.kind === 'provider-result').map(readObject),
          { transcript, signature: signature ?? fail() },
          effectiveTranscriptLimits,
        );
      const added = receipts.filter((r) => r.kind !== 'committed-manifest');
      if (added.length !== packages.length * 2) fail();
      const artifacts = order([...parents, ...added.map(identity)]);
      if (new Set(artifacts.map((entry) => entry.opaque_handle)).size !== artifacts.length) fail();
      const manifest: ReleaseExportArtifactCommitManifest = {
        schemaVersion: '1.0.0',
        kind: 'release-artifact-sink-commit-manifest',
        sink_id: binding.sink_id,
        transaction_handle: transaction,
        repository: binding.repository,
        candidate: binding.candidate,
        export_spec_id: specId,
        export_spec_digest_sha256: specDigest,
        parent_artifact_sink: binding.parent_artifact_sink,
        binding,
        artifacts,
      };
      return bytes(manifest);
    };
    const assertAbsent = (path: string) => {
      try {
        store.read(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      fail();
    };
    const reservation = (transaction: string) => ({
      binding,
      transaction_handle: transaction,
      prepared_state_id: state.state_id,
      prepared_state_digest_sha256: state.record_digest_sha256,
    });
    const readCommitted = async (input: ReadInput): Promise<Buffer> => {
      closed(input, ['sink_id', 'opaque_handle']);
      if (input.sink_id !== binding.sink_id) fail();
      await verifyParent(false);
      if (
        input.opaque_handle === binding.parent_artifact_sink.committed_manifest_handle ||
        parentIdentities.has(input.opaque_handle)
      )
        return checkedParentReader.readArtifact(input);
      const { transaction } = split(input.opaque_handle);
      const directory = directoryFor(transaction);
      if (
        !same(parse(store.read(reservationPath)), reservation(transaction)) ||
        !same(parse(store.read(join(directory, 'begin.json'))), reservation(transaction))
      )
        fail();
      assertAbsent(join(directory, 'abort.json'));
      const marker = parse<ArtifactSinkCommitReceipt>(store.read(join(directory, 'commit.json')));
      const manifestReceipt = receiptFor(marker.committed_manifest_handle);
      if (
        manifestReceipt.kind !== 'committed-manifest' ||
        manifestReceipt.transaction_handle !== transaction ||
        !same(marker, {
          committed: true,
          sink_id: binding.sink_id,
          transaction_handle: transaction,
          committed_manifest_handle: manifestReceipt.opaque_handle,
          committed_manifest_sha256: manifestReceipt.sha256,
          committed_manifest_size_bytes: manifestReceipt.size_bytes,
          commit_protocol: 'devai.artifact-sink.two-phase.v1',
        })
      )
        fail();
      const manifest = parse<ReleaseExportArtifactCommitManifest>(readObject(manifestReceipt));
      if (!Array.isArray(manifest.artifacts)) fail();
      const receipts = manifest.artifacts
        .filter((entry) => !parentIdentities.has(entry.opaque_handle))
        .map((entry) => {
          const receipt = receiptFor(entry.opaque_handle);
          if (receipt.transaction_handle !== transaction || !same(entry, identity(receipt))) fail();
          readObject(receipt);
          return receipt;
        });
      if (!readObject(manifestReceipt).equals(manifestFor(transaction, receipts))) fail();
      const all = [...receipts, manifestReceipt];
      const files = new Set(all.map((entry) => `${split(entry.opaque_handle).id}.json`));
      const stored = store.list(join(directory, 'receipts'));
      if (
        files.size !== all.length ||
        stored.length !== files.size ||
        stored.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !files.has(entry.name))
      )
        fail();
      const requested = all.find((entry) => entry.opaque_handle === input.opaque_handle);
      if (requested === undefined) fail();
      store.checkRoot();
      return readObject(requested);
    };
    let begun = false;
    return Object.freeze({
      readArtifact: (input: ReadInput) => guarded(() => readCommitted(copy(input))),
      async begin(): Promise<TrustedExportArtifactSinkTransaction> {
        return guarded(async () => {
          if (begun) fail();
          begun = true;
          verifyClosures();
          await verifyParent();
          assertAbsent(reservationPath);
          const capacity = readProtectedReleaseExportCapacity({
            action_id: 'release export',
            repository: binding.repository,
            candidate: binding.candidate,
            plan_receipt_digest_sha256: binding.plan_receipt_digest_sha256,
          });
          // `packages` is the complete, verified prepared roster, not a caller count.
          const required = 2 * packages.length + 34;
          if (capacity.remaining_batches < required || capacity.remaining_targets < required)
            throw new Error('release-export-capacity-insufficient');
          return adapter.invokeSink(() => {
            for (const name of ['staging', 'objects', 'exports'])
              store.ensureDirectory(join(store.root, name));
            store.ensureDirectory(join(store.root, 'exports', 'attempts'));
            assertAbsent(reservationPath);
            const transaction = randomUUID();
            // No-clobber durable reservation precedes all transaction data; a losing concurrent
            // begin or crash cannot reopen this attempt, even if no begin marker was written.
            store.install(reservationPath, bytes(reservation(transaction)));
            const directory = directoryFor(transaction);
            store.ensureDirectory(directory);
            store.ensureDirectory(join(directory, 'receipts'));
            store.install(join(directory, 'begin.json'), bytes(reservation(transaction)));
            const receipts = new Map<string, ReleaseExportArtifactObjectReceipt>();
            let terminal = false,
              signingStarted = false,
              failed = false,
              busy = false,
              committed = false;
            const active = () => {
              if (terminal || failed) fail();
            };
            const exclusive = async <T>(operation: () => T | Promise<T>): Promise<T> =>
              guarded(async () => {
                if (busy) fail();
                busy = true;
                try {
                  return await operation();
                } catch (error) {
                  // After signer dispatch every failure is terminal for further mutation, even
                  // a malformed post-sign put. It cannot be corrected by retrying this transaction.
                  if (signingStarted) failed = true;
                  throw error;
                } finally {
                  busy = false;
                }
              });
            const values = () => [...receipts.values()];
            const recheck = () => {
              for (const receipt of values()) {
                if (!same(receiptFor(receipt.opaque_handle), receipt)) fail();
                readObject(receipt);
              }
            };
            return Object.freeze<TrustedExportArtifactSinkTransaction>({
              sink_id: binding.sink_id,
              transaction_handle: transaction,
              readArtifact: (input) =>
                exclusive(async () => {
                  closed(input, ['sink_id', 'opaque_handle']);
                  if (committed) return readCommitted(copy(input));
                  if (input.sink_id !== binding.sink_id) fail();
                  const receipt = receipts.get(input.opaque_handle);
                  if (receipt === undefined || !same(receiptFor(input.opaque_handle), receipt))
                    fail();
                  return readObject(receipt);
                }),
              put: (input) =>
                exclusive(() => {
                  active();
                  closed(input, ['kind', 'package_id', 'bytes', 'sha256', 'size_bytes']);
                  if (
                    !Buffer.isBuffer(input.bytes) ||
                    input.bytes.length === 0 ||
                    input.bytes.length > store.limit ||
                    input.bytes.length !== input.size_bytes ||
                    hash(input.bytes) !== input.sha256 ||
                    values().some((r) => r.kind === input.kind && r.package_id === input.package_id)
                  )
                    fail();
                  const captured = Buffer.from(input.bytes);
                  const selected = copy({
                    kind: input.kind,
                    package_id: input.package_id,
                    sha256: input.sha256,
                  });
                  if (input.kind === 'evidence-manifest') {
                    const closure = closures.find((entry) => entry.package_id === input.package_id);
                    if (signingStarted || closure === undefined || !captured.equals(closure.bytes))
                      fail();
                  } else if (input.kind === 'provider-result') {
                    if (
                      !signingStarted ||
                      !packages.some(({ pkg }) => pkg.package_id === input.package_id)
                    )
                      fail();
                    const result = parse<ReleaseExportProviderResult>(captured);
                    const prior = values().find((r) => r.kind === 'provider-result');
                    const signature =
                      prior === undefined
                        ? result.signature
                        : parse<ReleaseExportProviderResult>(readObject(prior)).signature;
                    (current
                      ? verifyReleaseExportProviderResultV2
                      : verifyReleaseExportProviderResult)(
                      captured,
                      {
                        package_id: input.package_id,
                        transcript: transcriptFor(values()),
                        signature,
                      },
                      effectiveTranscriptLimits,
                    );
                  } else if (input.kind === 'committed-manifest') {
                    if (
                      !signingStarted ||
                      input.package_id !== null ||
                      !captured.equals(manifestFor(transaction, values()))
                    )
                      fail();
                  } else fail();
                  try {
                    return adapter.invokeSink(() => {
                      const id = randomUUID();
                      const receipt: ReleaseExportArtifactObjectReceipt = {
                        sink_id: binding.sink_id,
                        transaction_handle: transaction,
                        opaque_handle: `${transaction}:${id}:${selected.sha256}`,
                        kind: selected.kind,
                        package_id: selected.package_id,
                        sha256: selected.sha256,
                        size_bytes: captured.length,
                        export_spec_id: specId,
                        export_spec_digest_sha256: specDigest,
                      };
                      // Retain allocated handles even if a later durability operation loses its response.
                      receipts.set(receipt.opaque_handle, receipt);
                      store.install(store.objectPath(receipt.sha256), captured);
                      store.install(join(directory, 'receipts', `${id}.json`), bytes(receipt));
                      recheck();
                      return copy(receipt);
                    }, owner);
                  } catch (error) {
                    failed = true;
                    throw error;
                  }
                }),
              readTranscript: () =>
                exclusive(async () => {
                  active();
                  await verifyParent();
                  recheck();
                  return transcriptFor(values());
                }),
              markSigningStarted: () =>
                exclusive(async () => {
                  active();
                  if (signingStarted) fail();
                  await verifyParent();
                  recheck();
                  const transcript = transcriptFor(values());
                  signingStarted = true;
                  return transcript;
                }),
              readCommitManifest: () =>
                exclusive(async () => {
                  active();
                  if (!signingStarted) fail();
                  await verifyParent();
                  recheck();
                  return manifestFor(transaction, values());
                }),
              commit: (input) =>
                exclusive(async () => {
                  active();
                  const receipt = copy(input);
                  if (
                    !signingStarted ||
                    receipt.kind !== 'committed-manifest' ||
                    !same(receipts.get(receipt.opaque_handle), receipt) ||
                    values().length !== packages.length * 2 + 1
                  )
                    fail();
                  await verifyParent();
                  recheck();
                  if (!readObject(receipt).equals(manifestFor(transaction, values()))) fail();
                  const marker: ArtifactSinkCommitReceipt = {
                    committed: true,
                    sink_id: binding.sink_id,
                    transaction_handle: transaction,
                    committed_manifest_handle: receipt.opaque_handle,
                    committed_manifest_sha256: receipt.sha256,
                    committed_manifest_size_bytes: receipt.size_bytes,
                    commit_protocol: 'devai.artifact-sink.two-phase.v1',
                  };
                  try {
                    adapter.invokeSink(() => {
                      terminal = true;
                      store.install(join(directory, 'commit.json'), bytes(marker));
                    }, owner);
                    await readCommitted({
                      sink_id: binding.sink_id,
                      opaque_handle: receipt.opaque_handle,
                    });
                    committed = true;
                    return copy(marker);
                  } catch (error) {
                    failed = true;
                    if (terminal) throw new Error(COMMIT_UNKNOWN);
                    throw error;
                  }
                }),
              abort: () =>
                exclusive(() => {
                  if (terminal || signingStarted) fail();
                  return adapter.invokeSink(() => {
                    terminal = true;
                    store.install(
                      join(directory, 'abort.json'),
                      bytes({
                        sink_id: binding.sink_id,
                        transaction_handle: transaction,
                        aborted: true,
                      }),
                    );
                  }, owner);
                }),
              preserve: () => {
                if (busy || committed) return fail();
                terminal = true;
                return values().map(copy);
              },
            });
          }, owner);
        });
      },
    });
  });
}
