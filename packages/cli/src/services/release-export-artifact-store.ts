import { join } from 'node:path';
import {
  readProtectedReleaseExportCapacity,
  createProtectedReleaseSinkOwner,
} from '@devai-nyx/authority';
import { createReleaseArtifactStore } from './release-artifact-store.js';
import { createDurableReleaseContentStore } from './release-content-store.js';
import type { TrustedArtifactReader } from './release-lifecycle-execution.js';
import {
  RELEASE_PACK_SPEC_DIGEST,
  verifyPreparedPackageManifest,
  reverifySinkArtifacts,
} from './release-prepare-kernel.js';
import { verifyReleasePolicyClosure } from './release-policy-closure.js';
import { decodeReleasePolicyClosure } from './release-policy-closure-transport.js';
import {
  readReleaseExportMutationEvidence,
  reverifyReleaseExportMutationEvidence,
} from './release-export-mutation-evidence.js';
import {
  readReleaseExportCertificationEvidence,
  reverifyReleaseExportCertificationEvidence,
} from './release-export-certification-evidence.js';
import type {
  ReadInput,
  ReleaseExportArtifactObjectReceipt,
  ReleaseExportArtifactStoreOptions,
  TrustedExportArtifactSink,
  TrustedExportArtifactSinkTransaction,
} from './release-export-artifact-store-types.js';
import {
  HANDLE,
  bytes,
  closed,
  copy,
  fail,
  guarded,
  hash,
  object,
  parse,
  same,
} from './release-export-artifact-store-support.js';
import { captureExportStoreInputs } from './release-export-artifact-store-inputs.js';
import { openExportTransaction } from './release-export-artifact-store-transaction.js';
import {
  manifestBuilder,
  readCommittedFor,
  transcriptBuilder,
} from './release-export-artifact-store-readers.js';

export type {
  LegacyProtectedReleaseExportBinding,
  ProtectedReleaseExportBinding,
  ProtectedReleaseExportBindingV3,
  ProtectedReleaseExportBindingV4,
  ReleaseExportArtifactCommitManifest,
  ReleaseExportArtifactObject,
  ReleaseExportArtifactObjectReceipt,
  ReleaseExportArtifactStoreOptions,
  TrustedExportArtifactSink,
  TrustedExportArtifactSinkTransaction,
} from './release-export-artifact-store-types.js';

export { RELEASE_EXPORT_SPEC_ID, RELEASE_EXPORT_SPEC_DIGEST } from './release-export-transcript.js';

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
    const {
      binding,
      physical,
      parentIdentities,
      readParent,
      mutationEvidence,
      state,
      certificationEvidence,
      packages,
      transport,
      implementation,
      limits,
      current,
      specId,
      specDigest,
      parents,
      forward,
      effectiveTranscriptLimits,
      adapter,
    } = captureExportStoreInputs(options);
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
    const transcriptFor = transcriptBuilder({
      binding,
      parents,
      closures,
      readObject,
      current,
      forward,
      effectiveTranscriptLimits,
    });
    const manifestFor = manifestBuilder({
      transcriptFor,
      packages,
      readObject,
      forward,
      current,
      effectiveTranscriptLimits,
      parents,
      binding,
      specId,
      specDigest,
    });
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
    const readCommitted = readCommittedFor({
      binding,
      verifyParent,
      parentIdentities,
      checkedParentReader,
      split,
      directoryFor,
      store,
      reservationPath,
      reservation,
      assertAbsent,
      receiptFor,
      readObject,
      manifestFor,
    });
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
          return adapter.invokeSink(
            () =>
              openExportTransaction({
                store,
                assertAbsent,
                reservationPath,
                reservation,
                directoryFor,
                receiptFor,
                readObject,
                binding,
                readCommitted,
                closures,
                packages,
                forward,
                current,
                transcriptFor,
                effectiveTranscriptLimits,
                manifestFor,
                adapter,
                specId,
                specDigest,
                owner,
                verifyParent,
              }),
            owner,
          );
        });
      },
    });
  });
}
