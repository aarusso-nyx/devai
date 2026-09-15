import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import {
  createProtectedArtifactSinkAdapter,
  createProtectedReleaseSinkOwner,
} from '@devai-nyx/authority';
import {
  createDurableReleaseContentStore,
  type DurableReleaseContentStoreOptions,
} from './release-content-store.js';
import { RELEASE_PACK_SPEC_ID, RELEASE_PACK_SPEC_DIGEST } from './release-prepare-kernel.js';
import type {
  ArtifactSinkObjectReceipt,
  ArtifactSinkCommitManifest,
  TrustedArtifactSink,
  TrustedArtifactSinkTransaction,
} from './release-prepare-kernel.js';
import type {
  ArtifactSinkCommitIdentity,
  TrustedArtifactReader,
} from './release-lifecycle-execution.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const HANDLE = new RegExp(`^(${UUID}):(${UUID}):([0-9a-f]{64})$`, 'u');
const KINDS = ['package-manifest', 'package-tarball', 'package-sbom', 'committed-manifest'];
function fail(): never {
  throw new Error('release-artifact-sink-protocol-invalid');
}
function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function bytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}
function clone<T>(value: T): T {
  return JSON.parse(bytes(value).toString('utf8')) as T;
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function guard<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && /^AUTHORITY_[A-Z0-9_]+$/u.test(error.message)) throw error;
    return fail();
  }
}

/** Supplied only by the trusted host. Neither the CLI request nor a candidate chooses storage. */
export interface ReleaseArtifactStoreOptions extends DurableReleaseContentStoreOptions {
  readonly binding: {
    readonly action_id: 'release prepare';
    readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
    readonly plan_receipt_digest_sha256: string;
    readonly pack_spec_digest_sha256: string;
    readonly sink_id: string;
  };
}

type Begin = Parameters<TrustedArtifactSink['begin']>[0];
type ReadInput = Parameters<TrustedArtifactReader['readArtifact']>[0];

/** Injected opaque two-phase sink and committed-only reader. No default root or process execution. */
export function createReleaseArtifactStore(
  options: ReleaseArtifactStoreOptions,
): TrustedArtifactSink & TrustedArtifactReader {
  return guard(() => {
    const owner = createProtectedReleaseSinkOwner('artifact', options.sink_id);
    const store = createDurableReleaseContentStore(options, fail, owner);
    const binding = clone(options.binding);
    if (
      binding.sink_id !== store.sinkId ||
      binding.pack_spec_digest_sha256 !== RELEASE_PACK_SPEC_DIGEST
    )
      fail();
    const adapter = createProtectedArtifactSinkAdapter(binding);
    const authority = {
      invokeSink: <T>(callback: () => T): T => adapter.invokeSink(callback, owner),
    };
    const expectedBegin: Begin = {
      repository: binding.repository,
      candidate: { commit: binding.repository.commit, tree: binding.repository.tree },
      pack_spec_id: RELEASE_PACK_SPEC_ID,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
    };
    const parse = <T>(value: Buffer): T => {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as T;
      if (!value.equals(bytes(parsed))) fail();
      return parsed;
    };
    const split = (handle: string) => {
      const match = typeof handle === 'string' ? HANDLE.exec(handle) : null;
      const transaction = match?.[1];
      const object = match?.[2];
      const sha256 = match?.[3];
      if (transaction === undefined || object === undefined || sha256 === undefined) fail();
      return { transaction, object, sha256 };
    };
    const transactionPath = (transaction: string) => join(store.root, 'artifacts', transaction);
    const receiptFor = (handle: string): ArtifactSinkObjectReceipt => {
      const parts = split(handle);
      const receipt = parse<ArtifactSinkObjectReceipt>(
        store.read(join(transactionPath(parts.transaction), 'receipts', `${parts.object}.json`)),
      );
      if (
        !same(receipt, {
          sink_id: store.sinkId,
          transaction_handle: parts.transaction,
          opaque_handle: handle,
          kind: receipt.kind,
          logical_name: receipt.logical_name,
          sha256: parts.sha256,
          size_bytes: receipt.size_bytes,
          pack_spec_id: RELEASE_PACK_SPEC_ID,
          pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
        }) ||
        !KINDS.includes(receipt.kind) ||
        !Number.isSafeInteger(receipt.size_bytes) ||
        receipt.size_bytes < 0 ||
        typeof receipt.logical_name !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,399}$/u.test(receipt.logical_name)
      )
        fail();
      return receipt;
    };
    const readObject = (receipt: ArtifactSinkObjectReceipt): Buffer => {
      const value = store.read(store.objectPath(receipt.sha256));
      if (hash(value) !== receipt.sha256 || value.length !== receipt.size_bytes) fail();
      return value;
    };
    const identity = (receipt: ArtifactSinkObjectReceipt) => ({
      kind: receipt.kind,
      sink_id: receipt.sink_id,
      opaque_handle: receipt.opaque_handle,
      sha256: receipt.sha256,
      size_bytes: receipt.size_bytes,
    });
    const assertNotAborted = (directory: string) => {
      try {
        store.read(join(directory, 'abort.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      fail();
    };
    const committed = (handle: string) => {
      const parts = split(handle);
      const directory = transactionPath(parts.transaction);
      const begin = parse(store.read(join(directory, 'begin.json')));
      if (
        !same(begin, {
          ...expectedBegin,
          sink_id: store.sinkId,
          transaction_handle: parts.transaction,
          plan_receipt_digest_sha256: binding.plan_receipt_digest_sha256,
        })
      )
        fail();
      assertNotAborted(directory);
      const marker = parse<ArtifactSinkCommitIdentity & { committed: true }>(
        store.read(join(directory, 'commit.json')),
      );
      const receipt = receiptFor(marker.committed_manifest_handle);
      if (
        receipt.kind !== 'committed-manifest' ||
        !same(marker, {
          committed: true,
          sink_id: store.sinkId,
          transaction_handle: parts.transaction,
          committed_manifest_handle: receipt.opaque_handle,
          committed_manifest_sha256: receipt.sha256,
          committed_manifest_size_bytes: receipt.size_bytes,
          commit_protocol: 'devai.artifact-sink.two-phase.v1',
        }) ||
        receipt.transaction_handle !== parts.transaction
      )
        fail();
      const manifest = parse<ArtifactSinkCommitManifest>(readObject(receipt));
      if (
        !Array.isArray(manifest.artifacts) ||
        !same(manifest, {
          schemaVersion: '1.0.0',
          kind: 'release-artifact-sink-commit-manifest',
          sink_id: store.sinkId,
          transaction_handle: parts.transaction,
          ...expectedBegin,
          artifacts: manifest.artifacts,
        })
      )
        fail();
      const handles = new Set<string>();
      const logicalNames = new Set<string>([receipt.logical_name]);
      const receiptFiles = new Set<string>([`${split(receipt.opaque_handle).object}.json`]);
      for (const artifact of manifest.artifacts) {
        const observed = receiptFor(artifact.opaque_handle);
        if (
          observed.kind === 'committed-manifest' ||
          observed.transaction_handle !== parts.transaction ||
          logicalNames.has(observed.logical_name) ||
          handles.has(observed.opaque_handle) ||
          !same(artifact, identity(observed))
        )
          fail();
        handles.add(observed.opaque_handle);
        logicalNames.add(observed.logical_name);
        receiptFiles.add(`${split(observed.opaque_handle).object}.json`);
        readObject(observed);
      }
      const receiptsDirectory = join(directory, 'receipts');
      store.inspectAncestors(receiptsDirectory);
      const storedReceipts = store.list(receiptsDirectory);
      if (
        storedReceipts.length !== receiptFiles.size ||
        storedReceipts.some(
          (entry) => !entry.isFile() || entry.isSymbolicLink() || !receiptFiles.has(entry.name),
        )
      )
        fail();
      if (handles.size === 0 || (!handles.has(handle) && handle !== receipt.opaque_handle)) fail();
      const ordered = [...manifest.artifacts].sort((a, b) =>
        Buffer.compare(
          Buffer.from(`${a.kind}\0${a.sink_id}\0${a.opaque_handle}\0${a.sha256}\0${a.size_bytes}`),
          Buffer.from(`${b.kind}\0${b.sink_id}\0${b.opaque_handle}\0${b.sha256}\0${b.size_bytes}`),
        ),
      );
      if (!same(ordered, manifest.artifacts)) fail();
      store.checkRoot();
      return readObject(receiptFor(handle));
    };
    const readArtifact = (input: ReadInput): Buffer =>
      guard(() => {
        if (!same(input, { sink_id: store.sinkId, opaque_handle: input.opaque_handle })) fail();
        return committed(input.opaque_handle);
      });
    return Object.freeze({
      readArtifact,
      begin(input: Begin): TrustedArtifactSinkTransaction {
        return guard(() =>
          authority.invokeSink(() => {
            if (!same(input, expectedBegin)) fail();
            for (const name of ['staging', 'objects', 'artifacts'])
              store.ensureDirectory(join(store.root, name));
            const transaction = randomUUID();
            const directory = transactionPath(transaction);
            store.ensureDirectory(directory);
            store.ensureDirectory(join(directory, 'receipts'));
            store.install(
              join(directory, 'begin.json'),
              bytes({
                ...expectedBegin,
                sink_id: store.sinkId,
                transaction_handle: transaction,
                plan_receipt_digest_sha256: binding.plan_receipt_digest_sha256,
              }),
            );
            const receipts = new Map<string, ArtifactSinkObjectReceipt>();
            const names = new Set<string>();
            let terminal = false;
            let didCommit = false;
            const readTransaction = (input: ReadInput): Buffer =>
              guard(() => {
                if (didCommit) return readArtifact(input);
                if (terminal || input.sink_id !== store.sinkId) fail();
                const receipt = receipts.get(input.opaque_handle);
                if (!receipt || !same(receiptFor(input.opaque_handle), receipt)) fail();
                return readObject(receipt);
              });
            return Object.freeze<TrustedArtifactSinkTransaction>({
              sink_id: store.sinkId,
              transaction_handle: transaction,
              readArtifact: readTransaction,
              put(value) {
                return guard(() =>
                  authority.invokeSink(() => {
                    if (
                      terminal ||
                      !Buffer.isBuffer(value.bytes) ||
                      value.size_bytes !== value.bytes.length ||
                      value.sha256 !== hash(value.bytes) ||
                      value.pack_spec_id !== RELEASE_PACK_SPEC_ID ||
                      value.pack_spec_digest_sha256 !== RELEASE_PACK_SPEC_DIGEST ||
                      !KINDS.includes(value.kind) ||
                      typeof value.logical_name !== 'string' ||
                      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,399}$/u.test(value.logical_name) ||
                      names.has(value.logical_name)
                    )
                      fail();
                    const captured = Buffer.from(value.bytes);
                    const object = randomUUID();
                    const receipt: ArtifactSinkObjectReceipt = {
                      sink_id: store.sinkId,
                      transaction_handle: transaction,
                      opaque_handle: `${transaction}:${object}:${value.sha256}`,
                      kind: value.kind,
                      logical_name: value.logical_name,
                      sha256: value.sha256,
                      size_bytes: captured.length,
                      pack_spec_id: RELEASE_PACK_SPEC_ID,
                      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
                    };
                    store.install(store.objectPath(value.sha256), captured);
                    store.install(join(directory, 'receipts', `${object}.json`), bytes(receipt));
                    names.add(value.logical_name);
                    receipts.set(receipt.opaque_handle, receipt);
                    return clone(receipt);
                  }),
                );
              },
              commit(value) {
                return guard(() =>
                  authority.invokeSink(() => {
                    if (
                      terminal ||
                      !same(receipts.get(value.opaque_handle), value) ||
                      value.kind !== 'committed-manifest'
                    )
                      fail();
                    const manifest = parse<ArtifactSinkCommitManifest>(readObject(value));
                    const artifacts = [...receipts.values()]
                      .filter((receipt) => receipt.kind !== 'committed-manifest')
                      .map(identity)
                      .sort((a, b) =>
                        Buffer.compare(
                          Buffer.from(
                            `${a.kind}\0${a.sink_id}\0${a.opaque_handle}\0${a.sha256}\0${a.size_bytes}`,
                          ),
                          Buffer.from(
                            `${b.kind}\0${b.sink_id}\0${b.opaque_handle}\0${b.sha256}\0${b.size_bytes}`,
                          ),
                        ),
                      );
                    if (
                      artifacts.length === 0 ||
                      receipts.size !== artifacts.length + 1 ||
                      !same(manifest, {
                        schemaVersion: '1.0.0',
                        kind: 'release-artifact-sink-commit-manifest',
                        sink_id: store.sinkId,
                        transaction_handle: transaction,
                        ...expectedBegin,
                        artifacts,
                      })
                    )
                      fail();
                    for (const receipt of receipts.values()) {
                      if (!same(receiptFor(receipt.opaque_handle), receipt)) fail();
                      readObject(receipt);
                    }
                    const marker = {
                      committed: true as const,
                      sink_id: store.sinkId,
                      transaction_handle: transaction,
                      committed_manifest_handle: value.opaque_handle,
                      committed_manifest_sha256: value.sha256,
                      committed_manifest_size_bytes: value.size_bytes,
                      commit_protocol: 'devai.artifact-sink.two-phase.v1' as const,
                    };
                    terminal = true;
                    store.install(join(directory, 'commit.json'), bytes(marker));
                    committed(value.opaque_handle);
                    didCommit = true;
                    return marker;
                  }),
                );
              },
              abort() {
                return guard(() =>
                  authority.invokeSink(() => {
                    if (terminal) fail();
                    terminal = true;
                    store.install(
                      join(directory, 'abort.json'),
                      bytes({
                        sink_id: store.sinkId,
                        transaction_handle: transaction,
                        aborted: true,
                      }),
                    );
                  }),
                );
              },
            });
          }),
        );
      },
    });
  });
}
