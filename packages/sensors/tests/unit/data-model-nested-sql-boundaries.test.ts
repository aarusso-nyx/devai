import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataModel } from '../../src/inventory-data-model.js';

let root: string;
const NOW = '2026-09-08T12:00:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-model-nested-sql-'));
  mkdirSync(join(root, 'db/migrations'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(sql: string): void {
  writeFileSync(join(root, 'db/migrations/001.sql'), sql);
}

function sense() {
  return senseInventoryDataModel({
    repoRoot: root,
    migrationDirs: ['db/migrations'],
    persistBody: false,
    now: NOW,
  });
}

describe('data-model nested SQL boundaries', () => {
  it('recognizes IF NOT EXISTS and preserves a qualified table identity', () => {
    put(`CREATE TABLE IF NOT EXISTS app.accounts (
  id bigint NOT NULL,
  email text
);`);

    const result = sense();

    expect(result.reading.status).toBe('pass');
    expect(result.body.tables).toEqual([
      expect.objectContaining({
        schema: 'app',
        name: 'accounts',
        columns: [
          { name: 'id', type: 'bigint', nullable: false },
          { name: 'email', type: 'text', nullable: true },
        ],
      }),
    ]);
  });

  it('keeps nested expressions inside one table and retains raw annotation text', () => {
    put(`CREATE TABLE app.accounts (
  id bigint NOT NULL,
  profile jsonb -- @pii_class: profile
    CHECK (jsonb_typeof(profile) = 'object'),
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE app.audit_log (
  id bigint NOT NULL,
  account_id bigint
);`);

    const result = sense();

    expect(result.reading.status).toBe('pass');
    expect(result.body.tables.map((table) => table.name)).toEqual(['accounts', 'audit_log']);
    expect(result.body.tables[0]).toMatchObject({
      schema: 'app',
      columns: [
        { name: 'id', type: 'bigint', nullable: false },
        { name: 'profile', type: 'jsonb', nullable: true, pii_class: 'profile' },
        {
          name: 'created_at',
          type: 'timestamp with time zone',
          nullable: true,
          default: 'now()',
        },
      ],
    });
    expect(result.body.tables[0]?.evidence).toEqual([
      { path: 'db/migrations/001.sql', startLine: 1, endLine: 6 },
    ]);
  });

  it('accepts compact table headers and isolates annotations for repeated column names', () => {
    put(`CREATE TABLE contacts(
  email text -- @pii_class: contact
);
CREATE TABLE delivery(
  email text -- @pii_class: delivery
);`);
    const result = sense();
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables).toMatchObject([
      { name: 'contacts', columns: [{ name: 'email', pii_class: 'contact' }] },
      { name: 'delivery', columns: [{ name: 'email', pii_class: 'delivery' }] },
    ]);
  });

  it('extracts defaults before supported constraints without truncating the value', () => {
    put(`CREATE TABLE settings (
  enabled boolean DEFAULT false NOT NULL,
  retries integer DEFAULT 0 CHECK (retries >= 0),
  changed_at timestamp with time zone DEFAULT now() REFERENCES events(id)
);`);

    const result = sense();

    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]?.columns).toEqual([
      { name: 'enabled', type: 'boolean', nullable: false, default: 'false' },
      { name: 'retries', type: 'integer', nullable: true, default: '0' },
      {
        name: 'changed_at',
        type: 'timestamp with time zone',
        nullable: true,
        default: 'now()',
      },
    ]);
  });
});
