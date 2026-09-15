import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataModel } from '../../src/inventory-data-model.js';

let root: string;
const now = '2026-09-08T12:00:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-wave3-data-model-'));
  mkdirSync(join(root, 'db/migrations'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(sql: string): void {
  writeFileSync(join(root, 'db/migrations/001.sql'), sql);
}

function sense() {
  return senseInventoryDataModel({
    repoRoot: root,
    migrationDirs: ['db/migrations'],
    persistBody: false,
    now,
  });
}

describe('wave3 data-model boundaries', () => {
  it('accepts repeated whitespace in CREATE TABLE headers', () => {
    put(`CREATE  TABLE  IF  NOT  EXISTS  app.users (
  id INT
);`);

    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables).toHaveLength(1);
    expect(result.body.tables[0]).toMatchObject({
      name: 'users',
      schema: 'app',
      columns: [{ name: 'id', type: 'INT', nullable: true }],
    });
  });

  it('normalizes valid repeated whitespace in multi-word column types', () => {
    put(`CREATE TABLE types (
  a timestamp  with  time  zone,
  b double  precision,
  c character  varying(20)
);`);

    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]?.columns).toStrictEqual([
      { name: 'a', type: 'timestamp with time zone', nullable: true },
      { name: 'b', type: 'double precision', nullable: true },
      { name: 'c', type: 'character varying(20)', nullable: true },
    ]);
  });

  it('extracts a table-level primary key with repeated keyword spacing', () => {
    put(`CREATE TABLE accounts (
  id INT,
  tenant INT,
  CONSTRAINT accounts_pk PRIMARY  KEY  (id, tenant)
);`);

    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]?.primary_key).toStrictEqual(['id', 'tenant']);
    expect(result.body.tables[0]?.columns).toHaveLength(2);
  });

  it('extracts a table-level unique constraint with repeated spacing', () => {
    put(`CREATE TABLE accounts (
  id INT,
  email TEXT,
  CONSTRAINT accounts_uq UNIQUE  (id, email)
);`);

    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]?.unique_constraints).toStrictEqual([['id', 'email']]);
    expect(result.body.tables[0]?.columns).toHaveLength(2);
  });

  it('extracts a foreign key when FOREIGN KEY and ON UPDATE use repeated spacing', () => {
    put(`CREATE TABLE child (
  parent_id INT,
  FOREIGN  KEY (parent_id) REFERENCES parent (id) ON DELETE CASCADE  ON UPDATE CASCADE
);`);

    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]?.foreign_keys).toStrictEqual([
      {
        columns: ['parent_id'],
        references_table: 'parent',
        references_columns: ['id'],
        on_delete: 'cascade',
        on_update: 'cascade',
      },
    ]);
  });

  it('normalizes repeated whitespace in supported two-word referential actions', () => {
    put(`CREATE TABLE child (
  parent_id INT,
  FOREIGN KEY (parent_id) REFERENCES parent (id)
    ON DELETE SET  NULL
    ON UPDATE SET  DEFAULT
);
CREATE TABLE audit_child (
  parent_id INT,
  FOREIGN KEY (parent_id) REFERENCES parent (id)
    ON DELETE NO  ACTION
    ON UPDATE NO  ACTION
);`);

    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(
      result.body.tables.find((table) => table.name === 'child')?.foreign_keys?.[0],
    ).toMatchObject({
      on_delete: 'set null',
      on_update: 'set default',
    });
    expect(
      result.body.tables.find((table) => table.name === 'audit_child')?.foreign_keys?.[0],
    ).toMatchObject({
      on_delete: 'no action',
      on_update: 'no action',
    });
  });

  it('keeps unknown referential actions schema-invalid', () => {
    put(`CREATE TABLE child (
  parent_id INT,
  FOREIGN KEY (parent_id) REFERENCES parent (id) ON DELETE BOGUS
);`);

    const result = sense();
    expect(result.reading.status).toBe('error');
    expect(result.reading.findings?.map((finding) => finding.code)).toStrictEqual([
      'DATA_MODEL_SCHEMA_INVALID',
    ]);
    expect(result.body.tables[0]?.foreign_keys?.[0]?.on_delete).toBe('bogus');
  });
});
