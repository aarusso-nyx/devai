import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runCommand } from './run-command.js';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

export interface MigrateCheckOptions {
  readonly cwd: string;
  /** False for pure observation callers that must not materialize canonical state. */
  readonly persistBody?: boolean;
  readonly migrationsDir?: string;
  /**
   * Phase 29.D (closes D-A-28): support multiple migration directories
   * applied in declaration order. When supplied, takes precedence over
   * `migrationsDir`. Each dir is walked for `*.sql` files which are
   * sorted within the dir, then concatenated across dirs in the order
   * listed (so callers control inter-dir ordering by listing them in
   * dependency order).
   */
  readonly migrationDirs?: readonly string[];
  /** Postgres URL. Required to actually run migrations; without it, the sensor returns 'skipped'. */
  readonly databaseUrl?: string;
  readonly timeoutMs?: number;
  /**
   * Skip the idempotency table — apply every migration every time. The
   * caller is then responsible for the database being in a known clean
   * state. Default false; only set true for one-shot fixture provisioning.
   */
  readonly skipTracking?: boolean;
  /**
   * Phase 30.F (closes I-1): paths to SQL files applied BEFORE any
   * migration in `migrationDirs`. Use for adopter-specific role +
   * grant setup that platform migrations assume.
   */
  readonly preSeedFiles?: readonly string[];
  /**
   * Phase 30.F (closes I-1): when supplied, run a standard
   * idempotent `CREATE ROLE IF NOT EXISTS <name>` for each name
   * BEFORE any pre-seed file or migration.
   */
  readonly bootstrapRoles?: readonly string[];
}

/**
 * Bookkeeping table created on first run. Records (filename, sha256,
 * applied_at) so subsequent runs can:
 *   - skip files whose hash matches a prior application (idempotent),
 *   - error on files whose hash differs from a prior application
 *     (migration edited after-the-fact — that's a bug, not a no-op).
 *
 * The table itself is created with IF NOT EXISTS so the first run is
 * also safe.
 */
const TRACKING_SQL = `
CREATE TABLE IF NOT EXISTS devai_migrations (
  filename   TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

interface AppliedRow {
  readonly filename: string;
  readonly sha256: string;
}

/** Read the bookkeeping table; returns [] when the table doesn't exist yet. */
function loadApplied(databaseUrl: string, timeoutMs: number): AppliedRow[] {
  const r = runCommand(
    [
      'psql',
      databaseUrl,
      '-t', // tuples-only
      '-A', // unaligned
      '-F',
      '\t',
      '-c',
      'SELECT filename, sha256 FROM devai_migrations',
    ],
    { timeoutMs },
  );
  if (r.exit_code !== 0) return [];
  const rows: AppliedRow[] = [];
  for (const line of r.stdout.split('\n')) {
    if (line.length === 0) continue;
    const [filename, sha256] = line.split('\t');
    if (filename === undefined || sha256 === undefined) continue;
    rows.push({ filename, sha256 });
  }
  return rows;
}

function recordApplied(
  databaseUrl: string,
  filename: string,
  sha256: string,
  timeoutMs: number,
): { ok: boolean; err: string } {
  const r = runCommand(
    [
      'psql',
      databaseUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `INSERT INTO devai_migrations(filename, sha256) VALUES ('${filename.replace(/'/g, "''")}', '${sha256}')`,
    ],
    { timeoutMs },
  );
  return { ok: r.exit_code === 0, err: r.stderr };
}

/**
 * Apply every migration file under `migrationsDir` (sorted), recording
 * each in `devai_migrations` so re-runs skip already-applied files.
 *
 * Status semantics:
 *   - pass: all migrations are now applied (any combination of newly-
 *     applied this run + previously-applied with matching hash).
 *   - fail: at least one migration failed to apply, OR an already-
 *     recorded migration's file has been edited (hash mismatch).
 *   - error: bookkeeping table couldn't be created or `databaseUrl` is
 *     malformed (psql refuses to connect at all).
 *   - skipped: no `databaseUrl` provided.
 */
interface PerMigration {
  readonly file: string;
  readonly exit_code: number;
  readonly duration_ms: number;
}

export function senseMigrateCheck(opts: MigrateCheckOptions): SensorReading {
  // Phase 29.D (D-A-28): multi-dir support. migrationDirs wins; falls
  // back to single-dir migrationsDir; falls back to default `db/migrations`.
  // Relative paths resolve against opts.cwd.
  const toAbs = (p: string): string => (isAbsolute(p) ? p : resolve(opts.cwd, p));
  const dirs: readonly string[] =
    opts.migrationDirs !== undefined && opts.migrationDirs.length > 0
      ? opts.migrationDirs.map(toAbs)
      : [
          opts.migrationsDir !== undefined
            ? toAbs(opts.migrationsDir)
            : join(opts.cwd, 'db/migrations'),
        ];
  const command = ['psql', opts.databaseUrl ?? '<unset>', '-f', '<each migration>'];
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const phaseStart = Date.now();

  if (opts.databaseUrl === undefined) {
    return buildSensorReading({
      sensorName: 'migrate-check',
      sensorKind: 'migration_check',
      command,
      status: 'skipped',
      deterministic: true,
      findings: [
        { severity: 'info', code: 'no_db_url', message: 'skipped: no --database-url provided' },
      ],
    });
  }

  // Walk each dir in declaration order. A missing dir is silently
  // skipped (with a single info-finding) so adopters declaring
  // candidate dirs that don't all exist on every machine aren't
  // hard-broken. If NO dir exists, fall through to the legacy error.
  const filePairs: Array<{ dir: string; file: string }> = [];
  const skippedDirs: string[] = [];
  for (const d of dirs) {
    try {
      const sqlFiles = readdirSync(d)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const f of sqlFiles) filePairs.push({ dir: d, file: f });
    } catch {
      skippedDirs.push(d);
    }
  }
  if (filePairs.length === 0 && skippedDirs.length === dirs.length) {
    return buildSensorReading({
      sensorName: 'migrate-check',
      sensorKind: 'migration_check',
      command,
      status: 'error',
      deterministic: true,
      findings: [
        {
          severity: 'critical',
          code: 'no_migrations_dir',
          message: `cannot read any of: ${dirs.join(', ')}`,
        },
      ],
    });
  }

  // Phase 30.F (closes I-1): run role-bootstrap + pre-seed files
  // BEFORE the tracking table / migrations. Adopters whose
  // migrations assume specific role existence + grant prerequisites
  // (e.g. stynx's platform/0011_storage.sql expecting stynx_owner)
  // declare bootstrap_roles + pre_seed_files; without them, behavior
  // unchanged from pre-30.F. Role-bootstrap uses idempotent
  // `DO $$ BEGIN ... END $$` blocks so re-runs are safe.
  if (opts.bootstrapRoles !== undefined && opts.bootstrapRoles.length > 0) {
    const roleSql = opts.bootstrapRoles
      .map(
        (r) =>
          `DO $do$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r}; END IF; END $do$;`,
      )
      .join('\n');
    const result = runCommand(['psql', opts.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', roleSql], {
      timeoutMs,
    });
    if (result.exit_code !== 0) {
      return buildSensorReading({
        sensorName: 'migrate-check',
        sensorKind: 'migration_check',
        command,
        status: 'error',
        deterministic: true,
        err_head: result.stderr,
        findings: [
          {
            severity: 'critical',
            code: 'role_bootstrap_failed',
            message: `Bootstrap-role creation failed for: ${opts.bootstrapRoles.join(', ')}`,
          },
        ],
      });
    }
  }
  // Phase 32.C (D-A-33): track pre-seed counts to populate SR body.
  let preSeedApplied = 0;
  let preSeedFailed = 0;
  for (const seedFile of opts.preSeedFiles ?? []) {
    const seedPath = join(opts.cwd, seedFile);
    const result = runCommand(['psql', opts.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', seedPath], {
      timeoutMs,
    });
    if (result.exit_code !== 0) {
      preSeedFailed += 1;
      // Per D-87: pre-seed failure → status=unknown (adopter-side bug,
      // not migration-content failure). Short-circuit before migrations
      // because the DB likely isn't in a state where migrations could
      // meaningfully run.
      return buildSensorReading({
        sensorName: 'migrate-check',
        sensorKind: 'migration_check',
        command,
        status: 'unknown',
        deterministic: true,
        err_head: result.stderr,
        findings: [
          {
            severity: 'warning',
            code: 'pre_seed_failed',
            message: `Pre-seed ${seedFile} exited ${String(result.exit_code)}: ${result.stderr.split('\n')[0] ?? ''}`,
            file: seedFile,
          },
        ],
        metrics: {
          migrations_applied: 0,
          migrations_failed: 0,
          pre_seed_applied: preSeedApplied,
          pre_seed_failed: preSeedFailed,
          total_duration_ms: Date.now() - phaseStart,
        },
      });
    }
    preSeedApplied += 1;
  }

  // Provision the bookkeeping table (idempotent). If this fails, surface as 'error'
  // — we can't responsibly apply migrations without it.
  const trackingEnabled = opts.skipTracking !== true;
  if (trackingEnabled) {
    const setup = runCommand(
      ['psql', opts.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', TRACKING_SQL],
      {
        timeoutMs,
      },
    );
    if (setup.exit_code !== 0) {
      return buildSensorReading({
        sensorName: 'migrate-check',
        sensorKind: 'migration_check',
        command,
        status: 'error',
        deterministic: true,
        err_head: setup.stderr,
        findings: [
          {
            severity: 'critical',
            code: 'tracking_table_create_failed',
            message: 'cannot create devai_migrations bookkeeping table',
          },
        ],
      });
    }
  }
  const appliedMap = new Map<string, string>();
  if (trackingEnabled) {
    for (const row of loadApplied(opts.databaseUrl, timeoutMs)) {
      appliedMap.set(row.filename, row.sha256);
    }
  }

  const findings: SensorFinding[] = [];
  let newlyApplied = 0;
  let alreadyApplied = 0;
  let migrationsFailed = 0;
  const perMigration: PerMigration[] = [];
  for (const skipped of skippedDirs) {
    findings.push({
      severity: 'info',
      code: 'migration_dir_missing',
      message: `skipping non-existent dir ${skipped}`,
    });
  }
  for (const { dir: fileDir, file } of filePairs) {
    const path = join(fileDir, file);
    const body = readFileSync(path);
    const sha256 = createHash('sha256').update(body).digest('hex');

    if (trackingEnabled) {
      const recorded = appliedMap.get(file);
      if (recorded !== undefined) {
        if (recorded === sha256) {
          alreadyApplied++;
          perMigration.push({ file, exit_code: 0, duration_ms: 0 });
          continue;
        }
        // The migration was previously applied with a different hash —
        // someone edited a migration after it landed in the DB. This
        // is a hard error.
        findings.push({
          severity: 'critical',
          code: 'migration_hash_mismatch',
          message:
            `${file} sha256 changed since previous apply (was ${recorded.slice(0, 12)}…, now ${sha256.slice(0, 12)}…); ` +
            'migrations are immutable once applied',
          file: path,
        });
        migrationsFailed += 1;
        perMigration.push({ file, exit_code: -1, duration_ms: 0 });
        break;
      }
    }

    const migStart = Date.now();
    const r = runCommand(['psql', opts.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path], {
      timeoutMs,
    });
    const migDuration = Date.now() - migStart;
    perMigration.push({ file, exit_code: r.exit_code, duration_ms: migDuration });
    if (r.exit_code !== 0) {
      findings.push({
        severity: 'error',
        code: 'migration_failed',
        message: `${file} exited ${String(r.exit_code)}: ${r.stderr.split('\n')[0] ?? ''}`,
        file: path,
      });
      migrationsFailed += 1;
      break;
    }
    if (trackingEnabled) {
      const recorded = recordApplied(opts.databaseUrl, file, sha256, timeoutMs);
      if (!recorded.ok) {
        findings.push({
          severity: 'error',
          code: 'migration_record_failed',
          message: `${file} applied but bookkeeping insert failed: ${recorded.err.split('\n')[0] ?? ''}`,
          file: path,
        });
        migrationsFailed += 1;
        break;
      }
    }
    newlyApplied++;
  }

  // Per D-87 verdict mapping: pass iff both fail counts == 0;
  // fail iff migrations_failed > 0; pre-seed branch already returned
  // unknown above before reaching here.
  let status: SensorStatus = migrationsFailed === 0 ? 'pass' : 'fail';

  // Phase 32.C (D-A-33): persist the per_migration array as an
  // evidence body file. Schema constrains metrics to flat
  // number|string|boolean values, so structured arrays go via
  // evidence_path (same pattern as inventory_coverage).
  let evidencePath: string | undefined;
  if (opts.persistBody !== false) {
    const bodyPath = join(opts.cwd, 'record/proofs/sensors/migration_check/per-migration.json');
    try {
      mkdirSync(dirname(bodyPath), { recursive: true });
      writeFileSync(bodyPath, JSON.stringify({ per_migration: perMigration }, null, 2) + '\n');
      evidencePath = bodyPath;
    } catch (err) {
      findings.push({
        severity: 'warning',
        code: 'PER_MIGRATION_WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
      status = status === 'pass' ? 'review' : status;
    }
  }

  return buildSensorReading({
    sensorName: 'migrate-check',
    sensorKind: 'migration_check',
    command,
    status,
    deterministic: true,
    ...(evidencePath !== undefined && { evidence_path: evidencePath }),
    findings,
    metrics: {
      // Phase 32.C SR body shape (D-A-33).
      migrations_applied: newlyApplied,
      migrations_failed: migrationsFailed,
      pre_seed_applied: preSeedApplied,
      pre_seed_failed: preSeedFailed,
      total_duration_ms: Date.now() - phaseStart,
      // Carried-over metrics (Phase 29.D + earlier).
      migrations_total: filePairs.length,
      migrations_already_applied: alreadyApplied,
      dirs_scanned: dirs.length - skippedDirs.length,
      dirs_skipped: skippedDirs.length,
    },
  });
}
