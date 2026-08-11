import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { validators } from '@devai-nyx/schemas';
import { isSensorKind, type SensorReading } from '@devai-nyx/sensors';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import { rebuildSensorReadings } from './readings-rebuild.js';

interface RecordOptions {
  readonly repoRoot?: string;
  readonly input?: string;
  readonly rebuild?: boolean;
  readonly human?: boolean;
}

export interface RecordedSensorReading {
  readonly path: string;
  readonly action: 'created' | 'already-recorded';
  readonly reading: SensorReading;
}

export function recordSensorReading(repoRoot: string, inputPath: string): RecordedSensorReading {
  const source = resolve(repoRoot, inputPath);
  const parsed: unknown = JSON.parse(readFileSync(source, 'utf8'));
  if (!validators.sensorReading(parsed)) {
    throw new Error(
      `SENSE_RECORD_INVALID_READING:${JSON.stringify(validators.sensorReading.errors)}`,
    );
  }
  const reading = parsed as SensorReading;
  if (!isSensorKind(reading.sensor.kind)) {
    throw new Error(`SENSE_RECORD_KIND_UNKNOWN:${reading.sensor.kind}`);
  }
  if (!/^SR-[a-f0-9]{16}$/u.test(reading.id)) {
    throw new Error(`SENSE_RECORD_ID_INVALID:${reading.id}`);
  }
  const canonical = `${JSON.stringify(reading, null, 2)}\n`;
  const directory = join(repoRoot, '.devai/state/sensor-readings', reading.sensor.kind);
  const target = join(directory, `${reading.id}.json`);
  if (existsSync(target)) {
    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(target, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`SENSE_RECORD_EXISTING_INVALID:${target}`, { cause: error });
    }
    if (JSON.stringify(existing) !== JSON.stringify(reading)) {
      throw new Error(`SENSE_RECORD_ID_CONFLICT:${reading.id}`);
    }
    return Object.freeze({ path: target, action: 'already-recorded', reading });
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(target, canonical, { flag: 'wx' });
  return Object.freeze({ path: target, action: 'created', reading });
}

export const senseRecordCmd = defineCommand({
  name: 'sense record',
  description: 'Persist or rebuild declared sensor readings through the harness boundary.',
  authority: 'sensor',
  register(cli: CAC): void {
    cli
      .command('sense-record', 'Explicitly record one exact SensorReading')
      .option('--repo-root <path>', 'Repository root (default: .)')
      .option('--input <path>', 'Exact SensorReading JSON artifact')
      .option('--rebuild', 'Rebuild readings from existing inventory bodies')
      .option('--human', 'Human-readable summary')
      .action((options: RecordOptions) => {
        if ((options.input === undefined) === (options.rebuild !== true)) {
          process.stderr.write(
            'devai sense record: exactly one of --input or --rebuild is required\n',
          );
          process.exitCode = EXIT_USAGE;
          return;
        }
        const repoRoot = resolve(options.repoRoot ?? '.');
        try {
          if (options.rebuild === true) {
            const result = rebuildSensorReadings(repoRoot);
            process.stdout.write(
              options.human === true
                ? `devai sense record --rebuild: ${result.reading.status.toUpperCase()} created=${String(result.report.created)} skipped=${String(result.report.skipped)}\n`
                : `${JSON.stringify(result)}\n`,
            );
            process.exitCode =
              result.reading.status === 'pass'
                ? EXIT_PASS
                : result.reading.status === 'review'
                  ? EXIT_REVIEW
                  : EXIT_FAIL;
            return;
          }
          const result = recordSensorReading(repoRoot, options.input ?? '');
          process.stdout.write(
            options.human === true
              ? `devai sense record: ${result.action} ${result.path}\n`
              : `${JSON.stringify(result)}\n`,
          );
          process.exitCode = EXIT_PASS;
        } catch (error) {
          process.stderr.write(
            `devai sense record: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});
