import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataModel } from '../../src/inventory-data-model.js';

const now = '2026-09-08T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-model-annotation-empty-'));
  mkdirSync(join(root, 'db/migrations'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('data-model annotation value boundaries', () => {
  it('strips terminal punctuation, preserves interior punctuation, and omits empty values', () => {
    writeFileSync(
      join(root, 'db/migrations/0001.sql'),
      `CREATE TABLE accounts (
  email text, -- @pii_class: contact,
  phone text, -- @legal_basis: contract, consent
  address text, -- @retention: contract;note
  empty_note text -- @retention:${' '.repeat(3)}
);
`,
    );

    const result = senseInventoryDataModel({
      repoRoot: root,
      migrationDirs: ['db/migrations'],
      persistBody: false,
      now,
    });

    expect(result.reading.status).toBe('pass');
    const columns = result.body.tables[0]?.columns ?? [];
    expect(columns.find((column) => column.name === 'email')).toMatchObject({
      pii_class: 'contact',
    });
    expect(columns.find((column) => column.name === 'phone')).toMatchObject({
      legal_basis: 'contract, consent',
    });
    expect(columns.find((column) => column.name === 'address')).toMatchObject({
      retention: 'contract;note',
    });
    const emptyNote = columns.find((column) => column.name === 'empty_note');
    expect(emptyNote).toMatchObject({ name: 'empty_note', type: 'text', nullable: true });
    expect(emptyNote).not.toHaveProperty('retention');
  });
});
