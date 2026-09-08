import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataModel } from '../../src/inventory-data-model.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-model-default-discovery-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeMigration(relativePath: string, tableName: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `CREATE TABLE ${tableName} (id bigint NOT NULL PRIMARY KEY);\n`);
}

describe('senseInventoryDataModel default migration discovery', () => {
  it('scans each default root once and excludes files outside those roots', () => {
    writeMigration('migrations/0001.sql', 'from_migrations');
    writeMigration('db/migrations/0002.sql', 'from_db_migrations');
    writeMigration('db/0003.sql', 'from_db');
    writeMigration('database/0004.sql', 'from_database');
    writeMigration('rogue.sql', 'outside_default_roots');
    writeMigration('unrelated/0005.sql', 'outside_default_roots_nested');

    const result = senseInventoryDataModel({
      repoRoot: root,
      persistBody: false,
      now: NOW,
    });

    expect(result.reading.status).toBe('pass');
    expect(result.reading.metrics?.migration_file_count).toBe(4);
    expect(result.body.tables.map((table) => table.name)).toEqual([
      'from_database',
      'from_db',
      'from_db_migrations',
      'from_migrations',
    ]);
    expect(
      result.body.tables.flatMap((table) => table.evidence.map((evidence) => evidence.path)),
    ).toEqual([
      'database/0004.sql',
      'db/0003.sql',
      'db/migrations/0002.sql',
      'migrations/0001.sql',
    ]);
  });
});
