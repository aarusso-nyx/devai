import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  senseInventoryDataModel,
  type DataModelBody,
  type DataModelTable,
  type InventoryDataModelOptions,
} from '../../src/inventory-data-model.js';
import {
  senseInventoryDataHandling,
  type InventoryDataHandlingOptions,
} from '../../src/inventory-data-handling.js';
import type { SensorReading } from '../../src/sensor-reading.js';

const NOW = '2026-09-08T12:00:00.000Z';
const MODEL_BODY_REL = 'record/proofs/sensors/inventory_data_model/data-model.json';
const HANDLING_BODY_REL = 'record/proofs/sensors/inventory_data_handling/data-model-pii.json';

// Exact-path read fault injection also works in root-owned mutation containers.
const deniedFileReads = vi.hoisted(() => new Set<string>());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      if (deniedFileReads.has(String(args[0]))) throw new Error('EACCES: fixture file read denied');
      return Reflect.apply(actual.readFileSync, actual, args);
    },
  };
});
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-data-inventory-'));
});

afterEach(() => {
  deniedFileReads.clear();
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function codes(reading: SensorReading): readonly string[] {
  return (reading.findings ?? []).map((finding) => finding.code);
}

function senseModel(overrides: Partial<InventoryDataModelOptions> = {}) {
  return senseInventoryDataModel({
    repoRoot: root,
    migrationDirs: ['db/migrations'],
    persistBody: false,
    now: NOW,
    ...overrides,
  });
}

function senseHandling(overrides: Partial<InventoryDataHandlingOptions> = {}) {
  return senseInventoryDataHandling({
    repoRoot: root,
    persistBody: false,
    now: NOW,
    ...overrides,
  });
}

/**
 * Both sensors materialize their body through the authority mutation
 * boundary, so the persistence half of their contract is only observable
 * inside a real host-effect scope. This grants filesystem mutation confined
 * to the fixture root and nothing else.
 */
function withLocalWriteScope<T>(callback: () => T): T {
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'sensors-data-inventory-test-authority',
    issuer_version: '1.0.0',
    invocation_id: 'sensors-data-inventory-1',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'sensors-data-inventory-receipt',
    now: () => NOW,
    receipt_ttl_ms: 30_000,
  }) as { dispose: () => unknown };
  const scope: AuthorityHostEffectScope = {
    action_id: 'sense inventory data',
    invocation_id: 'sensors-data-inventory-1',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      const [target] = request.arguments;
      if (
        request.kind !== 'filesystem' ||
        typeof target !== 'string' ||
        !resolve(target).startsWith(`${resolve(root)}${sep}`)
      ) {
        throw new Error('SENSORS_TEST_WRITE_OUT_OF_FIXTURE');
      }
      return apply();
    },
  };
  try {
    return runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

function tablesHash(tables: readonly DataModelTable[]): string {
  return createHash('sha256')
    .update(JSON.stringify(tables.map((t) => [t.name, t.columns.map((c) => c.name)])))
    .digest('hex');
}

function handlingHash(tables: readonly DataModelTable[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        tables.flatMap((t) => t.columns.map((c) => [t.name, c.name, c.pii_class ?? ''])),
      ),
    )
    .digest('hex');
}

/**
 * A minimal, schema-valid data-model body — the documented input contract of
 * `inventory_data_handling` (`record/proofs/sensors/inventory_data_model/
 * data-model.json`).
 */
function modelBody(
  columns: readonly {
    name: string;
    type?: string;
    pii_class?: string;
    legal_basis?: string;
    retention?: string;
  }[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    generatedAt: '2020-01-01T00:00:00.000Z',
    dialect: 'postgres',
    sourceRepo: root,
    tables: [
      {
        name: 'users',
        columns: columns.map((c) => ({ type: 'text', ...c })),
        evidence: [{ path: 'db/migrations/0001_core.sql', startLine: 1, endLine: 9 }],
      },
    ],
    ...extra,
  };
}

/**
 * Fixture A — a realistic first migration. Exercises block-comment and
 * line-comment blanking (offsets must survive), quoted identifiers,
 * multi-word types, inline defaults, table-level UNIQUE, a CHECK clause
 * that is not a column, and inline `-- @key: value` PII annotations.
 */
const CORE_SQL = `-- 0001_core.sql: accounts
/* Superseded draft:
   CREATE TABLE ghost (
     id bigint NOT NULL
   );
*/
CREATE TABLE IF NOT EXISTS app.accounts (
  id bigint NOT NULL PRIMARY KEY,
  "user email" text NOT NULL, -- @pii_class: contact -- @legal_basis: contract
  "quoted""name" text,
  status text DEFAULT 'active' NOT NULL,
  score double precision NOT NULL,
  seen_at timestamp with time zone,
  tags text[],
  CONSTRAINT accounts_uq UNIQUE (id, "user email"),
  CHECK (score >= 0) -- @pii_class: ignored
);
`;

describe('senseInventoryDataModel DDL observation', () => {
  it('parses a commented migration without losing evidence offsets or quoted identifiers', () => {
    write('db/migrations/0001_core.sql', CORE_SQL);

    const result = senseModel();

    expect(result.reading.status).toBe('pass');
    expect(codes(result.reading)).toEqual([]);
    expect(result.body.tables).toHaveLength(1);
    const accounts = result.body.tables[0];
    expect(accounts).toMatchObject({
      name: 'accounts',
      schema: 'app',
      primary_key: ['id'],
      unique_constraints: [['id', 'user email']],
      // The `/* ... */` draft is blanked in place, so the header still starts
      // on its own physical line and the block ends on the `);` line.
      evidence: [{ path: 'db/migrations/0001_core.sql', startLine: 7, endLine: 17 }],
    });
    expect(accounts?.foreign_keys).toBeUndefined();
    expect(accounts?.columns).toEqual([
      { name: 'id', type: 'bigint', nullable: false, primary: true },
      {
        name: 'user email',
        type: 'text',
        nullable: false,
        pii_class: 'contact',
        legal_basis: 'contract',
      },
      { name: 'quoted"name', type: 'text', nullable: true },
      { name: 'status', type: 'text', nullable: false, default: "'active'" },
      { name: 'score', type: 'double precision', nullable: false },
      { name: 'seen_at', type: 'timestamp with time zone', nullable: true },
      { name: 'tags', type: 'text[]', nullable: true },
    ]);
  });

  it('never attaches an annotation trailing a table-level constraint to a column', () => {
    write('db/migrations/0001_core.sql', CORE_SQL);

    const result = senseModel();

    expect(
      result.body.tables.flatMap((t) => t.columns.map((c) => c.pii_class ?? 'none')),
    ).not.toContain('ignored');
  });

  it('drops a CREATE TABLE whose parenthesis never closes', () => {
    write(
      'db/migrations/0001_broken.sql',
      'CREATE TABLE broken (\n  id bigint NOT NULL,\n  label text\n',
    );

    const result = senseModel();

    expect(result.reading.status).toBe('review');
    expect(codes(result.reading)).toEqual(['DATA_MODEL_EMPTY']);
    expect(result.reading.findings?.[0]).toMatchObject({
      severity: 'warning',
      message: 'No CREATE TABLE statements found under: db/migrations',
    });
    expect(result.body.tables).toEqual([]);
    expect(result.reading.metrics).toMatchObject({
      table_count: 0,
      column_count: 0,
      foreign_key_count: 0,
      migration_file_count: 1,
    });
  });

  it('names every configured migration root in the empty-inventory finding', () => {
    mkdirSync(join(root, 'db/migrations'), { recursive: true });

    const result = senseModel({ migrationDirs: ['db/migrations', 'database', 'sql'] });

    expect(result.reading.findings?.[0]?.message).toBe(
      'No CREATE TABLE statements found under: db/migrations, database, sql',
    );
  });

  it('parses table-level keys, both ON clauses, and sorts tables by name', () => {
    write(
      'db/migrations/0002_sessions.sql',
      `CREATE TABLE sessions (
  id bigint NOT NULL,
  account_id bigint NOT NULL,
  ip_address inet,
  PRIMARY KEY (id),
  CONSTRAINT sessions_account_fk FOREIGN KEY (account_id) REFERENCES app.accounts (id) ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE TABLE audit_log (
  id bigint NOT NULL PRIMARY KEY
);
`,
    );

    const result = senseModel();

    expect(result.reading.status).toBe('pass');
    expect(result.body.tables.map((t) => t.name)).toEqual(['audit_log', 'sessions']);
    const sessions = result.body.tables.find((t) => t.name === 'sessions');
    expect(sessions?.primary_key).toEqual(['id']);
    expect(sessions?.foreign_keys).toEqual([
      {
        columns: ['account_id'],
        references_table: 'accounts',
        references_columns: ['id'],
        on_delete: 'cascade',
        on_update: 'no action',
      },
    ]);
    expect(result.reading.metrics).toMatchObject({
      table_count: 2,
      column_count: 4,
      foreign_key_count: 1,
      migration_file_count: 1,
      dialect: 'postgres',
    });
  });

  it('lets a table-level PRIMARY KEY supersede an inline column primary', () => {
    write(
      'db/migrations/0001_core.sql',
      `CREATE TABLE memberships (
  tenant_id bigint NOT NULL PRIMARY KEY,
  account_id bigint NOT NULL,
  CONSTRAINT memberships_pk PRIMARY KEY (tenant_id, account_id)
);
`,
    );

    const result = senseModel();

    expect(result.body.tables[0]?.primary_key).toEqual(['tenant_id', 'account_id']);
    expect(result.body.tables[0]?.columns[0]).toMatchObject({ primary: true });
  });

  it('reports a schema-invalid body instead of persisting it', () => {
    // `REFERENCES parent` with no column list yields `references_columns: []`,
    // which data-model-inventory.schema.json rejects (minItems 1).
    write(
      'db/migrations/0001_core.sql',
      `CREATE TABLE sessions (
  account_id bigint NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts
);
`,
    );

    const result = withLocalWriteScope(() => senseModel({ persistBody: true }));

    expect(result.reading.status).toBe('error');
    expect(codes(result.reading)).toEqual(['DATA_MODEL_SCHEMA_INVALID']);
    expect(result.reading.findings?.[0]?.severity).toBe('critical');
    expect(result.reading.findings?.[0]?.message).toMatch(
      /^body fails data-model-inventory\.schema\.json: /,
    );
    expect(result.body.tables[0]?.foreign_keys?.[0]?.references_columns).toEqual([]);
    expect(result.bodyPath).toBeNull();
    expect(result.reading.evidence_path).toBeUndefined();
  });

  it('carries the requested dialect into both the body and the metrics', () => {
    write('db/migrations/0001_core.sql', 'CREATE TABLE t (id bigint NOT NULL);');

    const result = senseModel({ dialect: 'sqlite' });

    expect(result.body.dialect).toBe('sqlite');
    expect(result.body.sourceRepo).toBe(root);
    expect(result.body.schemaVersion).toBe('1.0.0');
    expect(result.body.generatedAt).toBe(NOW);
    expect(result.reading.metrics?.dialect).toBe('sqlite');
    expect(result.reading.timestamp).toBe(NOW);
  });

  it('hashes the table-and-column shape and ignores everything else', () => {
    write(
      'db/migrations/0001_core.sql',
      "CREATE TABLE t (id bigint NOT NULL, label text DEFAULT 'a');",
    );
    const first = senseModel();
    write(
      'db/migrations/0001_core.sql',
      "CREATE TABLE t (id bigint, label text DEFAULT 'b' NOT NULL);",
    );
    const second = senseModel();
    write('db/migrations/0001_core.sql', 'CREATE TABLE t (id bigint NOT NULL, other text);');
    const third = senseModel();

    expect(first.reading.metrics?.tables_hash).toBe(tablesHash(first.body.tables));
    expect(second.reading.metrics?.tables_hash).toBe(first.reading.metrics?.tables_hash);
    expect(third.reading.metrics?.tables_hash).not.toBe(first.reading.metrics?.tables_hash);
  });
});

describe('senseInventoryDataModel migration discovery', () => {
  it('deduplicates overlapping roots, skips ignored dirs, and skips non-directories', () => {
    write('migrations/0001.sql', 'CREATE TABLE a (id bigint);');
    write('db/migrations/0002.sql', 'CREATE TABLE b (id bigint);');
    write('db/node_modules/0003.sql', 'CREATE TABLE c (id bigint);');
    write('db/vendor/0004.sql', 'CREATE TABLE d (id bigint);');
    write('db/notes.md', 'not sql');
    write('database', 'a regular file, not a migration directory');

    const result = senseModel({ migrationDirs: undefined });

    expect(result.body.tables.map((t) => t.name)).toEqual(['a', 'b', 'd']);
    expect(result.reading.metrics?.migration_file_count).toBe(3);
  });

  it('honours a caller-supplied ignore set', () => {
    write('db/migrations/0001.sql', 'CREATE TABLE a (id bigint);');
    write('db/migrations/vendor/0002.sql', 'CREATE TABLE b (id bigint);');

    const result = senseModel({ ignoreDirs: new Set(['vendor']) });

    expect(result.body.tables.map((t) => t.name)).toEqual(['a']);
    expect(result.reading.metrics?.migration_file_count).toBe(1);
  });

  it('counts an unreadable migration but recovers no tables from it', () => {
    write('db/migrations/0001.sql', 'CREATE TABLE a (id bigint);');
    const locked = write('db/migrations/0002.sql', 'CREATE TABLE b (id bigint);');
    deniedFileReads.add(locked);
    try {
      const result = senseModel();

      expect(result.reading.status).toBe('pass');
      expect(result.body.tables.map((t) => t.name)).toEqual(['a']);
      expect(result.reading.metrics?.migration_file_count).toBe(2);
    } finally {
      deniedFileReads.delete(locked);
    }
  });
});

describe('senseInventoryDataModel PII registry projection', () => {
  const ACCOUNTS_SQL = `CREATE TABLE app.accounts (
  id bigint NOT NULL PRIMARY KEY,
  email text NOT NULL,
  phone text,
  note text -- @pii_class: contact
);
CREATE TABLE bookmark (
  id bigint NOT NULL PRIMARY KEY,
  title text
);
`;

  it('projects registry rows onto columns across files, honouring schema-qualified joins', () => {
    write('db/migrations/0001_core.sql', ACCOUNTS_SQL);
    write(
      'db/migrations/0002_pii.sql',
      `INSERT INTO core.pii_map (table_schema, table_name, column_name, category, legal_basis, retention) VALUES
  ('app', 'accounts', 'email', 'contact', 'contract', 'P2Y'),
  ('other', 'accounts', 'phone', 'identity', 'consent', 'P1Y'),
  (NULL, 'bookmark', 'title', 'personal', NULL, 'P6M');
`,
    );

    const result = senseModel({ piiRegistryTable: 'pii_map' });

    const accounts = result.body.tables.find((t) => t.name === 'accounts');
    expect(accounts?.columns.find((c) => c.name === 'email')).toEqual({
      name: 'email',
      type: 'text',
      nullable: false,
      pii_class: 'contact',
      legal_basis: 'contract',
      retention: 'P2Y',
    });
    // The row carries schema `other`; it must not reach `app.accounts`.
    expect(accounts?.columns.find((c) => c.name === 'phone')).toEqual({
      name: 'phone',
      type: 'text',
      nullable: true,
    });
    // A schema-less row joins onto a schema-less table; `NULL` legal_basis
    // is treated as absent rather than as the string "NULL".
    const bookmark = result.body.tables.find((t) => t.name === 'bookmark');
    expect(bookmark?.columns.find((c) => c.name === 'title')).toEqual({
      name: 'title',
      type: 'text',
      nullable: true,
      pii_class: 'personal',
      retention: 'P6M',
    });
  });

  it('lets an inline column annotation win over a registry row', () => {
    write('db/migrations/0001_core.sql', ACCOUNTS_SQL);
    write(
      'db/migrations/0002_pii.sql',
      `INSERT INTO pii_map (table_name, column_name, category, legal_basis) VALUES
  ('accounts', 'note', 'identity', 'legitimate_interest'),
  ('accounts', 'email', '', 'contract');
`,
    );

    const result = senseModel({ piiRegistryTable: 'pii_map' });

    const accounts = result.body.tables.find((t) => t.name === 'accounts');
    expect(accounts?.columns.find((c) => c.name === 'note')).toMatchObject({
      pii_class: 'contact',
      legal_basis: 'legitimate_interest',
    });
    // An empty category is not a classification.
    expect(accounts?.columns.find((c) => c.name === 'email')).toEqual({
      name: 'email',
      type: 'text',
      nullable: false,
      legal_basis: 'contract',
    });
  });

  it('keeps rows after a semicolon or a line comment inside the INSERT', () => {
    write('db/migrations/0001_core.sql', ACCOUNTS_SQL);
    write(
      'db/migrations/0002_pii.sql',
      `INSERT INTO pii_map (table_name, column_name, category, legal_basis) VALUES
  ('accounts', 'email', 'contact', 'Support contact; erase on request.'),
  -- legacy carrier; kept for audit
  ('accounts', 'phone', 'contact', 'O''Brien; consent on file');
`,
    );

    const result = senseModel({ piiRegistryTable: 'pii_map' });

    const accounts = result.body.tables.find((t) => t.name === 'accounts');
    expect(accounts?.columns.find((c) => c.name === 'email')?.legal_basis).toBe(
      'Support contact; erase on request.',
    );
    expect(accounts?.columns.find((c) => c.name === 'phone')).toMatchObject({
      pii_class: 'contact',
      legal_basis: "O'Brien; consent on file",
    });
  });

  it('stops each INSERT at its own terminator rather than at the end of the file', () => {
    write('db/migrations/0001_core.sql', ACCOUNTS_SQL);
    write(
      'db/migrations/0002_pii.sql',
      `INSERT INTO pii_map (table_name, column_name, category) VALUES
  ('accounts', 'email', 'contact'), -- primary contact channel
  ('accounts', 'phone', 'contact');
INSERT INTO audit_map (table_name, column_name, category) VALUES
  ('bookmark', 'title', 'health');
`,
    );

    const result = senseModel({ piiRegistryTable: 'pii_map' });

    const accounts = result.body.tables.find((t) => t.name === 'accounts');
    expect(accounts?.columns.find((c) => c.name === 'email')?.pii_class).toBe('contact');
    expect(accounts?.columns.find((c) => c.name === 'phone')?.pii_class).toBe('contact');
    // The row belongs to `audit_map`, which is not the configured registry.
    expect(
      result.body.tables.find((t) => t.name === 'bookmark')?.columns.find((c) => c.name === 'title')
        ?.pii_class,
    ).toBeUndefined();
  });

  it('reads an unterminated INSERT that ends in a trailing line comment', () => {
    write('db/migrations/0001_core.sql', ACCOUNTS_SQL);
    write(
      'db/migrations/0002_pii.sql',
      'INSERT INTO pii_map (table_name, column_name, category) VALUES\n' +
        "  ('accounts', 'email', 'contact') -- pending review",
    );

    const result = senseModel({ piiRegistryTable: 'pii_map' });

    expect(
      result.body.tables.find((t) => t.name === 'accounts')?.columns.find((c) => c.name === 'email')
        ?.pii_class,
    ).toBe('contact');
  });

  it('ignores an ON CONFLICT tail rather than reading it as another row', () => {
    write('db/migrations/0001_core.sql', ACCOUNTS_SQL);
    write(
      'db/migrations/0002_pii.sql',
      `INSERT INTO pii_map (table_name, column_name, category, legal_basis) VALUES
  ('accounts', 'email', 'contact', 'contract')
ON CONFLICT (table_name, column_name) DO UPDATE SET category = EXCLUDED.category
  WHERE (pii_map.table_name, pii_map.column_name) <> ('accounts', 'email');
`,
    );

    const result = senseModel({ piiRegistryTable: 'pii_map' });

    expect(
      result.body.tables
        .find((t) => t.name === 'accounts')
        ?.columns.find((c) => c.name === 'email'),
    ).toMatchObject({ pii_class: 'contact', legal_basis: 'contract' });
  });

  it('matches the configured registry table literally, not as a pattern', () => {
    write('db/migrations/0001_core.sql', ACCOUNTS_SQL);
    write(
      'db/migrations/0002_pii.sql',
      `INSERT INTO pii.map (table_name, column_name, category) VALUES ('accounts', 'email', 'contact');
INSERT INTO pii_map (table_name, column_name, category) VALUES ('accounts', 'email', 'health');
`,
    );

    const result = senseModel({ piiRegistryTable: 'pii.map' });

    expect(
      result.body.tables.find((t) => t.name === 'accounts')?.columns.find((c) => c.name === 'email')
        ?.pii_class,
    ).toBe('contact');
  });

  it('skips an INSERT that declares no table or column position', () => {
    write('db/migrations/0001_core.sql', ACCOUNTS_SQL);
    write(
      'db/migrations/0002_pii.sql',
      `INSERT INTO pii_map (category, legal_basis) VALUES ('identity', 'consent');
INSERT INTO pii_map (class, "column", table) VALUES ('financial', 'email', 'accounts');
`,
    );

    const result = senseModel({ piiRegistryTable: 'pii_map' });

    const accounts = result.body.tables.find((t) => t.name === 'accounts');
    expect(accounts?.columns.find((c) => c.name === 'email')?.pii_class).toBe('financial');
    expect(accounts?.columns.find((c) => c.name === 'phone')?.pii_class).toBeUndefined();
  });

  it('keeps every table when the registry pass finds no rows at all', () => {
    write('db/migrations/0001_core.sql', ACCOUNTS_SQL);

    const withRegistry = senseModel({ piiRegistryTable: 'pii_map' });
    const withoutRegistry = senseModel();

    expect(withRegistry.body.tables.map((t) => t.name)).toEqual(['accounts', 'bookmark']);
    expect(withRegistry.reading.metrics?.tables_hash).toBe(
      withoutRegistry.reading.metrics?.tables_hash,
    );
  });

  it('leaves the registry pass off when the option is unset or empty', () => {
    write('db/migrations/0001_core.sql', ACCOUNTS_SQL);
    write(
      'db/migrations/0002_pii.sql',
      "INSERT INTO pii_map (table_name, column_name, category) VALUES ('accounts', 'email', 'contact');\n",
    );

    expect(
      senseModel({ piiRegistryTable: '' })
        .body.tables.find((t) => t.name === 'accounts')
        ?.columns.find((c) => c.name === 'email')?.pii_class,
    ).toBeUndefined();
    expect(
      senseModel()
        .body.tables.find((t) => t.name === 'accounts')
        ?.columns.find((c) => c.name === 'email')?.pii_class,
    ).toBeUndefined();
  });
});

describe('senseInventoryDataModel body persistence', () => {
  it('writes the canonical body to the default proof path and cites it as evidence', () => {
    write('db/migrations/0001_core.sql', 'CREATE TABLE a (id bigint NOT NULL);');

    const result = withLocalWriteScope(() => senseModel({ persistBody: true }));

    expect(result.reading.status).toBe('pass');
    expect(result.bodyPath).toBe(join(root, MODEL_BODY_REL));
    expect(result.reading.evidence_path).toBe(result.bodyPath);
    expect(readFileSync(join(root, MODEL_BODY_REL), 'utf8')).toBe(
      `${JSON.stringify(result.body, null, 2)}\n`,
    );
  });

  it('persists a review-status inventory as well', () => {
    mkdirSync(join(root, 'db/migrations'), { recursive: true });

    const result = withLocalWriteScope(() => senseModel({ persistBody: true }));

    expect(result.reading.status).toBe('review');
    expect(result.bodyPath).toBe(join(root, MODEL_BODY_REL));
    expect(
      (JSON.parse(readFileSync(join(root, MODEL_BODY_REL), 'utf8')) as DataModelBody).tables,
    ).toEqual([]);
  });

  it('honours an explicit body path', () => {
    write('db/migrations/0001_core.sql', 'CREATE TABLE a (id bigint NOT NULL);');
    const target = join(root, 'out/nested/model.json');

    const result = withLocalWriteScope(() => senseModel({ persistBody: true, bodyPath: target }));

    expect(result.bodyPath).toBe(target);
    expect(readFileSync(target, 'utf8')).toContain('"name": "a"');
  });

  it('reports a failed write instead of claiming evidence', () => {
    write('db/migrations/0001_core.sql', 'CREATE TABLE a (id bigint NOT NULL);');
    write('blocked', 'a regular file where a proof directory is expected');

    const result = withLocalWriteScope(() =>
      senseModel({ persistBody: true, bodyPath: join(root, 'blocked/model.json') }),
    );

    expect(result.reading.status).toBe('error');
    expect(codes(result.reading)).toEqual(['DATA_MODEL_WRITE_FAILED']);
    expect(result.reading.findings?.[0]?.severity).toBe('critical');
    expect(result.bodyPath).toBeNull();
    expect(result.reading.evidence_path).toBeUndefined();
    // The body is still returned to the caller even though it was not stored.
    expect(result.body.tables).toHaveLength(1);
  });

  it('reports the authority boundary refusal when asked to persist outside a scope', () => {
    write('db/migrations/0001_core.sql', 'CREATE TABLE a (id bigint NOT NULL);');

    const result = senseModel({ persistBody: true });

    expect(result.reading.status).toBe('error');
    expect(codes(result.reading)).toEqual(['DATA_MODEL_WRITE_FAILED']);
    expect(result.reading.findings?.[0]?.message).toBe('AUTHORITY_FINAL_BOUNDARY_REQUIRED');
    expect(result.bodyPath).toBeNull();
  });

  it('writes nothing when the caller opts out of persistence', () => {
    write('db/migrations/0001_core.sql', 'CREATE TABLE a (id bigint NOT NULL);');

    const result = withLocalWriteScope(() => senseModel({ persistBody: false }));

    expect(result.reading.status).toBe('pass');
    expect(result.bodyPath).toBeNull();
    expect(result.reading.evidence_path).toBeUndefined();
  });
});

describe('senseInventoryDataHandling prerequisite handling', () => {
  it('asks for the data-model run by name when the body is missing', () => {
    const result = senseHandling();

    expect(result.reading.status).toBe('review');
    expect(result.reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'DATA_HANDLING_REQUIRES_DATA_MODEL',
        message: `Data-model body not found at ${join(root, MODEL_BODY_REL)}. Run 'devai sense run inventory_data_model' first.`,
      },
    ]);
    expect(result.body).toBeNull();
    expect(result.bodyPath).toBeNull();
    expect(result.reading.evidence_path).toBeUndefined();
    expect(result.reading.metrics).toMatchObject({
      table_count: 0,
      pii_column_count: 0,
      unlabeled_pii_column_count: 0,
      data_handling_hash: handlingHash([]),
    });
  });

  it('reports a malformed data-model body as an error, not as an empty inventory', () => {
    const bad = write('record/proofs/sensors/inventory_data_model/data-model.json', '{"tables":');

    const result = senseHandling();

    expect(result.reading.status).toBe('error');
    expect(codes(result.reading)).toEqual(['DATA_HANDLING_INVALID_DATA_MODEL']);
    expect(result.reading.findings?.[0]?.severity).toBe('critical');
    expect(result.reading.findings?.[0]?.message.length).toBeGreaterThan(0);
    expect(result.body).toBeNull();
    expect(result.bodyPath).toBeNull();
    expect(bad.endsWith('data-model.json')).toBe(true);
  });

  it('reads an explicitly supplied data-model path', () => {
    const path = write('other/model.json', JSON.stringify(modelBody([{ name: 'email' }])));

    const result = senseHandling({ dataModelPath: path });

    expect(result.reading.status).toBe('pass');
    expect(result.body?.tables[0]?.columns[0]?.pii_class).toBe('contact');
  });

  it('rejects a data-model body that does not satisfy the inventory schema', () => {
    const path = write(
      'other/model.json',
      JSON.stringify(modelBody([{ name: 'email' }], { notes: 'hand-edited' })),
    );

    const result = withLocalWriteScope(() =>
      senseHandling({ dataModelPath: path, persistBody: true }),
    );

    expect(result.reading.status).toBe('error');
    expect(codes(result.reading)).toEqual(['DATA_HANDLING_SCHEMA_INVALID']);
    expect(result.reading.findings?.[0]?.message).toMatch(
      /^body fails data-model-inventory\.schema\.json: /,
    );
    expect(result.bodyPath).toBeNull();
    // The seeded body is still handed back for inspection.
    expect(result.body?.tables[0]?.columns[0]?.pii_class).toBe('contact');
  });

  it('flags an inventory in which no heuristic matched', () => {
    const path = write(
      'other/model.json',
      JSON.stringify(modelBody([{ name: 'id' }, { name: 'created_at' }])),
    );

    const result = senseHandling({ dataModelPath: path });

    expect(result.reading.status).toBe('review');
    expect(result.reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'DATA_HANDLING_NO_PII_DETECTED',
        message:
          "No columns matched any PII heuristic. Either the schema is genuinely PII-free, or the heuristics did not match the adopter's naming conventions.",
      },
    ]);
    expect(result.reading.metrics?.pii_column_count).toBe(0);
    expect(result.body?.tables[0]?.columns).toEqual([
      { name: 'id', type: 'text' },
      { name: 'created_at', type: 'text' },
    ]);
  });
});

describe('senseInventoryDataHandling PII classification', () => {
  function classify(names: readonly string[]): Record<string, string | undefined> {
    const path = write(
      'other/model.json',
      JSON.stringify(modelBody(names.map((name) => ({ name })))),
    );
    const result = senseHandling({ dataModelPath: path });
    const out: Record<string, string | undefined> = {};
    for (const column of result.body?.tables[0]?.columns ?? []) out[column.name] = column.pii_class;
    return out;
  }

  it.each([
    ['contact', ['email', 'billing_email', 'phone', 'work_phone', 'telephone', 'whatsapp', 'fax']],
    ['identity', ['cpf', 'cnpj', 'rg', 'ssn', 'passport', 'national_id', 'document', 'tax_id']],
    ['credentials', ['password', 'password_hash', 'secret', 'api_key', 'token', 'reset_token']],
    ['financial', ['credit_card', 'card_number', 'iban', 'account_number', 'routing_number']],
    ['location', ['address', 'street', 'postal_code', 'zip_code', 'latitude', 'city', 'country']],
    ['personal', ['full_name', 'firstname', 'last_name', 'birth_date', 'dob', 'gender']],
    ['health', ['diagnosis', 'medical_record', 'prescription', 'blood_type', 'allergies']],
    ['ip', ['ip_address', 'remote_addr', 'user_agent']],
  ])('classifies %s columns', (piiClass, names) => {
    const classified = classify(names);

    expect(Object.values(classified)).toEqual(names.map(() => piiClass));
  });

  it('leaves columns no heuristic recognizes untouched', () => {
    const classified = classify([
      'id',
      'created_at',
      'emails',
      'phone_number_kind',
      'documentation',
      'statement',
    ]);

    expect(classified).toEqual({
      id: undefined,
      created_at: undefined,
      emails: undefined,
      phone_number_kind: undefined,
      documentation: undefined,
      statement: undefined,
    });
  });

  it('matches column names case-insensitively and takes the first matching rule', () => {
    const classified = classify(['EMAIL', 'Password', 'Document_Number']);

    expect(classified).toEqual({
      EMAIL: 'contact',
      Password: 'credentials',
      Document_Number: 'identity',
    });
  });

  it('counts upstream classifications and preserves their explicit class', () => {
    const path = write(
      'other/model.json',
      JSON.stringify(
        modelBody([
          { name: 'label', pii_class: 'internal' },
          { name: 'email', pii_class: 'restricted', legal_basis: 'contract', retention: 'P1Y' },
          { name: 'phone', pii_class: '' },
          { name: 'id' },
        ]),
      ),
    );
    const result = senseHandling({ dataModelPath: path });
    expect(result.reading.status).toBe('pass');
    expect(result.body?.tables[0]?.columns.map((column) => column.pii_class)).toEqual([
      'internal',
      'restricted',
      'contact',
      undefined,
    ]);
    expect(result.reading.metrics).toMatchObject({
      pii_column_count: 3,
      unlabeled_pii_column_count: 2,
    });
  });

  it('counts PII columns and, separately, the ones still missing curation', () => {
    const path = write(
      'other/model.json',
      JSON.stringify(
        modelBody([
          { name: 'id' },
          { name: 'email', legal_basis: 'contract', retention: 'P2Y' },
          { name: 'phone', legal_basis: 'contract' },
          { name: 'cpf', retention: 'P5Y' },
          { name: 'password_hash' },
        ]),
      ),
    );

    const result = senseHandling({ dataModelPath: path });

    expect(result.reading.status).toBe('pass');
    expect(result.reading.metrics).toMatchObject({
      table_count: 1,
      pii_column_count: 4,
      unlabeled_pii_column_count: 3,
      data_handling_hash: handlingHash(result.body?.tables ?? []),
    });
    expect(result.body?.tables[0]?.columns.find((c) => c.name === 'email')).toEqual({
      name: 'email',
      type: 'text',
      legal_basis: 'contract',
      retention: 'P2Y',
      pii_class: 'contact',
    });
  });

  it('re-stamps generatedAt while preserving the rest of the input body', () => {
    const path = write('other/model.json', JSON.stringify(modelBody([{ name: 'email' }])));

    const result = senseHandling({ dataModelPath: path });

    expect(result.body?.generatedAt).toBe(NOW);
    expect(result.body).toMatchObject({
      schemaVersion: '1.0.0',
      dialect: 'postgres',
      sourceRepo: root,
    });
    expect(result.body?.tables[0]?.evidence).toEqual([
      { path: 'db/migrations/0001_core.sql', startLine: 1, endLine: 9 },
    ]);
    expect(result.reading.timestamp).toBe(NOW);
  });

  it('changes the handling hash when a classification changes, not when the clock moves', () => {
    const path = write('other/model.json', JSON.stringify(modelBody([{ name: 'email' }])));
    const first = senseHandling({ dataModelPath: path });
    const later = senseHandling({ dataModelPath: path, now: '2027-01-01T00:00:00.000Z' });
    write('other/model.json', JSON.stringify(modelBody([{ name: 'ssn' }])));
    const different = senseHandling({ dataModelPath: path });

    expect(later.reading.metrics?.data_handling_hash).toBe(
      first.reading.metrics?.data_handling_hash,
    );
    expect(different.reading.metrics?.data_handling_hash).not.toBe(
      first.reading.metrics?.data_handling_hash,
    );
  });
});

describe('senseInventoryDataHandling body persistence', () => {
  it('persists the seeded body at the default proof path and cites it', () => {
    const path = write('other/model.json', JSON.stringify(modelBody([{ name: 'email' }])));

    const result = withLocalWriteScope(() =>
      senseHandling({ dataModelPath: path, persistBody: true }),
    );

    expect(result.bodyPath).toBe(join(root, HANDLING_BODY_REL));
    expect(result.reading.evidence_path).toBe(result.bodyPath);
    expect(readFileSync(join(root, HANDLING_BODY_REL), 'utf8')).toBe(
      `${JSON.stringify(result.body, null, 2)}\n`,
    );
  });

  it('persists a review-status seeding as well', () => {
    const path = write('other/model.json', JSON.stringify(modelBody([{ name: 'id' }])));

    const result = withLocalWriteScope(() =>
      senseHandling({ dataModelPath: path, persistBody: true }),
    );

    expect(result.reading.status).toBe('review');
    expect(codes(result.reading)).toEqual(['DATA_HANDLING_NO_PII_DETECTED']);
    expect(readFileSync(join(root, HANDLING_BODY_REL), 'utf8')).toContain('"name": "id"');
  });

  it('reports a failed write instead of claiming evidence', () => {
    const path = write('other/model.json', JSON.stringify(modelBody([{ name: 'email' }])));
    write('blocked', 'a regular file where a proof directory is expected');

    const result = withLocalWriteScope(() =>
      senseHandling({
        dataModelPath: path,
        persistBody: true,
        bodyPath: join(root, 'blocked/pii.json'),
      }),
    );

    expect(result.reading.status).toBe('error');
    expect(codes(result.reading)).toEqual(['DATA_HANDLING_WRITE_FAILED']);
    expect(result.reading.findings?.[0]?.severity).toBe('critical');
    expect(result.bodyPath).toBeNull();
    expect(result.reading.evidence_path).toBeUndefined();
    expect(result.body?.tables[0]?.columns[0]?.pii_class).toBe('contact');
  });

  it('does not persist when the prerequisite body is missing', () => {
    const result = withLocalWriteScope(() => senseHandling({ persistBody: true }));

    expect(result.reading.status).toBe('review');
    expect(result.bodyPath).toBeNull();
  });
});

describe('data-model to data-handling evidence relationship', () => {
  it('seeds PII straight from the data-model proof written by the upstream sensor', () => {
    write(
      'db/migrations/0001_core.sql',
      `CREATE TABLE app.accounts (
  id bigint NOT NULL PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  ip_address inet,
  label text -- @pii_class: internal -- @legal_basis: contract -- @retention: P1Y
);
`,
    );

    const { model, handling } = withLocalWriteScope(() => {
      const modelResult = senseModel({ persistBody: true });
      return { model: modelResult, handling: senseHandling({ persistBody: true }) };
    });

    expect(model.reading.status).toBe('pass');
    expect(model.bodyPath).toBe(join(root, MODEL_BODY_REL));
    expect(handling.reading.status).toBe('pass');

    const stored = JSON.parse(readFileSync(join(root, HANDLING_BODY_REL), 'utf8')) as DataModelBody;
    expect(stored).toEqual(handling.body);
    expect(stored.tables[0]?.evidence).toEqual(model.body.tables[0]?.evidence);

    const columns = stored.tables[0]?.columns ?? [];
    expect(columns.map((c) => c.pii_class)).toEqual([
      undefined,
      'contact',
      'credentials',
      'ip',
      // The inline annotation the data-model captured is not overwritten by
      // the heuristics, which do not recognize `label`.
      'internal',
    ]);
    expect(handling.reading.metrics).toMatchObject({
      table_count: 1,
      pii_column_count: 4,
      unlabeled_pii_column_count: 3,
    });
    expect(handling.reading.evidence_path).toBe(join(root, HANDLING_BODY_REL));
  });
});
