import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, join, relative } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import {
  allBoundSurfacesAbsent,
  applySurfaceDeclaration,
  type PlantSurface,
} from './declared-surfaces.js';
import { buildSensorReading, type SensorStatus } from './sensor-reading.js';
import { DEFAULT_IGNORE_DIRS, walkFiles } from './inventory-walker.js';
import type {
  PiiRegistryRow,
  DataModelTable,
  InventoryDataModelOptions,
  InventoryDataModelResult,
  DataModelBody,
} from './inventory-data-model-types.js';
import { parsePiiRegistryInserts, mergePiiRegistryRows } from './inventory-data-model-pii.js';
import { parseSqlFile } from './inventory-data-model-sql.js';
export type {
  DataModelEvidence,
  DataModelColumn,
  DataModelForeignKey,
  DataModelTable,
  DataModelBody,
  InventoryDataModelOptions,
  InventoryDataModelResult,
} from './inventory-data-model-types.js';

const DEFAULT_MIGRATION_DIRS = ['migrations', 'db/migrations', 'db', 'database'];

function existingDir(repoRoot: string, rel: string): string | null {
  try {
    const full = join(repoRoot, rel);
    const s = statSync(full);
    return s.isDirectory() ? full : null;
  } catch {
    return null;
  }
}

function measureInventoryDataModel(opts: InventoryDataModelOptions): InventoryDataModelResult {
  const t0 = performance.now();
  const generatedAt = opts.now ?? new Date().toISOString();
  const dialect = opts.dialect ?? 'postgres';
  const ignoreDirs = opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS;

  const findings: Array<{
    readonly severity: 'info' | 'warning' | 'error' | 'critical';
    readonly code: string;
    readonly message: string;
  }> = [];

  const dirs = opts.migrationDirs ?? DEFAULT_MIGRATION_DIRS;
  const discovered = new Set<string>();
  for (const d of dirs) {
    const abs = existingDir(opts.repoRoot, d);
    if (abs === null) continue;
    for (const file of walkFiles(abs, {
      ignoreDirs,
      extensions: ['sql'],
      skipDeclarations: false,
    })) {
      discovered.add(file);
    }
  }

  const scanned = [...discovered];
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
    duration_ms: Math.round(performance.now() - t0),
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

/** Surfaces this sensor is bound to (ADR-SCR-0003). */
const BOUND_SURFACES: readonly PlantSurface[] = ['database'];

export function senseInventoryDataModel(opts: InventoryDataModelOptions): InventoryDataModelResult {
  // A declared-absent surface is still scanned, so a contradiction is caught; its
  // body is never materialized.
  const absent = allBoundSurfacesAbsent(opts.surfaces, BOUND_SURFACES);
  const result = measureInventoryDataModel(absent ? { ...opts, persistBody: false } : opts);
  const reading = applySurfaceDeclaration(result.reading, opts.surfaces, BOUND_SURFACES, [
    { surface: 'database', items: result.body.tables.map((t) => t.name) },
  ]);
  return { ...result, reading };
}
