import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SensorReading } from '@devai-nyx/sensors';
import { computeScorecard, type Scorecard } from '../loop/scorecard.js';
import { loadScorecardFailureMaxAgeMs } from './freshness-policy.js';
import { filterLatestPerKind } from './latest.js';

export { filterLatestPerKind } from './latest.js';

/**
 * Shared scorecard-input resolver used by deterministic scorecard
 * computation and assessment recipes. Precedence:
 *   1. `inputs.scorecard` if pre-populated → return as-is (caller
 *      supplied a fully-computed scorecard).
 *   2. `inputs.readings` if pre-populated → compute scorecard from
 *      it (caller supplied raw readings).
 *   3. Disk fallback: walk `<repoRoot>/.devai/state/sensor-readings/`
 *      (or `inputs.readings_dir` override) one level deep into
 *      `<kind>/<id>.json` subdirectories.
 *
 * The per-cell classifier remains in `loop/scorecard.ts`; this module
 * keeps input resolution identical for every consumer.
 */
export interface ScorecardInputs {
  readonly repoRoot: string;
  readonly inputs: Readonly<Record<string, unknown>> | undefined;
  readonly timestamp: string;
  readonly integrationHead?: string;
}

export interface ResolvedScorecardInputs {
  readonly scorecard: Scorecard;
  readonly readings: readonly SensorReading[];
  /**
   * Where the readings came from. `'inputs'` = caller pre-populated
   * `inputs.readings` or `inputs.scorecard`; `'disk'` = the disk
   * walker found readings under `.devai/state/sensor-readings/`;
   * `'empty'` = nothing on disk + no inputs supplied.
   */
  readonly source: 'inputs' | 'disk' | 'empty';
}

const DEFAULT_INTEGRATION_HEAD = '0'.repeat(39) + 'f';

export function resolveScorecardInputs(opts: ScorecardInputs): ResolvedScorecardInputs {
  const inputs = opts.inputs ?? {};
  const integrationHead = opts.integrationHead ?? DEFAULT_INTEGRATION_HEAD;

  // (1) Caller supplied a fully-computed scorecard.
  const preComputed = inputs['scorecard'] as Scorecard | undefined;
  if (preComputed !== undefined) {
    const preReadings = filterLatestPerKind(
      (inputs['readings'] as readonly SensorReading[] | undefined) ?? [],
    );
    return { scorecard: preComputed, readings: preReadings, source: 'inputs' };
  }

  // (2) Caller supplied raw readings.
  const suppliedReadings = inputs['readings'] as readonly SensorReading[] | undefined;
  if (suppliedReadings !== undefined && suppliedReadings.length > 0) {
    const preReadings = filterLatestPerKind(suppliedReadings);
    const scorecard = computeScorecard({
      timestamp: opts.timestamp,
      integrationHead,
      readings: preReadings,
      staleFailAfterMs: loadScorecardFailureMaxAgeMs(opts.repoRoot),
    });
    return { scorecard, readings: preReadings, source: 'inputs' };
  }

  // (3) Disk fallback.
  const readingsDir =
    (inputs['readings_dir'] as string | undefined) ??
    join(opts.repoRoot, '.devai/state/sensor-readings');
  const readings = loadReadingsFromDir(readingsDir);
  const scorecard = computeScorecard({
    timestamp: opts.timestamp,
    integrationHead,
    readings,
    staleFailAfterMs: loadScorecardFailureMaxAgeMs(opts.repoRoot),
  });
  return { scorecard, readings, source: readings.length > 0 ? 'disk' : 'empty' };
}

/**
 * Walk `<dir>` for `*.json` and one level into `<dir>/<kind>/*.json`.
 * The loader always selects the current standing for each sensor kind;
 * disk evidence remains intact.
 */
export function loadReadingsFromDir(dir: string): SensorReading[] {
  const out: SensorReading[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (entry.endsWith('.json')) {
      try {
        const parsed = JSON.parse(readFileSync(full, 'utf8')) as unknown;
        if (Array.isArray(parsed)) {
          for (const r of parsed) out.push(r as SensorReading);
        } else {
          out.push(parsed as SensorReading);
        }
      } catch {
        // skip unparseable
      }
      continue;
    }
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const childName of readdirSync(full).sort()) {
      if (!childName.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(full, childName), 'utf8')) as unknown;
        if (Array.isArray(parsed)) {
          for (const r of parsed) out.push(r as SensorReading);
        } else {
          out.push(parsed as SensorReading);
        }
      } catch {
        // skip unparseable
      }
    }
  }
  return filterLatestPerKind(out);
}
