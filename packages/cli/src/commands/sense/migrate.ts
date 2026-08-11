import type { CAC } from 'cac';
import { resolveSensorParams } from '@devai-nyx/skills';
import { senseMigrateCheck, type SensorReading } from '@devai-nyx/sensors';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

export interface SenseMigrateOptions {
  readonly repoRoot?: string;
  readonly migrationsDir?: string;
  readonly migrationDirs?: string;
  readonly preSeed?: string | string[];
  readonly roleBootstrap?: boolean;
  readonly databaseUrl?: string;
  readonly adopterRoot?: string;
  readonly packTune?: boolean;
  readonly packId?: string;
  readonly packsRoot?: string;
  readonly human?: boolean;
}

function csv(value?: string): readonly string[] | undefined {
  const values = value
    ?.split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return values === undefined || values.length === 0 ? undefined : values;
}

export function executeSenseMigration(options: SenseMigrateOptions): SensorReading {
  if (options.databaseUrl === undefined || options.databaseUrl.length === 0) {
    throw new Error('SENSE_MIGRATE_DATABASE_URL_REQUIRED');
  }
  const repoRoot = options.repoRoot ?? '.';
  const adopterRoot = options.adopterRoot ?? repoRoot;
  let migrationDirs = csv(options.migrationDirs);
  let bootstrapRoles: readonly string[] | undefined;
  if (
    options.roleBootstrap === true ||
    (migrationDirs === undefined && (options.packTune === true || options.packId !== undefined))
  ) {
    const resolved = resolveSensorParams({
      adopterRoot,
      sensorKind: 'migrate_check',
      ...(options.packsRoot === undefined ? {} : { packsRoot: options.packsRoot }),
      ...(options.packId === undefined ? {} : { explicitId: options.packId }),
    });
    if (migrationDirs === undefined) {
      const fromPack = resolved?.params.migration_dirs;
      if (Array.isArray(fromPack)) {
        migrationDirs = fromPack.filter((value): value is string => typeof value === 'string');
      }
    }
    if (options.roleBootstrap === true) {
      const fromPack = resolved?.params.bootstrap_roles;
      if (Array.isArray(fromPack)) {
        bootstrapRoles = fromPack.filter((value): value is string => typeof value === 'string');
      }
    }
  }
  const preSeedFiles =
    options.preSeed === undefined
      ? undefined
      : Array.isArray(options.preSeed)
        ? options.preSeed
        : [options.preSeed];

  return senseMigrateCheck({
    cwd: repoRoot,
    persistBody: false,
    databaseUrl: options.databaseUrl,
    ...(options.migrationsDir === undefined ? {} : { migrationsDir: options.migrationsDir }),
    ...(migrationDirs === undefined ? {} : { migrationDirs }),
    ...(preSeedFiles === undefined ? {} : { preSeedFiles }),
    ...(bootstrapRoles === undefined ? {} : { bootstrapRoles }),
  });
}

function migrationExit(reading: SensorReading): number {
  if (reading.status === 'pass' || reading.status === 'skipped') return EXIT_PASS;
  if (reading.status === 'review' || reading.status === 'unknown') return EXIT_REVIEW;
  return EXIT_FAIL;
}

export const senseMigrateCmd = defineCommand({
  name: 'sense migrate',
  description: 'Execute the DB-writing migration sensor with explicit Engineer write consent.',
  authority: 'sensor',
  register(cli: CAC): void {
    cli
      .command(
        'sense-migrate',
        'Execute the DB-writing migration sensor with explicit Engineer write consent',
      )
      .option('--repo-root <path>', 'Repository root (default: .)')
      .option('--migrations-dir <path>', 'Single migrations directory')
      .option('--migration-dirs <csv>', 'Ordered comma-separated migration directories')
      .option('--database-url <url>', 'Required Postgres URL')
      .option('--pre-seed <file>', 'SQL file applied before migrations (repeatable)')
      .option('--role-bootstrap', 'Create pack-declared roles before migrations')
      .option('--adopter-root <path>', 'Adopter root for pack resolution')
      .option('--pack-tune', 'Resolve migration defaults from the matched stack pack')
      .option('--pack-id <id>', 'Pin a stack pack (implies pack tuning)')
      .option('--packs-root <path>', 'Override bundled stack-pack root')
      .option('--human', 'Human-readable summary')
      .action((options: SenseMigrateOptions) => {
        try {
          const reading = executeSenseMigration(options);
          process.stdout.write(
            options.human === true
              ? `devai sense migrate: ${reading.status.toUpperCase()}\n`
              : `${JSON.stringify(reading)}\n`,
          );
          process.exitCode = migrationExit(reading);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`devai sense migrate: ${message}\n`);
          process.exitCode =
            message === 'SENSE_MIGRATE_DATABASE_URL_REQUIRED' ? EXIT_USAGE : EXIT_FAIL;
        }
      });
  },
});
