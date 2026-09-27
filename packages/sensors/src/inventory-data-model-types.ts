import type { DeclaredSurfaces } from './declared-surfaces.js';
import type { SensorReading } from './sensor-reading.js';

/**
 * Inventory sensor: database data model (DEVAI-native, Phase 17.C3).
 *
 * Postgres adapter — parses `*.sql` migration files for top-level
 * `CREATE TABLE` blocks and extracts:
 *   - table name (and optional schema)
 *   - columns (name + type + nullable + default + PRIMARY KEY / UNIQUE inline)
 *   - table-level PRIMARY KEY (...)
 *   - table-level FOREIGN KEY (cols) REFERENCES other(cols) [ON DELETE ...]
 *   - file + line evidence
 *
 * Intentionally lossy. Real DDL has many corners (CHECK constraints,
 * partial indexes, generated columns, schemas, partitioning). The
 * minimal output is enough to feed inventory_rbac (RBAC-table
 * detection) and inventory_data_handling (PII column heuristics)
 * + INV-INVENTORY-002 (Phase 17.D). Per-dialect richer parsing
 * lives in stack-adapter packs (17.G).
 *
 * Per Constitution Article 17 (sensor adapter uniformity); per D-57.
 */

export interface DataModelEvidence {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly note?: string;
}

export interface DataModelColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable?: boolean;
  readonly default?: string;
  readonly primary?: boolean;
  readonly unique?: boolean;
  readonly pii_class?: string;
  readonly legal_basis?: string;
  readonly retention?: string;
}

export interface DataModelForeignKey {
  readonly columns: readonly string[];
  readonly references_table: string;
  readonly references_columns: readonly string[];
  readonly on_delete?: 'cascade' | 'restrict' | 'set null' | 'set default' | 'no action';
  readonly on_update?: 'cascade' | 'restrict' | 'set null' | 'set default' | 'no action';
}

export interface DataModelTable {
  readonly name: string;
  readonly schema?: string;
  readonly columns: readonly DataModelColumn[];
  readonly primary_key?: readonly string[];
  readonly foreign_keys?: readonly DataModelForeignKey[];
  readonly unique_constraints?: readonly (readonly string[])[];
  readonly evidence: readonly DataModelEvidence[];
}

export interface DataModelBody {
  readonly schemaVersion: '1.0.0';
  readonly generatedAt: string;
  readonly dialect: 'postgres' | 'mysql' | 'oracle' | 'sqlite' | 'mssql' | 'unknown';
  readonly sourceRepo?: string;
  readonly tables: readonly DataModelTable[];
  readonly views?: readonly {
    name: string;
    schema?: string;
    definition?: string;
    evidence?: readonly DataModelEvidence[];
  }[];
  readonly enums?: readonly {
    name: string;
    values: readonly string[];
    evidence?: readonly DataModelEvidence[];
  }[];
}

export interface InventoryDataModelOptions {
  readonly repoRoot: string;
  /**
   * Declared plant surfaces (ADR-SCR-0003). Omitted: every surface is presumed present.
   */
  readonly surfaces?: DeclaredSurfaces;
  /** Directories under repo-root to scan for `.sql` files (default: ['migrations', 'db/migrations', 'db', 'database']). */
  readonly migrationDirs?: readonly string[];
  readonly ignoreDirs?: ReadonlySet<string>;
  readonly bodyPath?: string;
  /** False for pure observation callers that must not materialize canonical state. */
  readonly persistBody?: boolean;
  readonly dialect?: DataModelBody['dialect'];
  readonly now?: string;
  /**
   * Phase 22.C (closes D-A-13): pack-configurable PII-registry
   * table. When set, the parser also walks `INSERT INTO
   * <pii_registry_table> (...) VALUES (...)` statements in the
   * migrations and projects `(table, column, category, strategy,
   * legal_basis, retention)` rows onto the matching column's PII
   * metadata. Example: `"core.pii_map"` for stynx's runtime
   * registry. Default: undefined — only the inline SQL comment
   * annotations (`-- @pii_class: ...`, `-- @legal_basis: ...`,
   * `-- @retention: ...`) are honoured.
   *
   * Plumbed from
   * `extractor_params.inventory_data_model.pii_registry_table`
   * on the matched stack-adapter pack.
   */
  readonly piiRegistryTable?: string;
}

export interface InventoryDataModelResult {
  readonly reading: SensorReading;
  readonly body: DataModelBody;
  readonly bodyPath: string | null;
}

/**
 * Phase 22.C (closes D-A-13): parse `INSERT INTO <pii_registry_table>
 * (table_name, column_name, category, strategy, legal_basis,
 * retention) VALUES (...)` statements. The pack opts in via
 * `extractor_params.inventory_data_model.pii_registry_table`;
 * adopters who don't have such a registry leave the option unset
 * and this pass is a no-op. Returns a list of (table, column,
 * pii_class, legal_basis, retention) tuples to merge into the
 * parsed tables' columns.
 *
 * Column-name positions are read from the INSERT's column list,
 * not assumed — adopters may declare columns in any order or
 * include/omit `strategy`. Recognized column names (matched
 * case-insensitively): `table_name`/`table`, `column_name`/
 * `column`, `category`/`pii_class`, `legal_basis`, `retention`.
 */
export interface PiiRegistryRow {
  /** Phase 23.F: optional schema for schema-qualified joining onto DataModelTable.schema. */
  readonly table_schema?: string;
  readonly table: string;
  readonly column: string;
  readonly pii_class?: string;
  readonly legal_basis?: string;
  readonly retention?: string;
}

export interface ParsedTable {
  readonly columns: DataModelColumn[];
  readonly primaryKey?: readonly string[];
  readonly foreignKeys: DataModelForeignKey[];
  readonly uniqueConstraints: (readonly string[])[];
}

export interface ParsedSqlFile {
  readonly tables: DataModelTable[];
  /** The raw SQL text — Phase 22.C uses this for the pii-registry pass. */
  readonly rawText: string;
}
