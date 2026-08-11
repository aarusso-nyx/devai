import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { join } from 'node:path';
import { resolveSensorParams } from '@devai-nyx/skills';
import type { SensorReading } from '@devai-nyx/sensors';
import { EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';

export const DEFAULT_REPO_ROOT = '.';

/**
 * Phase 19.B (D-61): per-sensor pack-tune helper. When a sense CLI
 * invocation opts in via `--pack-tune` (or pins a pack with
 * `--pack-id`), this resolves the matched pack's `extractor_params`
 * for the given sensor kind and returns them as a defaults map.
 * CLI flags supplied explicitly always win over pack defaults; the
 * caller is responsible for that precedence.
 *
 * Returns an empty object when:
 *   - The caller did not opt in (packTune undefined/false and packId
 *     undefined).
 *   - No pack matches the adopter root.
 *   - The matched pack declares no params for this sensor kind.
 */
export interface PackTuneInputs {
  readonly packTune?: boolean;
  readonly packId?: string;
  readonly packsRoot?: string;
}

export function maybeResolvePackParams(
  sensorKind: string,
  adopterRoot: string,
  inputs: PackTuneInputs,
): Readonly<Record<string, unknown>> {
  if (inputs.packTune !== true && inputs.packId === undefined) return {};
  const resolved = resolveSensorParams({
    adopterRoot,
    sensorKind,
    ...(inputs.packsRoot !== undefined && { packsRoot: inputs.packsRoot }),
    ...(inputs.packId !== undefined && { explicitId: inputs.packId }),
  });
  return resolved?.params ?? {};
}

/**
 * Map a SensorReading status to a process exit code.
 *
 * CTX-07 separates successful observations from execution errors. PASS,
 * REVIEW, UNKNOWN, and SKIPPED are payload verdicts and exit 0. A sensor
 * invoked as a gate exits 3 on FAIL. Operational ERROR/KILLED outcomes exit 6
 * and never manufacture a verdict.
 */
export function exitFor(status: SensorReading['status']): number {
  switch (status) {
    case 'pass':
    case 'skipped':
    case 'unknown':
    case 'review':
      return EXIT_PASS;
    case 'fail':
      return 3;
    case 'error':
    case 'killed':
      return 6;
  }
}

export function emit(reading: SensorReading, human: boolean): void {
  if (human) {
    const findings = (reading.findings ?? [])
      .map(
        (f) =>
          `  [${f.severity}] ${f.code}: ${f.message}${f.file !== undefined ? ` (${f.file}${f.line !== undefined ? `:${String(f.line)}` : ''})` : ''}`,
      )
      .join('\n');
    process.stdout.write(
      `${reading.sensor.name} [${reading.sensor.kind}]: ${reading.status.toUpperCase()}` +
        (reading.duration_ms !== undefined ? ` (${String(reading.duration_ms)}ms)` : '') +
        '\n' +
        (findings.length > 0 ? findings + '\n' : ''),
    );
  } else {
    process.stdout.write(JSON.stringify(reading) + '\n');
  }
}

/**
 * Persist a SensorReading to
 * `<repoRoot>/.devai/state/sensor-readings/<kind>/<id>.json`. The
 * scorecard machinery (in `@devai-nyx/skills` via
 * `loadReadingsFromDir`) reads from this directory; without
 * persistence, the autonomous loop's scorecard → backlog →
 * assessment recipes receive all-UNKNOWN cells and
 * produces no useful work for adopters.
 *
 * Pre-21.E, the sense-* commands built SensorReading records and
 * emitted them to stdout via `emit()` but never persisted them.
 * Omitting this record makes
 * the autonomous loop non-functional for adopters even though the
 * substrate wired correctly end-to-end.
 *
 * Writes are best-effort: directory-creation or write failures
 * surface as a stderr note but don't change the SensorReading's
 * status. The sense command's exit code is driven by the reading,
 * not by the persistence side-effect.
 */
export function persistSensorReading(reading: SensorReading, repoRoot: string): string {
  const dir = join(repoRoot, '.devai/state/sensor-readings', reading.sensor.kind);
  const target = join(dir, `${reading.id}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, JSON.stringify(reading, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(
      `warning: failed to persist SensorReading to ${target}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return target;
}

/**
 * Shared post-amble for every supported sense observation. R21 D-139
 * supersedes the Phase 21.E/D-120 implicit persistence behavior: an
 * observation emits its reading and exits, but never creates state. A caller
 * that wants canonical persistence invokes the separately governed
 * `sense readings record` mutation over the exact emitted artifact.
 */
export interface FinishSenseOptions {
  readonly repoRoot: string;
  readonly human?: boolean;
}

export function finishSenseCommand(reading: SensorReading, opts: FinishSenseOptions): void {
  emit(reading, opts.human === true);
  process.exitCode = exitFor(reading.status);
}

export type InventoryOutputMode = 'reading' | 'body';

export interface FinishInventorySenseOptions extends FinishSenseOptions {
  readonly output?: string;
}

/**
 * Emit either the ordinary SensorReading or an inventory's complete body.
 *
 * D-139 makes both modes pure observations: selecting `body` changes stdout,
 * never persistence. The default remains `reading` so `sense run` and existing
 * machine consumers retain the stable SensorReading contract.
 */
export function finishInventorySenseCommand(
  reading: SensorReading,
  body: unknown,
  opts: FinishInventorySenseOptions,
): void {
  const output = opts.output ?? 'reading';
  if (output !== 'reading' && output !== 'body') {
    process.stderr.write(
      `sense inventory: --output must be 'reading' or 'body' (got '${output}')\n`,
    );
    process.exit(EXIT_USAGE);
  }
  if (output === 'body') {
    if (opts.human === true) {
      process.stderr.write(
        'sense inventory: --output body cannot be combined with --format human\n',
      );
      process.exit(EXIT_USAGE);
    }
    process.stdout.write(JSON.stringify(body) + '\n');
    // Large inventories can exceed a pipe's buffer. Assigning exitCode lets
    // Node drain stdout before termination; process.exit() can truncate the
    // payload (observed at 65,536 bytes for DEVAI's own dependency graph).
    process.exitCode = exitFor(reading.status);
    return;
  }
  finishSenseCommand(reading, opts);
}
