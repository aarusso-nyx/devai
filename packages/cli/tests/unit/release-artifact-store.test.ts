import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  protectedArtifactSinkHostEffect,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { createReleaseArtifactStore } from '../../src/services/release-artifact-store.js';
import {
  RELEASE_PACK_SPEC_DIGEST,
  RELEASE_PACK_SPEC_ID,
  type ArtifactSinkObject,
  type ArtifactSinkObjectReceipt,
} from '../../src/services/release-prepare-kernel.js';

const roots: string[] = [];
const REPOSITORY = { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const SINK_ID = 'fixture-artifact-sink';
const PLAN_DIGEST = 'c'.repeat(64);

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function root(prefix: string): string {
  // macOS commonly exposes /var through a compatibility symlink. The store's
  // no-follow contract deliberately requires a canonical root and ancestors.
  const value = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  roots.push(value);
  chmodSync(value, 0o700);
  return value;
}

function fixture() {
  const artifactRoot = root('devai external artifacts');
  const candidateRoot = root('devai artifact candidate');
  const binding = {
    action_id: 'release prepare' as const,
    repository: REPOSITORY,
    plan_receipt_digest_sha256: PLAN_DIGEST,
    pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
    sink_id: SINK_ID,
  };
  return {
    artifactRoot,
    candidateRoot,
    binding,
    input: {
      root: artifactRoot,
      sink_id: SINK_ID,
      repository_roots: [candidateRoot],
      max_blob_bytes: 1024 * 1024,
      binding,
    },
  };
}

async function invokePrepare<T>(
  binding: ReturnType<typeof fixture>['binding'],
  callback: () => T | Promise<T>,
): Promise<T> {
  let ordinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'release-artifact-store-test',
    issuer_version: '1.0.0',
    invocation_id: 'release-artifact-store-test',
    canonicalSha256,
    randomId: () => `release-artifact-store-${String(++ordinal)}`,
    now: () => '2026-09-03T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'release prepare',
    invocation_id: 'release-artifact-store-test',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      const operation = protectedArtifactSinkHostEffect(request);
      if (
        operation?.kind !== 'artifact-sink' ||
        canonicalJson(operation.binding) !== canonicalJson(binding)
      ) {
        throw new Error('TEST_PROTECTED_ARTIFACT_SINK_OPERATION_REQUIRED');
      }
      return apply();
    },
  };
  try {
    return await runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

function beginInput() {
  return {
    repository: REPOSITORY,
    candidate: { commit: REPOSITORY.commit, tree: REPOSITORY.tree },
    pack_spec_id: RELEASE_PACK_SPEC_ID,
    pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
  } as const;
}

function object(
  kind: ArtifactSinkObject['kind'],
  logicalName: string,
  value: Buffer,
): ArtifactSinkObject {
  return {
    kind,
    logical_name: logicalName,
    bytes: value,
    sha256: sha256(value),
    size_bytes: value.length,
    pack_spec_id: RELEASE_PACK_SPEC_ID,
    pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
  };
}

function identity(value: ArtifactSinkObjectReceipt) {
  return {
    kind: value.kind,
    sink_id: value.sink_id,
    opaque_handle: value.opaque_handle,
    sha256: value.sha256,
    size_bytes: value.size_bytes,
  };
}

function compare(left: ReturnType<typeof identity>, right: ReturnType<typeof identity>): number {
  return Buffer.compare(
    Buffer.from(
      `${left.kind}\0${left.sink_id}\0${left.opaque_handle}\0${left.sha256}\0${left.size_bytes}`,
    ),
    Buffer.from(
      `${right.kind}\0${right.sink_id}\0${right.opaque_handle}\0${right.sha256}\0${right.size_bytes}`,
    ),
  );
}

async function committedFixture() {
  const value = fixture();
  const store = createReleaseArtifactStore(value.input);
  const transaction = await invokePrepare(value.binding, () => store.begin(beginInput()));
  const manifest = await invokePrepare(value.binding, () =>
    transaction.put(
      object('package-manifest', 'package-manifest', Buffer.from('{"name":"fixture"}\n')),
    ),
  );
  const tarball = await invokePrepare(value.binding, () =>
    transaction.put(object('package-tarball', 'package-tarball', Buffer.from('tarball\n'))),
  );
  const sbom = await invokePrepare(value.binding, () =>
    transaction.put(
      object('package-sbom', 'package-sbom', Buffer.from('{"spdxVersion":"SPDX-2.3"}\n')),
    ),
  );
  const artifacts = [manifest, tarball, sbom].map(identity).sort(compare);
  const manifestBytes = Buffer.from(
    canonicalJson({
      schemaVersion: '1.0.0',
      kind: 'release-artifact-sink-commit-manifest',
      sink_id: SINK_ID,
      transaction_handle: transaction.transaction_handle,
      ...beginInput(),
      artifacts,
    }),
    'utf8',
  );
  const committedManifest = await invokePrepare(value.binding, () =>
    transaction.put(object('committed-manifest', 'commit-manifest', manifestBytes)),
  );
  const commit = await invokePrepare(value.binding, () => transaction.commit(committedManifest));
  return {
    ...value,
    store,
    transaction,
    manifest,
    tarball,
    sbom,
    artifacts,
    manifestBytes,
    committedManifest,
    commit,
  };
}

async function refusal(callback: () => unknown | Promise<unknown>): Promise<void> {
  await expect(Promise.resolve().then(callback)).rejects.toThrow(
    'release-artifact-sink-protocol-invalid',
  );
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('durable external release artifact store', () => {
  it('commits the exact complete manifest and reopens committed artifact bytes', async () => {
    const value = await committedFixture();
    expect(value.commit).toMatchObject({
      committed: true,
      sink_id: SINK_ID,
      transaction_handle: value.transaction.transaction_handle,
      committed_manifest_handle: value.committedManifest.opaque_handle,
    });
    expect(value.artifacts).toHaveLength(3);
    expect(value.manifestBytes).toEqual(
      Buffer.from(
        canonicalJson({
          schemaVersion: '1.0.0',
          kind: 'release-artifact-sink-commit-manifest',
          sink_id: SINK_ID,
          transaction_handle: value.transaction.transaction_handle,
          ...beginInput(),
          artifacts: value.artifacts,
        }),
        'utf8',
      ),
    );
    const reopened = createReleaseArtifactStore(value.input);
    expect(
      await reopened.readArtifact({
        sink_id: SINK_ID,
        opaque_handle: value.manifest.opaque_handle,
      }),
    ).toEqual(Buffer.from('{"name":"fixture"}\n'));
    expect(
      await reopened.readArtifact({
        sink_id: SINK_ID,
        opaque_handle: value.committedManifest.opaque_handle,
      }),
    ).toEqual(value.manifestBytes);
  });

  it('never exposes uncommitted or aborted objects to the committed reader', async () => {
    const value = fixture();
    const store = createReleaseArtifactStore(value.input);
    await refusal(() => store.begin(beginInput()));
    const transaction = await invokePrepare(value.binding, () => store.begin(beginInput()));
    const receipt = await invokePrepare(value.binding, () =>
      transaction.put(object('package-manifest', 'pending', Buffer.from('pending'))),
    );
    expect(
      await transaction.readArtifact({ sink_id: SINK_ID, opaque_handle: receipt.opaque_handle }),
    ).toEqual(Buffer.from('pending'));
    await refusal(() =>
      store.readArtifact({ sink_id: SINK_ID, opaque_handle: receipt.opaque_handle }),
    );
    await invokePrepare(value.binding, () => transaction.abort());
    await refusal(() =>
      transaction.readArtifact({ sink_id: SINK_ID, opaque_handle: receipt.opaque_handle }),
    );
    await refusal(() =>
      store.readArtifact({ sink_id: SINK_ID, opaque_handle: receipt.opaque_handle }),
    );
  });

  it('rejects foreign, malformed, duplicate, digest, and size inputs before commit', async () => {
    const value = fixture();
    const store = createReleaseArtifactStore(value.input);
    await refusal(() =>
      invokePrepare(value.binding, () =>
        store.begin({
          ...beginInput(),
          candidate: { commit: 'd'.repeat(40), tree: REPOSITORY.tree },
        }),
      ),
    );
    const transaction = await invokePrepare(value.binding, () => store.begin(beginInput()));
    const valid = object('package-manifest', 'manifest', Buffer.from('manifest'));
    await refusal(() =>
      invokePrepare(value.binding, () => transaction.put({ ...valid, sha256: '0'.repeat(64) })),
    );
    await refusal(() =>
      invokePrepare(value.binding, () =>
        transaction.put({ ...valid, size_bytes: valid.size_bytes + 1 }),
      ),
    );
    await refusal(() =>
      invokePrepare(value.binding, () =>
        transaction.put({ ...valid, logical_name: '../host-path' }),
      ),
    );
    await invokePrepare(value.binding, () => transaction.put(valid));
    await refusal(() => invokePrepare(value.binding, () => transaction.put(valid)));
    await refusal(() => store.readArtifact({ sink_id: SINK_ID, opaque_handle: 'missing' }));
  });

  it('refuses corrupt objects, extra receipts, symlinked objects, and roots contained by a repository', async () => {
    const value = await committedFixture();
    writeFileSync(join(value.artifactRoot, 'objects', value.manifest.sha256), 'corrupt');
    await refusal(() =>
      value.store.readArtifact({ sink_id: SINK_ID, opaque_handle: value.manifest.opaque_handle }),
    );

    const extraReceipt = await committedFixture();
    writeFileSync(
      join(
        extraReceipt.artifactRoot,
        'artifacts',
        extraReceipt.transaction.transaction_handle,
        'receipts',
        'unexpected.json',
      ),
      '{}',
    );
    await refusal(() =>
      extraReceipt.store.readArtifact({
        sink_id: SINK_ID,
        opaque_handle: extraReceipt.manifest.opaque_handle,
      }),
    );

    const symlinkedObject = await committedFixture();
    const objectPath = join(
      symlinkedObject.artifactRoot,
      'objects',
      symlinkedObject.manifest.sha256,
    );
    rmSync(objectPath);
    symlinkSync('../staging', objectPath);
    await refusal(() =>
      symlinkedObject.store.readArtifact({
        sink_id: SINK_ID,
        opaque_handle: symlinkedObject.manifest.opaque_handle,
      }),
    );

    const fresh = fixture();
    const linkRoot = join(fresh.artifactRoot, 'linked-root');
    symlinkSync(fresh.artifactRoot, linkRoot);
    await refusal(() => createReleaseArtifactStore({ ...fresh.input, root: linkRoot }));
    const contained = join(fresh.candidateRoot, 'artifacts');
    mkdirSync(contained, { mode: 0o700 });
    await refusal(() => createReleaseArtifactStore({ ...fresh.input, root: contained }));
    expect(lstatSync(linkRoot).isSymbolicLink()).toBe(true);
  });

  it('makes an uncertain commit terminal without abort or retry', async () => {
    const value = fixture();
    const store = createReleaseArtifactStore(value.input);
    const transaction = await invokePrepare(value.binding, () => store.begin(beginInput()));
    const packageManifest = await invokePrepare(value.binding, () =>
      transaction.put(object('package-manifest', 'manifest', Buffer.from('manifest'))),
    );
    const manifestBytes = Buffer.from(
      canonicalJson({
        schemaVersion: '1.0.0',
        kind: 'release-artifact-sink-commit-manifest',
        sink_id: SINK_ID,
        transaction_handle: transaction.transaction_handle,
        ...beginInput(),
        artifacts: [identity(packageManifest)],
      }),
      'utf8',
    );
    const committedManifest = await invokePrepare(value.binding, () =>
      transaction.put(object('committed-manifest', 'commit-manifest', manifestBytes)),
    );
    writeFileSync(
      join(value.artifactRoot, 'artifacts', transaction.transaction_handle, 'commit.json'),
      'conflicting evidence',
    );
    await refusal(() => invokePrepare(value.binding, () => transaction.commit(committedManifest)));
    await refusal(() => invokePrepare(value.binding, () => transaction.commit(committedManifest)));
    await refusal(() => invokePrepare(value.binding, () => transaction.abort()));
    expect(
      readFileSync(
        join(value.artifactRoot, 'artifacts', transaction.transaction_handle, 'commit.json'),
        'utf8',
      ),
    ).toBe('conflicting evidence');
  });
});
