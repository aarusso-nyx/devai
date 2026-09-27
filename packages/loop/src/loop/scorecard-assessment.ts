import type { SensorReading } from '@devai-nyx/sensors';
import type {
  CellVerdict,
  Property,
  Scorecard,
  ScorecardCell,
  Substrate,
} from './scorecard-types.js';

/**
 * Build the schema-conformant scorecard id: `SC-YYYYMMDDThhmmss-NNN`.
 * Per scorecard.schema.json pattern `^SC-[0-9]{8}T[0-9]{6}-[0-9]{3}$`.
 */
export function scorecardId(isoTimestamp: string, sequence: number, prefix: 'SC' | 'AS'): string {
  // Robust: parse ISO into UTC parts so we never produce e.g. fractional seconds.
  const date = new Date(isoTimestamp);
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const seq = String(sequence).padStart(3, '0');
  return `${prefix}-${yyyy}${mm}${dd}T${hh}${mi}${ss}-${seq}`;
}

/** Convenience helper: count cells by verdict for human output. */
export function summarizeCells(cells: readonly ScorecardCell[]): {
  total: number;
  pass: number;
  fail: number;
  review: number;
  unknown: number;
  na: number;
} {
  const out = { total: cells.length, pass: 0, fail: 0, review: 0, unknown: 0, na: 0 };
  for (const c of cells) {
    switch (c.verdict) {
      case 'PASS':
        out.pass++;
        break;
      case 'FAIL':
        out.fail++;
        break;
      case 'REVIEW':
        out.review++;
        break;
      case 'UNKNOWN':
        out.unknown++;
        break;
      case 'N/A':
        out.na++;
        break;
    }
  }
  return out;
}

// ============================================================================
// Assessment
// ============================================================================

export interface AssessmentDelta {
  substrate: Substrate;
  property: Property;
  direction: 'improved' | 'regressed' | 'unchanged' | 'newly_evaluated';
  previous_verdict?: CellVerdict;
  current_verdict?: CellVerdict;
  delta_score?: number;
}

export interface BacklogActions {
  additions: { task_id: string; rationale: string }[];
  completions: string[];
  deprioritizations: { task_id?: string; new_priority?: number; rationale?: string }[];
}

export interface RecommendedPriority {
  task_id: string;
  priority: number;
  rationale: string;
}

export interface Assessment {
  schemaVersion: '1.0.0';
  id: string; // AS-YYYYMMDDThhmmss-NNN
  generated_at: string;
  scorecard_id: string;
  previous_assessment_id: string | null;
  narrative: string;
  deltas: AssessmentDelta[];
  backlog_actions: BacklogActions;
  recommended_priorities: RecommendedPriority[];
}

/**
 * Build a schema-conformant Assessment from a Scorecard:
 *
 *   - narrative encodes the green/yellow/red status read.
 *   - deltas: empty (no previous scorecard available in the MVP API).
 *   - backlog_actions / recommended_priorities: empty arrays. The real
 *     auditor will populate them; deterministic backlog compilation is
 *     where the work lives.
 */
export function assessScorecard(
  scorecard: Scorecard,
  timestamp: string,
  sequence = 1,
  readings: readonly SensorReading[] = [],
): Assessment {
  const s = summarizeCells(scorecard.cells);
  const status: 'green' | 'yellow' | 'red' =
    s.fail > 0
      ? 'red'
      : s.review > 0 || s.unknown > scorecard.cells.length / 2
        ? 'yellow'
        : 'green';
  const narrativeParts = [
    `Overall: ${status.toUpperCase()}.`,
    `${String(s.pass)}/${String(s.total)} cells passing.`,
    s.fail > 0 ? `${String(s.fail)} cell(s) failing.` : '',
    s.review > 0 ? `${String(s.review)} cell(s) in review.` : '',
    s.unknown > 0 ? `${String(s.unknown)} cell(s) unknown (sensor coverage gap).` : '',
  ].filter((p) => p.length > 0);

  // Phase 22.F (closes D-A-16): when more than half the cells are
  // UNKNOWN, append an actionable-advice paragraph. The pre-22.F
  // narrative diagnosed correctly ("0/45 cells passing, 43
  // UNKNOWN") but offered no path forward for an adopter reading
  // it. The advice cites the L1+ correctness sensors most likely
  // missing and points at the recommended `sense-* --emit-reading`
  // wrapper pattern documented in docs/adopters/first-introspection.md.
  const isMostlyUnknown = scorecard.cells.length > 0 && s.unknown * 2 > scorecard.cells.length;
  if (isMostlyUnknown) {
    narrativeParts.push(
      "Your scorecard is heavily UNKNOWN. This usually means correctness sensors (sense-lint, sense-test, sense-build, sense-type-check) aren't emitting SensorReadings yet. To populate the cell matrix, wrap your existing test/lint/build scripts as `devai sense-* --emit-reading` invocations (one per kind) and re-run this assessment. See docs/adopters/first-introspection.md#correctness-sensors for the recommended wrapper pattern.",
    );
  }

  // Per-cell-class actionable lines.
  // For FAIL cells, quote the SR's first finding (or err_head head)
  // verbatim so the adopter can act without opening the SR file.
  // For REVIEW cells, list the review finding codes. For UNKNOWN
  // cells that nonetheless carry sensor_readings refs (classifier
  // rejected a present SR), point at the (kind, path) so the
  // adopter can audit the classifier rule. The pre-23.I narrative
  // was a single text block; post-23.I, adopters get per-cell
  // guidance.
  const readingById = new Map<string, SensorReading>();
  for (const r of readings) readingById.set(r.id, r);
  const perCellLines: string[] = [];
  for (const c of scorecard.cells) {
    const cellKey = `${c.substrate}×${c.property}`;
    const refs = c.sensor_readings ?? [];
    if (c.verdict === 'FAIL') {
      const detail = describeFailureFromRefs(refs, readingById);
      perCellLines.push(`  - ${cellKey} FAIL: ${detail}`);
    } else if (c.verdict === 'REVIEW') {
      const detail = describeReviewFromRefs(refs, readingById);
      perCellLines.push(`  - ${cellKey} REVIEW: ${detail}`);
    } else if (c.verdict === 'UNKNOWN' && refs.length > 0) {
      // SR(s) present but classifier returned UNKNOWN — this happens
      // when the SR's status was `unknown` (a skipped SR records N/A
      // by declaration instead, ADR-SCR-0003).
      const kinds = Array.from(
        new Set(refs.map((id) => readingById.get(id)?.sensor.kind ?? '<unknown>')),
      ).join(', ');
      perCellLines.push(
        `  - ${cellKey} UNKNOWN (SR exists but classifier returned UNKNOWN; check rule for kind=${kinds})`,
      );
    }
  }
  if (perCellLines.length > 0) {
    narrativeParts.push('Per-cell signals:\n' + perCellLines.join('\n'));
  }

  const narrative = narrativeParts.join(' ');

  return {
    schemaVersion: '1.0.0',
    id: scorecardId(timestamp, sequence, 'AS'),
    generated_at: timestamp,
    scorecard_id: scorecard.id,
    previous_assessment_id: null,
    narrative,
    deltas: [],
    backlog_actions: { additions: [], completions: [], deprioritizations: [] },
    recommended_priorities: [],
  };
}

/**
 * Summarize a FAIL cell's underlying
 * SR(s). Prefers the first finding's `code: message` (with optional
 * file:line), falling back to the SR's err_head head or sensor
 * name when no findings landed. Truncates to keep the narrative
 * scannable.
 */
function describeFailureFromRefs(
  refs: readonly string[],
  readingById: ReadonlyMap<string, SensorReading>,
): string {
  if (refs.length === 0) return '(no SR refs; cell verdict came from elsewhere)';
  const fragments: string[] = [];
  for (const id of refs) {
    const r = readingById.get(id);
    if (r === undefined) {
      fragments.push(`SR ${id} not loaded`);
      continue;
    }
    if (r.status !== 'fail' && r.status !== 'error' && r.status !== 'killed') continue;
    const f = (r.findings ?? [])[0];
    if (f !== undefined) {
      const loc =
        f.file !== undefined
          ? ` (${f.file}${f.line !== undefined ? `:${String(f.line)}` : ''})`
          : '';
      fragments.push(`${r.sensor.kind} → ${f.code}: ${truncate(f.message, 160)}${loc}`);
    } else if (r.err_head !== undefined && r.err_head.length > 0) {
      fragments.push(`${r.sensor.kind} → ${truncate(r.err_head, 160)}`);
    } else {
      fragments.push(`${r.sensor.kind} → exit=${String(r.exit_code ?? '?')} (no findings)`);
    }
  }
  return fragments.length > 0 ? fragments.join('; ') : '(no failure detail available)';
}

/**
 * List review reasons from REVIEW-status sensor readings backing
 * a REVIEW cell. Surfaces unique finding codes so the adopter can
 * decide which to triage.
 */
function describeReviewFromRefs(
  refs: readonly string[],
  readingById: ReadonlyMap<string, SensorReading>,
): string {
  if (refs.length === 0) return '(no SR refs)';
  const codes = new Set<string>();
  for (const id of refs) {
    const r = readingById.get(id);
    if (r === undefined || r.status !== 'review') continue;
    for (const f of r.findings ?? []) {
      if (f.severity === 'warning' || f.severity === 'info') codes.add(f.code);
    }
  }
  return codes.size > 0 ? Array.from(codes).sort().join(', ') : '(no review findings cited)';
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
