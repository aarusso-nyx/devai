import type { SensorReading } from '@devai-nyx/sensors';

/**
 * Anti-relabeling check (D-120; audit finding: a scorecard whose
 * cells are fanned from one command's exit code onto a dozen
 * differently-named SensorReadings overstates independently-verified
 * coverage — the audited adopter case shared one `command_hash`
 * across 12 distinct `sensor.kind` values). A scorecard cell is
 * supposed to be an independent measurement (Article 32, polymorphic
 * sensor-adapter composition); two readings with the same
 * `command_hash` but different `sensor.kind` are the same command
 * wearing two labels, not two measurements.
 */
export interface RelabelGroup {
  readonly command_hash: string;
  readonly kinds: readonly string[];
  readonly reading_ids: readonly string[];
}

/**
 * Group readings by `command_hash` and return the groups where more
 * than one distinct `sensor.kind` shares a hash. Readings without a
 * `command_hash` are ignored (the field is optional on older
 * readings). Deterministic ordering: groups sorted by command_hash,
 * kinds/reading_ids sorted lexically.
 */
export function detectRelabeledSensors(readings: readonly SensorReading[]): RelabelGroup[] {
  const byHash = new Map<string, { kinds: Set<string>; ids: Set<string> }>();
  for (const reading of readings) {
    const hash = reading.command_hash;
    if (hash === undefined || hash.length === 0) continue;
    const entry = byHash.get(hash) ?? { kinds: new Set<string>(), ids: new Set<string>() };
    entry.kinds.add(reading.sensor.kind);
    entry.ids.add(reading.id);
    byHash.set(hash, entry);
  }

  const groups: RelabelGroup[] = [];
  for (const [hash, entry] of byHash) {
    if (entry.kinds.size < 2) continue;
    groups.push({
      command_hash: hash,
      kinds: [...entry.kinds].sort(),
      reading_ids: [...entry.ids].sort(),
    });
  }
  return groups.sort((a, b) => a.command_hash.localeCompare(b.command_hash));
}
