import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import type { CertificationEvidenceTransaction } from './release-lifecycle-certification.js';
import { readCertifiedEvidenceCarrier } from './release-certified-evidence-carrier.js';
import {
  finalizeCertificationReceipt,
  type CertificationOutputClosure,
  type CertificationOutputClosureBinding,
} from './release-prepare-kernel.js';
import type { CertificationOutputBlobHandle } from './release-lifecycle-execution.js';
import {
  captureUnitMutationEvidenceBinding,
  finalizeUnitMutationEvidenceClosure,
  verifyUnitMutationEvidenceDocuments,
  type ReleaseUnitMutationEvidenceClosure,
  type UnitMutationEvidenceObject,
  type UnitMutationEvidenceSink,
  type UnitMutationEvidenceTransaction,
} from './release-unit-mutation-evidence.js';
import {
  RELEASE_UNIT,
  assertBinding,
  bytes,
  digest,
  fail,
  safeOutputPath,
  same,
  snapshot,
  type CertificationStoreContext,
  type CommittedCarrier,
} from './release-evidence-store-support.js';

/** Begin one unit mutation evidence transaction bound to its exact unit binding. */
export function beginUnitMutationEvidenceTransaction(
  store: CertificationStoreContext,
  value: Parameters<UnitMutationEvidenceSink['beginUnitMutationEvidence']>[0],
): ReturnType<UnitMutationEvidenceSink['beginUnitMutationEvidence']> {
  const {
    checkRoot,
    root,
    read,
    ensureDirectory,
    install,
    sinkId,
    objectPath,
    maximumUnitBytes,
    unitObject,
    assertWriteAuthority,
  } = store;
  checkRoot();
  const binding = captureUnitMutationEvidenceBinding(value);
  const bindingIndex = join(root, 'unit-mutation-index', `${digest(bytes(binding))}.json`);
  try {
    read(bindingIndex);
    fail();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const name of ['staging', 'objects', 'unit-mutation', 'unit-mutation-index'])
    ensureDirectory(join(root, name));
  const transaction = randomUUID();
  const directory = join(root, 'unit-mutation', transaction);
  ensureDirectory(directory);
  install(
    join(directory, 'begin.json'),
    bytes({ evidence_sink_id: sinkId, transaction_handle: transaction, binding }),
  );
  const handles = new Map<string, Omit<UnitMutationEvidenceObject, 'path'>>();
  let terminal = false;
  let verificationEpoch = 0;
  let verified: ReleaseUnitMutationEvidenceClosure | undefined;
  return Object.freeze<UnitMutationEvidenceTransaction>({
    evidence_sink_id: sinkId,
    transaction_handle: transaction,
    put(value) {
      if (
        terminal ||
        !Buffer.isBuffer(value.bytes) ||
        value.bytes.length !== value.size_bytes ||
        digest(value.bytes) !== value.sha256
      )
        fail();
      const captured = Buffer.from(value.bytes);
      install(objectPath(value.sha256), captured);
      const handle = {
        evidence_sink_id: sinkId,
        opaque_handle: `sha256:${value.sha256}`,
        sha256: value.sha256,
        size_bytes: captured.length,
      };
      handles.set(handle.opaque_handle, handle);
      return snapshot(handle);
    },
    async verify(projection) {
      if (terminal) fail();
      verified = undefined;
      const epoch = ++verificationEpoch;
      const closure = finalizeUnitMutationEvidenceClosure(binding, projection);
      for (const identity of [closure.output_contract, ...closure.members]) {
        if (
          !same(handles.get(identity.opaque_handle), {
            evidence_sink_id: identity.evidence_sink_id,
            opaque_handle: identity.opaque_handle,
            sha256: identity.sha256,
            size_bytes: identity.size_bytes,
          })
        )
          fail();
      }
      await verifyUnitMutationEvidenceDocuments({
        closure,
        expected: binding,
        maximum_bytes: maximumUnitBytes,
        read: unitObject,
      });
      if (terminal || epoch !== verificationEpoch) fail();
      verified = closure;
    },
    commit(projection) {
      assertWriteAuthority();
      if (terminal) fail();
      terminal = true;
      const closure = finalizeUnitMutationEvidenceClosure(binding, projection);
      if (verified === undefined || !same(closure, verified)) fail();
      // No await inside the authorized write operation. Rehash every object
      // against the privately verified snapshot before creating any receipt.
      for (const identity of [closure.output_contract, ...closure.members]) unitObject(identity);
      // One atomic election per binding, including across processes. A lost
      // response leaves its index intact for reconciliation, never a retry.
      install(
        bindingIndex,
        bytes({ evidence_sink_id: sinkId, transaction_handle: transaction, binding }),
      );
      install(join(directory, 'commit.json'), bytes(closure));
      return snapshot(closure);
    },
    abort() {
      assertWriteAuthority();
      if (terminal) fail();
      terminal = true;
      install(
        join(directory, 'abort.json'),
        bytes({ evidence_sink_id: sinkId, transaction_handle: transaction, aborted: true }),
      );
    },
  });
}

/** Begin one certification evidence transaction over distinct, valid closure bindings. */
export function beginCertificationEvidenceTransaction(
  store: CertificationStoreContext,
  bindings: readonly CertificationOutputClosureBinding[],
): CertificationEvidenceTransaction {
  const {
    checkRoot,
    ensureDirectory,
    root,
    install,
    sinkId,
    objectPath,
    maximumCarrierBytes,
    readBlob,
    assertCarrierDerivation,
    carrierBytes,
  } = store;
  checkRoot();
  const selected = snapshot(bindings);
  if (selected.length === 0) fail();
  selected.forEach(assertBinding);
  if (new Set(selected.map((binding) => canonicalJson(binding))).size !== selected.length) fail();
  if (
    new Set(selected.map((binding) => binding.package_id)).size !== selected.length ||
    selected.some((binding) => !same(binding.repository, selected[0]?.repository))
  )
    fail();
  for (const name of ['staging', 'objects', 'certification']) ensureDirectory(join(root, name));
  const transaction = randomUUID();
  const directory = join(root, 'certification', transaction);
  ensureDirectory(directory);
  install(
    join(directory, 'begin.json'),
    bytes({ evidence_sink_id: sinkId, transaction_handle: transaction, bindings: selected }),
  );
  const handles = new Map<string, CertificationOutputBlobHandle>();
  const carriers = new Map<string, CommittedCarrier>();
  const derivations = selected.map((binding) => ({
    repository: binding.repository,
    candidate: binding.candidate,
    task_policy_digest_sha256: binding.task_policy_digest_sha256,
  }));
  let terminal = false;
  return Object.freeze<CertificationEvidenceTransaction>({
    evidence_sink_id: sinkId,
    transaction_handle: transaction,
    put(value) {
      if (
        terminal ||
        !Buffer.isBuffer(value.bytes) ||
        value.bytes.length !== value.size_bytes ||
        digest(value.bytes) !== value.sha256
      )
        fail();
      const captured = Buffer.from(value.bytes);
      install(objectPath(value.sha256), captured);
      const handle = {
        evidence_sink_id: sinkId,
        opaque_handle: `sha256:${value.sha256}`,
        sha256: value.sha256,
        size_bytes: captured.length,
      };
      handles.set(handle.opaque_handle, handle);
      return snapshot(handle);
    },
    putCertifiedEvidenceCarrier(value) {
      if (
        terminal ||
        typeof value.release_unit !== 'string' ||
        !RELEASE_UNIT.test(value.release_unit) ||
        carriers.has(value.release_unit) ||
        !Buffer.isBuffer(value.bytes) ||
        value.bytes.length !== value.size_bytes ||
        value.bytes.length < 1 ||
        value.bytes.length > maximumCarrierBytes ||
        digest(value.bytes) !== value.sha256
      )
        fail();
      const captured = Buffer.from(value.bytes);
      // The sink, never the producer, decodes and elects the derivation.
      const decoded = readCertifiedEvidenceCarrier(captured, maximumCarrierBytes);
      if (decoded.carrier.release_unit !== value.release_unit) fail();
      const derivation = derivations.find((candidate) =>
        same(candidate, decoded.carrier.derivation),
      );
      if (derivation === undefined) fail();
      install(objectPath(value.sha256), captured);
      const identity: CommittedCarrier = {
        evidence_sink_id: sinkId,
        release_unit: value.release_unit,
        derivation: snapshot(derivation),
        opaque_handle: `sha256:${value.sha256}`,
        sha256: value.sha256,
        size_bytes: captured.length,
      };
      carriers.set(value.release_unit, identity);
      return snapshot({
        evidence_sink_id: identity.evidence_sink_id,
        release_unit: identity.release_unit,
        opaque_handle: identity.opaque_handle,
        sha256: identity.sha256,
        size_bytes: identity.size_bytes,
      });
    },
    commit(values) {
      if (terminal || values.length !== selected.length) fail();
      const closures = snapshot(values).map((value, index): CertificationOutputClosure => {
        const binding = selected[index];
        if (
          binding === undefined ||
          !same(value, { ...binding, outputs: value.outputs }) ||
          !Array.isArray(value.outputs)
        )
          fail();
        const paths = value.outputs.map((output) => output.path);
        if (
          new Set(paths).size !== paths.length ||
          !same(
            paths,
            [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
          )
        )
          fail();
        return {
          ...binding,
          outputs: value.outputs.map((output) => {
            const handle = output.output_blob_handle;
            if (
              !safeOutputPath(output.path) ||
              !['100644', '100755'].includes(output.mode) ||
              !same(output, {
                path: output.path,
                mode: output.mode,
                output_blob_handle: handle,
              }) ||
              !same(handles.get(handle.opaque_handle), handle)
            )
              fail();
            readBlob(handle);
            return {
              ...output,
              certification_evidence_receipt: finalizeCertificationReceipt({
                candidate_commit: binding.candidate.commit,
                candidate_tree: binding.candidate.tree,
                task_policy_digest_sha256: binding.task_policy_digest_sha256,
                package_id: binding.package_id,
                output_blob_sha256: handle.sha256,
                output_blob_handle: handle,
              }),
            };
          }),
        };
      });
      // Rehash and re-decode every retained carrier against its elected derivation
      // before the atomic effect. A producer cache never substitutes for these bytes.
      const retained = [...carriers.values()].sort((a, b) =>
        a.release_unit.localeCompare(b.release_unit, 'en'),
      );
      for (const carrier of retained)
        assertCarrierDerivation(carrierBytes(carrier), carrier.derivation, carrier.release_unit);
      // Commit outcome becomes terminal before the atomic effect: any lost
      // fsync/response requires reading durable state, never abort/retry.
      terminal = true;
      install(
        join(directory, 'commit.json'),
        bytes(
          retained.length === 0
            ? { evidence_sink_id: sinkId, transaction_handle: transaction, closures }
            : {
                evidence_sink_id: sinkId,
                transaction_handle: transaction,
                closures,
                carriers: retained,
              },
        ),
      );
      return snapshot(closures);
    },
    abort() {
      if (terminal) fail();
      terminal = true;
      install(
        join(directory, 'abort.json'),
        bytes({ evidence_sink_id: sinkId, transaction_handle: transaction, aborted: true }),
      );
    },
  });
}
