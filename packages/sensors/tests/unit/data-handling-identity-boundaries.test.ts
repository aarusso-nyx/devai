import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataHandling } from '../../src/inventory-data-handling.js';

const now = '2026-09-09T12:00:00.000Z';
let root = '';

const permissionFlags = new Set([
  'can_view_full_name',
  'full_name_enabled',
  'can_view_first_name',
  'first_name_enabled',
  'can_view_last_name',
  'last_name_enabled',
  'can_view_birth_date',
  'birth_date_enabled',
  'can_view_dob',
  'dob_enabled',
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
          name: 'profiles',
          columns: names.map((name) => ({
            name,
            type: permissionFlags.has(name) ? 'boolean' : 'text',
          })),
          evidence: [{ path: 'db/migrations/0001_profiles.sql', startLine: 1, endLine: 30 }],
        },
      ],
    }),
  );
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-handling-identity-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('data-handling identity-name boundaries', () => {
  it('classifies exact identity fields while rejecting boolean permission lookalikes', () => {
    const names = [
      'full_name',
      'can_view_full_name',
      'full_name_enabled',
      'first_name',
      'can_view_first_name',
      'first_name_enabled',
      'last_name',
      'can_view_last_name',
      'last_name_enabled',
      'birth_date',
      'can_view_birth_date',
      'birth_date_enabled',
      'dob',
      'can_view_dob',
      'dob_enabled',
      'profile_permission',
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
      { name: 'full_name', type: 'text', pii_class: 'personal' },
      { name: 'can_view_full_name', type: 'boolean' },
      { name: 'full_name_enabled', type: 'boolean' },
      { name: 'first_name', type: 'text', pii_class: 'personal' },
      { name: 'can_view_first_name', type: 'boolean' },
      { name: 'first_name_enabled', type: 'boolean' },
      { name: 'last_name', type: 'text', pii_class: 'personal' },
      { name: 'can_view_last_name', type: 'boolean' },
      { name: 'last_name_enabled', type: 'boolean' },
      { name: 'birth_date', type: 'text', pii_class: 'personal' },
      { name: 'can_view_birth_date', type: 'boolean' },
      { name: 'birth_date_enabled', type: 'boolean' },
      { name: 'dob', type: 'text', pii_class: 'personal' },
      { name: 'can_view_dob', type: 'boolean' },
      { name: 'dob_enabled', type: 'boolean' },
      { name: 'profile_permission', type: 'text' },
    ]);
  });
});
