import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataHandling } from '../../src/inventory-data-handling.js';

const now = '2026-09-09T12:00:00.000Z';
let root = '';

const permissionFlags = new Set([
  'can_edit_credit_card',
  'credit_card_enabled',
  'can_edit_card_number',
  'card_number_enabled',
  'can_edit_iban',
  'iban_enabled',
  'can_view_account_number',
  'account_number_enabled',
  'can_edit_bank_code',
  'bank_code_enabled',
]);

function writeModel(names: readonly string[]): string {
  const path = join(root, 'record/proofs/sensors/inventory_data_model/data-model.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: '1.0.0',
      generatedAt: '2020-01-01T00:00:00.000Z',
      dialect: 'postgres',
      sourceRepo: root,
      tables: [
        {
          name: 'accounts',
          columns: names.map((name) => ({
            name,
            type: permissionFlags.has(name) ? 'boolean' : 'text',
          })),
          evidence: [{ path: 'db/migrations/0001_accounts.sql', startLine: 1, endLine: 30 }],
        },
      ],
    }),
  );
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-handling-financial-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('data-handling financial-name boundaries', () => {
  it('classifies exact financial fields while rejecting boolean permission lookalikes', () => {
    const names = [
      'credit_card',
      'can_edit_credit_card',
      'credit_card_enabled',
      'card_number',
      'can_edit_card_number',
      'card_number_enabled',
      'iban',
      'can_edit_iban',
      'iban_enabled',
      'account_number',
      'can_view_account_number',
      'account_number_enabled',
      'bank_code',
      'can_edit_bank_code',
      'bank_code_enabled',
      'account_permission',
    ] as const;
    const dataModelPath = writeModel(names);

    const result = senseInventoryDataHandling({
      repoRoot: root,
      dataModelPath,
      persistBody: false,
      now,
    });

    expect(result.reading.status).toBe('pass');
    expect(result.reading.metrics).toMatchObject({
      table_count: 1,
      pii_column_count: 5,
      unlabeled_pii_column_count: 5,
    });
    expect(result.body?.tables[0]?.columns).toEqual([
      { name: 'credit_card', type: 'text', pii_class: 'financial' },
      { name: 'can_edit_credit_card', type: 'boolean' },
      { name: 'credit_card_enabled', type: 'boolean' },
      { name: 'card_number', type: 'text', pii_class: 'financial' },
      { name: 'can_edit_card_number', type: 'boolean' },
      { name: 'card_number_enabled', type: 'boolean' },
      { name: 'iban', type: 'text', pii_class: 'financial' },
      { name: 'can_edit_iban', type: 'boolean' },
      { name: 'iban_enabled', type: 'boolean' },
      { name: 'account_number', type: 'text', pii_class: 'financial' },
      { name: 'can_view_account_number', type: 'boolean' },
      { name: 'account_number_enabled', type: 'boolean' },
      { name: 'bank_code', type: 'text', pii_class: 'financial' },
      { name: 'can_edit_bank_code', type: 'boolean' },
      { name: 'bank_code_enabled', type: 'boolean' },
      { name: 'account_permission', type: 'text' },
    ]);
  });
});
