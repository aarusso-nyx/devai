import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataHandling } from '../../src/inventory-data-handling.js';

const now = '2026-09-09T12:00:00.000Z';
let root = '';

const permissionFlags = new Set([
  'can_view_diagnosis',
  'diagnosis_enabled',
  'can_view_medical_record',
  'medical_record_enabled',
  'can_view_prescription',
  'prescription_enabled',
  'can_view_blood_type',
  'blood_type_enabled',
  'can_view_allergies',
  'allergies_enabled',
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
          name: 'patients',
          columns: names.map((name) => ({
            name,
            type: permissionFlags.has(name) ? 'boolean' : 'text',
          })),
          evidence: [{ path: 'db/migrations/0001_patients.sql', startLine: 1, endLine: 30 }],
        },
      ],
    }),
  );
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-handling-health-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('data-handling health-name boundaries', () => {
  it('classifies exact health fields while rejecting boolean permission lookalikes', () => {
    const names = [
      'diagnosis',
      'can_view_diagnosis',
      'diagnosis_enabled',
      'medical_record',
      'can_view_medical_record',
      'medical_record_enabled',
      'prescription',
      'can_view_prescription',
      'prescription_enabled',
      'blood_type',
      'can_view_blood_type',
      'blood_type_enabled',
      'allergies',
      'can_view_allergies',
      'allergies_enabled',
      'patient_permission',
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
      { name: 'diagnosis', type: 'text', pii_class: 'health' },
      { name: 'can_view_diagnosis', type: 'boolean' },
      { name: 'diagnosis_enabled', type: 'boolean' },
      { name: 'medical_record', type: 'text', pii_class: 'health' },
      { name: 'can_view_medical_record', type: 'boolean' },
      { name: 'medical_record_enabled', type: 'boolean' },
      { name: 'prescription', type: 'text', pii_class: 'health' },
      { name: 'can_view_prescription', type: 'boolean' },
      { name: 'prescription_enabled', type: 'boolean' },
      { name: 'blood_type', type: 'text', pii_class: 'health' },
      { name: 'can_view_blood_type', type: 'boolean' },
      { name: 'blood_type_enabled', type: 'boolean' },
      { name: 'allergies', type: 'text', pii_class: 'health' },
      { name: 'can_view_allergies', type: 'boolean' },
      { name: 'allergies_enabled', type: 'boolean' },
      { name: 'patient_permission', type: 'text' },
    ]);
  });
});
