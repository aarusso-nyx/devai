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
          name: 'locations',
          columns: names.map((name) => ({
            name,
            type: /(?:_enabled|^can_(?:edit|view)_)/.test(name) ? 'boolean' : 'text',
          })),
          evidence: [{ path: 'db/migrations/0001_locations.sql', startLine: 1, endLine: 30 }],
        },
      ],
    }),
  );
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-handling-location-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('data-handling location-name boundaries', () => {
  it('classifies exact location fields while rejecting permission and enabled lookalikes', () => {
    const names = [
      'street',
      'street_enabled',
      'can_view_street',
      'postal_code',
      'postal_code_enabled',
      'can_view_postal_code',
      'zip',
      'zip_enabled',
      'latitude',
      'latitude_enabled',
      'can_view_latitude',
      'longitude',
      'longitude_enabled',
      'can_view_longitude',
      'can_view_zip',
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
      { name: 'street', type: 'text', pii_class: 'location' },
      { name: 'street_enabled', type: 'boolean' },
      { name: 'can_view_street', type: 'boolean' },
      { name: 'postal_code', type: 'text', pii_class: 'location' },
      { name: 'postal_code_enabled', type: 'boolean' },
      { name: 'can_view_postal_code', type: 'boolean' },
      { name: 'zip', type: 'text', pii_class: 'location' },
      { name: 'zip_enabled', type: 'boolean' },
      { name: 'latitude', type: 'text', pii_class: 'location' },
      { name: 'latitude_enabled', type: 'boolean' },
      { name: 'can_view_latitude', type: 'boolean' },
      { name: 'longitude', type: 'text', pii_class: 'location' },
      { name: 'longitude_enabled', type: 'boolean' },
      { name: 'can_view_longitude', type: 'boolean' },
      { name: 'can_view_zip', type: 'boolean' },
    ]);
  });
});
