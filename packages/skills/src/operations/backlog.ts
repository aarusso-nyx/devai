import { getValidator } from '@devai-nyx/schemas';

interface ScorecardCellLike {
  readonly substrate: string;
  readonly property: string;
  readonly verdict: string;
}

export function compileBacklogObservation(scorecard: unknown): {
  readonly count: number;
  readonly items: readonly Readonly<Record<string, unknown>>[];
} {
  if (
    typeof scorecard !== 'object' ||
    scorecard === null ||
    !Array.isArray((scorecard as { readonly cells?: unknown }).cells)
  ) {
    throw new Error('BACKLOG_SCORECARD_INVALID');
  }
  const cells = (scorecard as { readonly cells: readonly ScorecardCellLike[] }).cells;
  const items = cells
    .filter((cell) => cell.verdict === 'FAIL' || cell.verdict === 'REVIEW')
    .map((cell) =>
      Object.freeze({
        id: `BL-${cell.substrate}-${cell.property}`,
        title: `${cell.substrate} × ${cell.property} → ${cell.verdict}`,
        priority: cell.verdict === 'FAIL' ? 80 : 50,
        cell: `${cell.substrate}×${cell.property}`,
        verdict: cell.verdict,
      }),
    );
  return Object.freeze({ count: items.length, items: Object.freeze(items) });
}

/** The observation backlog contract (ADR-SCR-0008). */
export const OBSERVATION_BACKLOG_SCHEMA = 'observation-backlog.schema.json';
/** A delta naming a cell absent from the current observations. */
export const OBSERVATION_BACKLOG_DELTA_CELL_UNKNOWN = 'OBSERVATION_BACKLOG_DELTA_CELL_UNKNOWN';
/** A backlog that fails law/schemas/observation-backlog.schema.json. */
export const OBSERVATION_BACKLOG_SCHEMA_INVALID = 'OBSERVATION_BACKLOG_SCHEMA_INVALID';

export interface ObservationBacklogObservation {
  readonly cell: string;
  readonly verdict: string;
  readonly reading_ids: readonly string[];
}

export interface ObservationBacklogDelta {
  readonly cell: string;
  readonly verdict: string;
}

export interface ObservationBacklog {
  readonly schemaVersion: '1.0.0';
  readonly merge_sha: string;
  readonly previous_merge_sha: string | null;
  readonly generated_at: string;
  readonly observations: readonly ObservationBacklogObservation[];
  readonly deltas: {
    readonly additions: readonly ObservationBacklogDelta[];
    readonly completions: readonly ObservationBacklogDelta[];
  };
}

/**
 * Validate a backlog.json against the observation backlog contract, then check the
 * cross-reference JSON Schema cannot express: every delta names a cell present in
 * the current observations.
 */
export function validateObservationBacklog(value: unknown): {
  readonly ok: boolean;
  readonly errors: readonly string[];
} {
  const validate = getValidator(OBSERVATION_BACKLOG_SCHEMA);
  if (!validate(value)) {
    const errors = (validate.errors ?? []).map((error) =>
      `${OBSERVATION_BACKLOG_SCHEMA_INVALID}:${error.instancePath || '/'} ${error.message ?? ''}`.trim(),
    );
    return {
      ok: false,
      errors: errors.length > 0 ? errors : [`${OBSERVATION_BACKLOG_SCHEMA_INVALID}:/`],
    };
  }
  const backlog = value as ObservationBacklog;
  const observed = new Set(backlog.observations.map((observation) => observation.cell));
  const errors: string[] = [];
  for (const delta of [...backlog.deltas.additions, ...backlog.deltas.completions]) {
    if (!observed.has(delta.cell))
      errors.push(`${OBSERVATION_BACKLOG_DELTA_CELL_UNKNOWN}:${delta.cell}`);
  }
  const unique = [...new Set(errors)];
  return { ok: unique.length === 0, errors: unique };
}

interface ObservedScorecardCell extends ScorecardCellLike {
  readonly sensor_readings?: readonly string[];
}

const BACKLOG_VERDICTS = new Set(['FAIL', 'REVIEW']);

/**
 * Compile the backlog.json of one observation bundle (ADR-SCR-0008): one observation
 * per scorecard cell with its verdict and reading ids, and the deltas against the
 * previous bundle's observations. Without a previous bundle the deltas are empty.
 */
export function compileObservationBacklog(input: {
  readonly scorecard: unknown;
  readonly mergeSha: string;
  readonly previousMergeSha: string | null;
  readonly generatedAt: string;
  readonly previous: readonly ObservationBacklogObservation[] | null;
}): ObservationBacklog {
  const scorecard = input.scorecard;
  if (
    typeof scorecard !== 'object' ||
    scorecard === null ||
    !Array.isArray((scorecard as { readonly cells?: unknown }).cells)
  ) {
    throw new Error('BACKLOG_SCORECARD_INVALID');
  }
  const cells = (scorecard as { readonly cells: readonly ObservedScorecardCell[] }).cells;
  const observations: readonly ObservationBacklogObservation[] = cells.map((cell) =>
    Object.freeze({
      cell: `${cell.substrate}:${cell.property}`,
      verdict: cell.verdict,
      reading_ids: Object.freeze([...new Set(cell.sensor_readings ?? [])]),
    }),
  );
  const additions: ObservationBacklogDelta[] = [];
  const completions: ObservationBacklogDelta[] = [];
  if (input.previous !== null) {
    const prior = new Map(input.previous.map((observation) => [observation.cell, observation]));
    const current = new Map(observations.map((observation) => [observation.cell, observation]));
    for (const observation of observations) {
      const before = prior.get(observation.cell);
      if (
        BACKLOG_VERDICTS.has(observation.verdict) &&
        (before === undefined || !BACKLOG_VERDICTS.has(before.verdict))
      ) {
        additions.push({ cell: observation.cell, verdict: observation.verdict });
      }
    }
    for (const before of input.previous) {
      const now = current.get(before.cell);
      if (now === undefined) continue;
      if (BACKLOG_VERDICTS.has(before.verdict) && !BACKLOG_VERDICTS.has(now.verdict)) {
        completions.push({ cell: before.cell, verdict: before.verdict });
      }
    }
  }
  return Object.freeze({
    schemaVersion: '1.0.0',
    merge_sha: input.mergeSha,
    previous_merge_sha: input.previousMergeSha,
    generated_at: input.generatedAt,
    observations: Object.freeze(observations),
    deltas: Object.freeze({
      additions: Object.freeze(additions),
      completions: Object.freeze(completions),
    }),
  });
}
