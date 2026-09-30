import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import type { SensorReading } from '@devai-nyx/sensors';
import { computeScorecard, type Scorecard } from '../loop/scorecard.js';
import {
  loadScorecardNaConfig,
  resolveScorecardNaPath,
  scorecardNaCellSet,
} from '../loop/scorecard-na.js';
import { loadScorecardFailureMaxAgeMs } from './freshness-policy.js';
import { filterLatestPerKind } from './latest.js';

export { filterLatestPerKind } from './latest.js';

/**
 * The one readings store (ADR-SCR-0002): `sense record` persists every
 * reading at `<repoRoot>/.devai/state/sensor-readings/<kind>/<id>.json`
 * and every scorecard consumer resolves readings from that directory
 * through `resolveScorecardInputs`. No consumer reads another store.
 */
export const SENSOR_READINGS_DIR = '.devai/state/sensor-readings';

/**
 * Shared scorecard-input resolver used by `audit scorecard`, deterministic
 * scorecard computation and assessment recipes. Precedence:
 *   1. `inputs.scorecard` if pre-populated → return as-is (caller
 *      supplied a fully-computed scorecard).
 *   2. `inputs.readings` if pre-populated → compute scorecard from
 *      it (caller supplied raw readings).
 *   3. Disk fallback: walk `<repoRoot>/.devai/state/sensor-readings/`
 *      (or `inputs.readings_dir` override) one level deep into
 *      `<kind>/<id>.json` subdirectories.
 *
 * Every computed scorecard applies the repository's N/A ledger
 * (`.devai/config/scorecard-na.json`, the materialized copy of
 * `law/policy/scorecard-na.json`) as the sole source of N/A cells, and
 * the repository stale-failure policy. The per-cell classifier remains in
 * `loop/scorecard.ts`; this module keeps input resolution identical for
 * every consumer.
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

/** Project the repository N/A ledger into the classifier's `naCells` option. */
export function resolveScorecardNaCells(repoRoot: string): ReadonlySet<string> {
  return scorecardNaCellSet(loadScorecardNaConfig(resolveScorecardNaPath(repoRoot)));
}

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
      naCells: resolveScorecardNaCells(opts.repoRoot),
      staleFailAfterMs: loadScorecardFailureMaxAgeMs(opts.repoRoot),
    });
    return { scorecard, readings: preReadings, source: 'inputs' };
  }

  // (3) Disk fallback.
  const readingsDir =
    (inputs['readings_dir'] as string | undefined) ?? join(opts.repoRoot, SENSOR_READINGS_DIR);
  const readings = loadReadingsFromDir(readingsDir, { rejectInvalid: true });
  const scorecard = computeScorecard({
    timestamp: opts.timestamp,
    integrationHead,
    readings,
    naCells: resolveScorecardNaCells(opts.repoRoot),
    staleFailAfterMs: loadScorecardFailureMaxAgeMs(opts.repoRoot),
  });
  return { scorecard, readings, source: readings.length > 0 ? 'disk' : 'empty' };
}

/** A file in the readings store that is not valid JSON (ADR-REL-0033 IA-002). */
export const SCORECARD_READING_UNPARSEABLE = 'SCORECARD_READING_UNPARSEABLE';
/** A file in the readings store holding a value that is not a valid SensorReading. */
export const SCORECARD_READING_INVALID = 'SCORECARD_READING_INVALID';

/** Options of the readings-directory walker. */
export interface LoadReadingsOptions {
  /**
   * Reject instead of skipping: a file of invalid JSON throws
   * `SCORECARD_READING_UNPARSEABLE:<path>` and a value that is not a valid SensorReading
   * under the packaged schema throws `SCORECARD_READING_INVALID:<path>`. The scorecard
   * resolver always sets it (ADR-REL-0033 IA-002).
   */
  readonly rejectInvalid?: boolean;
}

/**
 * Parse one store file. Under `rejectInvalid` every SensorReading it holds is validated
 * against the packaged schema and a rejected file fails the whole resolution with a named
 * code and its path, so an unreadable or invalid reading is never counted, least of all as
 * PASS; otherwise an unparseable file is skipped.
 */
function readStoreFile(path: string, rejectInvalid: boolean): SensorReading[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    if (rejectInvalid) throw new Error(`${SCORECARD_READING_UNPARSEABLE}:${path}`);
    return [];
  }
  const values = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
  if (rejectInvalid && values.some((value) => !validators.sensorReading(value))) {
    throw new Error(`${SCORECARD_READING_INVALID}:${path}`);
  }
  return values as SensorReading[];
}

/**
 * Walk `<dir>` for `*.json` and one level into `<dir>/<kind>/*.json`.
 * The loader always selects the current standing for each sensor kind;
 * disk evidence remains intact. Without `rejectInvalid` an unparseable file
 * is skipped; with it the walk fails closed with a named code (see
 * `LoadReadingsOptions`).
 */
export function loadReadingsFromDir(
  dir: string,
  options: LoadReadingsOptions = {},
): SensorReading[] {
  const rejectInvalid = options.rejectInvalid === true;
  const out: SensorReading[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (entry.endsWith('.json')) {
      out.push(...readStoreFile(full, rejectInvalid));
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
      out.push(...readStoreFile(join(full, childName), rejectInvalid));
    }
  }
  return filterLatestPerKind(out);
}
