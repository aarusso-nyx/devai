import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ArtifactSinkCommitReceipt } from './release-prepare-kernel.js';
import {
  verifyReleaseExportProviderResult,
  type ReleaseExportProviderResult,
} from './release-export-transcript.js';
import { verifyReleaseExportProviderResultV2 } from './release-export-transcript-v2.js';
import { verifyReleaseExportProviderResultV3 } from './release-export-transcript-v3.js';
import type {
  ReleaseExportArtifactObjectReceipt,
  TrustedExportArtifactSinkTransaction,
} from './release-export-artifact-store-types.js';
import {
  COMMIT_UNKNOWN,
  bytes,
  closed,
  copy,
  fail,
  guarded,
  hash,
  parse,
  same,
} from './release-export-artifact-store-support.js';
import type { ExportStoreScope } from './release-export-artifact-store-inputs.js';

/**
 * Inside the export sink: reserve the attempt, write the begin marker, and return the
 * transaction whose puts, signing, commit, abort and preserve operate on it.
 */
export function openExportTransaction(
  scope: Pick<
    ExportStoreScope,
    | 'store'
    | 'assertAbsent'
    | 'reservationPath'
    | 'reservation'
    | 'directoryFor'
    | 'receiptFor'
    | 'readObject'
    | 'binding'
    | 'readCommitted'
    | 'closures'
    | 'packages'
    | 'forward'
    | 'current'
    | 'transcriptFor'
    | 'effectiveTranscriptLimits'
    | 'manifestFor'
    | 'adapter'
    | 'specId'
    | 'specDigest'
    | 'owner'
    | 'verifyParent'
  >,
) {
  const {
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
  } = scope;
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
        if (receipt === undefined || !same(receiptFor(input.opaque_handle), receipt)) fail();
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
          if (signingStarted || closure === undefined || !captured.equals(closure.bytes)) fail();
        } else if (input.kind === 'provider-result') {
          if (!signingStarted || !packages.some(({ pkg }) => pkg.package_id === input.package_id))
            fail();
          const result = parse<ReleaseExportProviderResult>(captured);
          const prior = values().find((r) => r.kind === 'provider-result');
          const signature =
            prior === undefined
              ? result.signature
              : parse<ReleaseExportProviderResult>(readObject(prior)).signature;
          (forward
            ? verifyReleaseExportProviderResultV3
            : current
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
}
