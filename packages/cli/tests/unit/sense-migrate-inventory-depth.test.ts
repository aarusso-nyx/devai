import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSensorParams: vi.fn(),
  senseMigrateCheck: vi.fn(),
  inventorySlice: vi.fn(),
  withSnapshot: vi.fn(),
  regenerateInventory: vi.fn(),
  resolveStackAdapterPack: vi.fn(),
  computeReverseAdherence: vi.fn(),
  extractComponents: vi.fn(),
  validateContracts: vi.fn(),
  normalizeCoverage: vi.fn(),
  extractDependencies: vi.fn(),
  glossaryCoverage: vi.fn(),
  extractModules: vi.fn(),
  extractRoutes: vi.fn(),
  discoverSchemas: vi.fn(),
  discoverTests: vi.fn(),
}));

vi.mock('@devai-nyx/skills', () => ({ resolveSensorParams: mocks.resolveSensorParams }));
vi.mock('@devai-nyx/sensors', () => ({ senseMigrateCheck: mocks.senseMigrateCheck }));
vi.mock('@devai-nyx/sensors/inventory-slices', () => ({
  INVENTORY_SLICES: [
    { name: 'all', members: [] },
    { name: 'review', members: [] },
  ],
  inventorySlice: mocks.inventorySlice,
}));
vi.mock('#runtime-core', () => ({
  computeReverseAdherence: mocks.computeReverseAdherence,
  discoverSchemas: mocks.discoverSchemas,
  discoverTests: mocks.discoverTests,
  extractComponents: mocks.extractComponents,
  extractDependencies: mocks.extractDependencies,
  extractModules: mocks.extractModules,
  extractRoutes: mocks.extractRoutes,
  glossaryCoverage: mocks.glossaryCoverage,
  normalizeCoverage: mocks.normalizeCoverage,
  regenerateInventory: mocks.regenerateInventory,
  resolveStackAdapterPack: mocks.resolveStackAdapterPack,
  validateContracts: mocks.validateContracts,
  withInventoryReadSnapshot: mocks.withSnapshot,
}));

import { executeSenseMigration, senseMigrateCmd } from '../../src/commands/sense/migrate.js';
import { executeInventorySlice, senseInventoryCmd } from '../../src/commands/sense/inventory.js';

const ALL_MEMBERS = [
  'stack-adapter-pack-resolution',
  'inventory-adherence',
  'component-inventory',
  'contract-inventory',
  'inventory-coverage',
  'dependency-graph',
  'glossary-inventory',
  'module-inventory',
  'route-inventory',
  'schema-inventory',
  'test-inventory',
] as const;
const roots: string[] = [];

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-sense-depth-'));
  roots.push(root);
  return root;
}

function trace(root: string): void {
  mkdirSync(join(root, 'law'), { recursive: true });
  writeFileSync(join(root, 'law/trace.json'), JSON.stringify({ requirements: [] }));
}

function reading(status: string) {
  return { sensorName: 'migrate-check', sensorKind: 'migration_check', status, findings: [] };
}

function actionFor(command: { register(cli: CAC): void }) {
  // The fake CAC boundary deliberately accepts malformed runtime option bags.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let action: ((options: any) => unknown) | undefined;
  const options: unknown[][] = [];
  const chain = {
    option: (...args: unknown[]) => {
      options.push(args);
      return chain;
    },
    action: (value: typeof action) => {
      action = value;
      return chain;
    },
  };
  const cli = { command: vi.fn(() => chain) } as unknown as CAC;
  command.register(cli);
  expect(action).toBeTypeOf('function');
  if (action === undefined) throw new Error('command action missing');
  return { action, cli, options };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.senseMigrateCheck.mockReturnValue(reading('pass'));
  mocks.resolveSensorParams.mockReturnValue(undefined);
  mocks.inventorySlice.mockImplementation((name: string) =>
    name === 'all'
      ? { name: 'all', members: ALL_MEMBERS }
      : name === 'review'
        ? {
            name: 'review',
            members: [
              'stack-adapter-pack-resolution',
              'inventory-adherence',
              'contract-inventory',
              'inventory-coverage',
            ],
          }
        : undefined,
  );
  mocks.withSnapshot.mockImplementation((operation: () => unknown) => operation());
  mocks.regenerateInventory.mockResolvedValue({ version: 'fixture-inventory' });
  mocks.resolveStackAdapterPack.mockReturnValue({
    matched: { id: 'fixture-pack' },
    ambiguous: false,
  });
  mocks.computeReverseAdherence.mockReturnValue({ counts: { orphan: 0 }, rows: [] });
  mocks.extractComponents.mockReturnValue([{ id: 'component-a' }]);
  mocks.validateContracts.mockReturnValue({ ok: true, contracts: ['contract-a'] });
  mocks.normalizeCoverage.mockReturnValue({ summary: { lines: 100 } });
  mocks.extractDependencies.mockReturnValue({ nodes: ['dependency-a'] });
  mocks.glossaryCoverage.mockReturnValue({ covered: 3 });
  mocks.extractModules.mockReturnValue([{ id: 'module-a' }]);
  mocks.extractRoutes.mockReturnValue([{ path: '/a' }]);
  mocks.discoverSchemas.mockResolvedValue([{ name: 'public' }]);
  mocks.discoverTests.mockReturnValue([{ path: 'tests/a.test.ts' }]);
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('sense migrate direct contract', () => {
  it.each([undefined, ''])('requires a non-empty database URL (%s)', (databaseUrl) => {
    expect(() => executeSenseMigration({ databaseUrl })).toThrow(
      'SENSE_MIGRATE_DATABASE_URL_REQUIRED',
    );
    expect(mocks.senseMigrateCheck).not.toHaveBeenCalled();
  });

  it('forwards exact explicit ordered migration and pre-seed populations', () => {
    const root = temporary();
    const result = executeSenseMigration({
      repoRoot: root,
      databaseUrl: 'postgres://fixture',
      migrationsDir: 'legacy',
      migrationDirs: ' db/one, ,db/two ',
      preSeed: ['seed/a.sql', 'seed/b.sql'],
    });
    expect(result).toEqual(reading('pass'));
    expect(mocks.resolveSensorParams).not.toHaveBeenCalled();
    expect(mocks.senseMigrateCheck).toHaveBeenCalledWith({
      cwd: root,
      persistBody: false,
      databaseUrl: 'postgres://fixture',
      migrationsDir: 'legacy',
      migrationDirs: ['db/one', 'db/two'],
      preSeedFiles: ['seed/a.sql', 'seed/b.sql'],
    });
  });

  it('omits every optional migration input when it was not supplied', () => {
    executeSenseMigration({ databaseUrl: 'postgres://fixture' });
    expect(mocks.resolveSensorParams).not.toHaveBeenCalled();
    expect(mocks.senseMigrateCheck).toHaveBeenCalledWith({
      cwd: '.',
      persistBody: false,
      databaseUrl: 'postgres://fixture',
    });
  });

  it('lets an explicit pack id trigger tuning and tolerates an unresolved pack', () => {
    executeSenseMigration({ databaseUrl: 'postgres://fixture', packId: 'missing-pack' });
    expect(mocks.resolveSensorParams).toHaveBeenCalledWith({
      adopterRoot: '.',
      sensorKind: 'migrate_check',
      explicitId: 'missing-pack',
    });
    expect(mocks.senseMigrateCheck).toHaveBeenCalledWith({
      cwd: '.',
      persistBody: false,
      databaseUrl: 'postgres://fixture',
    });
  });

  it('resolves pack migration defaults and filters non-string roles without widening inputs', () => {
    const root = temporary();
    mocks.resolveSensorParams.mockReturnValue({
      params: {
        migration_dirs: ['pack/one', 7, 'pack/two'],
        bootstrap_roles: ['owner', null, 'reader'],
      },
    });
    executeSenseMigration({
      databaseUrl: 'postgres://fixture',
      adopterRoot: root,
      roleBootstrap: true,
      packTune: true,
      packId: 'fixture-pack',
      packsRoot: '/protected/packs',
      preSeed: 'seed.sql',
    });
    expect(mocks.resolveSensorParams).toHaveBeenCalledWith({
      adopterRoot: root,
      sensorKind: 'migrate_check',
      packsRoot: '/protected/packs',
      explicitId: 'fixture-pack',
    });
    expect(mocks.senseMigrateCheck).toHaveBeenCalledWith({
      cwd: '.',
      persistBody: false,
      databaseUrl: 'postgres://fixture',
      migrationDirs: ['pack/one', 'pack/two'],
      preSeedFiles: ['seed.sql'],
      bootstrapRoles: ['owner', 'reader'],
    });
  });

  it('keeps explicit migration directories while resolving only requested bootstrap roles', () => {
    mocks.resolveSensorParams.mockReturnValue({
      params: { migration_dirs: ['ignored'], bootstrap_roles: [] },
    });
    executeSenseMigration({
      databaseUrl: 'postgres://fixture',
      migrationDirs: 'explicit',
      roleBootstrap: true,
    });
    expect(mocks.senseMigrateCheck).toHaveBeenCalledWith(
      expect.objectContaining({ migrationDirs: ['explicit'] }),
    );
    expect(mocks.senseMigrateCheck.mock.calls[0]?.[0]).toHaveProperty('bootstrapRoles', []);
  });

  it('forwards identical captured inputs consistently and propagates sensor failures', () => {
    const options = { databaseUrl: 'postgres://fixture', migrationDirs: 'one,two' };
    expect(executeSenseMigration(options)).toEqual(executeSenseMigration(options));
    expect(mocks.senseMigrateCheck).toHaveBeenNthCalledWith(
      1,
      mocks.senseMigrateCheck.mock.calls[1]?.[0],
    );
    mocks.senseMigrateCheck.mockImplementation(() => {
      throw new Error('MIGRATION_SOURCE_FAILED');
    });
    expect(() => executeSenseMigration(options)).toThrow('MIGRATION_SOURCE_FAILED');
  });

  it('renders JSON and human results with exact status exit mapping and stable errors', () => {
    const { action, cli, options } = actionFor(senseMigrateCmd);
    expect(cli.command).toHaveBeenCalledWith(
      'sense-migrate',
      'Execute the DB-writing migration sensor with explicit Engineer write consent',
    );
    expect(options).toEqual([
      ['--repo-root <path>', 'Repository root (default: .)'],
      ['--migrations-dir <path>', 'Single migrations directory'],
      ['--migration-dirs <csv>', 'Ordered comma-separated migration directories'],
      ['--database-url <url>', 'Required Postgres URL'],
      ['--pre-seed <file>', 'SQL file applied before migrations (repeatable)'],
      ['--role-bootstrap', 'Create pack-declared roles before migrations'],
      ['--adopter-root <path>', 'Adopter root for pack resolution'],
      ['--pack-tune', 'Resolve migration defaults from the matched stack pack'],
      ['--pack-id <id>', 'Pin a stack pack (implies pack tuning)'],
      ['--packs-root <path>', 'Override bundled stack-pack root'],
      ['--human', 'Human-readable summary'],
    ]);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const previous = process.exitCode;
    try {
      mocks.senseMigrateCheck.mockReturnValue(reading('skipped'));
      action({ databaseUrl: 'postgres://fixture' });
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        status: 'skipped',
      });
      expect(process.exitCode).toBe(0);

      for (const status of ['review', 'unknown']) {
        mocks.senseMigrateCheck.mockReturnValue(reading(status));
        action({ databaseUrl: 'postgres://fixture', human: true });
        expect(stdout).toHaveBeenLastCalledWith(`devai sense migrate: ${status.toUpperCase()}\n`);
        expect(process.exitCode).toBe(1);
      }
      mocks.senseMigrateCheck.mockReturnValue(reading('error'));
      action({ databaseUrl: 'postgres://fixture', human: true });
      expect(process.exitCode).toBe(2);

      action({});
      expect(stderr).toHaveBeenLastCalledWith(
        'devai sense migrate: SENSE_MIGRATE_DATABASE_URL_REQUIRED\n',
      );
      expect(process.exitCode).toBe(2);

      mocks.senseMigrateCheck.mockImplementation(() => {
        throw 'opaque failure';
      });
      action({ databaseUrl: 'postgres://fixture' });
      expect(stderr).toHaveBeenLastCalledWith('devai sense migrate: opaque failure\n');
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = previous;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe('sense inventory direct contract', () => {
  it('preserves the selected member order and delegated source values', async () => {
    const root = temporary();
    trace(root);
    const result = await executeInventorySlice('all', {
      repoRoot: root,
      adopterRoot: '/adopter',
      coverage: 'reports/coverage.json',
      databaseUrl: 'postgres://fixture',
      databaseSchema: 'tenant',
    });
    expect(result).toMatchObject({
      slice: 'all',
      members: ALL_MEMBERS,
      status: 'pass',
      implicit_persistence: false,
    });
    expect(result.results.map((entry) => entry.member)).toEqual(ALL_MEMBERS);
    expect(result.results.map((entry) => entry.status)).toEqual(ALL_MEMBERS.map(() => 'pass'));
    expect(result.results).toEqual([
      {
        member: 'stack-adapter-pack-resolution',
        status: 'pass',
        value: { matched: { id: 'fixture-pack' }, ambiguous: false },
      },
      {
        member: 'inventory-adherence',
        status: 'pass',
        value: { counts: { orphan: 0 }, rows: [] },
      },
      {
        member: 'component-inventory',
        status: 'pass',
        value: { count: 1, components: [{ id: 'component-a' }] },
      },
      {
        member: 'contract-inventory',
        status: 'pass',
        value: { ok: true, contracts: ['contract-a'] },
      },
      {
        member: 'inventory-coverage',
        status: 'pass',
        value: { summary: { lines: 100 } },
      },
      {
        member: 'dependency-graph',
        status: 'pass',
        value: { nodes: ['dependency-a'] },
      },
      {
        member: 'glossary-inventory',
        status: 'pass',
        value: { covered: 3 },
      },
      {
        member: 'module-inventory',
        status: 'pass',
        value: { count: 1, modules: [{ id: 'module-a' }] },
      },
      {
        member: 'route-inventory',
        status: 'pass',
        value: { count: 1, routes: [{ path: '/a' }] },
      },
      {
        member: 'schema-inventory',
        status: 'pass',
        value: { count: 1, schemas: [{ name: 'public' }] },
      },
      {
        member: 'test-inventory',
        status: 'pass',
        value: { count: 1, tests: [{ path: 'tests/a.test.ts' }] },
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.results)).toBe(true);
    expect(mocks.withSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.resolveStackAdapterPack).toHaveBeenCalledWith({
      repoRoot: resolve(root),
      adopterRoot: '/adopter',
    });
    expect(mocks.regenerateInventory).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: resolve(root), integrationHead: '0'.repeat(40) }),
    );
    expect(mocks.computeReverseAdherence).toHaveBeenCalledWith({
      inventory: { version: 'fixture-inventory' },
      trace: { requirements: [] },
    });
    expect(mocks.normalizeCoverage).toHaveBeenCalledWith({
      coveragePath: resolve(root, 'reports/coverage.json'),
    });
    expect(mocks.discoverSchemas).toHaveBeenCalledWith({
      repoRoot: resolve(root),
      noDb: false,
      databaseUrl: 'postgres://fixture',
      databaseSchema: 'tenant',
    });
    for (const operation of [
      mocks.extractComponents,
      mocks.validateContracts,
      mocks.extractDependencies,
      mocks.glossaryCoverage,
      mocks.extractModules,
      mocks.extractRoutes,
      mocks.discoverTests,
    ]) {
      expect(operation).toHaveBeenCalledWith({ repoRoot: resolve(root) });
    }
    expect(result.results.find((entry) => entry.member === 'component-inventory')?.value).toEqual({
      count: 1,
      components: [{ id: 'component-a' }],
    });
  });

  it('aggregates every review-producing member without dropping results', async () => {
    const root = temporary();
    trace(root);
    mocks.resolveStackAdapterPack.mockReturnValue({ matched: null, ambiguous: true });
    mocks.computeReverseAdherence.mockReturnValue({ counts: { orphan: 2 } });
    mocks.validateContracts.mockReturnValue({ ok: false });
    mocks.normalizeCoverage.mockReturnValue({ summary: null });
    const result = await executeInventorySlice('review', { repoRoot: root });
    expect(result.status).toBe('review');
    expect(result.results.map((entry) => [entry.member, entry.status])).toEqual([
      ['stack-adapter-pack-resolution', 'review'],
      ['inventory-adherence', 'review'],
      ['contract-inventory', 'review'],
      ['inventory-coverage', 'review'],
    ]);
  });

  it('uses safe repository-relative defaults consistently', async () => {
    const root = temporary();
    trace(root);
    const first = await executeInventorySlice('all', { repoRoot: root });
    const second = await executeInventorySlice('all', { repoRoot: root });
    expect(second).toEqual(first);
    expect(mocks.resolveStackAdapterPack).toHaveBeenNthCalledWith(1, {
      repoRoot: resolve(root),
      adopterRoot: resolve(root),
    });
    expect(mocks.normalizeCoverage).toHaveBeenNthCalledWith(1, {
      coveragePath: resolve(root, 'coverage/coverage-final.json'),
    });
    expect(mocks.discoverSchemas).toHaveBeenNthCalledWith(1, {
      repoRoot: resolve(root),
      noDb: true,
    });
  });

  it('resolves the default repository root inside the read snapshot', async () => {
    mocks.inventorySlice.mockReturnValue({ name: 'component', members: ['component-inventory'] });
    await expect(executeInventorySlice('component')).resolves.toMatchObject({
      slice: 'component',
      members: ['component-inventory'],
      status: 'pass',
    });
    expect(mocks.extractComponents).toHaveBeenCalledWith({ repoRoot: resolve('.') });
  });

  it('fails closed for unknown slices, members, missing trace, and snapshot errors', async () => {
    const root = temporary();
    await expect(executeInventorySlice('missing', { repoRoot: root })).rejects.toThrow(
      'SENSE_INVENTORY_SLICE_UNKNOWN:missing',
    );
    mocks.inventorySlice.mockReturnValue({ name: 'unsafe', members: ['not-implemented'] });
    await expect(executeInventorySlice('unsafe', { repoRoot: root })).rejects.toThrow(
      'SENSE_INVENTORY_MEMBER_UNIMPLEMENTED:not-implemented',
    );
    mocks.inventorySlice.mockReturnValue({ name: 'trace', members: ['inventory-adherence'] });
    await expect(executeInventorySlice('trace', { repoRoot: root })).rejects.toThrow(
      `SENSE_INVENTORY_TRACE_MISSING:${resolve(root, 'law/trace.json')}`,
    );
    mocks.withSnapshot.mockImplementation(() => {
      throw new Error('SNAPSHOT_UNAVAILABLE');
    });
    await expect(executeInventorySlice('all', { repoRoot: root })).rejects.toThrow(
      'SNAPSHOT_UNAVAILABLE',
    );
  });

  it('renders required, JSON, human review, and fail-closed CLI outcomes', async () => {
    const { action, cli, options } = actionFor(senseInventoryCmd);
    expect(cli.command).toHaveBeenCalledWith(
      'sense-inventory',
      'Render one canonical repository inventory slice without persistence',
    );
    expect(options).toEqual([
      ['--slice <name>', 'Required slice: all | review'],
      ['--repo-root <path>', 'Repository root (default: .)'],
      ['--adopter-root <path>', 'Adopter root for stack pack resolution'],
      ['--database-url <url>', 'Optional read-only database introspection URL'],
      ['--database-schema <name>', 'Optional database schema filter'],
      ['--coverage <path>', 'Coverage JSON path'],
      ['--trace <path>', 'Trace registry path'],
      ['--human', 'Human-readable summary'],
    ]);
    const root = temporary();
    trace(root);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const previous = process.exitCode;
    try {
      await action({ repoRoot: root });
      expect(stderr).toHaveBeenLastCalledWith('devai sense inventory: --slice is required\n');
      expect(process.exitCode).toBe(2);

      await action({ slice: 'all', repoRoot: root });
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        slice: 'all',
        status: 'pass',
        implicit_persistence: false,
      });
      expect(process.exitCode).toBe(0);

      mocks.resolveStackAdapterPack.mockReturnValue({ matched: null, ambiguous: false });
      await action({ slice: 'review', repoRoot: root, human: true });
      expect(stdout).toHaveBeenLastCalledWith(
        'devai sense inventory (review): REVIEW 4 member(s)\n',
      );
      expect(process.exitCode).toBe(1);

      await action({ slice: 'missing', repoRoot: root });
      expect(stderr).toHaveBeenLastCalledWith(
        'devai sense inventory: SENSE_INVENTORY_SLICE_UNKNOWN:missing\n',
      );
      expect(process.exitCode).toBe(2);

      mocks.inventorySlice.mockImplementation(() => {
        throw 'opaque inventory failure';
      });
      await action({ slice: 'all', repoRoot: root });
      expect(stderr).toHaveBeenLastCalledWith('devai sense inventory: opaque inventory failure\n');
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = previous;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('activates both command modules freshly without changing output identity', async () => {
    vi.resetModules();
    const [freshMigrate, freshInventory] = await Promise.all([
      import('../../src/commands/sense/migrate.js?fresh-migrate-depth'),
      import('../../src/commands/sense/inventory.js?fresh-inventory-depth'),
    ]);
    expect(freshMigrate.executeSenseMigration({ databaseUrl: 'postgres://fixture' })).toEqual(
      reading('pass'),
    );
    const root = temporary();
    trace(root);
    await expect(
      freshInventory.executeInventorySlice('all', { repoRoot: root }),
    ).resolves.toMatchObject({
      slice: 'all',
      members: ALL_MEMBERS,
      implicit_persistence: false,
    });
  });
});
