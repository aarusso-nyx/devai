import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataHandling } from '../../src/inventory-data-handling.js';

const NOW = '2026-09-09T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-handling-name-boundaries-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeModel(): string {
  const path = join(root, 'record/proofs/sensors/inventory_data_model/data-model.json');
  const names = [
    'email',
    'preemail',
    'fax',
    'fax_number',
    'passport',
    'passport_number',
    'national_id',
    'legacy_national_id',
    'address',
    'address_line',
    'ordinary_label',
  ];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      generatedAt: NOW,
      dialect: 'postgres',
      sourceRepo: root,
      tables: [
        {
          name: 'profile',
          columns: names.map((name) => ({ name, type: 'text' })),
          evidence: [{ path: 'db/migrations/001_profile.sql', startLine: 1, endLine: 20 }],
        },
      ],
    })}\n`,
  );
  return path;
}

describe('data-handling exact-name boundaries', () => {
  it('classifies canonical names without admitting prefix or suffix lookalikes', () => {
    const result = senseInventoryDataHandling({
      repoRoot: root,
      dataModelPath: writeModel(),
      persistBody: false,
      now: NOW,
    });
    const columns = result.body?.tables[0]?.columns ?? [];
    const classified = new Map(columns.map((column) => [column.name, column.pii_class]));

    expect(result.reading.status).toBe('pass');
    expect(result.reading.deterministic).toBe(true);
    expect(result.reading).not.toHaveProperty('findings');
    expect(result.reading.metrics).toMatchObject({
      table_count: 1,
      pii_column_count: 5,
      unlabeled_pii_column_count: 5,
    });
    expect(Object.fromEntries(classified)).toMatchObject({
      email: 'contact',
      fax: 'contact',
      passport: 'identity',
      national_id: 'identity',
      address: 'location',
    });
    for (const name of [
      'preemail',
      'fax_number',
      'passport_number',
      'legacy_national_id',
      'address_line',
      'ordinary_label',
    ]) {
      expect(classified.get(name)).toBeUndefined();
    }
  });
});
