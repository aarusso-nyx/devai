import { describe, expect, it } from 'vitest';
import {
  boundaryApi,
  dbTarget,
  expectBoundaryFailure,
  gitTarget,
  remoteTarget,
} from './authority-boundary-testkit.js';
import { REPOSITORY_ID, fsTarget } from './authority-runtime-testkit.js';

// Invariants: INV-AUTH-002, INV-AUTH-003

describe('R19 filesystem resource classification', () => {
  it.each([
    ['leading slash', '/packages/core/src/index.ts'],
    ['parent traversal', 'packages/core/../secrets'],
    ['backslash', 'packages\\core\\src\\index.ts'],
    ['NUL', 'packages/core/src/index.ts\0escape'],
    ['repeated slash', 'packages//core/src/index.ts'],
    ['trailing slash', 'packages/core/src/'],
  ])('refuses %s before filesystem access', async (_name, path) => {
    const api = await boundaryApi();
    const result = api.classifyAuthorityResource({
      ...fsTarget,
      id: `fs:${path}`,
      canonical_relative_path: path,
    });
    expectBoundaryFailure(result, 'usage-error', 'AUTHORITY_FS_TARGET_INVALID');
  });

  it('refuses a path that realpath resolves outside repository containment', async () => {
    const api = await boundaryApi();
    const result = api.classifyAuthorityResource(fsTarget, {
      repository_root: '/workspace/devai',
      realpath: () => '/private/outside/index.ts',
    });
    expectBoundaryFailure(result, 'refused', 'AUTHORITY_FS_SYMLINK_ESCAPE');
  });

  it('requires independent authorization of rename source and destination', async () => {
    const api = await boundaryApi();
    const result = api.classifyAuthorityResource({
      kind: 'fs-rename',
      repository_id: REPOSITORY_ID,
      operation: 'rename',
      source: {
        id: 'fs:packages/core/src/old.ts',
        canonical_relative_path: 'packages/core/src/old.ts',
      },
      destination: {
        id: 'fs:docs/framework/new.ts',
        canonical_relative_path: 'docs/framework/new.ts',
      },
    });
    expectBoundaryFailure(result, 'refused', 'AUTHORITY_RENAME_DESTINATION_DENIED');
  });

  it('classifies an exact atomic filesystem target without widening its plan', async () => {
    const api = await boundaryApi();
    const result = api.classifyAuthorityResource(fsTarget);
    expect(result).toMatchObject({
      ok: true,
      value: {
        target: fsTarget,
        atomicity: 'whole-plan',
        adapter_id: 'fs-authority-boundary',
      },
    });
  });
});

describe('R19 Git-ref resource classification', () => {
  it('uses full refs and preserves protected-ref identity', async () => {
    const api = await boundaryApi();
    const result = api.classifyAuthorityResource(gitTarget);
    expect(result).toMatchObject({
      ok: true,
      value: {
        target: gitTarget,
        adapter_id: 'git-ref-authority-boundary',
        protected: true,
      },
    });
  });

  it.each([
    ['short branch name', { ...gitTarget, ref: 'main' }, 'AUTHORITY_GIT_REF_INVALID'],
    [
      'protected delete',
      { ...gitTarget, operation: 'delete' },
      'AUTHORITY_GIT_PROTECTED_REF_DENIED',
    ],
    [
      'protected force push',
      { ...gitTarget, operation: 'force-push' },
      'AUTHORITY_GIT_PROTECTED_REF_DENIED',
    ],
    [
      'merge encoded as generic update',
      { ...gitTarget, operation: 'update', merge: true },
      'AUTHORITY_GIT_OPERATION_INVALID',
    ],
  ])('refuses %s', async (_name, target, code) => {
    const api = await boundaryApi();
    expectBoundaryFailure(api.classifyAuthorityResource(target), 'refused', code);
  });
});

describe('R19 database resource classification', () => {
  it('accepts logical identifiers only', async () => {
    const api = await boundaryApi();
    expect(api.classifyAuthorityResource(dbTarget)).toMatchObject({
      ok: true,
      value: { target: dbTarget, adapter_id: 'db-authority-boundary' },
    });
  });

  it.each([
    ['connection URL', { ...dbTarget, connection_id: 'postgresql://user:secret@db/devai' }],
    ['password field', { ...dbTarget, password: 'secret' }],
    ['SQL payload', { ...dbTarget, sql: 'DROP TABLE users' }],
  ])('rejects secret-bearing or executable %s', async (_name, target) => {
    const api = await boundaryApi();
    expectBoundaryFailure(
      api.classifyAuthorityResource(target),
      'usage-error',
      'AUTHORITY_DB_TARGET_SECRET_OR_PAYLOAD',
    );
  });

  it.each(['ddl', 'execute'])('preserves the explicit %s operation boundary', async (operation) => {
    const api = await boundaryApi();
    expect(api.classifyAuthorityResource({ ...dbTarget, operation })).toMatchObject({
      ok: true,
      value: { target: { operation } },
    });
  });
});

describe('R19 remote resource classification', () => {
  it('uses semantic system/endpoint/operation IDs and remote-write posture', async () => {
    const api = await boundaryApi();
    expect(api.classifyAuthorityResource(remoteTarget)).toMatchObject({
      ok: true,
      value: { target: remoteTarget, adapter_id: 'remote-authority-boundary' },
    });
  });

  it.each([
    ['credential URL', { ...remoteTarget, endpoint_id: 'https://token@example.invalid/api' }],
    ['generic operation', { ...remoteTarget, operation: 'invoke' }],
    ['missing operation_id', { ...remoteTarget, operation_id: undefined }],
  ])('rejects %s', async (_name, target) => {
    const api = await boundaryApi();
    expectBoundaryFailure(
      api.classifyAuthorityResource(target),
      'usage-error',
      'AUTHORITY_REMOTE_TARGET_INVALID',
    );
  });

  it('requires independent allow-publish consent before classification succeeds', async () => {
    const api = await boundaryApi();
    expectBoundaryFailure(
      api.classifyAuthorityResource(remoteTarget, {
        consent: { write: true, allow_publish: false, experimental: false },
      }),
      'refused',
      'AUTHORITY_PUBLISH_CONSENT_REQUIRED',
    );
  });
});
