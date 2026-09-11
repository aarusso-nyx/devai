import { createHash } from 'node:crypto';
import {
  chmodSync,
  renameSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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

describe('CLI shard 07 release content-store custody', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  afterAll(() => repositoryFixture.dispose());

  it('installs bytes exactly at the limit into the staging and object directories', async () => {
    const f = fixture();
    const bytes = Buffer.alloc(1024, 0x61);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const path = f.store.objectPath(digest);
    expect(path).toBe(join(f.root, 'objects', digest));
    await inPrepare(f.owner, () => f.store.install(path, bytes));
    expect(f.store.read(path)).toEqual(bytes);
    expect(f.store.list(join(f.root, 'staging'))).toHaveLength(1);
    expect(f.store.list(join(f.root, 'objects')).map((entry) => entry.name)).toEqual([digest]);
  });

  it('rejects repository/store overlap and traversal while preserving separate roots', async () => {
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
    await expect(
      inPrepare(f.owner, () => f.store.install(join(f.root, '..', 'escape'), Buffer.from('x'))),
    ).rejects.toThrow('release-content-store-fixture-failure');
    await expect(
      inPrepare(f.owner, () => f.store.ensureDirectory(join(f.root, '..'))),
    ).rejects.toThrow('release-content-store-fixture-failure');
  });

  it.each(['root', 'repository'] as const)('rejects a relative %s path', (kind) => {
    const f = fixture();
    expect(() =>
      createDurableReleaseContentStore(
        {
          root: kind === 'root' ? relative(process.cwd(), f.root) : f.root,
          sink_id: binding.sink_id,
          repository_roots: [
            kind === 'repository' ? relative(process.cwd(), f.repositoryRoot) : f.repositoryRoot,
          ],
          max_blob_bytes: 1024,
        },
        () => {
          throw new Error('release-content-store-fixture-failure');
        },
        createProtectedReleaseSinkOwner('artifact', binding.sink_id),
      ),
    ).toThrow('release-content-store-fixture-failure');
  });

  it('requires the store root to belong to the current uid', () => {
    const f = fixture();
    const getuid = process.getuid;
    if (getuid === undefined) {
      throw new Error('release-content-store fixture requires uid support');
    }
    vi.spyOn(process, 'getuid').mockReturnValue(getuid() + 1);
    expect(() =>
      createDurableReleaseContentStore(
        {
          root: f.root,
          sink_id: binding.sink_id,
          repository_roots: [f.repositoryRoot],
          max_blob_bytes: 1024,
        },
        () => {
          throw new Error('release-content-store-fixture-failure');
        },
        createProtectedReleaseSinkOwner('artifact', binding.sink_id),
      ),
    ).toThrow('release-content-store-fixture-failure');
  });

  it('rejects one-way repository containment', () => {
    const f = fixture();
    expect(() =>
      createDurableReleaseContentStore(
        {
          root: f.root,
          sink_id: binding.sink_id,
          repository_roots: [f.parent],
          max_blob_bytes: 1024,
        },
        () => {
          throw new Error('release-content-store-fixture-failure');
        },
        createProtectedReleaseSinkOwner('artifact', binding.sink_id),
      ),
    ).toThrow('release-content-store-fixture-failure');
  });

  it('accepts the one-byte limit and refuses empty repository custody', () => {
    const f = fixture();
    const oneByteStore = createDurableReleaseContentStore(
      {
        root: f.root,
        sink_id: binding.sink_id,
        repository_roots: [f.repositoryRoot],
        max_blob_bytes: 1,
      },
      () => {
        throw new Error('release-content-store-fixture-failure');
      },
      createProtectedReleaseSinkOwner('artifact', binding.sink_id),
    );
    expect(oneByteStore.limit).toBe(1);
    expect(() =>
      createDurableReleaseContentStore(
        {
          root: f.root,
          sink_id: binding.sink_id,
          repository_roots: [],
          max_blob_bytes: 1,
        },
        () => {
          throw new Error('release-content-store-fixture-failure');
        },
        createProtectedReleaseSinkOwner('artifact', binding.sink_id),
      ),
    ).toThrow('release-content-store-fixture-failure');
  });

  it('rejects overlap when any one of several repository roots overlaps', () => {
    const f = fixture();
    const separate = ownedRoot('release-content-separate-repository');
    expect(() =>
      createDurableReleaseContentStore(
        {
          root: f.root,
          sink_id: binding.sink_id,
          repository_roots: [separate, f.root],
          max_blob_bytes: 1024,
        },
        () => {
          throw new Error('release-content-store-fixture-failure');
        },
        createProtectedReleaseSinkOwner('artifact', binding.sink_id),
      ),
    ).toThrow('release-content-store-fixture-failure');
  });

  it('rejects a symlink in a configured repository ancestor', () => {
    const f = fixture();
    const target = ownedRoot('release-content-repository-target');
    const link = join(f.parent, 'repository-link');
    symlinkSync(target, link, 'dir');
    expect(() =>
      createDurableReleaseContentStore(
        {
          root: f.root,
          sink_id: binding.sink_id,
          repository_roots: [link],
          max_blob_bytes: 1024,
        },
        () => {
          throw new Error('release-content-store-fixture-failure');
        },
        createProtectedReleaseSinkOwner('artifact', binding.sink_id),
      ),
    ).toThrow('release-content-store-fixture-failure');
  });

  it('detects root permission and inode changes after construction', () => {
    const permission = fixture();
    chmodSync(permission.root, 0o755);
    expect(() => permission.store.checkRoot()).toThrow('release-content-store-fixture-failure');

    const inode = fixture();
    const moved = `${inode.root}-moved`;
    roots.push(moved);
    renameSync(inode.root, moved);
    mkdirSync(inode.root, { mode: 0o700 });
    expect(() => inode.store.checkRoot()).toThrow('release-content-store-fixture-failure');
  });

  it('detects a root ancestor replaced by a symlink', () => {
    const f = fixture();
    const moved = `${f.parent}-moved`;
    roots.push(moved);
    renameSync(f.parent, moved);
    symlinkSync(moved, f.parent, 'dir');
    expect(() => f.store.checkRoot()).toThrow('release-content-store-fixture-failure');
  });

  it('rejects the store root as a directory-install target', () => {
    const f = fixture();
    expect(() => f.store.ensureDirectory(f.root)).toThrow('release-content-store-fixture-failure');
  });

  it('accepts a file exactly at the read limit and rejects a symlink read', () => {
    const f = fixture();
    const exact = join(f.root, 'objects', 'exact');
    writeFileSync(exact, Buffer.alloc(1024));
    expect(f.store.read(exact)).toHaveLength(1024);
    const linked = join(f.root, 'objects', 'linked');
    symlinkSync(exact, linked);
    expect(() => f.store.read(linked)).toThrow('release-content-store-fixture-failure');
  });

  it('accepts hidden in-root directories whose names start with two dots', async () => {
    const f = fixture();
    const hidden = join(f.root, '..retained');
    await inPrepare(f.owner, () => f.store.ensureDirectory(hidden));
    expect(statSync(hidden).isDirectory()).toBe(true);
  });

  it.each([0o755, 0o600])('rejects an existing directory with mode %o', async (mode) => {
    const f = fixture();
    const path = join(f.root, 'bad-directory');
    mkdirSync(path, { mode });
    chmodSync(path, mode);
    await expect(inPrepare(f.owner, () => f.store.ensureDirectory(path))).rejects.toThrow(
      'release-content-store-fixture-failure',
    );
  });

  it('rejects anchored digest prefixes and suffixes', () => {
    const f = fixture();
    expect(() => f.store.objectPath(`x${'a'.repeat(64)}`)).toThrow(
      'release-content-store-fixture-failure',
    );
    expect(() => f.store.objectPath(`${'a'.repeat(64)}x`)).toThrow(
      'release-content-store-fixture-failure',
    );
  });
});
