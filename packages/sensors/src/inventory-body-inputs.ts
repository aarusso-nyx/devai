import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where a sensor that measures from another inventory sensor's body finds that body
 * (#382, SENSOR-NOTE-inventory_regeneration "Sweep consumers"). Each input resolves in a
 * fixed order and the first present location wins:
 *
 *   1. an explicit input passed to the producer;
 *   2. the regenerated state body `sense run inventory_regeneration` publishes under
 *      `.devai/state/sensors/<kind>/`;
 *   3. the direct sensor default under `record/proofs/sensors/<kind>/`, which regeneration
 *      neither writes nor removes.
 *
 * An explicit `null` names no input at all: the consumer measures as it does without it
 * and reads no default. Regeneration passes it for an input whose kind it does not
 * produce, so a dependent never reads a body this run did not stage.
 */

/** The state directory regeneration publishes the inventory bodies under. */
export const REGENERATED_BODY_DIRECTORY = '.devai/state/sensors';

/** The directory a direct inventory sensor run writes its body under. */
export const DIRECT_BODY_DIRECTORY = 'record/proofs/sensors';

/**
 * Resolve one body input, `kindFile` naming it inside each directory (for example
 * `inventory_api/api-map.json`). Without an explicit input, the regenerated state body is
 * the input whenever it is present, even unreadable or not admitted: the consumer then
 * refuses or reports it, and a lower-priority default never stands in for it. Only when
 * it is absent is the direct default returned, so the consumer reports a missing input
 * exactly as it always has. `null` stays `null`.
 */
export function resolveBodyInput(
  repoRoot: string,
  explicit: string | null | undefined,
  kindFile: string,
): string | null {
  if (explicit !== undefined) return explicit;
  const regenerated = join(repoRoot, REGENERATED_BODY_DIRECTORY, kindFile);
  if (existsSync(regenerated)) return regenerated;
  return join(repoRoot, DIRECT_BODY_DIRECTORY, kindFile);
}

/**
 * The locations a consumer read for one absent body input, in the order it read them, for a
 * missing-input message (#391): the explicit input alone when one was passed, otherwise the
 * regenerated state body and then the direct sensor default.
 */
export function bodyInputLocations(
  repoRoot: string,
  explicit: string | null | undefined,
  kindFile: string,
): readonly string[] {
  if (explicit !== undefined && explicit !== null) return [explicit];
  return [
    join(repoRoot, REGENERATED_BODY_DIRECTORY, kindFile),
    join(repoRoot, DIRECT_BODY_DIRECTORY, kindFile),
  ];
}

/** The producer every missing inventory body points at (#382, #391). */
export const INVENTORY_REGENERATION_HINT =
  "Run 'devai sense run inventory_regeneration' to regenerate the inventory bodies";
