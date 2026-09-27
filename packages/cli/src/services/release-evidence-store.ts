import { createProtectedReleaseSinkOwner } from '@devai-nyx/authority';
import { createDurableReleaseContentStore } from './release-content-store.js';
import type {
  CertificationEvidenceTransaction,
  CertifiedEvidenceCarrierBinding,
  CertifiedEvidenceCarrierIdentity,
  TrustedCertificationEvidenceSink,
} from './release-lifecycle-certification.js';
import { readCertifiedEvidenceCarrier } from './release-certified-evidence-carrier.js';
import {
  finalizeCertificationReceipt,
  type CertificationOutputClosureBinding,
} from './release-prepare-kernel.js';
import type { CertificationOutputBlobHandle } from './release-lifecycle-execution.js';
import {
  captureUnitMutationEvidenceBinding,
  type UnitMutationEvidenceObject,
  type UnitMutationEvidenceSink,
  type UnitMutationEvidenceTransaction,
} from './release-unit-mutation-evidence.js';
import {
  DIGEST,
  RELEASE_UNIT,
  assertBinding,
  digest,
  fail,
  same,
  snapshot,
  type CarrierDerivation,
  type CertificationStoreContext,
  type CommittedCarrier,
} from './release-evidence-store-support.js';
import { certificationCommitReader, unitCommitReader } from './release-evidence-store-commits.js';
import {
  beginCertificationEvidenceTransaction,
  beginUnitMutationEvidenceTransaction,
} from './release-evidence-store-transactions.js';

/** Durable host-owned store. Tasks must never receive its root or these capabilities.
 * Mutating methods run only inside the protected sink authority adapter. */
export interface ReleaseCertificationEvidenceStoreOptions {
  readonly root: string;
  readonly evidence_sink_id: string;
  readonly repository_roots: readonly string[];
  readonly max_blob_bytes: number;
}

export type ReleaseCertificationEvidenceStore = TrustedCertificationEvidenceSink &
  UnitMutationEvidenceSink & {
    readonly authority_owner: object;
  };

function createStore(
  input: ReleaseCertificationEvidenceStoreOptions,
): ReleaseCertificationEvidenceStore {
  const maximumUnitBytes = input.max_blob_bytes;
  const maximumCarrierBytes = input.max_blob_bytes;
  const owner = createProtectedReleaseSinkOwner('certification', input.evidence_sink_id);
  const {
    root,
    sinkId,
    checkRoot,
    inspectAncestors,
    read,
    ensureDirectory,
    install,
    objectPath,
    assertWriteAuthority,
  } = createDurableReleaseContentStore({ ...input, sink_id: input.evidence_sink_id }, fail, owner);
  const readBlob = (handle: CertificationOutputBlobHandle) => {
    if (
      !same(handle, {
        evidence_sink_id: sinkId,
        opaque_handle: `sha256:${handle.sha256}`,
        sha256: handle.sha256,
        size_bytes: handle.size_bytes,
      }) ||
      !Number.isSafeInteger(handle.size_bytes) ||
      handle.size_bytes < 0
    )
      fail();
    const value = read(objectPath(handle.sha256));
    if (value.length !== handle.size_bytes || digest(value) !== handle.sha256) fail();
    return value;
  };
  const unitObject = (identity: UnitMutationEvidenceObject) =>
    readBlob({
      evidence_sink_id: identity.evidence_sink_id,
      opaque_handle: identity.opaque_handle,
      sha256: identity.sha256,
      size_bytes: identity.size_bytes,
    });
  // Unit evidence shares this protected owner and content-addressed object population.
  // Its receipts are separate from package-entry closures and can never enter a tarball.
  const unitCommits = unitCommitReader({ checkRoot, root, inspectAncestors, read, sinkId });
  const committedCarriers: CommittedCarrier[] = [];
  const commits = certificationCommitReader(
    { checkRoot, root, inspectAncestors, read, sinkId },
    committedCarriers,
  );
  const carrierBytes = (identity: CertifiedEvidenceCarrierIdentity): Buffer => {
    const value = read(objectPath(identity.sha256));
    if (value.length !== identity.size_bytes || digest(value) !== identity.sha256) fail();
    return value;
  };
  const assertCarrierDerivation = (
    value: Buffer,
    derivation: CarrierDerivation,
    release_unit: string,
  ): void => {
    const decoded = readCertifiedEvidenceCarrier(value, maximumCarrierBytes);
    if (
      decoded.carrier.release_unit !== release_unit ||
      !same(decoded.carrier.derivation, {
        repository: derivation.repository,
        candidate: derivation.candidate,
        task_policy_digest_sha256: derivation.task_policy_digest_sha256,
      })
    )
      fail();
  };
  const context: CertificationStoreContext = {
    root,
    sinkId,
    checkRoot,
    inspectAncestors,
    read,
    ensureDirectory,
    install,
    objectPath,
    assertWriteAuthority,
    maximumUnitBytes,
    maximumCarrierBytes,
    unitObject,
    readBlob,
    carrierBytes,
    assertCarrierDerivation,
  };
  return Object.freeze<ReleaseCertificationEvidenceStore>({
    unit_mutation_maximum_bytes: maximumUnitBytes,
    certified_evidence_carrier_maximum_bytes: maximumCarrierBytes,
    authority_owner: owner,
    kind: 'certification-evidence-sink-v3' as const,
    protocol: 'two-phase-content-addressed' as const,
    beginUnitMutationEvidence(value) {
      return beginUnitMutationEvidenceTransaction(context, value);
    },
    readUnitMutationEvidenceClosure(value) {
      const binding = captureUnitMutationEvidenceBinding(value);
      const matches = unitCommits()
        .filter((entry) => same(entry.binding, binding))
        .map((entry) => entry.closure);
      const first = matches[0];
      if (!first || matches.length !== 1) fail();
      return snapshot(first);
    },
    readUnitMutationEvidenceReceipt(value) {
      if (value.evidence_sink_id !== sinkId || !DIGEST.test(value.receipt_digest_sha256)) fail();
      const matches = unitCommits()
        .map((entry) => entry.closure.receipt)
        .filter((receipt) => receipt.receipt_digest_sha256 === value.receipt_digest_sha256);
      const first = matches[0];
      if (!first || matches.length !== 1) fail();
      return snapshot(first);
    },
    readUnitMutationEvidenceBlob(value) {
      const closure = this.readUnitMutationEvidenceClosure(value.binding);
      if (
        ![closure.output_contract, ...closure.members].some((identity) =>
          same(
            {
              path: identity.path,
              sha256: identity.sha256,
              size_bytes: identity.size_bytes,
              evidence_sink_id: identity.evidence_sink_id,
              opaque_handle: identity.opaque_handle,
            },
            value.identity,
          ),
        )
      )
        fail();
      return unitObject(value.identity);
    },
    begin(
      bindings: readonly CertificationOutputClosureBinding[],
    ): CertificationEvidenceTransaction {
      return beginCertificationEvidenceTransaction(context, bindings);
    },
    readCertifiedEvidenceCarrier(binding: CertifiedEvidenceCarrierBinding): Buffer {
      if (
        !same(binding, {
          repository: binding.repository,
          candidate: binding.candidate,
          task_policy_digest_sha256: binding.task_policy_digest_sha256,
          release_unit: binding.release_unit,
        }) ||
        typeof binding.release_unit !== 'string' ||
        !RELEASE_UNIT.test(binding.release_unit)
      )
        fail();
      const derivation = {
        repository: binding.repository,
        candidate: binding.candidate,
        task_policy_digest_sha256: binding.task_policy_digest_sha256,
      };
      commits();
      const found = committedCarriers.filter(
        (carrier) =>
          carrier.release_unit === binding.release_unit && same(carrier.derivation, derivation),
      );
      const first = found[0];
      if (first === undefined || found.some((carrier) => !same(carrier, first))) fail();
      const value = carrierBytes(first);
      assertCarrierDerivation(value, first.derivation, first.release_unit);
      return Buffer.from(value);
    },
    readCertificationOutputClosure(binding) {
      assertBinding(binding);
      const found = commits().filter(({ outputs: _outputs, ...observed }) =>
        same(binding, observed),
      );
      const first = found[0];
      if (first === undefined || found.some((value) => !same(value, first))) fail();
      return snapshot(first);
    },
    readCertificationEvidenceReceipt(input) {
      if (input.evidence_sink_id !== sinkId || !DIGEST.test(input.receipt_digest_sha256)) fail();
      const found = commits()
        .flatMap((closure) =>
          closure.outputs.map((output) => output.certification_evidence_receipt),
        )
        .filter((receipt) => receipt.receipt_digest_sha256 === input.receipt_digest_sha256);
      const first = found[0];
      if (first === undefined || found.some((value) => !same(value, first))) fail();
      if (!same(first, finalizeCertificationReceipt(first.referent))) fail();
      return snapshot(first);
    },
    readGeneratedBlob(input) {
      const referent = input.receipt.referent;
      if (
        referent.candidate_commit !== input.candidate.commit ||
        referent.candidate_tree !== input.candidate.tree ||
        input.repository.commit !== input.candidate.commit ||
        input.repository.tree !== input.candidate.tree ||
        referent.output_blob_sha256 !== input.output_blob_sha256 ||
        !same(referent.output_blob_handle, input.output_blob_handle)
      )
        fail();
      const closure = this.readCertificationOutputClosure({
        repository: input.repository,
        candidate: { commit: input.candidate.commit, tree: input.candidate.tree },
        task_policy_digest_sha256: referent.task_policy_digest_sha256,
        package_id: referent.package_id,
      });
      if (
        closure instanceof Promise ||
        !closure.outputs.some((output) =>
          same(output.certification_evidence_receipt, input.receipt),
        )
      )
        fail();
      return readBlob(input.output_blob_handle);
    },
  });
}

// This implementation is synchronous. Keep native paths and filesystem exception
// details inside the protected host rather than exposing them in portable receipts.
function storageBoundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    fail();
  }
}

export function createReleaseCertificationEvidenceStore(
  input: ReleaseCertificationEvidenceStoreOptions,
): ReleaseCertificationEvidenceStore {
  const store = storageBoundary(() => createStore(input));
  return Object.freeze<ReleaseCertificationEvidenceStore>({
    unit_mutation_maximum_bytes: store.unit_mutation_maximum_bytes,
    certified_evidence_carrier_maximum_bytes: store.certified_evidence_carrier_maximum_bytes,
    authority_owner: store.authority_owner,
    kind: store.kind,
    protocol: store.protocol,
    beginUnitMutationEvidence(binding) {
      const transaction = storageBoundary(() => store.beginUnitMutationEvidence(binding));
      return Object.freeze<UnitMutationEvidenceTransaction>({
        evidence_sink_id: transaction.evidence_sink_id,
        transaction_handle: transaction.transaction_handle,
        put: (value) => storageBoundary(() => transaction.put(value)),
        async verify(value) {
          try {
            return await transaction.verify(value);
          } catch {
            return fail();
          }
        },
        commit: (value) => storageBoundary(() => transaction.commit(value)),
        abort: () => storageBoundary(() => transaction.abort()),
      });
    },
    readUnitMutationEvidenceClosure: (value) =>
      storageBoundary(() => store.readUnitMutationEvidenceClosure(value)),
    readUnitMutationEvidenceReceipt: (value) =>
      storageBoundary(() => store.readUnitMutationEvidenceReceipt(value)),
    readUnitMutationEvidenceBlob: (value) =>
      storageBoundary(() => store.readUnitMutationEvidenceBlob(value)),
    begin(bindings) {
      const transaction = storageBoundary(() => store.begin(bindings));
      if (transaction instanceof Promise) fail();
      return Object.freeze<CertificationEvidenceTransaction>({
        evidence_sink_id: transaction.evidence_sink_id,
        transaction_handle: transaction.transaction_handle,
        put: (input) => storageBoundary(() => transaction.put(input)),
        putCertifiedEvidenceCarrier: (input) =>
          storageBoundary(() => {
            if (typeof transaction.putCertifiedEvidenceCarrier !== 'function') fail();
            return transaction.putCertifiedEvidenceCarrier(input);
          }),
        commit: (input) => storageBoundary(() => transaction.commit(input)),
        abort: () => storageBoundary(() => transaction.abort()),
      });
    },
    readCertifiedEvidenceCarrier: (input) =>
      storageBoundary(() => {
        if (typeof store.readCertifiedEvidenceCarrier !== 'function') fail();
        return store.readCertifiedEvidenceCarrier(input);
      }),
    readCertificationOutputClosure: (input) =>
      storageBoundary(() => store.readCertificationOutputClosure(input)),
    readCertificationEvidenceReceipt: (input) =>
      storageBoundary(() => store.readCertificationEvidenceReceipt(input)),
    readGeneratedBlob: (input) => storageBoundary(() => store.readGeneratedBlob(input)),
  });
}
