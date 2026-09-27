import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CertifiedEvidenceCarrierIdentity } from './release-lifecycle-certification.js';
import {
  finalizeCertificationReceipt,
  type CertificationOutputClosure,
  type CertificationOutputClosureBinding,
} from './release-prepare-kernel.js';
import {
  captureUnitMutationEvidenceBinding,
  verifyUnitMutationEvidenceClosure,
  type ReleaseUnitMutationEvidenceClosure,
  type UnitMutationEvidenceBinding,
} from './release-unit-mutation-evidence.js';
import {
  DIGEST,
  RELEASE_UNIT,
  TRANSACTION,
  assertBinding,
  bytes,
  digest,
  fail,
  safeOutputPath,
  same,
  snapshot,
  type CarrierDerivation,
  type CertificationStoreContext,
  type CommittedCarrier,
} from './release-evidence-store-support.js';

/** Reader of every committed, unaborted unit mutation evidence transaction in the store. */
export function unitCommitReader(
  store: Pick<
    CertificationStoreContext,
    'checkRoot' | 'root' | 'inspectAncestors' | 'read' | 'sinkId'
  >,
) {
  const { checkRoot, root, inspectAncestors, read, sinkId } = store;
  return (): readonly {
    binding: UnitMutationEvidenceBinding;
    closure: ReleaseUnitMutationEvidenceClosure;
  }[] => {
    checkRoot();
    const directory = join(root, 'unit-mutation');
    inspectAncestors(directory);
    const values: {
      binding: UnitMutationEvidenceBinding;
      closure: ReleaseUnitMutationEvidenceClosure;
    }[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!TRANSACTION.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) fail();
      let committed: Buffer;
      try {
        committed = read(join(directory, entry.name, 'commit.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const closure = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(committed),
      ) as ReleaseUnitMutationEvidenceClosure;
      if (!committed.equals(bytes(closure))) fail();
      const beginBytes = read(join(directory, entry.name, 'begin.json'));
      const begin = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(beginBytes)) as {
        evidence_sink_id: string;
        transaction_handle: string;
        binding: UnitMutationEvidenceBinding;
      };
      const binding = captureUnitMutationEvidenceBinding(begin.binding);
      if (
        !beginBytes.equals(
          bytes({ evidence_sink_id: sinkId, transaction_handle: entry.name, binding }),
        )
      )
        fail();
      const index = read(join(root, 'unit-mutation-index', `${digest(bytes(binding))}.json`));
      if (
        !index.equals(bytes({ evidence_sink_id: sinkId, transaction_handle: entry.name, binding }))
      )
        fail();
      try {
        lstatSync(join(directory, entry.name, 'abort.json'));
        fail();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      verifyUnitMutationEvidenceClosure(closure, binding);
      if (closure.output_contract.evidence_sink_id !== sinkId) fail();
      values.push({ binding, closure });
    }
    return values;
  };
}

/**
 * Reader of every committed certification transaction, in name order; it refreshes the
 * committed carrier list it is given as it verifies each commit.
 */
export function certificationCommitReader(
  store: Pick<
    CertificationStoreContext,
    'checkRoot' | 'root' | 'inspectAncestors' | 'read' | 'sinkId'
  >,
  committedCarriers: CommittedCarrier[],
) {
  const { checkRoot, root, inspectAncestors, read, sinkId } = store;
  return (): readonly CertificationOutputClosure[] => {
    checkRoot();
    const directory = join(root, 'certification');
    inspectAncestors(directory);
    committedCarriers.length = 0;
    const closures: CertificationOutputClosure[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      if (!TRANSACTION.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) fail();
      let value: Buffer;
      try {
        value = read(join(directory, entry.name, 'commit.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const commit = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as {
        evidence_sink_id: string;
        transaction_handle: string;
        closures: CertificationOutputClosure[];
        carriers?: CertifiedEvidenceCarrierIdentity[];
      };
      // Historical commits carry no carrier member and stay byte-identical under this branch.
      if (
        !same(
          commit,
          commit.carriers === undefined
            ? {
                evidence_sink_id: sinkId,
                transaction_handle: entry.name,
                closures: commit.closures,
              }
            : {
                evidence_sink_id: sinkId,
                transaction_handle: entry.name,
                closures: commit.closures,
                carriers: commit.carriers,
              },
        ) ||
        !Array.isArray(commit.closures) ||
        !value.equals(bytes(commit))
      )
        fail();
      const beginBytes = read(join(directory, entry.name, 'begin.json'));
      const begin = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(beginBytes)) as {
        evidence_sink_id: string;
        transaction_handle: string;
        bindings: CertificationOutputClosureBinding[];
      };
      if (
        !beginBytes.equals(bytes(begin)) ||
        !same(begin, {
          evidence_sink_id: sinkId,
          transaction_handle: entry.name,
          bindings: commit.closures.map(({ outputs: _outputs, ...binding }) => binding),
        })
      )
        fail();
      try {
        lstatSync(join(directory, entry.name, 'abort.json'));
        fail();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      for (const closure of commit.closures) {
        const { outputs, ...binding } = closure;
        assertBinding(binding);
        if (!Array.isArray(outputs)) fail();
        const paths = outputs.map((output) => output.path);
        if (
          new Set(paths).size !== paths.length ||
          !same(
            paths,
            [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
          )
        )
          fail();
        for (const output of outputs) {
          const handle = output.output_blob_handle;
          if (
            !safeOutputPath(output.path) ||
            !['100644', '100755'].includes(output.mode) ||
            !DIGEST.test(handle.sha256) ||
            !Number.isSafeInteger(handle.size_bytes) ||
            handle.size_bytes < 0 ||
            !same(handle, {
              evidence_sink_id: sinkId,
              opaque_handle: `sha256:${handle.sha256}`,
              sha256: handle.sha256,
              size_bytes: handle.size_bytes,
            }) ||
            !same(output, {
              path: output.path,
              mode: output.mode,
              output_blob_handle: handle,
              certification_evidence_receipt: finalizeCertificationReceipt({
                candidate_commit: binding.candidate.commit,
                candidate_tree: binding.candidate.tree,
                task_policy_digest_sha256: binding.task_policy_digest_sha256,
                package_id: binding.package_id,
                output_blob_sha256: handle.sha256,
                output_blob_handle: handle,
              }),
            })
          )
            fail();
        }
      }
      if (commit.carriers !== undefined) {
        if (!Array.isArray(commit.carriers)) fail();
        const units = commit.carriers.map((carrier) => carrier.release_unit);
        if (
          new Set(units).size !== units.length ||
          !same(
            units,
            [...units].sort((a, b) => a.localeCompare(b, 'en')),
          )
        )
          fail();
        // Each carrier records its own protected derivation. It must equal one of this
        // transaction's committed package bindings; nothing is inferred positionally.
        const derivations = commit.closures.map(({ outputs: _ignored, ...binding }) => ({
          repository: binding.repository,
          candidate: binding.candidate,
          task_policy_digest_sha256: binding.task_policy_digest_sha256,
        }));
        for (const carrier of commit.carriers as (CertifiedEvidenceCarrierIdentity & {
          derivation: CarrierDerivation;
        })[]) {
          if (
            !same(carrier, {
              evidence_sink_id: sinkId,
              release_unit: carrier.release_unit,
              derivation: carrier.derivation,
              opaque_handle: `sha256:${carrier.sha256}`,
              sha256: carrier.sha256,
              size_bytes: carrier.size_bytes,
            }) ||
            typeof carrier.release_unit !== 'string' ||
            !RELEASE_UNIT.test(carrier.release_unit) ||
            !DIGEST.test(carrier.sha256) ||
            !Number.isSafeInteger(carrier.size_bytes) ||
            carrier.size_bytes < 1 ||
            !derivations.some((derivation) => same(derivation, carrier.derivation))
          )
            fail();
          committedCarriers.push(snapshot(carrier));
        }
      }
      closures.push(...commit.closures);
    }
    return closures;
  };
}
