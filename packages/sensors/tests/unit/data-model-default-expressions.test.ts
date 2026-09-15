import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryDataModel } from '../../src/inventory-data-model.js';

const NOW = '2026-09-09T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-model-boundaries-'));
  mkdirSync(join(root, 'db/migrations'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function sense(sql: string) {
  writeFileSync(join(root, 'db/migrations/001.sql'), sql);
  return senseInventoryDataModel({
    repoRoot: root,
    migrationDirs: ['db/migrations'],
    persistBody: false,
    now: NOW,
  });
}

describe('SQL nested default expression retention', () => {
  it.each([
    ['round((1.25)::numeric, 2)', ' NOT NULL', false],
    ['coalesce(round(1.25, 2), 0)', '', true],
    ['42', ' NOT NULL', false],
    ['NULL', '', true],
    ["'comma, NOT NULL UNIQUE ) and ''quote'", '', true],
    ["concat('a,b', lower('NOT NULL'))", '', true],
  ])('retains %s and subsequent columns', (expression, suffix, nullable) => {
    const result = sense(`CREATE TABLE metrics (
      sample numeric DEFAULT ${expression}${suffix},
      next_column integer
    );`);
    expect(result.reading.status).toBe('pass');
    expect(result.body.tables[0]?.columns).toEqual([
      { name: 'sample', type: 'numeric', nullable, default: expression },
      { name: 'next_column', type: 'integer', nullable: true },
    ]);
  });
});
