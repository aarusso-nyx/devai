import type { PiiRegistryRow, DataModelTable } from './inventory-data-model-types.js';

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

export function parsePiiRegistryInserts(sql: string, registryTable: string): PiiRegistryRow[] {
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

/**
 * Merge pii-registry rows onto
 * matching DataModelColumn entries. Mutation-by-rebuild: returns
 * a new tables list with PII metadata filled in. Registry rows
 * targeting unknown (table, column) pairs are silently ignored
 * (some pii_map entries may pre-declare columns slated for a
 * future migration; this is non-fatal).
 */
export function mergePiiRegistryRows(
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
