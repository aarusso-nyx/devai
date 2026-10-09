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
 * `inventory_api/api-map.json`). Without an explicit input, the first default location
 * that exists and is admitted is read; when none is, the direct default is returned, so
 * the consumer reports the input missing exactly as it always has. `null` stays `null`.
 */
export function resolveBodyInput(
  repoRoot: string,
  explicit: string | null | undefined,
  kindFile: string,
  admit: (absolutePath: string) => boolean = () => true,
): string | null {
  if (explicit !== undefined) return explicit;
  const regenerated = join(repoRoot, REGENERATED_BODY_DIRECTORY, kindFile);
  if (existsSync(regenerated) && admit(regenerated)) return regenerated;
  return join(repoRoot, DIRECT_BODY_DIRECTORY, kindFile);
}
