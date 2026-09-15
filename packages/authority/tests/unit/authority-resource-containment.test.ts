import { describe, expect, it, vi } from 'vitest';
import { classifyAuthorityResource } from '../../src/boundaries/index.js';
import {
  dbTarget,
  expectBoundaryFailure,
  gitTarget,
  remoteTarget,
} from './authority-boundary-testkit.js';
import { REPOSITORY_ID, fsTarget } from './authority-runtime-testkit.js';

describe('resource identity and containment before effect authorization', () => {
  it.each([
    ['empty', ''],
    ['absolute', '/private'],
    ['credential', 'user@host'],
    ['URL', 'scheme://host'],
    ['backslash', 'a\\b'],
    ['NUL', 'a\0b'],
    ['non-string', 42],
  ])('refuses a %s logical identity in every independent resource field', (_name, value) => {
    const cases = [
      [fsTarget, ['repository_id'], 'usage-error', 'AUTHORITY_FS_TARGET_INVALID'],
      [gitTarget, ['repository_id'], 'refused', 'AUTHORITY_GIT_REF_INVALID'],
      [
        dbTarget,
        ['connection_id', 'database_id', 'object_id'],
        'usage-error',
        'AUTHORITY_DB_TARGET_SECRET_OR_PAYLOAD',
      ],
      [
        remoteTarget,
        ['system_id', 'endpoint_id', 'operation_id'],
        'usage-error',
        'AUTHORITY_REMOTE_TARGET_INVALID',
      ],
    ] as const;
    for (const [base, fields, tag, code] of cases) {
      for (const field of fields) {
        expectBoundaryFailure(classifyAuthorityResource({ ...base, [field]: value }), tag, code);
      }
    }
  });

  it.each([
    'packages/./file',
    'packages/../file',
    'packages/a/../../file',
    'https://host/file',
    'user@host/file',
    '',
  ])('rejects unsafe path %s without consulting the filesystem', (path) => {
    const realpath = vi.fn(() => '/workspace/devai/packages/file');
    expectBoundaryFailure(
      classifyAuthorityResource(
        { ...fsTarget, canonical_relative_path: path },
        {
          repository_root: '/workspace/devai',
          realpath,
        },
      ),
      'usage-error',
      'AUTHORITY_FS_TARGET_INVALID',
    );
    expect(realpath).not.toHaveBeenCalled();
  });

  it.each(['/workspace/devai-sibling/file', '/workspace/devai/../outside/file'])(
    'refuses resolved sibling escape %s',
    (resolved) => {
      expectBoundaryFailure(
        classifyAuthorityResource(
          { ...fsTarget },
          {
            repository_root: '/workspace/devai',
            realpath: () => resolved,
          },
        ),
        'refused',
        'AUTHORITY_FS_SYMLINK_ESCAPE',
      );
    },
  );

  it.each([
    '/workspace/devai',
    '/workspace/devai/packages/../file',
    '/workspace/devai/.private/file',
  ])(
    'accepts normalized repository containment %s without changing the requested target',
    (resolved) => {
      const target = { ...fsTarget };
      const realpath = vi.fn(() => resolved);
      const result = classifyAuthorityResource(target, {
        repository_root: '/workspace/devai/',
        realpath,
      });
      expect(result).toEqual({
        ok: true,
        value: { target, atomicity: 'whole-plan', adapter_id: 'fs-authority-boundary' },
      });
      expect(realpath).toHaveBeenCalledExactlyOnceWith(target.canonical_relative_path);
      expect(Object.isFrozen(target)).toBe(true);
    },
  );

  function rename() {
    return {
      kind: 'fs-rename',
      repository_id: REPOSITORY_ID,
      operation: 'rename',
      source: { id: 'old', canonical_relative_path: 'packages/core/old.ts' },
      destination: { id: 'new', canonical_relative_path: 'packages/core/new.ts' },
    };
  }

  it('keeps both rename endpoints in one immutable atomic plan', () => {
    const target = rename();
    const result = classifyAuthorityResource(target);
    expect(result).toEqual({
      ok: true,
      value: { target, atomicity: 'whole-plan', adapter_id: 'fs-authority-boundary' },
    });
    expect(Object.isFrozen(target.source)).toBe(true);
    expect(Object.isFrozen(target.destination)).toBe(true);
  });

  it.each(['', '/private', 'user@host', 'scheme://host', 'a\\b', 'a\0b', undefined, 42])(
    'refuses an invalid rename repository identity %s even with valid endpoints',
    (repository_id) => {
      expectBoundaryFailure(
        classifyAuthorityResource({ ...rename(), repository_id }),
        'usage-error',
        'AUTHORITY_FS_TARGET_INVALID',
      );
    },
  );

  it.each(['create', 'update', 'delete', 'copy', '', undefined])(
    'refuses to reinterpret a two-endpoint rename as operation %s',
    (operation) => {
      expectBoundaryFailure(
        classifyAuthorityResource({ ...rename(), operation }),
        'usage-error',
        'AUTHORITY_FS_TARGET_INVALID',
      );
    },
  );

  it.each(['create', 'update', 'delete', 'rename'])(
    'preserves filesystem operation %s in the exact immutable target',
    (operation) => {
      const target = { ...fsTarget, operation };
      expect(classifyAuthorityResource(target)).toEqual({
        ok: true,
        value: { target, atomicity: 'whole-plan', adapter_id: 'fs-authority-boundary' },
      });
      expect(Object.isFrozen(target)).toBe(true);
    },
  );

  it.each(['read', 'copy', 'execute', '', undefined, 42])(
    'rejects unsupported filesystem operation %s before path resolution',
    (operation) => {
      const realpath = vi.fn(() => '/workspace/devai/packages/core/file');
      expectBoundaryFailure(
        classifyAuthorityResource(
          { ...fsTarget, operation },
          {
            realpath,
            repository_root: '/workspace/devai',
          },
        ),
        'usage-error',
        'AUTHORITY_FS_TARGET_INVALID',
      );
      expect(realpath).not.toHaveBeenCalled();
    },
  );

  it.each(['source', 'destination'] as const)(
    'validates %s independently before admitting an atomic rename',
    (side) => {
      for (const invalid of [
        undefined,
        { id: '', canonical_relative_path: 'packages/core/file' },
        { id: 'valid', canonical_relative_path: 'packages/core/../file' },
      ]) {
        expectBoundaryFailure(
          classifyAuthorityResource({ ...rename(), [side]: invalid }),
          'usage-error',
          'AUTHORITY_FS_TARGET_INVALID',
        );
      }
      for (const path of ['docs/file', 'packages-sibling/file']) {
        expectBoundaryFailure(
          classifyAuthorityResource({
            ...rename(),
            [side]: { id: 'valid', canonical_relative_path: path },
          }),
          'refused',
          'AUTHORITY_RENAME_DESTINATION_DENIED',
        );
      }
    },
  );

  it('distinguishes publication consent from non-publishing remote writes', () => {
    for (const consent of [
      undefined,
      null,
      false,
      {},
      { allow_publish: false },
      { allow_publish: 'true' },
    ]) {
      expectBoundaryFailure(
        classifyAuthorityResource({ ...remoteTarget, publication: true }, { consent }),
        'refused',
        'AUTHORITY_PUBLISH_CONSENT_REQUIRED',
      );
      expect(
        classifyAuthorityResource({ ...remoteTarget, publication: false }, { consent }).ok,
      ).toBe(true);
    }
    expect(
      classifyAuthorityResource(
        { ...remoteTarget, publication: true },
        { consent: { allow_publish: true } },
      ).ok,
    ).toBe(true);
  });
});
