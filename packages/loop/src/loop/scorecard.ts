import { SENSOR_KINDS_BY_TIER, sensorCellMap, type SensorReading } from '@devai-nyx/sensors';
import { filterLatestPerKind } from '../scorecard/latest.js';
import type {
  AggregateVerdict,
  CellVerdict,
  Property,
  Scorecard,
  ScorecardCell,
  Substrate,
  SubstrateAggregate,
} from './scorecard-types.js';
import { scorecardId } from './scorecard-assessment.js';
export { assessScorecard, summarizeCells } from './scorecard-assessment.js';
export type {
  Assessment,
  AssessmentDelta,
  BacklogActions,
  RecommendedPriority,
} from './scorecard-assessment.js';

export type {
  AggregateVerdict,
  CellVerdict,
  InvariantRollup,
  Property,
  Scorecard,
  ScorecardCell,
  Substrate,
  SubstrateAggregate,
} from './scorecard-types.js';

/**
 * Marker that opens the `notes` of a cell recorded N/A by declaration
 * (ADR-SCR-0003). scorecard.schema.json closes the cell record, so the
 * source of an N/A verdict travels in `notes`: a ledger N/A carries no
 * readings and no marker; a declaration N/A lists its skipped readings in
 * `sensor_readings` and opens `notes` with this marker followed by one
 * `<kind>: <reason>` entry per skipped reading, joined by `; `.
 */
export const NA_DECLARATION_NOTE_PREFIX = 'N/A-declaration:';

/** Where an N/A verdict came from: the ledger (ADR-SCR-0002) or a surfaces declaration (ADR-SCR-0003). */
export type CellNaSource = 'ledger' | 'declaration';

/**
 * Read the source of a cell's N/A verdict from its record, or null when the
 * cell is not N/A. Ledger and declaration are the only two sources.
 */
export function scorecardCellNaSource(
  cell: Pick<ScorecardCell, 'verdict' | 'notes'>,
): CellNaSource | null {
  if (cell.verdict !== 'N/A') return null;
  return cell.notes?.startsWith(NA_DECLARATION_NOTE_PREFIX) === true ? 'declaration' : 'ledger';
}

/**
 * The declaration reason a skipped reading carries (ADR-SCR-0003): the
 * message of its first finding, else its err_head or out_head, else a
 * generic statement naming the sensor. A sensor skipping for an absent
 * surface therefore states the declaration in its first finding.
 */
export function skippedReadingReason(reading: SensorReading): string {
  const finding = reading.findings?.[0];
  if (finding !== undefined && finding.message.length > 0) return finding.message;
  if (reading.err_head !== undefined && reading.err_head.length > 0) return reading.err_head;
  if (reading.out_head !== undefined && reading.out_head.length > 0) return reading.out_head;
  return `skipped by ${reading.sensor.kind} without a stated reason`;
}

const SUBSTRATES: readonly Substrate[] = ['F1', 'F2', 'F3', 'F4', 'F5'];
const PROPERTIES: readonly Property[] = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'];

export interface ComputeScorecardOptions {
  readonly timestamp: string;
  readonly integrationHead: string;
  readonly readings?: readonly SensorReading[];
  /** Counter suffix; defaults to 001. Use to disambiguate sub-second runs. */
  readonly sequence?: number;
  /**
   * The N/A ledger projection (ADR-SCR-0002): cell coordinates in
   * `Fx:Ty` form forced to verdict `N/A` regardless of any reading,
   * applied BEFORE reading-driven verdicts and winning over every
   * reading, skipped or measured. The classifier holds no list of its
   * own, so a degenerate cell under Constitution Article 5 (for example
   * Inventory × Idiomaticity, F4:T5) is N/A only because the ledger
   * says so with a reason. The one other path to N/A is a surfaces
   * declaration (ADR-SCR-0003): a cell whose readings are all
   * `skipped` is recorded N/A with the declaration reason, marked by
   * `NA_DECLARATION_NOTE_PREFIX` in its notes. Build the ledger set with `loadScorecardNaConfig` +
   * `scorecardNaCellSet` from the repo's materialized
   * `.devai/config/scorecard-na.json`, which mirrors
   * `law/policy/scorecard-na.json`. Omitted or empty, every cell is
   * scoreable.
   */
  readonly naCells?: ReadonlySet<string>;
  /**
   * Freshness boundary. Omit until policy supplies an authorized value; the readings it bounds
   * are governed by ADR-SCR-0002.
   */
  readonly staleFailAfterMs?: number;
}

/**
 * Compute a scorecard from a set of recent SensorReadings.
 *
 * - Every substrate × property cell starts as 'UNKNOWN'.
 * - Cells listed in the N/A ledger (`naCells`, ADR-SCR-0002) are marked 'N/A'
 *   and take no reading at all.
 * - For each SensorReading we map sensor.kind → substrate/property and
 *   set the cell's verdict from the reading's status. Multiple measured
 *   readings for one cell collapse to the worst (FAIL > REVIEW > UNKNOWN > PASS).
 * - A 'skipped' reading (ADR-SCR-0003: its sensor is bound to a surface the
 *   repository declared absent) is listed in the cell's readings but never
 *   enters the collapse. A cell whose readings are all skipped is recorded
 *   'N/A' with the declaration reason in its notes, never 'UNKNOWN' or
 *   'REVIEW'; one measured reading in the cell makes its skipped siblings
 *   inert.
 * - Per-cell deterministic flag = AND of the measured readings'
 *   deterministic flags (any non-deterministic reading taints the cell).
 *
 * Returns a Scorecard record conformant to scorecard.schema.json.
 */
export function computeScorecard(opts: ComputeScorecardOptions): Scorecard {
  const cells: ScorecardCell[] = [];
  const naOverlay = opts.naCells ?? new Set<string>();
  for (const substrate of SUBSTRATES) {
    for (const property of PROPERTIES) {
      const key = `${substrate}:${property}`;
      // The ledger projection is the only path to N/A (ADR-SCR-0002).
      const isDegenerate = naOverlay.has(key);
      cells.push({
        substrate,
        property,
        verdict: isDegenerate ? 'N/A' : 'UNKNOWN',
        deterministic: true, // vacuously; updated when a reading lands.
      });
    }
  }

  const currentReadings = filterLatestPerKind(opts.readings ?? []);
  const staleFailAfterMs = opts.staleFailAfterMs;
  const generatedAtMs = Date.parse(opts.timestamp);
  // Per cell: how many measured readings landed, and the declaration
  // reasons of the skipped ones (ADR-SCR-0003).
  const tallies = new Map<string, { measured: number; skipped: string[] }>();
  for (const reading of currentReadings) {
    // mapSensorToCell may return more than one cell.
    // cell — e.g. an inventory SR contributes to both the F4×T1
    // "presence" row AND the per-kind semantic cell. The loop
    // applies the reading to every mapped cell, with the same
    // worst-wins merge semantics on each.
    const mappings = scorecardCellsForSensorKind(reading.sensor.kind);
    for (const mapping of mappings) {
      const cellKey = `${mapping.substrate}:${mapping.property}`;
      const cell = cells.find(
        (c) => c.substrate === mapping.substrate && c.property === mapping.property,
      );
      // A ledger N/A wins over every reading and lists none of them.
      if (cell === undefined || naOverlay.has(cellKey)) continue;
      let tally = tallies.get(cellKey);
      if (tally === undefined) {
        tally = { measured: 0, skipped: [] };
        tallies.set(cellKey, tally);
      }
      const refs = cell.sensor_readings ?? [];
      refs.push(reading.id);
      cell.sensor_readings = refs;
      if (reading.status === 'skipped') {
        // Listed, never collapsed: the surface was declared absent.
        tally.skipped.push(`${reading.sensor.kind}: ${skippedReadingReason(reading)}`);
        continue;
      }
      const staleFail = isStaleFailure(reading, generatedAtMs, staleFailAfterMs);
      const incoming = staleFail ? 'REVIEW' : sensorStatusToVerdict(reading.status);
      // Only a cell with no measured reading yet is replaced outright. An
      // explicit UNKNOWN reading is evidence of a gap and participates in
      // worst-wins merging.
      cell.verdict = tally.measured === 0 ? incoming : worseVerdict(cell.verdict, incoming);
      tally.measured += 1;
      cell.deterministic = cell.deterministic && reading.deterministic;
      if (staleFail) {
        const marker = `REVIEW-stale: latest ${reading.sensor.kind} failure at ${reading.timestamp}`;
        cell.notes = cell.notes === undefined ? marker : `${cell.notes}; ${marker}`;
      } else if (['fail', 'error', 'killed'].includes(reading.status)) {
        const marker = `latest ${reading.sensor.kind} failure at ${reading.timestamp}`;
        cell.notes = cell.notes === undefined ? marker : `${cell.notes}; ${marker}`;
      }
    }
  }

  // ADR-SCR-0003: a cell whose readings are all skipped is N/A by
  // declaration, with the reasons in its notes behind the marker.
  for (const cell of cells) {
    const tally = tallies.get(`${cell.substrate}:${cell.property}`);
    if (tally === undefined || tally.measured > 0 || tally.skipped.length === 0) continue;
    cell.verdict = 'N/A';
    const marker = `${NA_DECLARATION_NOTE_PREFIX} ${tally.skipped.join('; ')}`;
    cell.notes = cell.notes === undefined ? marker : `${cell.notes}; ${marker}`;
  }

  // Substrate aggregates: each substrate's worst cell.
  const substrate_aggregates: Partial<Record<Substrate, SubstrateAggregate>> = {};
  for (const substrate of SUBSTRATES) {
    let worst: AggregateVerdict = 'PASS';
    let any = false;
    for (const c of cells) {
      if (c.substrate !== substrate) continue;
      if (c.verdict === 'N/A') continue;
      any = true;
      worst = worseAggregate(worst, cellToAggregate(c.verdict));
    }
    substrate_aggregates[substrate] = { verdict: any ? worst : 'UNKNOWN' };
  }

  // Overall: worst across substrate aggregates.
  let overallVerdict: AggregateVerdict = 'PASS';
  for (const agg of Object.values(substrate_aggregates)) {
    if (agg === undefined) continue;
    overallVerdict = worseAggregate(overallVerdict, agg.verdict);
  }

  const id = scorecardId(opts.timestamp, opts.sequence ?? 1, 'SC');
  return {
    schemaVersion: '1.0.0',
    id,
    generated_at: opts.timestamp,
    integration_head: opts.integrationHead,
    thresholds_used: { source: 'defaults' },
    cells,
    substrate_aggregates,
    invariant_rollups: [],
    overall: { verdict: overallVerdict },
  };
}

/**
 * Map a SensorReading to one or more scorecard cells.
 *
 * Most sensor kinds map to a single cell. The seven L0 inventory kinds also contribute
 * to a canonical "presence" cell at F4×T1 (Inventory × Coverage,
 * per Constitution Article 5), in addition to the per-kind
 * semantic cell. Rationale: T1 ("did we cover this surface?")
 * is the natural anchor for "we inventoried the API map / the
 * routes / the data model / etc." Every inventory SR
 * contributes to F4×T1, and the worst-wins merge across the
 * seven kinds gives a single scorecard-level read on inventory
 * completeness.
 *
 * The per-kind semantic cells are retained:
 * - inventory_api / inventory_routes / inventory_data_model /
 *   inventory_coverage → F4×T2 (Depth)
 * - inventory_data_handling / inventory_rbac → F4×T6 (Security
 *   and Privacy)
 * - inventory_dep_graph → F4×T3 (Coherence)
 *
 * Constitution Article 5 T-axis names:
 *   T1 Coverage, T2 Depth, T3 Coherence, T4 Alignment,
 *   T5 Idiomaticity, T6 Security and Privacy,
 *   T7 Performance and Efficiency, T8 Robustness, T9 Discipline.
 *
 * Returns an empty array for unmapped sensor kinds.
 */
export function scorecardCellsForSensorKind(
  kind: SensorReading['sensor']['kind'],
): ReadonlyArray<{ substrate: Substrate; property: Property }> {
  const registryCells = sensorCellMap()[kind] ?? [];
  return registryCells.flatMap((cell) =>
    isSubstrate(cell.substrate) && isProperty(cell.property)
      ? [{ substrate: cell.substrate, property: cell.property }]
      : [],
  );
}

/**
 * Scheduled reachability, derived entirely from the sensor registry. Scorecard composition is
 * governed by ADR-SCR-0002.
 */
export function scheduledScorecardCells(): ReadonlyArray<{
  substrate: Substrate;
  property: Property;
}> {
  const cells = new Map<string, { substrate: Substrate; property: Property }>();
  for (const kinds of Object.values(SENSOR_KINDS_BY_TIER)) {
    for (const kind of kinds) {
      for (const cell of sensorCellMap()[kind] ?? []) {
        if (!isSubstrate(cell.substrate) || !isProperty(cell.property)) continue;
        cells.set(`${cell.substrate}:${cell.property}`, {
          substrate: cell.substrate,
          property: cell.property,
        });
      }
    }
  }
  return [...cells.values()].sort((left, right) =>
    `${left.substrate}:${left.property}`.localeCompare(`${right.substrate}:${right.property}`),
  );
}

function isSubstrate(value: string): value is Substrate {
  return (SUBSTRATES as readonly string[]).includes(value);
}

function isProperty(value: string): value is Property {
  return (PROPERTIES as readonly string[]).includes(value);
}

function isStaleFailure(
  reading: SensorReading,
  generatedAtMs: number,
  staleAfterMs: number | undefined,
): boolean {
  if (staleAfterMs === undefined) return false;
  if (!['fail', 'error', 'killed'].includes(reading.status)) return false;
  const readingAtMs = Date.parse(reading.timestamp);
  return (
    Number.isFinite(generatedAtMs) &&
    Number.isFinite(readingAtMs) &&
    staleAfterMs >= 0 &&
    generatedAtMs - readingAtMs > staleAfterMs
  );
}

function sensorStatusToVerdict(s: SensorReading['status']): CellVerdict {
  switch (s) {
    case 'pass':
      return 'PASS';
    case 'fail':
    case 'killed':
    case 'error':
      return 'FAIL';
    case 'review':
      return 'REVIEW';
    case 'unknown':
      return 'UNKNOWN';
    case 'skipped':
      // Unreachable from computeScorecard, which lists a skipped reading
      // without collapsing it (ADR-SCR-0003); kept so the switch stays
      // total over SensorStatus.
      return 'UNKNOWN';
  }
}

const CELL_ORDER: Readonly<Record<CellVerdict, number>> = {
  FAIL: 4,
  REVIEW: 3,
  UNKNOWN: 2,
  PASS: 1,
  'N/A': 0,
};

function worseVerdict(a: CellVerdict, b: CellVerdict): CellVerdict {
  return CELL_ORDER[a] >= CELL_ORDER[b] ? a : b;
}

const AGG_ORDER: Readonly<Record<AggregateVerdict, number>> = {
  FAIL: 4,
  REVIEW: 3,
  UNKNOWN: 2,
  PASS: 1,
};

function worseAggregate(a: AggregateVerdict, b: AggregateVerdict): AggregateVerdict {
  return AGG_ORDER[a] >= AGG_ORDER[b] ? a : b;
}

function cellToAggregate(v: CellVerdict): AggregateVerdict {
  return v === 'N/A' ? 'UNKNOWN' : v;
}
