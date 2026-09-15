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
          columns: names.map((name) => ({
            name,
            type: name === 'can_change_password' ? 'boolean' : 'text',
          })),
          evidence: [{ path: 'db/migrations/0001_accounts.sql', startLine: 1, endLine: 30 }],
        },
      ],
    }),
  );
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-handling-credentials-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('data-handling credential-name boundaries', () => {
  it('classifies credential names while rejecting prefix and suffix lookalikes', () => {
    const names = [
      'password',
      'password_hash',
      'password_digest',
      'password_hash_archive',
      'can_change_password',
      'secret',
      'nosecret',
      'secret_archive',
      'my_secret_archive',
      'api_key',
      'apikey',
      'prefix_api_key',
      'api_key_archive',
      'token',
      'notoken',
      'token_archive',
      'reset_token',
      'credential_label',
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
      pii_column_count: 8,
      unlabeled_pii_column_count: 8,
    });
    expect(result.body?.tables[0]?.columns).toEqual([
      { name: 'password', type: 'text', pii_class: 'credentials' },
      { name: 'password_hash', type: 'text', pii_class: 'credentials' },
      { name: 'password_digest', type: 'text', pii_class: 'credentials' },
      { name: 'password_hash_archive', type: 'text' },
      { name: 'can_change_password', type: 'boolean' },
      { name: 'secret', type: 'text', pii_class: 'credentials' },
      { name: 'nosecret', type: 'text' },
      { name: 'secret_archive', type: 'text' },
      { name: 'my_secret_archive', type: 'text' },
      { name: 'api_key', type: 'text', pii_class: 'credentials' },
      { name: 'apikey', type: 'text', pii_class: 'credentials' },
      { name: 'prefix_api_key', type: 'text' },
      { name: 'api_key_archive', type: 'text' },
      { name: 'token', type: 'text', pii_class: 'credentials' },
      { name: 'notoken', type: 'text' },
      { name: 'token_archive', type: 'text' },
      { name: 'reset_token', type: 'text', pii_class: 'credentials' },
      { name: 'credential_label', type: 'text' },
    ]);
  });
});
