import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataModel } from '../../src/inventory-data-model.js';

const now = '2026-09-08T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-quoted-annotation-boundaries-'));
  mkdirSync(join(root, 'db/migrations'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeMigration(sql: string): void {
  writeFileSync(join(root, 'db/migrations/0001.sql'), sql);
}

function sense() {
  return senseInventoryDataModel({
    repoRoot: root,
    migrationDirs: ['db/migrations'],
    persistBody: false,
    now,
  });
}

describe('quoted SQL column annotation boundaries', () => {
  it('keeps a mixed-case quoted column name when attaching annotations', () => {
    writeMigration(`CREATE TABLE accounts (
  "EmailAddress" text, -- @pii_class: contact -- @legal_basis: contract
  id bigint
);\n`);

    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]?.columns).toContainEqual({
      name: 'EmailAddress',
      type: 'text',
      nullable: true,
      pii_class: 'contact',
      legal_basis: 'contract',
    });
  });

  it('unescapes doubled quotes before attaching annotations to the column', () => {
    writeMigration(`CREATE TABLE accounts (
  "profile""Email" text, -- @retention: P1Y
  id bigint
);\n`);

    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]?.columns).toContainEqual({
      name: 'profile"Email',
      type: 'text',
      nullable: true,
      retention: 'P1Y',
    });
  });

  it('treats a quoted keyword-looking identifier as a column, while keeping a real constraint separate', () => {
    writeMigration(`CREATE TABLE accounts (
  id bigint,
  "CONSTRAINT" text, -- @pii_class: contact
  CONSTRAINT accounts_pk PRIMARY KEY (id)
);\n`);

    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]).toMatchObject({
      primary_key: ['id'],
      columns: [
        { name: 'id', type: 'bigint' },
        {
          name: 'CONSTRAINT',
          type: 'text',
          nullable: true,
          pii_class: 'contact',
        },
      ],
    });
  });
});
