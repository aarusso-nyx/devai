import {
  resolveDeclaredSensorInputs,
  validateEffectiveSensorInputs,
  type SensorInputs,
} from './shared.js';

const ROOT_KEYS = [
  'sourceRoots',
  'packageRoots',
  'threatModelDirs',
  'piiMigrationDirs',
  'errorContractDirs',
] as const;
type RootKey = (typeof ROOT_KEYS)[number];

/** Adopter layout populations use the same schema and checkout boundary for overrides. */
export function resolveLayoutInputs(
  repoRoot: string,
  sensorKind: string,
  explicit?: SensorInputs,
): Partial<Record<RootKey, string[]>> {
  const effective = resolveDeclaredSensorInputs({
    repoRoot,
    sensorKind,
    ...(explicit === undefined ? {} : { explicit }),
  });
  const roots: Partial<Record<RootKey, string[]>> = {};
  for (const key of ROOT_KEYS) {
    if (effective[key] !== undefined) roots[key] = effective[key] as string[];
  }
  if (Object.keys(roots).length > 0) validateEffectiveSensorInputs(repoRoot, sensorKind, roots);
  return roots;
}
