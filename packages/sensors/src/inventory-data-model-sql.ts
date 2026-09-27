import { readFileSync } from 'node:fs';
import type {
  DataModelColumn,
  DataModelForeignKey,
  ParsedTable,
  ParsedSqlFile,
  DataModelTable,
} from './inventory-data-model-types.js';

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
      if (ch === "'" || ch === '"') {
        i = sqlQuotedEnd(cleaned, i) + 1;
        continue;
      }
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
        if (rawName.startsWith('"') || !reservedFirst.has(name.toUpperCase())) {
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

// SQL quote escapes repeat the delimiter; parentheses and commas inside are data.
function sqlQuotedEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== quote) continue;
    if (text[i + 1] === quote) i += 1;
    else return i;
  }
  return text.length - 1;
}

function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" || ch === '"') {
      i = sqlQuotedEnd(body, i);
      continue;
    }
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
  if (!rawName.startsWith('"') && RESERVED_FIRST_TOKENS.has(name.toUpperCase())) return null;
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
  const defMatch = /\bDEFAULT\s+/i.exec(tail);
  if (defMatch !== null) {
    const start = defMatch.index + defMatch[0].length;
    let end = tail.length;
    let depth = 0;
    let quote = '';
    for (let i = start; i < tail.length; i++) {
      const ch = tail[i];
      if (quote.length > 0) {
        if (ch === quote) {
          if (tail[i + 1] === quote) i += 1;
          else quote = '';
        }
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (
        depth === 0 &&
        i > start &&
        /\s/.test(ch ?? '') &&
        /^\s+(?:NOT\s+NULL|NULL|PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|CONSTRAINT)\b/i.test(
          tail.slice(i),
        )
      ) {
        end = i;
        break;
      }
    }
    const value = tail.slice(start, end).trim();
    if (value.length > 0) (col as { default: string }).default = value;
    const constraints = (tail.slice(0, defMatch.index) + tail.slice(end)).toUpperCase();
    (col as { nullable: boolean }).nullable = !constraints.includes('NOT NULL');
    if (!constraints.includes('PRIMARY KEY')) delete (col as { primary?: boolean }).primary;
    if (!constraints.includes('UNIQUE')) delete (col as { unique?: boolean }).unique;
  }
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
    /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(?:([A-Za-z_][\w]*)\.)?([A-Za-z_][\w]*)\s*(?:\(([^)]+)\))?(?:\s+ON\s+DELETE\s+([A-Za-z]+(?:\s+(?!ON\b)[A-Za-z]+)?))?(?:\s+ON\s+UPDATE\s+([A-Za-z]+(?:\s+(?!ON\b)[A-Za-z]+)?))?/i,
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
    (fk as { on_delete: DataModelForeignKey['on_delete'] }).on_delete = onDel
      .toLowerCase()
      .replace(/\s+/g, ' ') as DataModelForeignKey['on_delete'];
  if (onUpd !== undefined)
    (fk as { on_update: DataModelForeignKey['on_update'] }).on_update = onUpd
      .toLowerCase()
      .replace(/\s+/g, ' ') as DataModelForeignKey['on_update'];
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

export function parseSqlFile(absPath: string, fileRel: string): ParsedSqlFile {
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
