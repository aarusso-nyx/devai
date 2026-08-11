import { relative } from 'node:path';
import { introspectDatabase } from './db-introspector.js';
import { walkFiles } from './walker.js';

export type SchemaKind = 'db_table' | 'db_view' | 'dto' | 'openapi' | 'json_schema';

export interface SchemaRecord {
  readonly kind: SchemaKind;
  readonly name: string;
  readonly path?: string;
  /** Postgres schema namespace, only set for db_table/db_view records. */
  readonly db_schema?: string;
}

export interface DiscoverSchemasOptions {
  readonly repoRoot: string;
  readonly dir?: string;
  readonly ignoreDirs?: ReadonlySet<string>;
  /**
   * When true, skip Postgres `information_schema` introspection even if
   * `databaseUrl` is supplied. Phase-3 CLI default is true so self-app
   * runs (no DB) work out of the box.
   */
  readonly noDb?: boolean;
  /**
   * Postgres connection URL. When supplied and `noDb !== true`, introspect
   * `information_schema.tables` and merge BASE TABLE + VIEW results into
   * the returned records (kind `db_table` / `db_view`).
   */
  readonly databaseUrl?: string;
  /** Optional Postgres schema-name filter for introspection (e.g. 'public'). */
  readonly databaseSchema?: string;
}

/**
 * Discover schema-shaped F2 artifacts:
 *   - JSON Schema files (any `*.schema.json` under `dir`)
 *   - OpenAPI files (`openapi.{json,yaml,yml}`)
 *   - Postgres tables and views (only when `databaseUrl` is supplied
 *     and `noDb !== true`)
 *
 * Async because Postgres introspection is async. Callers that don't pass
 * `databaseUrl` resolve immediately.
 */
export async function discoverSchemas(
  opts: DiscoverSchemasOptions,
): Promise<readonly SchemaRecord[]> {
  const dir = opts.dir ?? opts.repoRoot;
  const records: SchemaRecord[] = [];

  const jsonSchemaFiles = walkFiles(dir, {
    extensions: ['.schema.json'],
    ignoreDirs: opts.ignoreDirs,
  });
  for (const file of jsonSchemaFiles) {
    const rel = relative(opts.repoRoot, file);
    const name = baseName(rel).replace(/\.schema$/, '');
    records.push({ kind: 'json_schema', name, path: rel });
  }

  const openapiFiles = walkFiles(dir, {
    extensions: ['.json', '.yaml', '.yml'],
    ignoreDirs: opts.ignoreDirs,
  }).filter((f) => /openapi\.(json|ya?ml)$/.test(f));
  for (const file of openapiFiles) {
    const rel = relative(opts.repoRoot, file);
    const name = baseName(rel).replace(/\.(json|ya?ml)$/, '');
    records.push({ kind: 'openapi', name, path: rel });
  }

  if (opts.databaseUrl !== undefined && opts.noDb !== true) {
    const dbRecords = await introspectDatabase({
      databaseUrl: opts.databaseUrl,
      ...(opts.databaseSchema !== undefined && { schemaName: opts.databaseSchema }),
    });
    for (const r of dbRecords) {
      records.push({ kind: r.kind, name: r.name, db_schema: r.db_schema });
    }
  }

  return records.sort((a, b) =>
    a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

function baseName(p: string): string {
  const slash = p.lastIndexOf('/');
  const name = slash === -1 ? p : p.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}
