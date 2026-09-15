import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('../../src/run-command.js', () => ({ runCommand: mocks.runCommand }));

import { senseMigrateCheck } from '../../src/migrate-check.js';

function result(
  stdout = '',
  exit_code = 0,
  stderr = '',
): import('../../src/run-command.js').RunResult {
  return { exit_code, stdout, stderr, duration_ms: 1, killed: false };
}

let root: string;
let migrations: string;

beforeEach(() => {
  mocks.runCommand.mockReset();
  root = mkdtempSync(join(tmpdir(), 'devai-migrate-tracking-'));
  migrations = join(root, 'migrations');
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(migrations, '001.sql'), 'CREATE TABLE accounts (id integer);\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('migration tracking command boundaries', () => {
  it('creates the canonical tracking table with an exact psql command', () => {
    mocks.runCommand.mockImplementation((argv: readonly string[]) => {
      if (argv.includes('SELECT filename, sha256 FROM devai_migrations')) {
        return result('');
      }
      return result();
    });

    const reading = senseMigrateCheck({
      cwd: root,
      migrationsDir: migrations,
      databaseUrl: 'postgres://fixture/db',
      timeoutMs: 4321,
      persistBody: false,
    });

    expect(reading).toMatchObject({
      status: 'pass',
      metrics: { migrations_applied: 1, migrations_total: 1 },
    });
    expect(mocks.runCommand).toHaveBeenCalledWith(
      ['psql', 'postgres://fixture/db', '-v', 'ON_ERROR_STOP=1', '-f', join(migrations, '001.sql')],
      { timeoutMs: 4321 },
    );
    const setup = mocks.runCommand.mock.calls.find(([argv]) =>
      (argv as readonly string[]).some((arg) =>
        arg.includes('CREATE TABLE IF NOT EXISTS devai_migrations'),
      ),
    );
    expect(setup?.[0]).toEqual([
      'psql',
      'postgres://fixture/db',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      expect.stringContaining('CREATE TABLE IF NOT EXISTS devai_migrations'),
    ]);
    expect(setup?.[0][5]).toEqual(expect.stringContaining('filename   TEXT PRIMARY KEY'));
    expect(setup?.[0][5]).toEqual(expect.stringContaining('sha256     TEXT NOT NULL'));
    expect(setup?.[0][5]).toEqual(
      expect.stringContaining('applied_at TIMESTAMPTZ NOT NULL DEFAULT now()'),
    );
  });

  it('loads applied rows with tuples-only unaligned tab-separated psql output', () => {
    const applied = '001.sql\tdeadbeef\n';
    mocks.runCommand.mockImplementation((argv: readonly string[]) => {
      if (argv.includes('SELECT filename, sha256 FROM devai_migrations')) return result(applied);
      if (argv.includes('CREATE TABLE IF NOT EXISTS devai_migrations')) return result();
      return result();
    });

    const reading = senseMigrateCheck({
      cwd: root,
      migrationsDir: migrations,
      databaseUrl: 'postgres://fixture/db',
      timeoutMs: 9876,
      persistBody: false,
    });

    expect(reading).toMatchObject({
      status: 'fail',
      metrics: { migrations_total: 1, migrations_already_applied: 0, migrations_failed: 1 },
    });
    expect(reading.findings?.[0]).toMatchObject({
      code: 'migration_hash_mismatch',
      file: join(migrations, '001.sql'),
    });
    expect(mocks.runCommand).toHaveBeenCalledWith(
      [
        'psql',
        'postgres://fixture/db',
        '-t',
        '-A',
        '-F',
        '\t',
        '-c',
        'SELECT filename, sha256 FROM devai_migrations',
      ],
      { timeoutMs: 9876 },
    );
  });

  it('keeps a matching applied migration idempotent and records its parsed row', () => {
    const body = 'CREATE TABLE accounts (id integer);\n';
    writeFileSync(join(migrations, '001.sql'), body);
    const hash = createHash('sha256').update(body).digest('hex');
    mocks.runCommand.mockImplementation((argv: readonly string[]) => {
      if (argv.includes('SELECT filename, sha256 FROM devai_migrations'))
        return result(`001.sql\t${hash}\n`);
      if (argv.includes('CREATE TABLE IF NOT EXISTS devai_migrations')) return result();
      return result();
    });

    const reading = senseMigrateCheck({
      cwd: root,
      migrationsDir: migrations,
      databaseUrl: 'postgres://fixture',
      persistBody: false,
    });
    expect(reading).toMatchObject({
      status: 'pass',
      metrics: { migrations_already_applied: 1, migrations_applied: 0 },
    });
    expect(mocks.runCommand).not.toHaveBeenCalledWith(
      ['psql', 'postgres://fixture', '-v', 'ON_ERROR_STOP=1', '-f', join(migrations, '001.sql')],
      { timeoutMs: 60_000 },
    );
  });
});
