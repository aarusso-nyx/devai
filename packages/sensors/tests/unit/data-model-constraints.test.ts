import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataModel } from '../../src/inventory-data-model.js';

let root: string;
const now = '2026-09-07T12:00:00.000Z';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-constraints-'));
  mkdirSync(join(root, 'db/migrations'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function put(sql: string) {
  writeFileSync(join(root, 'db/migrations/001.sql'), sql);
}
function sense(migrationDirs: readonly string[] = ['db/migrations']) {
  return senseInventoryDataModel({ repoRoot: root, migrationDirs, persistBody: false, now });
}

describe('data-model migration constraints', () => {
  it.each([
    ['CASCADE', 'RESTRICT'],
    ['RESTRICT', 'CASCADE'],
    ['SET NULL', 'SET DEFAULT'],
    ['NO ACTION', 'NO ACTION'],
    ['SET DEFAULT', 'SET NULL'],
  ])(
    'extracts both ON DELETE %s and ON UPDATE %s without consuming the next keyword',
    (onDelete, onUpdate) => {
      put(`CREATE TABLE child (
  parent_id bigint,
  tenant_id bigint,
  CONSTRAINT parent_fk FOREIGN KEY (parent_id, tenant_id) REFERENCES parent(id, tenant_id) ON DELETE ${onDelete} ON UPDATE ${onUpdate}
);`);
      const result = sense();
      expect(result.reading.status).toBe('pass');
      expect(result.body.tables[0]?.foreign_keys).toEqual([
        {
          columns: ['parent_id', 'tenant_id'],
          references_table: 'parent',
          references_columns: ['id', 'tenant_id'],
          on_delete: onDelete.toLowerCase(),
          on_update: onUpdate.toLowerCase(),
        },
      ]);
    },
  );

  it('does not count a migration twice when configured roots overlap or repeat', () => {
    put('CREATE TABLE example (id bigint NOT NULL, PRIMARY KEY (id));');
    const result = sense(['db', 'db/migrations', 'db']);
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables.map((table) => table.name)).toEqual(['example']);
  });

  it('does not count default db/migrations twice through the default db root', () => {
    put('CREATE TABLE example (id bigint NOT NULL, PRIMARY KEY (id));');
    const result = senseInventoryDataModel({ repoRoot: root, persistBody: false, now });
    expect(result.body.tables.map((table) => table.name)).toEqual(['example']);
  });

  it('extracts table-level composite keys and unique constraints without treating them as columns', () => {
    put(`CREATE TABLE example (
  tenant_id bigint NOT NULL,
  id bigint NOT NULL,
  email text UNIQUE,
  CONSTRAINT example_pk PRIMARY KEY (tenant_id, id),
  CONSTRAINT example_uq UNIQUE (tenant_id, email),
  CHECK (id > 0)
);`);
    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]).toMatchObject({
      name: 'example',
      primary_key: ['tenant_id', 'id'],
      unique_constraints: [['tenant_id', 'email']],
      columns: [
        { name: 'tenant_id', type: 'bigint', nullable: false },
        { name: 'id', type: 'bigint', nullable: false },
        { name: 'email', type: 'text', nullable: true, unique: true },
      ],
    });
    expect(result.bodyPath).toBeNull();
  });
});

it('retains same-named table declarations from distinct migration files', () => {
  put('CREATE TABLE example (first_id bigint);');
  writeFileSync(join(root, 'db/migrations/002.sql'), 'CREATE TABLE example (second_id bigint);');
  const result = sense(['db', 'db/migrations']);
  expect(result.body.tables).toHaveLength(2);
  expect(result.body.tables.flatMap((table) => table.columns.map((column) => column.name))).toEqual(
    ['first_id', 'second_id'],
  );
});
