import { describe, expect, it } from 'vitest';
import {
  resourceValid,
  selectorMatches,
  targetOperation,
} from '../../src/runtime/policy-resolver.js';

const targets: Record<string, Record<string, unknown>> = {
  fs: {
    kind: 'fs',
    id: 'file',
    repository_id: 'repo',
    canonical_relative_path: 'packages/core/index.ts',
    operation: 'update',
  },
  'git-ref': {
    kind: 'git-ref',
    id: 'ref',
    repository_id: 'repo',
    ref: 'refs/heads/main',
    operation: 'update',
  },
  db: {
    kind: 'db',
    id: 'table',
    connection_id: 'control',
    database_id: 'devai',
    object_id: 'table:receipts',
    operation: 'insert',
  },
  remote: {
    kind: 'remote',
    id: 'endpoint',
    system_id: 'registry',
    endpoint_id: 'packages',
    operation_id: 'publish',
    publication: true,
  },
};
const selectors: Record<string, Record<string, unknown>> = {
  fs: {
    kind: 'fs',
    repository_id: 'repo',
    canonical_relative_path_glob: 'packages/**',
    operations: ['update'],
  },
  'git-ref': {
    kind: 'git-ref',
    repository_id: 'repo',
    ref_glob: 'refs/heads/*',
    operations: ['update'],
  },
  db: {
    kind: 'db',
    connection_id: 'control',
    database_id_glob: 'devai',
    object_id_glob: 'table:*',
    operations: ['insert'],
  },
  remote: {
    kind: 'remote',
    system_id: 'registry',
    endpoint_ids: ['packages'],
    operation_ids: ['publish'],
    publication: true,
  },
};
const target = (kind: string) => ({ ...targets[kind] });
const selector = (kind: string) => ({ ...selectors[kind] });

describe('authority resource grammar', () => {
  it.each(Object.keys(targets))(
    'accepts the complete %s resource and resolves its semantic operation',
    (kind) => {
      const value = target(kind);
      expect(resourceValid(value)).toBe(true);
      expect(targetOperation(value)).toBe(kind === 'remote' ? 'publish' : value.operation);
    },
  );
  it.each([null, undefined, 1, 'file', [], {}, { kind: 'unknown', id: 'item' }])(
    'refuses a malformed resource %j',
    (value) => {
      expect(resourceValid(value)).toBe(false);
    },
  );
  it.each(Object.keys(targets))('requires a string identity for %s', (kind) => {
    for (const id of [undefined, null, 1, {}, []])
      expect(resourceValid({ ...target(kind), id })).toBe(false);
  });
  for (const [kind, fields] of Object.entries({
    fs: ['repository_id'],
    'git-ref': ['repository_id', 'ref'],
    db: ['connection_id', 'database_id', 'object_id'],
    remote: ['system_id', 'endpoint_id', 'operation_id'],
  })) {
    for (const field of fields) {
      it.each(['', '/absolute', 'back\\slash', 'nul\0byte', null, undefined, 1])(
        `${kind}.${field} rejects malformed semantic identity %j`,
        (value) => {
          expect(resourceValid({ ...target(kind), [field]: value })).toBe(false);
        },
      );
    }
  }
  it.each([
    '',
    '/root/file',
    './file',
    'a/../file',
    'a/./file',
    'a//file',
    'a/file/',
    'a\\file',
    'a\0file',
  ])('refuses a noncanonical filesystem path %j', (canonical_relative_path) => {
    expect(resourceValid({ ...target('fs'), canonical_relative_path })).toBe(false);
  });
  it.each(['.config/value', 'código/ação.ts', 'space dir/file name.ts'])(
    'accepts canonical path %s',
    (canonical_relative_path) => {
      expect(resourceValid({ ...target('fs'), canonical_relative_path })).toBe(true);
    },
  );
  it.each(['create', 'update', 'delete'])(
    'accepts fs %s only without a rename source',
    (operation) => {
      expect(resourceValid({ ...target('fs'), operation })).toBe(true);
      expect(
        resourceValid({
          ...target('fs'),
          operation,
          rename_from_canonical_relative_path: undefined,
        }),
      ).toBe(false);
      expect(
        resourceValid({
          ...target('fs'),
          operation,
          rename_from_canonical_relative_path: 'old.ts',
        }),
      ).toBe(false);
    },
  );
  it('requires a distinct canonical rename source', () => {
    const rename = { ...target('fs'), operation: 'rename' };
    expect(resourceValid({ ...rename, rename_from_canonical_relative_path: 'old.ts' })).toBe(true);
    for (const path of [undefined, '', '../old.ts', 'packages/core/index.ts'])
      expect(resourceValid({ ...rename, rename_from_canonical_relative_path: path })).toBe(false);
  });
  it.each(['create', 'update', 'delete', 'merge', 'push'])(
    'recognizes git-ref operation %s',
    (operation) => {
      expect(resourceValid({ ...target('git-ref'), operation })).toBe(true);
    },
  );
  it.each(['insert', 'update', 'delete', 'ddl', 'execute'])(
    'recognizes database operation %s',
    (operation) => {
      expect(resourceValid({ ...target('db'), operation })).toBe(true);
    },
  );
  it.each(['fs', 'git-ref', 'db'])('rejects unknown operations for %s', (kind) => {
    for (const operation of ['read', 'publish', '', null, undefined])
      expect(resourceValid({ ...target(kind), operation })).toBe(false);
  });
  it('requires explicit remote publication classification and forbids a second operation channel', () => {
    expect(resourceValid({ ...target('remote'), publication: false })).toBe(true);
    for (const publication of [undefined, null, 'true', 1])
      expect(resourceValid({ ...target('remote'), publication })).toBe(false);
    expect(resourceValid({ ...target('remote'), operation: undefined })).toBe(false);
    expect(resourceValid({ ...target('remote'), operation: 'read' })).toBe(false);
  });
});

describe('authority selector isolation', () => {
  it.each(Object.keys(targets))('matches %s only for its own kind and operation', (kind) => {
    expect(selectorMatches(selector(kind), target(kind))).toBe(true);
    for (const other of Object.keys(targets).filter((item) => item !== kind))
      expect(selectorMatches(selector(other), target(kind))).toBe(false);
    const denied = {
      ...target(kind),
      [kind === 'remote' ? 'operation_id' : 'operation']: 'forbidden',
    };
    expect(selectorMatches(selector(kind), denied)).toBe(false);
    // Classification may identify the resource but never changes its identity boundary.
    expect(selectorMatches(selector(kind), denied, true)).toBe(true);
  });
  it.each([null, undefined, [], {}, { kind: 'unknown' }])(
    'does not match malformed selector %j',
    (value) => {
      expect(selectorMatches(value, target('fs'))).toBe(false);
    },
  );
  for (const [kind, fields] of Object.entries({
    fs: ['repository_id', 'canonical_relative_path_glob'],
    'git-ref': ['repository_id', 'ref_glob'],
    db: ['connection_id', 'database_id_glob', 'object_id_glob'],
    remote: ['system_id', 'endpoint_ids', 'publication'],
  })) {
    for (const field of fields) {
      it(`${kind} cannot match a different ${field}, even during classification`, () => {
        const changed = {
          ...selector(kind),
          [field]:
            field === 'publication'
              ? false
              : field === 'endpoint_ids'
                ? ['different']
                : 'different',
        };
        expect(selectorMatches(changed, target(kind))).toBe(false);
        expect(selectorMatches(changed, target(kind), true)).toBe(false);
      });
    }
  }
  it.each([
    ['packages/**', 'packages/deep/nested/file.ts', true],
    ['packages/*', 'packages/deep/nested/file.ts', false],
    ['packages/*', 'packages/.hidden.ts', true],
    ['packages/*', 'Packages/file.ts', false],
    ['*.ts', 'packages/file.ts', false],
    ['!secret.ts', 'ordinary.ts', false],
    ['!secret.ts', '!secret.ts', true],
    ['#file.ts', '#file.ts', true],
    ['{a,b}.ts', 'a.ts', false],
    ['{a,b}.ts', '{a,b}.ts', true],
    ['+(a|b).ts', 'a.ts', false],
    ['+(a|b).ts', '+(a|b).ts', true],
    ['código/**', 'código/ação.ts', true],
  ] as const)('applies the restricted pattern %s to %s as %s', (pattern, path, expected) => {
    expect(
      selectorMatches(
        { ...selector('fs'), canonical_relative_path_glob: pattern },
        { ...target('fs'), canonical_relative_path: path },
      ),
    ).toBe(expected);
  });
  it.each(['../*', './*', '/absolute/*', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\0b', 'a/'])(
    'refuses unsafe selector path %j',
    (pattern) => {
      expect(
        selectorMatches(
          { ...selector('fs'), canonical_relative_path_glob: pattern },
          { ...target('fs'), canonical_relative_path: pattern },
        ),
      ).toBe(false);
    },
  );
});
