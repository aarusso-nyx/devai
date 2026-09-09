import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataHandling } from '../../src/inventory-data-handling.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-handling-technical-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeModel(names: readonly string[]): string {
  const path = join(root, 'record/proofs/sensors/inventory_data_model/data-model.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: '1.0.0',
      generatedAt: '2026-09-08T11:00:00.000Z',
      dialect: 'postgres',
      sourceRepo: root,
      tables: [
        {
          name: 'requests',
          columns: names.map((name) => ({
            name,
            type: ['ip_address', 'remote_addr', 'user_agent'].includes(name) ? 'text' : 'boolean',
          })),
          evidence: [{ path: 'db/migrations/0001_requests.sql', startLine: 1, endLine: 30 }],
        },
      ],
    }),
  );
  return path;
}

describe('data-handling technical field boundaries', () => {
  it('classifies exact technical fields while rejecting prefix and suffix lookalikes', () => {
    const names = [
      'ip_address',
      'remote_addr',
      'user_agent',
      'allow_ip_address',
      'ip_address_enabled',
      'allow_remote_addr',
      'remote_addr_enabled',
      'allow_user_agent',
      'user_agent_enabled',
    ] as const;
    const dataModelPath = writeModel(names);

    const result = senseInventoryDataHandling({
      repoRoot: root,
      dataModelPath,
      persistBody: false,
      now: NOW,
    });

    expect(result.reading).toMatchObject({
      status: 'pass',
      sensor: {
        name: 'inventory:data-handling',
        kind: 'inventory_data_handling',
        version: '1.0.0',
      },
      command: `devai sense data-handling --repo-root ${root}`,
      timestamp: NOW,
      metrics: { table_count: 1, pii_column_count: 3, unlabeled_pii_column_count: 3 },
    });
    expect(result.body?.tables[0]?.columns).toEqual([
      { name: 'ip_address', type: 'text', pii_class: 'ip' },
      { name: 'remote_addr', type: 'text', pii_class: 'ip' },
      { name: 'user_agent', type: 'text', pii_class: 'ip' },
      { name: 'allow_ip_address', type: 'boolean' },
      { name: 'ip_address_enabled', type: 'boolean' },
      { name: 'allow_remote_addr', type: 'boolean' },
      { name: 'remote_addr_enabled', type: 'boolean' },
      { name: 'allow_user_agent', type: 'boolean' },
      { name: 'user_agent_enabled', type: 'boolean' },
    ]);
  });
});
