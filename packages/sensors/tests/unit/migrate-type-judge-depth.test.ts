// Invariants: INV-DEVAI-001, INV-DEVAI-012, INV-DEVAI-017
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

const mocks = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('../../src/run-command.js', () => ({ runCommand: mocks.runCommand }));

import { senseJudge, type JudgeLlmClient } from '../../src/judge.js';
import { senseMigrateCheck } from '../../src/migrate-check.js';
import { senseTypeCheck } from '../../src/type-check.js';

const root = mkdtempSync(join(tmpdir(), 'devai-sensor-command-depth-'));
const migrations = join(root, 'migrations');

function command(exitCode = 0, stdout = '', stderr = '') {
  return {
    command: [],
    exit_code: exitCode,
    signal: null,
    stdout,
    stderr,
    duration_ms: 7,
    killed: false,
  };
}

beforeEach(() => mocks.runCommand.mockReset());
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('migration sensor depth', () => {
  it('returns skipped or error when database or every migration directory is absent', () => {
    expect(senseMigrateCheck({ cwd: root, persistBody: false }).status).toBe('skipped');
    const missing = senseMigrateCheck({
      cwd: root,
      databaseUrl: 'postgres://fixture',
      migrationDirs: ['missing-a', 'missing-b'],
      persistBody: false,
    });
    expect(missing).toMatchObject({ status: 'error' });
    expect(missing.findings?.[0]?.code).toBe('no_migrations_dir');
  });

  it('fails closed on role bootstrap, pre-seed, and tracking setup failures', () => {
    mkdirSync(migrations, { recursive: true });
    writeFileSync(join(migrations, '001.sql'), 'select 1;\n');

    mocks.runCommand.mockReturnValueOnce(command(1, '', 'role failure'));
    expect(
      senseMigrateCheck({
        cwd: root,
        databaseUrl: 'postgres://fixture',
        migrationsDir: migrations,
        bootstrapRoles: ['owner'],
        persistBody: false,
      }).findings?.[0]?.code,
    ).toBe('role_bootstrap_failed');

    mocks.runCommand.mockReturnValueOnce(command(1, '', 'seed failure\nmore'));
    const seed = senseMigrateCheck({
      cwd: root,
      databaseUrl: 'postgres://fixture',
      migrationsDir: migrations,
      preSeedFiles: ['seed.sql'],
      persistBody: false,
    });
    expect(seed).toMatchObject({ status: 'unknown', metrics: { pre_seed_failed: 1 } });

    mocks.runCommand.mockReturnValueOnce(command(1, '', 'tracking failure'));
    expect(
      senseMigrateCheck({
        cwd: root,
        databaseUrl: 'postgres://fixture',
        migrationsDir: migrations,
        persistBody: false,
      }).findings?.[0]?.code,
    ).toBe('tracking_table_create_failed');
  });

  it('detects matching and edited applied migrations while retaining missing-dir evidence', () => {
    writeFileSync(join(migrations, '002.sql'), 'select 2;\n');
    const hash = createHash('sha256').update('select 1;\n').digest('hex');
    mocks.runCommand
      .mockReturnValueOnce(command())
      .mockReturnValueOnce(command(0, `001.sql\t${hash}\n002.sql\tdeadbeef\ninvalid\n`));
    const reading = senseMigrateCheck({
      cwd: root,
      databaseUrl: 'postgres://fixture',
      migrationDirs: [migrations, 'missing'],
      persistBody: false,
    });
    expect(reading).toMatchObject({
      status: 'fail',
      metrics: { migrations_already_applied: 1, dirs_skipped: 1 },
    });
    expect(reading.findings?.map((finding) => finding.code)).toEqual([
      'migration_dir_missing',
      'migration_hash_mismatch',
    ]);
  });

  it('distinguishes migration execution and bookkeeping failures', () => {
    mocks.runCommand.mockReturnValueOnce(command(3, '', 'migration failed\nmore'));
    const migrationFailure = senseMigrateCheck({
      cwd: root,
      databaseUrl: 'postgres://fixture',
      migrationsDir: migrations,
      skipTracking: true,
      persistBody: false,
    });
    expect(migrationFailure.findings?.[0]?.code).toBe('migration_failed');

    mocks.runCommand
      .mockReturnValueOnce(command())
      .mockReturnValueOnce(command(1))
      .mockReturnValueOnce(command())
      .mockReturnValueOnce(command(1, '', 'insert failed'));
    const recordFailure = senseMigrateCheck({
      cwd: root,
      databaseUrl: 'postgres://fixture',
      migrationsDir: migrations,
      persistBody: false,
    });
    expect(recordFailure.findings?.[0]?.code).toBe('migration_record_failed');
  });

  it('applies migrations in order and persists the structured evidence body', async () => {
    mocks.runCommand.mockImplementation((args?: readonly string[]) => {
      if (args?.includes('SELECT filename, sha256 FROM devai_migrations') === true) {
        return command(1);
      }
      return command();
    });
    const reading = await withAuthorityHostTestScope(() =>
      senseMigrateCheck({
        cwd: root,
        databaseUrl: 'postgres://fixture',
        migrationsDir: migrations,
        preSeedFiles: ['seed-a.sql', 'seed-b.sql'],
        bootstrapRoles: ['owner', "quoted'role"],
      }),
    );
    expect(reading).toMatchObject({
      status: 'pass',
      metrics: { migrations_applied: 2, pre_seed_applied: 2 },
    });
    expect(reading.evidence_path).toContain('per-migration.json');
  });
});

describe('type-check sensor depth', () => {
  it('parses root compiler diagnostics and honors an explicit project', () => {
    mocks.runCommand.mockReturnValueOnce(
      command(2, 'src/a.ts(3,4): error TS1234: broken\nnot a diagnostic'),
    );
    const result = senseTypeCheck({ cwd: root, project: 'tsconfig.fixture.json', timeoutMs: 99 });
    expect(result.aggregate).toMatchObject({ status: 'fail', metrics: { error_count: 1 } });
    expect(result.aggregate.findings?.[0]).toMatchObject({ code: 'TS1234', line: 3 });
    expect(mocks.runCommand).toHaveBeenCalledWith(
      ['npx', 'tsc', '--noEmit', '-p', 'tsconfig.fixture.json'],
      { cwd: root, timeoutMs: 99 },
    );
  });

  it('discovers sorted per-package projects and aggregates pass/fail readings', () => {
    for (const name of ['zeta', 'alpha']) {
      mkdirSync(join(root, 'packages', name), { recursive: true });
      writeFileSync(join(root, 'packages', name, 'tsconfig.json'), '{}\n');
    }
    writeFileSync(join(root, 'packages', 'not-a-directory'), 'x');
    mocks.runCommand
      .mockReturnValueOnce(command())
      .mockReturnValueOnce(command(1, 'z.ts(1,2): error TS9: no'));
    const result = senseTypeCheck({ cwd: root, strategy: 'per-package', scanDirs: ['packages'] });
    expect(result.perProject.map((reading) => reading.status)).toEqual(['pass', 'fail']);
    expect(result.aggregate).toMatchObject({
      status: 'fail',
      metrics: { projects_total: 2, projects_passed: 1, projects_failed: 1 },
    });
    expect(result.aggregate.findings?.[0]?.code).toBe('TYPECHECK_PROJECT_FAIL');
  });

  it('falls back to one root reading when no package project exists', () => {
    mocks.runCommand.mockReturnValueOnce(command());
    const result = senseTypeCheck({
      cwd: root,
      strategy: 'per-package',
      scanDirs: ['absent', join(root, 'also-absent')],
    });
    expect(result.aggregate.status).toBe('pass');
    expect(result.perProject).toEqual([]);
  });
});

function client(response: Record<string, unknown>): JudgeLlmClient {
  return {
    family: 'fixture',
    model: 'judge',
    complete: async () =>
      ({
        text: '',
        family: 'fixture',
        model: 'judge',
        usage: { input_tokens: 2, output_tokens: 3, cost_usd: 0.1 },
        finish_reason: 'stop',
        latency_ms: 4,
        ...response,
      }) as Awaited<ReturnType<JudgeLlmClient['complete']>>,
  };
}

describe('LLM judge sensor depth', () => {
  it('reports invalid JSON as an error with telemetry', async () => {
    const reading = await senseJudge(
      { aspect: 'depth', rubric: 'rubric', evidence: 'evidence', evidencePath: 'record/e.json' },
      client({ text: 'not-json' }),
    );
    expect(reading).toMatchObject({ status: 'error', metrics: { input_tokens: 2 } });
  });

  it('normalizes verdict, rationale, findings, metadata, and confidence', async () => {
    const reading = await senseJudge(
      {
        aspect: 'depth',
        rubric: 'rubric',
        evidence: 'evidence',
        prompt_pc_id: 'PC-fixture',
        stack_sha256: 'stack',
      },
      client({
        json: {
          verdict: 'review',
          confidence: 0.75,
          rationale: 'needs attention',
          findings: [
            { severity: 'critical', code: 'A', message: 'a' },
            { severity: 'other', code: 'B', message: 'b' },
            { severity: 'error', code: 1, message: 'ignored' },
          ],
        },
      }),
    );
    expect(reading).toMatchObject({ status: 'review', metrics: { confidence: 0.75 } });
    expect(reading.findings?.map((finding) => finding.code)).toEqual(['rationale', 'A', 'B']);
  });

  it('parses text JSON and maps an unsupported verdict to UNKNOWN', async () => {
    const reading = await senseJudge(
      { aspect: 'depth', rubric: 'r', evidence: 'e' },
      client({ text: '{"verdict":"invented"}' }),
    );
    expect(reading).toMatchObject({ status: 'unknown', metrics: { confidence: 0 } });
  });
});
