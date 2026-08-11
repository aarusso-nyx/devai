// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// The canonical CLI cannot reach PostgreSQL
// without bound Engineer/write authority and does execute the migration with it.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'packages/cli/dist/runtime/index/bin.js');
const ADMIN_URL =
  process.env['DEVAI_DB_URL'] ??
  `postgresql://${process.env['USER'] ?? 'postgres'}@127.0.0.1:5432/postgres`;
const DATABASE_NAME = `devai_authority_effect_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const databaseUrl = new URL(ADMIN_URL);
databaseUrl.pathname = `/${DATABASE_NAME}`;
const DATABASE_URL = databaseUrl.toString();
const TABLE = 'authority_effect_probe';
const MIGRATION = '001-authority-effect.sql';
const FIXTURE = mkdtempSync(join(tmpdir(), 'devai-authority-effect-postgres-'));
const MIGRATIONS = join(FIXTURE, 'migrations');

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

const requireFromSensors = createRequire(resolve(ROOT, 'packages/sensors/package.json'));
const { Client } = requireFromSensors('pg') as {
  Client: new (options: { readonly connectionString: string }) => PgClient;
};

async function query(
  connectionString: string,
  sql: string,
  values?: readonly unknown[],
): Promise<readonly Record<string, unknown>[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return (await client.query(sql, values)).rows;
  } finally {
    await client.end();
  }
}

function invoke(authorityArgs: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    [
      CLI,
      'sense',
      'migrate',
      '--repo-root',
      FIXTURE,
      '--migrations-dir',
      MIGRATIONS,
      '--database-url',
      DATABASE_URL,
      ...authorityArgs,
      '--format',
      'json',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
      timeout: 30_000,
    },
  );
  return {
    exit: result.status ?? (result.signal === null ? 1 : 128),
    stdout: result.stdout,
    stderr: result.stderr,
    signal: result.signal,
    error: result.error,
  };
}

function bindFixture(extraArgs: readonly string[]) {
  return spawnSync(
    process.execPath,
    [
      CLI,
      'init',
      'bind',
      '--target',
      FIXTURE,
      ...extraArgs,
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ],
    { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 30_000 },
  );
}

async function relation(name: string): Promise<unknown> {
  const rows = await query(DATABASE_URL, 'SELECT to_regclass($1) AS relation', [`public.${name}`]);
  return rows[0]?.['relation'];
}

beforeAll(async () => {
  const psql = spawnSync('psql', ['--version'], { encoding: 'utf8' });
  if (psql.status !== 0) throw new Error('R0007_B4_POSTGRES_PSQL_REQUIRED');
  mkdirSync(MIGRATIONS, { recursive: true });
  writeFileSync(
    join(MIGRATIONS, MIGRATION),
    [
      `CREATE TABLE ${TABLE} (id integer PRIMARY KEY, proof text NOT NULL);`,
      `INSERT INTO ${TABLE}(id, proof) VALUES (1, 'bound-write-authority');`,
      '',
    ].join('\n'),
    'utf8',
  );
  const constitution = bindFixture(['--constitution']);
  if (constitution.status !== 0) {
    throw new Error(`R0007_B4_CONSTITUTION_BIND_FAILED: ${constitution.stderr}`);
  }
  const policy = bindFixture([]);
  if (policy.status !== 0) throw new Error(`R0007_B4_POLICY_BIND_FAILED: ${policy.stderr}`);
  await query(ADMIN_URL, `CREATE DATABASE "${DATABASE_NAME}"`);
});

afterAll(async () => {
  try {
    await query(
      ADMIN_URL,
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [DATABASE_NAME],
    );
    await query(ADMIN_URL, `DROP DATABASE IF EXISTS "${DATABASE_NAME}"`);
  } finally {
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});

describe('PostgreSQL authority/effect acceptance', () => {
  it('refuses missing write consent and wrong-role authority before any DB mutation', async () => {
    const noWrite = invoke(['--as-role', 'engineer']);
    expect(noWrite.error).toBeUndefined();
    expect(noWrite.signal).toBeNull();
    expect(noWrite.exit).not.toBe(0);
    expect(`${noWrite.stdout}${noWrite.stderr}`).toContain('--write');
    expect(await relation(TABLE)).toBeNull();
    expect(await relation('devai_migrations')).toBeNull();

    const wrongRole = invoke(['--as-role', 'auditor', '--write']);
    expect(wrongRole.error).toBeUndefined();
    expect(wrongRole.signal).toBeNull();
    expect(wrongRole.exit).not.toBe(0);
    expect(`${wrongRole.stdout}${wrongRole.stderr}`).toContain('AUTHORITY_HUMAN_ROLE_DENIED');
    expect(await relation(TABLE)).toBeNull();
    expect(await relation('devai_migrations')).toBeNull();
  });

  it('uses bound Engineer/write authority to migrate PostgreSQL and records the exact file', async () => {
    const result = invoke(['--as-role', 'engineer', '--write']);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe('');

    expect(await relation(TABLE)).toBe(TABLE);
    expect(await relation('devai_migrations')).toBe('devai_migrations');
    expect(await query(DATABASE_URL, `SELECT id, proof FROM ${TABLE} ORDER BY id`)).toEqual([
      { id: 1, proof: 'bound-write-authority' },
    ]);
    expect(
      await query(
        DATABASE_URL,
        'SELECT filename FROM devai_migrations WHERE filename = $1 ORDER BY filename',
        [MIGRATION],
      ),
    ).toEqual([{ filename: MIGRATION }]);
  });
});
