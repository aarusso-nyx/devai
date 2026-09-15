import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataModel } from '../../src/inventory-data-model.js';

const now = '2026-09-08T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-registry-column-boundaries-'));
  mkdirSync(join(root, 'db/migrations'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeMigration(name: string, sql: string): void {
  writeFileSync(join(root, 'db/migrations', name), sql);
}

function sense() {
  return senseInventoryDataModel({
    repoRoot: root,
    migrationDirs: ['db/migrations'],
    piiRegistryTable: 'pii_map',
    persistBody: false,
    now,
  });
}

describe('PII registry column-boundary cases', () => {
  it('does not parse an ON CONFLICT target as an additional registry row', () => {
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
  ('accounts', 'email', 'contact')
ON  CONFLICT (table_name, column_name) DO UPDATE
  SET (table_name, column_name, category) = ('accounts', 'email', 'sensitive');\n`,
    );

    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]?.columns).toEqual([
      { name: 'id', type: 'bigint', nullable: false, primary: true },
      { name: 'email', type: 'text', nullable: true, pii_class: 'contact' },
    ]);
  });
});
