import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, join, relative } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { buildSensorReading, type SensorReading, type SensorStatus } from './sensor-reading.js';
import { DEFAULT_IGNORE_DIRS, walkFiles } from './inventory-walker.js';

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

const DEFAULT_MIGRATION_DIRS = ['migrations', 'db/migrations', 'db', 'database'];

/**
 * Parse `CREATE TABLE [IF NOT EXISTS] [schema.]name (...)` blocks.
 * Tolerates comments, trailing commas, and case variations.
 * Returns one match per CREATE TABLE found. Each match carries
 * both the cleaned body (for structural parsing) AND the raw
 * body for inline-comment PII-annotation extraction.
 */
function* extractCreateTableBlocks(sql: string): Generator<{
  schema?: string;
  name: string;
  body: string;
  rawBody: string;
  startOffset: number;
  endOffset: number;
}> {
  // Strip `--` line comments + `/* ... */` block comments before scanning.
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));

  const headerRe =
    /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:([A-Za-z_][\w]*)\.)?([A-Za-z_][\w]*)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(cleaned)) !== null) {
    const open = headerRe.lastIndex - 1; // position of '('
    // Find matching ')' respecting nested parens.
    let depth = 1;
    let i = open + 1;
    while (i < cleaned.length && depth > 0) {
      const ch = cleaned[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    if (depth !== 0) continue;
    const name = m[2];
    if (name === undefined) continue;
    const body = cleaned.slice(open + 1, i - 1);
    const rawBody = sql.slice(open + 1, i - 1);
    yield {
      ...(m[1] !== undefined && { schema: m[1] }),
      name,
      body,
      rawBody,
      startOffset: m.index,
      endOffset: i,
    };
  }
}

/**
 * Extract `-- @key: value` annotations
 * from a raw (un-stripped) CREATE TABLE body. Walks the body
 * line-by-line; for each line that starts with a column name (the
 * `parseColumnLine` shape), reads trailing comments on the same
 * line AND any consecutive `-- @key: value` lines that follow,
 * up to the next column declaration. Returns a map from column
 * name to the parsed annotations.
 *
 * Recognized keys: `pii_class`, `legal_basis`, `retention`. Other
 * keys are ignored (forward-compat — adopters can stash arbitrary
 * metadata in SQL comments without breaking the parser).
 */
function extractColumnAnnotations(
  rawBody: string,
): Map<string, { pii_class?: string; legal_basis?: string; retention?: string }> {
  const out = new Map<string, { pii_class?: string; legal_basis?: string; retention?: string }>();
  const lines = rawBody.split('\n');
  let currentColumn: string | null = null;
  const colHeaderRe = /^\s*("(?:[^"]|"")+"|[A-Za-z_]\w*)\s+[A-Za-z_]/;
  const reservedFirst = RESERVED_FIRST_TOKENS;
  const annotationRe = /--\s*@(pii_class|legal_basis|retention)\s*:\s*([^\n,]+?)\s*$/i;
  // Also accept multiple annotations on one comment: `-- @pii_class: contact -- @legal_basis: contract`
  const inlineAnnotationsRe = /@(pii_class|legal_basis|retention)\s*:\s*([^@\n]+?)(?=\s+@|\s*$)/gi;

  for (const line of lines) {
    const colMatch = line.match(colHeaderRe);
    if (colMatch !== null) {
      const rawName = colMatch[1];
      if (rawName !== undefined) {
        const name = rawName.startsWith('"') ? rawName.slice(1, -1).replace(/""/g, '"') : rawName;
        if (!reservedFirst.has(name.toUpperCase())) {
          currentColumn = name;
          if (!out.has(currentColumn)) out.set(currentColumn, {});
        } else {
          currentColumn = null;
        }
      }
    }
    if (currentColumn === null) continue;
    // Capture annotations on this line (single or multi-key).
    const commentIdx = line.indexOf('--');
    if (commentIdx === -1) {
      // No comment on this line; only continue capturing if the
      // next line is another comment continuation (single-key case
      // above handles single-line; multi-line continuations would
      // require lookahead which we skip for simplicity — adopters
      // should put annotations on the same line as the column or
      // immediately after).
      continue;
    }
    // Normalize `--` line-comment markers to whitespace so a
    // single line like `-- @pii_class: x -- @legal_basis: y` reads
    // as `@pii_class: x  @legal_basis: y` for the multi-key
    // matcher. This also handles single-annotation lines and
    // arbitrary mixed-spacing.
    const commentText = line.slice(commentIdx).replace(/--/g, '  ');
    const target = out.get(currentColumn);
    if (target === undefined) continue;
    let im: RegExpExecArray | null;
    inlineAnnotationsRe.lastIndex = 0;
    while ((im = inlineAnnotationsRe.exec(commentText)) !== null) {
      const key = im[1]?.toLowerCase();
      const value = im[2]?.trim().replace(/[,;]\s*$/, '');
      if (key !== undefined && value !== undefined && value.length > 0) {
        if (key === 'pii_class') target.pii_class = value;
        else if (key === 'legal_basis') target.legal_basis = value;
        else if (key === 'retention') target.retention = value;
      }
    }
  }
  // The fallback single-key regex was a remnant of an earlier
  // implementation; the multi-key matcher above covers both shapes
  // after the `--` → spaces normalization.
  void annotationRe;
  return out;
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
interface PiiRegistryRow {
  /** Phase 23.F: optional schema for schema-qualified joining onto DataModelTable.schema. */
  readonly table_schema?: string;
  readonly table: string;
  readonly column: string;
  readonly pii_class?: string;
  readonly legal_basis?: string;
  readonly retention?: string;
}

/**
 * Walk forward from `startIdx` in `sql`
 * to find the matching statement-terminator `;`, respecting SQL
 * single-quote string literals (escape: `''`) and line-comment
 * trailers (`-- ...\n`). Returns the slice from `startIdx` up to
 * (but not including) the terminator, or to end-of-input.
 *
 * Why: the pre-24.B regex `(.+?)(?:;|$)` truncated the VALUES body
 * at the first `;` even when that `;` was inside a `'...'` string
 * literal — e.g. stynx's `'Display title may contain personal
 * information; nullify on erasure.'` ate the rest of the INSERT,
 * starving the inner row-tuple walker of all but the first row.
 * The state-machine extractor avoids that misread.
 */
function sliceToStatementTerminator(sql: string, startIdx: number): string {
  let i = startIdx;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          i += 2; // escaped quote
          continue;
        }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      // SQL line comment: skip to next newline (or EOF).
      const nl = sql.indexOf('\n', i + 2);
      if (nl === -1) {
        i = sql.length;
      } else {
        i = nl + 1;
      }
      continue;
    }
    if (ch === ';') {
      return sql.slice(startIdx, i);
    }
    i += 1;
  }
  return sql.slice(startIdx);
}

function parsePiiRegistryInserts(sql: string, registryTable: string): PiiRegistryRow[] {
  // Accept either `<schema>.<table>` or just `<table>`. Match
  // case-insensitively so `core.pii_map` matches `CORE.PII_MAP`.
  // The column list and VALUES body are extracted with a string-
  // literal-aware walker (sliceToStatementTerminator) instead of
  // the pre-24.B regex `(.+?)(?:;|$)`, which truncated VALUES at
  // the first `;` even when that `;` sat inside a string literal
  // (e.g. `'...info; nullify on erasure.'` — stynx's
  // `0001_reference.sql` row notes carry semicolons in their
  // prose). Pre-24.B lost rows 2..N of any multi-row INSERT whose
  // first row had a semicolon in any cell.
  const escaped = registryTable.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const headRe = new RegExp(
    `INSERT\\s+INTO\\s+(?:[A-Za-z_]\\w*\\.)?${escaped}\\s*\\(([^)]+)\\)\\s*VALUES\\s*`,
    'gis',
  );
  const out: PiiRegistryRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(sql)) !== null) {
    const colListRaw = m[1] ?? '';
    const valuesStart = m.index + m[0].length;
    let valuesRaw = sliceToStatementTerminator(sql, valuesStart);
    // Phase 23.F (closes D-A-13 residual): trim at the first
    // `ON CONFLICT` (case-insensitive) so the inner row-tuple regex
    // doesn't misinterpret the conflict-target column list
    // (`ON CONFLICT (table_schema, table_name, column_name)`) or
    // the DO UPDATE SET expressions as additional rows.
    const onConflictMatch = /\bON\s+CONFLICT\b/i.exec(valuesRaw);
    if (onConflictMatch !== null) {
      valuesRaw = valuesRaw.slice(0, onConflictMatch.index);
    }
    const colNames = colListRaw.split(',').map((s) =>
      s
        .trim()
        .replace(/^"(.+)"$/, '$1')
        .toLowerCase(),
    );
    // Map known column names to row indices.
    const idx = {
      table_schema: -1,
      table: -1,
      column: -1,
      pii_class: -1,
      legal_basis: -1,
      retention: -1,
    };
    colNames.forEach((n, i) => {
      if (n === 'table_schema' || n === 'schema') idx.table_schema = i;
      else if (n === 'table_name' || n === 'table') idx.table = i;
      else if (n === 'column_name' || n === 'column') idx.column = i;
      else if (n === 'category' || n === 'pii_class' || n === 'class') idx.pii_class = i;
      else if (n === 'legal_basis') idx.legal_basis = i;
      else if (n === 'retention' || n === 'retention_period') idx.retention = i;
    });
    if (idx.table === -1 || idx.column === -1) continue;
    // Walk row tuples `(...)` in VALUES.
    const rowRe = /\(((?:[^()']|'(?:[^']|'')*')+)\)/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(valuesRaw)) !== null) {
      const cells = splitSqlTupleCells(rm[1] ?? '');
      const table = unquoteSql(cells[idx.table] ?? '');
      const column = unquoteSql(cells[idx.column] ?? '');
      if (table.length === 0 || column.length === 0) continue;
      const tableSchemaCell =
        idx.table_schema >= 0 ? unquoteSql(cells[idx.table_schema] ?? '') : '';
      const row: PiiRegistryRow = {
        ...(tableSchemaCell.length > 0 && { table_schema: tableSchemaCell }),
        table,
        column,
        ...(idx.pii_class >= 0 &&
          cells[idx.pii_class] !== undefined && {
            pii_class: unquoteSql(cells[idx.pii_class] ?? ''),
          }),
        ...(idx.legal_basis >= 0 &&
          cells[idx.legal_basis] !== undefined && {
            legal_basis: unquoteSql(cells[idx.legal_basis] ?? ''),
          }),
        ...(idx.retention >= 0 &&
          cells[idx.retention] !== undefined && {
            retention: unquoteSql(cells[idx.retention] ?? ''),
          }),
      };
      out.push(row);
    }
  }
  return out;
}

function splitSqlTupleCells(tuple: string): string[] {
  const out: string[] = [];
  let inString = false;
  let start = 0;
  for (let i = 0; i < tuple.length; i++) {
    const ch = tuple[i];
    if (ch === "'") {
      // SQL escapes single quotes by doubling.
      if (inString && tuple[i + 1] === "'") {
        i += 1;
        continue;
      }
      inString = !inString;
    } else if (ch === ',' && !inString) {
      out.push(tuple.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(tuple.slice(start).trim());
  return out;
}

function unquoteSql(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  // NULL or non-string literal → empty (treated as absent).
  if (/^NULL$/i.test(trimmed)) return '';
  return trimmed;
}

function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

interface ParsedTable {
  readonly columns: DataModelColumn[];
  readonly primaryKey?: readonly string[];
  readonly foreignKeys: DataModelForeignKey[];
  readonly uniqueConstraints: (readonly string[])[];
}

const RESERVED_FIRST_TOKENS = new Set([
  'PRIMARY',
  'FOREIGN',
  'UNIQUE',
  'CHECK',
  'CONSTRAINT',
  'EXCLUDE',
  'LIKE',
]);

function parseColumnLine(line: string): DataModelColumn | null {
  // Column form: `name TYPE [type-args] [constraints...]`
  // Identifiers may be double-quoted.
  const m = line.match(/^("(?:[^"]|"")+"|[A-Za-z_][\w]*)\s+(.+)$/s);
  if (m === null) return null;
  const rawName = m[1];
  const rest = m[2];
  if (rawName === undefined || rest === undefined) return null;
  const name = rawName.startsWith('"') ? rawName.slice(1, -1).replace(/""/g, '"') : rawName;
  if (RESERVED_FIRST_TOKENS.has(name.toUpperCase())) return null;
  // Type: one identifier or one of the explicit SQL multi-word type forms,
  // optionally followed by parens (e.g. VARCHAR(255)) or an array suffix.
  // An unconstrained second identifier would consume constraint keywords such
  // as `NOT` in `TEXT NOT NULL`.
  const typeMatch = rest.match(
    /^((?:(?:timestamp|time)\s+(?:with|without)\s+time\s+zone|double\s+precision|character\s+varying|bit\s+varying|national\s+character(?:\s+varying)?|[A-Za-z_][\w]*)(?:\s*\([^)]*\))?(?:\s*\[\])?)/i,
  );
  if (typeMatch === null) return null;
  const typeText = typeMatch[1];
  if (typeText === undefined) return null;
  const type = typeText.replace(/\s+/g, ' ').trim();
  const tail = rest.slice(typeMatch[0].length).trim();
  const upper = tail.toUpperCase();
  const col: DataModelColumn = {
    name,
    type,
    nullable: !upper.includes('NOT NULL'),
    ...(upper.includes('PRIMARY KEY') && { primary: true }),
    ...(upper.includes('UNIQUE') && { unique: true }),
  };
  const defMatch = tail.match(
    /\bDEFAULT\s+([^,]+?)(?=$|\s+(?:NOT|NULL|PRIMARY|UNIQUE|REFERENCES|CHECK|CONSTRAINT))/i,
  );
  const defaultValue = defMatch?.[1];
  if (defaultValue !== undefined) (col as { default: string }).default = defaultValue.trim();
  return col;
}

function parsePkLine(line: string): readonly string[] | null {
  // Line forms covered:
  //   PRIMARY KEY (col1, col2)
  //   CONSTRAINT name PRIMARY KEY (col1, col2)
  const m = line.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
  const inner = m?.[1];
  if (inner === undefined) return null;
  return inner.split(',').map((s) => s.trim().replace(/"/g, ''));
}

function parseUniqueLine(line: string): readonly string[] | null {
  const m = line.match(/^\s*(?:CONSTRAINT\s+[A-Za-z_][\w]*\s+)?UNIQUE\s*\(([^)]+)\)/i);
  const inner = m?.[1];
  if (inner === undefined) return null;
  return inner.split(',').map((s) => s.trim().replace(/"/g, ''));
}

function parseFkLine(line: string): DataModelForeignKey | null {
  // CONSTRAINT name FOREIGN KEY (cols) REFERENCES table(cols) [ON DELETE x] [ON UPDATE y]
  const m = line.match(
    /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(?:([A-Za-z_][\w]*)\.)?([A-Za-z_][\w]*)\s*(?:\(([^)]+)\))?(?:\s+ON\s+DELETE\s+([A-Za-z]+(?:\s+[A-Za-z]+)?))?(?:\s+ON\s+UPDATE\s+([A-Za-z]+(?:\s+[A-Za-z]+)?))?/i,
  );
  if (m === null) return null;
  const cols = m[1];
  const refTable = m[3];
  if (cols === undefined || refTable === undefined) return null;
  const refCols = m[4];
  const fk: DataModelForeignKey = {
    columns: cols.split(',').map((s) => s.trim().replace(/"/g, '')),
    references_table: refTable,
    references_columns:
      refCols !== undefined ? refCols.split(',').map((s) => s.trim().replace(/"/g, '')) : [],
  };
  const onDel = m[5];
  const onUpd = m[6];
  if (onDel !== undefined)
    (fk as { on_delete: DataModelForeignKey['on_delete'] }).on_delete =
      onDel.toLowerCase() as DataModelForeignKey['on_delete'];
  if (onUpd !== undefined)
    (fk as { on_update: DataModelForeignKey['on_update'] }).on_update =
      onUpd.toLowerCase() as DataModelForeignKey['on_update'];
  return fk;
}

function parseTableBody(body: string): ParsedTable {
  const parts = splitTopLevelCommas(body);
  const columns: DataModelColumn[] = [];
  const foreignKeys: DataModelForeignKey[] = [];
  const uniqueConstraints: (readonly string[])[] = [];
  let primaryKey: readonly string[] | undefined;

  for (const p of parts) {
    const fk = parseFkLine(p);
    if (fk !== null) {
      foreignKeys.push(fk);
      continue;
    }
    const pk = parsePkLine(p);
    if (pk !== null) {
      // Table-level PK supersedes any inline-column primary.
      primaryKey = pk;
      continue;
    }
    const uq = parseUniqueLine(p);
    if (uq !== null) {
      uniqueConstraints.push(uq);
      continue;
    }
    const col = parseColumnLine(p);
    if (col !== null) {
      columns.push(col);
      if (col.primary === true && primaryKey === undefined) primaryKey = [col.name];
    }
  }

  return {
    columns,
    foreignKeys,
    uniqueConstraints,
    ...(primaryKey !== undefined && { primaryKey }),
  };
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line += 1;
  return line;
}

interface ParsedSqlFile {
  readonly tables: DataModelTable[];
  /** The raw SQL text — Phase 22.C uses this for the pii-registry pass. */
  readonly rawText: string;
}

function parseSqlFile(absPath: string, fileRel: string): ParsedSqlFile {
  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return { tables: [], rawText: '' };
  }
  const out: DataModelTable[] = [];
  for (const block of extractCreateTableBlocks(text)) {
    const parsed = parseTableBody(block.body);
    if (parsed.columns.length === 0) continue;
    // Merge inline `-- @key: value`
    // annotations from the raw (un-stripped) body into the parsed
    // columns. Annotations on columns the parser didn't recognize
    // are silently dropped (forward-compat).
    const annotations = extractColumnAnnotations(block.rawBody);
    const columnsWithAnnotations: DataModelColumn[] = parsed.columns.map((col) => {
      const ann = annotations.get(col.name);
      if (ann === undefined) return col;
      return {
        ...col,
        ...(ann.pii_class !== undefined && { pii_class: ann.pii_class }),
        ...(ann.legal_basis !== undefined && { legal_basis: ann.legal_basis }),
        ...(ann.retention !== undefined && { retention: ann.retention }),
      };
    });
    const startLine = lineOf(text, block.startOffset);
    const endLine = lineOf(text, block.endOffset);
    const table: DataModelTable = {
      name: block.name,
      ...(block.schema !== undefined && { schema: block.schema }),
      columns: columnsWithAnnotations,
      ...(parsed.primaryKey !== undefined && { primary_key: parsed.primaryKey }),
      ...(parsed.foreignKeys.length > 0 && { foreign_keys: parsed.foreignKeys }),
      ...(parsed.uniqueConstraints.length > 0 && { unique_constraints: parsed.uniqueConstraints }),
      evidence: [{ path: fileRel, startLine, endLine }],
    };
    out.push(table);
  }
  return { tables: out, rawText: text };
}

/**
 * Merge pii-registry rows onto
 * matching DataModelColumn entries. Mutation-by-rebuild: returns
 * a new tables list with PII metadata filled in. Registry rows
 * targeting unknown (table, column) pairs are silently ignored
 * (some pii_map entries may pre-declare columns slated for a
 * future migration; this is non-fatal).
 */
function mergePiiRegistryRows(
  tables: readonly DataModelTable[],
  rows: readonly PiiRegistryRow[],
): DataModelTable[] {
  if (rows.length === 0) return [...tables];
  // Phase 23.F (closes D-A-13 residual): join key includes
  // table_schema when the row carries one. A row with no schema
  // matches any table with the same bare name; a row with a schema
  // matches only the table whose `schema` matches (or equals the
  // bare table name when the table has no schema). This handles
  // both `CREATE TABLE bookmark` (no schema, schema-less pii_map
  // row) and `CREATE TABLE demo.bookmark` (paired with a pii_map
  // row carrying table_schema='demo').
  const byKey = new Map<string, PiiRegistryRow>();
  for (const row of rows) {
    const schemaKey = row.table_schema ?? '';
    byKey.set(`${schemaKey}::${row.table}::${row.column}`, row);
  }
  return tables.map((t) => {
    const tableSchema = t.schema ?? '';
    const newColumns = t.columns.map((c) => {
      const row =
        byKey.get(`${tableSchema}::${t.name}::${c.name}`) ?? byKey.get(`::${t.name}::${c.name}`);
      if (row === undefined) return c;
      return {
        ...c,
        ...(row.pii_class !== undefined &&
          row.pii_class.length > 0 &&
          c.pii_class === undefined && { pii_class: row.pii_class }),
        ...(row.legal_basis !== undefined &&
          row.legal_basis.length > 0 &&
          c.legal_basis === undefined && { legal_basis: row.legal_basis }),
        ...(row.retention !== undefined &&
          row.retention.length > 0 &&
          c.retention === undefined && { retention: row.retention }),
      };
    });
    return { ...t, columns: newColumns };
  });
}

function existingDir(repoRoot: string, rel: string): string | null {
  try {
    const full = join(repoRoot, rel);
    const s = statSync(full);
    return s.isDirectory() ? full : null;
  } catch {
    return null;
  }
}

export function senseInventoryDataModel(opts: InventoryDataModelOptions): InventoryDataModelResult {
  const t0 = Date.now();
  const generatedAt = opts.now ?? new Date().toISOString();
  const dialect = opts.dialect ?? 'postgres';
  const ignoreDirs = opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS;

  const findings: Array<{
    readonly severity: 'info' | 'warning' | 'error' | 'critical';
    readonly code: string;
    readonly message: string;
  }> = [];

  const dirs = opts.migrationDirs ?? DEFAULT_MIGRATION_DIRS;
  const scanned: string[] = [];
  for (const d of dirs) {
    const abs = existingDir(opts.repoRoot, d);
    if (abs === null) continue;
    scanned.push(...walkFiles(abs, { ignoreDirs, extensions: ['sql'], skipDeclarations: false }));
  }

  let tables: DataModelTable[] = [];
  // Phase 22.C: accumulate raw SQL across all migration files so
  // the pii-registry pass can scan inserts that target tables
  // declared elsewhere in the migration history.
  const rawSqlByFile: Array<{ path: string; text: string }> = [];
  let status: SensorStatus = 'pass';
  try {
    for (const file of scanned) {
      const parsed = parseSqlFile(file, relative(opts.repoRoot, file));
      tables.push(...parsed.tables);
      rawSqlByFile.push({ path: file, text: parsed.rawText });
    }
    tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Phase 22.C (closes D-A-13): when the pack opts in via
    // `pii_registry_table`, scan every migration file for INSERT
    // INTO <registry_table> statements and project the rows onto
    // the matching column's PII metadata. Inline column-comment
    // annotations win over registry rows (column has higher
    // local visibility); the merge preserves any field already
    // set.
    if (opts.piiRegistryTable !== undefined && opts.piiRegistryTable.length > 0) {
      const rows: PiiRegistryRow[] = [];
      for (const { text } of rawSqlByFile) {
        rows.push(...parsePiiRegistryInserts(text, opts.piiRegistryTable));
      }
      tables = mergePiiRegistryRows(tables, rows);
    }
  } catch (err) {
    status = 'error';
    findings.push({
      severity: 'critical',
      code: 'DATA_MODEL_PARSE_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (status === 'pass' && tables.length === 0) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'DATA_MODEL_EMPTY',
      message: `No CREATE TABLE statements found under: ${dirs.join(', ')}`,
    });
  }

  const body: DataModelBody = {
    schemaVersion: '1.0.0',
    generatedAt,
    dialect,
    ...(opts.repoRoot !== undefined && { sourceRepo: opts.repoRoot }),
    tables,
  };

  if (status === 'pass') {
    const ok = validators.dataModelInventory(body);
    if (!ok) {
      status = 'error';
      findings.push({
        severity: 'critical',
        code: 'DATA_MODEL_SCHEMA_INVALID',
        message: `body fails data-model-inventory.schema.json: ${JSON.stringify(validators.dataModelInventory.errors)}`,
      });
    }
  }

  let bodyPath: string | null = null;
  if ((status === 'pass' || status === 'review') && opts.persistBody !== false) {
    bodyPath =
      opts.bodyPath ??
      join(opts.repoRoot, 'record/proofs/sensors/inventory_data_model/data-model.json');
    try {
      mkdirSync(dirname(bodyPath), { recursive: true });
      writeFileSync(bodyPath, JSON.stringify(body, null, 2) + '\n');
    } catch (err) {
      status = 'error';
      bodyPath = null;
      findings.push({
        severity: 'critical',
        code: 'DATA_MODEL_WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const columnCount = tables.reduce((acc, t) => acc + t.columns.length, 0);
  const fkCount = tables.reduce((acc, t) => acc + (t.foreign_keys?.length ?? 0), 0);
  const tablesHash = createHash('sha256')
    .update(JSON.stringify(tables.map((t) => [t.name, t.columns.map((c) => c.name)])))
    .digest('hex');

  const reading = buildSensorReading({
    sensorName: 'inventory:data-model',
    sensorKind: 'inventory_data_model',
    sensorVersion: '1.0.0',
    command: ['devai', 'sense', 'data-model', '--repo-root', opts.repoRoot],
    status,
    deterministic: true,
    tier: 'L0',
    duration_ms: Date.now() - t0,
    timestamp: generatedAt,
    ...(findings.length > 0 && { findings }),
    metrics: {
      table_count: tables.length,
      column_count: columnCount,
      foreign_key_count: fkCount,
      migration_file_count: scanned.length,
      tables_hash: tablesHash,
      dialect,
    },
    ...(bodyPath !== null && { evidence_path: bodyPath }),
  });

  return { reading, body, bodyPath };
}
