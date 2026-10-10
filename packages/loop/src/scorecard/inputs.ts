import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadChain, verifyLoadedChain, type EvidenceRecord } from '@devai-nyx/evidence';
import { validators } from '@devai-nyx/schemas';
import type { SensorReading } from '@devai-nyx/sensors';
import { computeScorecard, type Scorecard } from '../loop/scorecard.js';
import {
  loadScorecardNaConfig,
  resolveScorecardNaPath,
  scorecardNaCellSet,
} from '../loop/scorecard-na.js';
import { loadScorecardFailureMaxAgeMs } from './freshness-policy.js';
import { assertCandidateSupersessionGraph, filterLatestPerKind } from './latest.js';

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

/** A ledger N/A entry for a cell whose subject has readings (ADR-SCR-0008 IA-006). */
export const SCORECARD_NA_MEASURED_CELL = 'SCORECARD_NA_MEASURED_CELL';

/**
 * Cells whose subject is measured whenever readings of these kinds exist:
 * `inventory_regeneration` (F4:T9) regenerates the `inventory_dep_graph` and
 * `inventory_coverage` kinds, so a ledger N/A for F4:T9 beside them is rejected.
 */
const MEASURED_CELL_KINDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'F4:T9': Object.freeze(['inventory_dep_graph', 'inventory_coverage']),
});

/**
 * Reject a ledger N/A for a cell whose subject has readings in the store: a cell
 * reads a measured verdict or a ledger-anchored N/A, never an N/A over evidence.
 */
export function assertNaCellsUnmeasured(
  naCells: ReadonlySet<string>,
  readings: readonly SensorReading[],
): void {
  const kinds = new Set(readings.map((reading) => reading.sensor.kind as string));
  for (const [cell, measuredBy] of Object.entries(MEASURED_CELL_KINDS)) {
    if (!naCells.has(cell)) continue;
    const present = measuredBy.filter((kind) => kinds.has(kind));
    if (present.length > 0) {
      throw new Error(`${SCORECARD_NA_MEASURED_CELL}:${cell}:${present.join(',')}`);
    }
  }
}

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
    const naCells = resolveScorecardNaCells(opts.repoRoot);
    assertNaCellsUnmeasured(naCells, preReadings);
    const scorecard = computeScorecard({
      timestamp: opts.timestamp,
      integrationHead,
      readings: preReadings,
      naCells,
      staleFailAfterMs: loadScorecardFailureMaxAgeMs(opts.repoRoot),
    });
    return { scorecard, readings: preReadings, source: 'inputs' };
  }

  // (3) Disk fallback.
  const readingsDir =
    (inputs['readings_dir'] as string | undefined) ?? join(opts.repoRoot, SENSOR_READINGS_DIR);
  const readings = loadReadingsFromDir(readingsDir, {
    rejectInvalid: true,
    ...(opts.integrationHead === undefined ? {} : { integrationHead: opts.integrationHead }),
  });
  const naCells = resolveScorecardNaCells(opts.repoRoot);
  assertNaCellsUnmeasured(naCells, readings);
  const scorecard = computeScorecard({
    timestamp: opts.timestamp,
    integrationHead,
    readings,
    naCells,
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
  /** Exact candidate custody, applied before latest-instance selection. Omission is diagnostic. */
  readonly integrationHead?: string;
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
function readStoreFile(
  path: string,
  rejectInvalid: boolean,
  custody?: {
    readonly root: string;
    readonly head: string;
    readonly records: readonly EvidenceRecord[];
  },
): SensorReading[] {
  let parsed: unknown;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    if (rejectInvalid || custody !== undefined) {
      throw new Error(`${SCORECARD_READING_UNPARSEABLE}:${path}`);
    }
    return [];
  }
  const values = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
  if (
    (rejectInvalid || custody !== undefined) &&
    values.some((value) => !validators.sensorReading(value))
  ) {
    throw new Error(`${SCORECARD_READING_INVALID}:${path}`);
  }
  const readings = values as SensorReading[];
  if (custody === undefined) return readings;
  const reading = readings[0];
  const storedPath = relative(custody.root, path).split('\\').join('/');
  if (
    readings.length !== 1 ||
    reading === undefined ||
    storedPath !== `${SENSOR_READINGS_DIR}/${reading.sensor.kind}/${reading.id}.json`
  ) {
    throw new Error(`SCORECARD_READING_STORE_IDENTITY_MISMATCH:${path}`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  const bindings = custody.records.flatMap((record) =>
    record.action !== 'sense.readings.record'
      ? []
      : record.artifacts
          .filter((artifact) => artifact.path === storedPath)
          .map((artifact) => ({ digest: artifact.sha256, head: record.context.git.head_sha })),
  );
  if (bindings.length > 0 && !bindings.some((binding) => binding.digest === digest)) {
    throw new Error(`SCORECARD_READING_CHAIN_DIGEST_MISMATCH:${reading.id}`);
  }
  return bindings.some((binding) => binding.digest === digest && binding.head === custody.head)
    ? readings
    : [];
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
  let custody: Parameters<typeof readStoreFile>[2];
  if (options.integrationHead !== undefined) {
    // The post-merge observer reads a bound checkout's store from a detached worktree.
    // Custody belongs to the source store's chain, not the observer's working directory.
    const root = resolve(dir, '../../..');
    if (resolve(dir) !== join(root, SENSOR_READINGS_DIR)) {
      throw new Error(`SCORECARD_READING_CUSTODY_STORE_REQUIRED:${dir}`);
    }
    const chainPath = join(root, 'record/proofs/chain.json');
    const chain = existsSync(chainPath) ? loadChain(chainPath) : { head: null, records: [] };
    if (!verifyLoadedChain(chain).valid) throw new Error('SCORECARD_READING_CHAIN_INVALID');
    custody = { root, head: options.integrationHead, records: chain.records };
  }
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (entry.endsWith('.json')) {
      out.push(...readStoreFile(full, rejectInvalid, custody));
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
      out.push(...readStoreFile(join(full, childName), rejectInvalid, custody));
    }
  }
  if (custody !== undefined) assertCandidateSupersessionGraph(out);
  return filterLatestPerKind(out);
}
