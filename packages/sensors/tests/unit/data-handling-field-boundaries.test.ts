import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataHandling } from '../../src/inventory-data-handling.js';

const now = '2026-09-09T12:00:00.000Z';
let root = '';

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
          columns: names.map((name) => ({ name, type: 'text' })),
          evidence: [{ path: 'db/migrations/0001_accounts.sql', startLine: 1, endLine: 30 }],
        },
      ],
    }),
  );
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-handling-fields-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('data-handling field-name boundaries', () => {
  it('classifies exact sensitive names while rejecting merely containing-name variants', () => {
    const names = [
      'email',
      'billing_email_archive',
      'phone',
      'myphone',
      'work_phone_archive',
      'telephone',
      'home_telephone',
      'telephone_archive',
      'cellphone',
      'home_cellphone',
      'cellphone_archive',
      'whatsapp',
      'home_whatsapp',
      'whatsapp_archive',
      'account_label',
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
      { name: 'email', type: 'text', pii_class: 'contact' },
      { name: 'billing_email_archive', type: 'text' },
      { name: 'phone', type: 'text', pii_class: 'contact' },
      { name: 'myphone', type: 'text' },
      { name: 'work_phone_archive', type: 'text' },
      { name: 'telephone', type: 'text', pii_class: 'contact' },
      { name: 'home_telephone', type: 'text' },
      { name: 'telephone_archive', type: 'text' },
      { name: 'cellphone', type: 'text', pii_class: 'contact' },
      { name: 'home_cellphone', type: 'text' },
      { name: 'cellphone_archive', type: 'text' },
      { name: 'whatsapp', type: 'text', pii_class: 'contact' },
      { name: 'home_whatsapp', type: 'text' },
      { name: 'whatsapp_archive', type: 'text' },
      { name: 'account_label', type: 'text' },
    ]);
  });
});
