import pg from 'pg';
import { createDbCapabilities } from '@devai-nyx/authority';
import type { SchemaKind } from './schemas-discoverer.js';

const { Client } = pg;

export interface DbSchemaRecord {
  readonly kind: Extract<SchemaKind, 'db_table' | 'db_view'>;
  readonly name: string;
  /** Postgres schema (namespace), e.g. 'public'. */
  readonly db_schema: string;
}

export interface IntrospectDatabaseOptions {
  /**
   * Connection string in the libpq URI form, e.g.
   * `postgres://user:pass@host:port/dbname`. Required.
   */
  readonly databaseUrl: string;
  /**
   * Optional Postgres schema name filter (e.g. 'public'). When omitted,
   * every schema except pg_catalog and information_schema is returned.
   */
  readonly schemaName?: string;
  /** Override the connect timeout (ms). Default: 5000. */
  readonly connectionTimeoutMs?: number;
}

/**
 * Introspect a Postgres database via `information_schema.tables`. Returns
 * one DbSchemaRecord per BASE TABLE (kind: 'db_table') and VIEW (kind:
 * 'db_view') outside the system schemas. Results are sorted for
 * determinism: (db_schema, kind, name).
 *
 * Does not throw on connection failure — instead returns an empty array
 * and lets the caller decide whether to surface that. A repository
 * runs without a database; the CLI's --no-db default short-circuits before
 * we get here, so any call to this helper is opting into a real DB.)
 */
export async function introspectDatabase(
  opts: IntrospectDatabaseOptions,
): Promise<readonly DbSchemaRecord[]> {
  const client = new Client({
    connectionString: opts.databaseUrl,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5000,
  });
  const db = createDbCapabilities(client);
  try {
    await client.connect();
  } catch {
    return [];
  }

  try {
    const rows = await db.read.query<{
      table_schema: string;
      table_name: string;
      table_type: string;
    }>(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND ($1::text IS NULL OR table_schema = $1)
       ORDER BY table_schema, table_type, table_name`,
      [opts.schemaName ?? null],
    );

    const records: DbSchemaRecord[] = [];
    for (const r of rows.rows) {
      const kind: DbSchemaRecord['kind'] =
        r.table_type === 'BASE TABLE'
          ? 'db_table'
          : r.table_type === 'VIEW'
            ? 'db_view'
            : 'db_table';
      records.push({ kind, name: r.table_name, db_schema: r.table_schema });
    }
    return records;
  } finally {
    await client.end().catch(() => undefined);
  }
}
