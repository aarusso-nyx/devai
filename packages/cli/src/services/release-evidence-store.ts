import { createHash, randomUUID } from 'node:crypto';
import { constants, fstatSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import { createProtectedReleaseSinkFilesystem } from '@devai-nyx/authority';
import type {
  CertificationEvidenceTransaction,
  TrustedCertificationEvidenceSink,
} from './release-lifecycle-certification.js';
import {
  finalizeCertificationReceipt,
  type CertificationOutputClosure,
  type CertificationOutputClosureBinding,
} from './release-prepare-kernel.js';
import type { CertificationOutputBlobHandle } from './release-lifecycle-execution.js';

const DIGEST = /^[0-9a-f]{64}$/u;
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TRANSACTION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fail(): never {
  throw new Error('release-certification-generated-output-untrusted');
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

function snapshot<T>(value: T): T {
  return JSON.parse(bytes(value).toString('utf8')) as T;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  );
}

function safeOutputPath(path: string): boolean {
  return (
    typeof path === 'string' &&
    path === path.normalize('NFC') &&
    !path.includes('\\') &&
    !path.includes(':') &&
    ![...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function assertBinding(binding: CertificationOutputClosureBinding): void {
  if (
    !same(binding, {
      repository: binding.repository,
      candidate: binding.candidate,
      task_policy_digest_sha256: binding.task_policy_digest_sha256,
      package_id: binding.package_id,
    }) ||
    !same(binding.repository, {
      id: binding.repository.id,
      commit: binding.repository.commit,
      tree: binding.repository.tree,
    }) ||
    !same(binding.candidate, { commit: binding.candidate.commit, tree: binding.candidate.tree }) ||
    typeof binding.repository.id !== 'string' ||
    binding.repository.id.length === 0 ||
    !GIT_OBJECT.test(binding.candidate.commit) ||
    !GIT_OBJECT.test(binding.candidate.tree) ||
    binding.candidate.commit.length !== binding.candidate.tree.length ||
    binding.repository.commit !== binding.candidate.commit ||
    binding.repository.tree !== binding.candidate.tree ||
    !DIGEST.test(binding.task_policy_digest_sha256) ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(binding.package_id)
  )
    fail();
}

/** Durable host-owned store. Tasks must never receive its root or these capabilities.
 * Mutating methods run only inside the protected sink authority adapter. */
export interface ReleaseCertificationEvidenceStoreOptions {
  readonly root: string;
  readonly evidence_sink_id: string;
  readonly repository_roots: readonly string[];
  readonly max_blob_bytes: number;
}

function createStore(
  input: ReleaseCertificationEvidenceStoreOptions,
): TrustedCertificationEvidenceSink {
  if (
    typeof constants.O_NOFOLLOW !== 'number' ||
    !isAbsolute(input.root) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u.test(input.evidence_sink_id) ||
    !Number.isSafeInteger(input.max_blob_bytes) ||
    input.max_blob_bytes < 1 ||
    input.repository_roots.length === 0
  )
    fail();
  const root = resolve(input.root);
  const sinkId = input.evidence_sink_id;
  const limit = input.max_blob_bytes;
  if (root === parse(root).root) fail();
  const roots = input.repository_roots.map((path) => {
    if (!isAbsolute(path)) fail();
    return resolve(path);
  });
  if (roots.some((path) => within(path, root) || within(root, path))) fail();

  const inspectAncestors = (path: string) => {
    const absolute = resolve(path);
    let current = parse(absolute).root;
    const identities = [];
    for (const part of relative(current, absolute).split(sep)) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) fail();
      identities.push({ path: current, dev: stat.dev, ino: stat.ino });
    }
    return identities;
  };
  const initial = inspectAncestors(root);
  for (const path of roots) inspectAncestors(path);
  const rootStat = lstatSync(root);
  if (
    !rootStat.isDirectory() ||
    (rootStat.mode & 0o777) !== 0o700 ||
    typeof process.getuid !== 'function' ||
    rootStat.uid !== process.getuid()
  )
    fail();
  const { closeSync, fsyncSync, linkSync, mkdirSync, openSync, writeSync } =
    createProtectedReleaseSinkFilesystem(root);
  const checkRoot = () => {
    for (const identity of initial) {
      const stat = lstatSync(identity.path);
      if (stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) fail();
    }
    const stat = lstatSync(root);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== rootStat.uid) fail();
  };
  const assertPath = (path: string) => {
    checkRoot();
    if (!within(root, path) || path === root) fail();
  };
  const read = (path: string): Buffer => {
    assertPath(path);
    const identities = inspectAncestors(path);
    const before = lstatSync(path);
    if (!before.isFile() || before.size > limit) fail();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > limit)
        fail();
      const value = readFileSync(fd);
      if (value.length > limit) fail();
      for (const identity of identities) {
        const current = lstatSync(identity.path);
        if (
          current.isSymbolicLink() ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino
        )
          fail();
      }
      checkRoot();
      return value;
    } finally {
      closeSync(fd);
    }
  };
  const ensureDirectory = (path: string) => {
    assertPath(path);
    inspectAncestors(dirname(path));
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) fail();
    flushDirectory(dirname(path));
    checkRoot();
  };
  const flushDirectory = (path: string) => {
    inspectAncestors(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isDirectory()) fail();
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  // Atomic no-clobber installation. Failed and successful staging bytes remain
  // inspectable; no recovery path edits or removes existing evidence.
  const install = (path: string, value: Buffer) => {
    assertPath(path);
    if (value.length > limit) fail();
    inspectAncestors(dirname(path));
    try {
      if (!read(path).equals(value)) fail();
      const existing = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(existing);
      } finally {
        closeSync(existing);
      }
      flushDirectory(dirname(path));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const stage = join(root, 'staging', randomUUID());
    const fd = openSync(
      stage,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      let offset = 0;
      while (offset < value.length) {
        const written = writeSync(fd, value, offset, value.length - offset, offset);
        if (!Number.isSafeInteger(written) || written <= 0) fail();
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    flushDirectory(dirname(stage));
    if (!read(stage).equals(value)) fail();
    try {
      linkSync(stage, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !read(path).equals(value))
        throw error;
    }
    flushDirectory(dirname(path));
    if (!read(path).equals(value)) fail();
  };
  const objectPath = (sha256: string) => {
    if (!DIGEST.test(sha256)) fail();
    return join(root, 'objects', sha256);
  };
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
  const commits = (): readonly CertificationOutputClosure[] => {
    checkRoot();
    const directory = join(root, 'certification');
    inspectAncestors(directory);
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
      };
      if (
        !same(commit, {
          evidence_sink_id: sinkId,
          transaction_handle: entry.name,
          closures: commit.closures,
        }) ||
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
      closures.push(...commit.closures);
    }
    return closures;
  };
  return Object.freeze<TrustedCertificationEvidenceSink>({
    kind: 'certification-evidence-sink-v3' as const,
    protocol: 'two-phase-content-addressed' as const,
    begin(
      bindings: readonly CertificationOutputClosureBinding[],
    ): CertificationEvidenceTransaction {
      checkRoot();
      const selected = snapshot(bindings);
      if (selected.length === 0) fail();
      selected.forEach(assertBinding);
      if (new Set(selected.map((binding) => canonicalJson(binding))).size !== selected.length)
        fail();
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
          // Commit outcome becomes terminal before the atomic effect: any lost
          // fsync/response requires reading durable state, never abort/retry.
          terminal = true;
          install(
            join(directory, 'commit.json'),
            bytes({ evidence_sink_id: sinkId, transaction_handle: transaction, closures }),
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
): TrustedCertificationEvidenceSink {
  const store = storageBoundary(() => createStore(input));
  return Object.freeze<TrustedCertificationEvidenceSink>({
    kind: store.kind,
    protocol: store.protocol,
    begin(bindings) {
      const transaction = storageBoundary(() => store.begin(bindings));
      if (transaction instanceof Promise) fail();
      return Object.freeze<CertificationEvidenceTransaction>({
        evidence_sink_id: transaction.evidence_sink_id,
        transaction_handle: transaction.transaction_handle,
        put: (input) => storageBoundary(() => transaction.put(input)),
        commit: (input) => storageBoundary(() => transaction.commit(input)),
        abort: () => storageBoundary(() => transaction.abort()),
      });
    },
    readCertificationOutputClosure: (input) =>
      storageBoundary(() => store.readCertificationOutputClosure(input)),
    readCertificationEvidenceReceipt: (input) =>
      storageBoundary(() => store.readCertificationEvidenceReceipt(input)),
    readGeneratedBlob: (input) => storageBoundary(() => store.readGeneratedBlob(input)),
  });
}
