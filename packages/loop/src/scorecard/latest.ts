import type { SensorReading } from '@devai-nyx/sensors';

/** Each declared producer population has independent immutable instance history. */
function standingKey(reading: SensorReading): string {
  const task = reading.metrics?.task_id;
  const population = reading.metrics?.population;
  return typeof task === 'string' && typeof population === 'string'
    ? JSON.stringify([reading.sensor.kind, task, population])
    : JSON.stringify([reading.sensor.kind]);
}

/** Validate the complete population already bound to one exact candidate. */
export function assertCandidateSupersessionGraph(
  readings: readonly SensorReading[],
  prefix = 'SCORECARD_READING',
): void {
  const byId = new Map<string, SensorReading>();
  for (const reading of readings) {
    if (byId.has(reading.id)) throw new Error(`${prefix}_DUPLICATE_ID:${reading.id}`);
    byId.set(reading.id, reading);
  }
  const retired = new Set<string>();
  for (const reading of readings) {
    if (reading.supersedes === undefined) continue;
    const previous = byId.get(reading.supersedes);
    if (previous === undefined || standingKey(previous) !== standingKey(reading)) {
      throw new Error(`${prefix}_INVALID_SUPERSEDES:${reading.id}`);
    }
    retired.add(previous.id);
  }
  // Visit every component: a disconnected cycle must not hide behind a valid head.
  const visited = new Set<string>();
  for (const reading of readings) {
    const active = new Set<string>();
    let cursor: SensorReading | undefined = reading;
    while (cursor !== undefined && !visited.has(cursor.id)) {
      if (active.has(cursor.id)) throw new Error(`${prefix}_SUPERSEDES_CYCLE:${cursor.id}`);
      active.add(cursor.id);
      cursor = cursor.supersedes === undefined ? undefined : byId.get(cursor.supersedes);
    }
    for (const id of active) visited.add(id);
  }
  const heads = new Set<string>();
  for (const reading of readings) {
    if (retired.has(reading.id)) continue;
    const key = standingKey(reading);
    if (heads.has(key)) {
      throw new Error(`${prefix}_AMBIGUOUS:${reading.sensor.kind}`);
    }
    heads.add(key);
  }
}

function isUnknown(reading: SensorReading): boolean {
  return reading.status === 'unknown' || reading.status === 'skipped';
}

function isFailure(reading: SensorReading): boolean {
  return reading.status === 'fail' || reading.status === 'error' || reading.status === 'killed';
}

function isNewer(candidate: SensorReading, current: SensorReading): boolean {
  const candidateTimestamp = candidate.timestamp ?? '';
  const currentTimestamp = current.timestamp ?? '';
  return (
    candidateTimestamp > currentTimestamp ||
    (candidateTimestamp === currentTimestamp && candidate.id > current.id)
  );
}

/**
 * The ids some other reading of the same kind names in `supersedes`
 * (ADR-SCR-0008). A recorded reading is immutable, so a later instance names the
 * earlier one and the link, never the timestamp or file order, retires it. A
 * link cycle retires nothing, so no kind is ever emptied by its own links.
 */
function supersededIds(readings: readonly SensorReading[]): ReadonlySet<string> {
  const kindOf = new Map<string, string>();
  for (const reading of readings) kindOf.set(reading.id, standingKey(reading));
  const retired = new Set<string>();
  for (const reading of readings) {
    const earlier = reading.supersedes;
    if (typeof earlier !== 'string' || earlier === reading.id) continue;
    if (kindOf.get(earlier) !== standingKey(reading)) continue;
    retired.add(earlier);
  }
  const byKind = new Map<string, number>();
  for (const reading of readings) {
    if (retired.has(reading.id)) continue;
    const key = standingKey(reading);
    byKind.set(key, (byKind.get(key) ?? 0) + 1);
  }
  // A kind every one of whose instances is retired holds a cycle: keep it whole.
  for (const reading of readings) {
    if (retired.has(reading.id) && !byKind.has(standingKey(reading))) {
      for (const member of readings) {
        if (standingKey(member) === standingKey(reading)) retired.delete(member.id);
      }
    }
  }
  return retired;
}

/**
 * Applies the configured freshness boundary.
 *
 * Supported readings compete only with supported readings: experimental
 * observations never change production standing. Within each kind, only
 * newer evidence supersedes older evidence. UNKNOWN/SKIPPED evidence cannot
 * erase an existing FAIL/ERROR/KILLED standing. An instance another instance of
 * the same kind supersedes never competes (ADR-SCR-0008).
 */
export function filterLatestPerKind(readings: readonly SensorReading[]): SensorReading[] {
  const supported = readings.filter((reading) => reading.lifecycle !== 'experimental');
  const retired = supersededIds(supported);
  const byKind = new Map<string, SensorReading>();
  for (const reading of supported) {
    if (retired.has(reading.id)) continue;
    const kind = reading.sensor?.kind;
    if (typeof kind !== 'string' || kind.length === 0) continue;
    const key = standingKey(reading);
    const current = byKind.get(key);
    if (current === undefined) {
      byKind.set(key, reading);
      continue;
    }
    if (isUnknown(current) && isFailure(reading)) {
      byKind.set(key, reading);
      continue;
    }
    if (!isNewer(reading, current)) continue;
    if (isFailure(current) && isUnknown(reading)) continue;
    byKind.set(key, reading);
  }
  return [...byKind.values()].sort((left, right) =>
    left.sensor.kind.localeCompare(right.sensor.kind),
  );
}
