import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  createProtectedArtifactSinkAdapter,
  createProtectedReleaseSinkOwner,
  protectedArtifactSinkHostEffect,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { canonicalSha256 } from '@devai-nyx/utils';
import { createReleaseRepositoryTestFixture } from '../../../authority/tests/unit/release-repository-test-fixture.js';
import { createDurableReleaseContentStore } from '../../src/services/release-content-store.js';

import { afterAll, afterEach, describe, expect, it } from 'vitest';
const repositoryFixture = createReleaseRepositoryTestFixture();
const roots: string[] = [];
const binding = {
  action_id: 'release prepare' as const,
  repository: repositoryFixture.repository,
  plan_receipt_digest_sha256: 'a'.repeat(64),
  pack_spec_digest_sha256: 'b'.repeat(64),
  sink_id: 'content-store-fixture',
};

function ownedRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

async function inPrepare<T>(owner: object, callback: () => T): Promise<T> {
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'release-content-store-test',
    issuer_version: '1.0.0',
    invocation_id: 'release-content-store-test',
    canonicalSha256,
    randomId: () => 'release-content-store-test-receipt',
    now: () => '2026-09-09T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const adapter = createProtectedArtifactSinkAdapter(binding);
  const scope: AuthorityHostEffectScope = {
    action_id: 'release prepare',
    invocation_id: 'release-content-store-test',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      if (protectedArtifactSinkHostEffect(request)?.kind !== 'artifact-sink')
        throw new Error('fixture protected sink operation required');
      return apply();
    },
  };
  try {
    return await repositoryFixture.run(() =>
      runWithAuthorityHostEffects(scope, () => adapter.invokeSink(callback, owner)),
    );
  } finally {
    issuer.dispose();
  }
}

function fixture() {
  const parent = ownedRoot('release-content-parent');
  const root = join(parent, 'store');
  const repositoryRoot = join(parent, 'repository');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(repositoryRoot, { mode: 0o700 });
  mkdirSync(join(root, 'staging'), { mode: 0o700 });
  mkdirSync(join(root, 'objects'), { mode: 0o700 });
  const owner = createProtectedReleaseSinkOwner('artifact', binding.sink_id);
  const store = createDurableReleaseContentStore(
    { root, sink_id: binding.sink_id, repository_roots: [repositoryRoot], max_blob_bytes: 1024 },
    () => {
      throw new Error('release-content-store-fixture-failure');
    },
    owner,
  );
  return { parent, root, repositoryRoot, store, owner };
}

describe('release content store direct boundaries', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  afterAll(() => repositoryFixture.dispose());

  it('installs digest-addressed bytes idempotently and refuses a different value', async () => {
    const f = fixture();
    const bytes = Buffer.from('owned release bytes\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const path = f.store.objectPath(digest);
    await inPrepare(f.owner, () => f.store.install(path, bytes));
    const before = readFileSync(path);
    await inPrepare(f.owner, () => f.store.install(path, bytes));
    expect(readFileSync(path)).toEqual(before);
    await expect(
      inPrepare(f.owner, () => f.store.install(path, Buffer.from('different'))),
    ).rejects.toThrow('release-content-store-fixture-failure');
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.each(['not-a-digest', 'A'.repeat(64), `${'a'.repeat(63)}-`])(
    'rejects noncanonical object digest %s before path use',
    (digest) => {
      const f = fixture();
      expect(() => f.store.objectPath(digest)).toThrow('release-content-store-fixture-failure');
    },
  );

  it('rejects repository/store overlap and traversal while preserving separate roots', () => {
    const f = fixture();
    expect(f.store.root).not.toBe(f.repositoryRoot);
    expect(() =>
      createDurableReleaseContentStore(
        {
          root: f.root,
          sink_id: binding.sink_id,
          repository_roots: [f.root],
          max_blob_bytes: 1024,
        },
        () => {
          throw new Error('release-content-store-fixture-failure');
        },
        createProtectedReleaseSinkOwner('artifact', binding.sink_id),
      ),
    ).toThrow('release-content-store-fixture-failure');
    expect(() => f.store.install(join(f.root, '..', 'escape'), Buffer.from('x'))).toThrow(
      'release-content-store-fixture-failure',
    );
  });

  it.each(['sink', 'permissions', 'limit'] as const)(
    'rejects invalid %s independently',
    (invalid) => {
      const f = fixture();
      if (invalid === 'permissions') chmodSync(f.root, 0o755);
      expect(() =>
        createDurableReleaseContentStore(
          {
            root: f.root,
            sink_id: invalid === 'sink' ? 'bad/sink' : binding.sink_id,
            repository_roots: [f.repositoryRoot],
            max_blob_bytes: invalid === 'limit' ? 0 : 1024,
          },
          () => {
            throw new Error('release-content-store-fixture-failure');
          },
          createProtectedReleaseSinkOwner('artifact', binding.sink_id),
        ),
      ).toThrow('release-content-store-fixture-failure');
    },
  );
});
