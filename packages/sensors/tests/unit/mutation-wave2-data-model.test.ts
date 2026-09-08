import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  senseInventoryDataModel,
  type InventoryDataModelOptions,
} from '../../src/inventory-data-model.js';

let root: string;
const now = '2026-09-08T12:00:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-wave2-data-model-'));
  mkdirSync(join(root, 'db/migrations'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeMigration(name: string, sql: string): void {
  writeFileSync(join(root, 'db/migrations', name), sql);
}

function sense(options: Partial<InventoryDataModelOptions> = {}) {
  return senseInventoryDataModel({
    repoRoot: root,
    migrationDirs: ['db/migrations'],
    persistBody: false,
    now,
    ...options,
  });
}

describe('wave2 data-model parser boundaries', () => {
  it('normalizes punctuation in inline annotations and ignores empty values', () => {
    writeMigration(
      '0001_annotations.sql',
      `CREATE TABLE accounts (
  id bigint NOT NULL PRIMARY KEY,
  email text, -- @pii_class: contact, -- @legal_basis: contract;
  empty_note text -- @retention:
);\n`,
    );

    const result = sense();
    const columns = result.body.tables[0]?.columns;

    expect(result.reading.status).toBe('pass');
    expect(columns?.find((column) => column.name === 'email')).toEqual({
      name: 'email',
      type: 'text',
      nullable: true,
      pii_class: 'contact',
      legal_basis: 'contract',
    });
    expect(columns?.find((column) => column.name === 'empty_note')).toEqual({
      name: 'empty_note',
      type: 'text',
      nullable: true,
    });
  });

  it('projects registry aliases when the INSERT column order is arbitrary', () => {
    writeMigration(
      '0001_tables.sql',
      `CREATE TABLE accounts (
  id bigint NOT NULL PRIMARY KEY,
  email text,
  note text
);\n`,
    );
    writeMigration(
      '0002_registry.sql',
      `INSERT INTO pii_map (class, "column", table, category_unused) VALUES
  ('contact', 'email', 'accounts', 'ignored');
INSERT INTO pii_map (retention_period, "column", table, class) VALUES
  ('P1Y', 'note', 'accounts', 'internal');\n`,
    );

    const result = sense({ piiRegistryTable: 'pii_map' });
    const table = result.body.tables[0];

    expect(table?.columns.find((column) => column.name === 'email')).toEqual({
      name: 'email',
      type: 'text',
      nullable: true,
      pii_class: 'contact',
    });
    expect(table?.columns.find((column) => column.name === 'note')).toEqual({
      name: 'note',
      type: 'text',
      nullable: true,
      pii_class: 'internal',
      retention: 'P1Y',
    });
  });

  it('retains registry metadata when its recognized fields occur at position zero', () => {
    writeMigration(
      '0001_tables.sql',
      `CREATE TABLE accounts (
  id bigint NOT NULL PRIMARY KEY,
  email text,
  phone text
);\n`,
    );
    writeMigration(
      '0002_registry.sql',
      `INSERT INTO pii_map (legal_basis, table_name, column_name, category) VALUES
  ('contract', 'accounts', 'email', 'contact');
INSERT INTO pii_map (retention, table_name, column_name, category) VALUES
  ('P2Y', 'accounts', 'phone', 'contact');\n`,
    );

    const result = sense({ piiRegistryTable: 'pii_map' });
    const table = result.body.tables[0];

    expect(table?.columns.find((column) => column.name === 'email')).toMatchObject({
      pii_class: 'contact',
      legal_basis: 'contract',
    });
    expect(table?.columns.find((column) => column.name === 'phone')).toMatchObject({
      pii_class: 'contact',
      retention: 'P2Y',
    });
  });

  it('joins a schema-qualified registry row to the matching table only', () => {
    writeMigration(
      '0001_tables.sql',
      `CREATE TABLE app.accounts (
  id bigint NOT NULL PRIMARY KEY,
  email text
);
CREATE TABLE audit.accounts (
  id bigint NOT NULL PRIMARY KEY,
  email text
);\n`,
    );
    writeMigration(
      '0002_registry.sql',
      `INSERT INTO pii_map (schema, table, column, category) VALUES
  ('app', 'accounts', 'email', 'contact');\n`,
    );

    const result = sense({ piiRegistryTable: 'pii_map' });
    const appAccounts = result.body.tables.find((table) => table.schema === 'app');
    const auditAccounts = result.body.tables.find((table) => table.schema === 'audit');

    expect(appAccounts?.columns.find((column) => column.name === 'email')?.pii_class).toBe(
      'contact',
    );
    expect(
      auditAccounts?.columns.find((column) => column.name === 'email')?.pii_class,
    ).toBeUndefined();
  });

  it('does not invent PII metadata when a registry row supplies only its join key', () => {
    writeMigration(
      '0001_tables.sql',
      `CREATE TABLE accounts (
  id bigint NOT NULL PRIMARY KEY,
  email text
);\n`,
    );
    writeMigration(
      '0002_registry.sql',
      `INSERT INTO pii_map (table_name, column_name) VALUES
  ('accounts', 'email');\n`,
    );

    const result = sense({ piiRegistryTable: 'pii_map' });
    expect(result.body.tables[0]?.columns.find((column) => column.name === 'email')).toEqual({
      name: 'email',
      type: 'text',
      nullable: true,
    });
  });

  it('ignores registry rows for unknown tables and columns while retaining real tables', () => {
    writeMigration(
      '0001_tables.sql',
      `CREATE TABLE accounts (
  id bigint NOT NULL PRIMARY KEY,
  email text
);\n`,
    );
    writeMigration(
      '0002_registry.sql',
      `INSERT INTO pii_map (table_name, column_name, category) VALUES
  ('missing', 'email', 'contact'),
  ('accounts', 'missing', 'contact');\n`,
    );

    const result = sense({ piiRegistryTable: 'pii_map' });
    expect(result.body.tables).toHaveLength(1);
    expect(
      result.body.tables[0]?.columns.find((column) => column.name === 'email')?.pii_class,
    ).toBeUndefined();
  });

  it('preserves recognized annotations while ignoring unknown annotation keys', () => {
    writeMigration(
      '0001_annotations.sql',
      `CREATE TABLE accounts (
  id bigint NOT NULL PRIMARY KEY,
  email text, -- @pii_class: contact -- @owner: security
  phone text -- @retention: P1Y
);\n`,
    );

    const result = sense();
    const columns = result.body.tables[0]?.columns;
    expect(columns?.find((column) => column.name === 'email')).toMatchObject({
      name: 'email',
      pii_class: 'contact',
    });
    expect(columns?.find((column) => column.name === 'email')).not.toHaveProperty('owner');
    expect(columns?.find((column) => column.name === 'phone')).toMatchObject({
      name: 'phone',
      retention: 'P1Y',
    });
  });

  it('keeps nested expressions inside a table body out of column and constraint splits', () => {
    writeMigration(
      '0001_nested.sql',
      `CREATE TABLE events (
  id bigint NOT NULL,
  payload jsonb DEFAULT '{}'::jsonb,
  CONSTRAINT events_pk PRIMARY KEY (id),
  CHECK (position(',' in 'a,b') > 0)
);\n`,
    );

    const result = sense();
    expect(result.body.tables[0]).toMatchObject({
      name: 'events',
      primary_key: ['id'],
      columns: [
        { name: 'id', type: 'bigint', nullable: false },
        {
          name: 'payload',
          type: 'jsonb',
          nullable: true,
          default: "'{}'::jsonb",
        },
      ],
    });
  });
});
