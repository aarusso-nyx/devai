import type { SensorReading } from '@devai-nyx/sensors';

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
 * Applies the configured freshness boundary.
 *
 * Supported readings compete only with supported readings: experimental
 * observations never change production standing. Within each kind, only
 * newer evidence supersedes older evidence. UNKNOWN/SKIPPED evidence cannot
 * erase an existing FAIL/ERROR/KILLED standing.
 */
export function filterLatestPerKind(readings: readonly SensorReading[]): SensorReading[] {
  const byKind = new Map<string, SensorReading>();
  for (const reading of readings) {
    if (reading.lifecycle === 'experimental') continue;
    const kind = reading.sensor?.kind;
    if (typeof kind !== 'string' || kind.length === 0) continue;
    const current = byKind.get(kind);
    if (current === undefined) {
      byKind.set(kind, reading);
      continue;
    }
    if (isUnknown(current) && isFailure(reading)) {
      byKind.set(kind, reading);
      continue;
    }
    if (!isNewer(reading, current)) continue;
    if (isFailure(current) && isUnknown(reading)) continue;
    byKind.set(kind, reading);
  }
  return [...byKind.values()].sort((left, right) =>
    left.sensor.kind.localeCompare(right.sensor.kind),
  );
}
