import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendVerbEvidence, loadChain } from '#runtime-core';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { validators } from '@devai-nyx/schemas';
import { isSensorKind, type SensorReading } from '@devai-nyx/sensors';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW, EXIT_USAGE } from '@devai-nyx/utils';
import { declaredInvocationAuthority } from '../../authority/index.js';
import { defineCommand } from '../../define-command.js';
import {
  gateSelfDogfoodCommand,
  resolveSelfDogfoodDeclaration,
  selfDogfoodRefusal,
} from '../../services/self-dogfood.js';
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

/** The chain `sense record` appends its second write to (ADR-SCR-0008). */
export const SENSE_RECORD_CHAIN_PATH = 'record/proofs/chain.json';
/** The chain action naming one recorded reading file and its digest. */
export const SENSE_RECORD_CHAIN_ACTION = 'sense.readings.record';
const SENSOR_READINGS_STORE = '.devai/state/sensor-readings';

interface ChainArtifactView {
  readonly path?: unknown;
  readonly sha256?: unknown;
}

/** The SHA-256 the latest chain entry naming `path` declares for it, if any. */
function chainedDigest(repoRoot: string, path: string): string | undefined {
  const chainPath = join(repoRoot, SENSE_RECORD_CHAIN_PATH);
  if (!existsSync(chainPath)) return undefined;
  const chain = loadChain(chainPath);
  let digest: string | undefined;
  for (const entry of chain.records) {
    if (entry.action !== SENSE_RECORD_CHAIN_ACTION) continue;
    for (const artifact of (entry.artifacts ?? []) as readonly ChainArtifactView[]) {
      if (artifact.path === path) digest = String(artifact.sha256);
    }
  }
  return digest;
}

function appendChainEntry(
  repoRoot: string,
  reading: SensorReading,
  path: string,
  sha256: string,
): void {
  const appended = appendVerbEvidence({
    repoRoot,
    chainPath: SENSE_RECORD_CHAIN_PATH,
    action: SENSE_RECORD_CHAIN_ACTION,
    status: 'completed',
    artifacts: [{ path, sha256, kind: 'sensor-reading' }],
    notes: [`sensor-reading id: ${reading.id}; kind: ${reading.sensor.kind}; sha256: ${sha256}`],
  });
  if (!appended.ok) {
    throw new Error(`SENSE_RECORD_CHAIN_APPEND_FAILED:${reading.id}:${appended.error ?? ''}`);
  }
}

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The second write of a re-record: an already recorded file whose chain entry was
 * lost gains one `sense.readings.record` entry. An existing entry is never
 * rewritten; one whose digest disagrees with the file is a finding
 * (`SENSE_RECORD_CHAIN_DIGEST_MISMATCH`), never a repair.
 */
function repairChainEntry(
  repoRoot: string,
  reading: SensorReading,
  path: string,
  bytes: Buffer,
): void {
  const sha256 = digestOf(bytes);
  const declared = chainedDigest(repoRoot, path);
  if (declared === undefined) {
    appendChainEntry(repoRoot, reading, path, sha256);
    return;
  }
  if (declared !== sha256) throw new Error(`SENSE_RECORD_CHAIN_DIGEST_MISMATCH:${reading.id}`);
}

/**
 * Record one reading as an immutable instance (ADR-SCR-0008). Two ordered writes:
 * the reading file under `.devai/state/sensor-readings/<kind>/<id>.json` with `wx`,
 * then one digest-bearing chain entry. A re-record of the same body appends the
 * missing entry when the second write was lost and rewrites nothing.
 */
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
  const relativePath = `${SENSOR_READINGS_STORE}/${reading.sensor.kind}/${reading.id}.json`;
  const directory = join(repoRoot, SENSOR_READINGS_STORE, reading.sensor.kind);
  const target = join(directory, `${reading.id}.json`);
  if (existsSync(target)) {
    const bytes = readFileSync(target);
    let existing: unknown;
    try {
      existing = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (error) {
      throw new Error(`SENSE_RECORD_EXISTING_INVALID:${target}`, { cause: error });
    }
    if (JSON.stringify(existing) !== JSON.stringify(reading)) {
      throw new Error(`SENSE_RECORD_ID_CONFLICT:${reading.id}`);
    }
    repairChainEntry(repoRoot, reading, relativePath, bytes);
    return Object.freeze({ path: target, action: 'already-recorded', reading });
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(target, canonical, { flag: 'wx' });
  // A newly created file always gains its own entry naming exactly these bytes.
  appendChainEntry(repoRoot, reading, relativePath, digestOf(Buffer.from(canonical, 'utf8')));
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
        // ADR-SCR-0001: on the framework repository only the inspector, with
        // write consent, records readings, and every reading it records carries
        // the declaring role and the human invocation. Refused before any write.
        const declaration = resolveSelfDogfoodDeclaration(declaredInvocationAuthority());
        const attribution = {
          declaring_role: declaration?.role,
          human_invocation:
            declaration?.human_invoked === true ? declaration.declaration_source : undefined,
        };
        const selfDogfood = gateSelfDogfoodCommand({
          repoRoot,
          action_id: 'sense record',
          declaration,
          reading: attribution,
        });
        if (selfDogfood.applies && !selfDogfood.decision.ok) {
          process.stderr.write(selfDogfoodRefusal(selfDogfood));
          process.exitCode = EXIT_USAGE;
          return;
        }
        const attributed = selfDogfood.applies ? { attribution } : {};
        try {
          if (options.rebuild === true) {
            const result = rebuildSensorReadings(repoRoot);
            process.stdout.write(
              options.human === true
                ? `devai sense record --rebuild: ${result.reading.status.toUpperCase()} created=${String(result.report.created)} skipped=${String(result.report.skipped)}\n`
                : `${JSON.stringify({ ...result, ...attributed })}\n`,
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
              : `${JSON.stringify({ ...result, ...attributed })}\n`,
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
