import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataModel } from '../../src/inventory-data-model.js';

const now = '2026-09-08T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-registry-precedence-values-'));
  mkdirSync(join(root, 'db/migrations'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(relativePath: string, content: string): void {
  writeFileSync(join(root, relativePath), content);
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

describe('PII registry value and precedence boundaries', () => {
  it('omits empty registry metadata instead of fabricating empty properties', () => {
    write(
      'db/migrations/0001.sql',
      `CREATE TABLE accounts (
  id bigint NOT NULL PRIMARY KEY,
  email text
);
INSERT INTO pii_map (table_name, column_name, category, legal_basis, retention) VALUES
  ('accounts', 'email', '', '', '');
`,
    );

    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]?.columns).toEqual([
      { name: 'id', type: 'bigint', nullable: false, primary: true },
      { name: 'email', type: 'text', nullable: true },
    ]);
  });

  it('keeps inline legal basis and retention ahead of registry alternatives', () => {
    write(
      'db/migrations/0001.sql',
      `CREATE TABLE accounts (
  id bigint NOT NULL PRIMARY KEY,
  email text -- @legal_basis: inline-contract -- @retention: P1Y
);
INSERT INTO pii_map (table_name, column_name, category, legal_basis, retention) VALUES
  ('accounts', 'email', 'contact', 'registry-consent', 'P5Y');
`,
    );

    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]?.columns).toContainEqual({
      name: 'email',
      type: 'text',
      nullable: true,
      legal_basis: 'inline-contract',
      retention: 'P1Y',
      pii_class: 'contact',
    });
  });
});
