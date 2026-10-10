import type { InventoryRoutesOptions } from '@devai-nyx/sensors';
import {
  resolveDeclaredSensorInputs,
  validateEffectiveSensorInputs,
  type SensorInputs,
} from './shared.js';

export function resolveInventoryRouteInputs(
  repoRoot: string,
  explicit?: SensorInputs,
): Pick<InventoryRoutesOptions, 'framework' | 'scanDirs'> {
  const inputs = resolveDeclaredSensorInputs({
    repoRoot,
    sensorKind: 'inventory_routes',
    ...(explicit === undefined ? {} : { explicit }),
  });
  const framework = inputs['framework'];
  const scanDirs = inputs['scanDirs'];
  if (framework !== undefined && framework !== 'angular' && framework !== 'react') {
    throw new Error('SENSE_INPUT_INVALID:framework');
  }
  if (
    scanDirs !== undefined &&
    (!Array.isArray(scanDirs) || scanDirs.some((path) => typeof path !== 'string'))
  ) {
    throw new Error('SENSE_INPUT_INVALID:scanDirs');
  }
  const options: Pick<InventoryRoutesOptions, 'framework' | 'scanDirs'> = {
    ...(framework === undefined ? {} : { framework }),
    ...(scanDirs === undefined ? {} : { scanDirs: scanDirs as string[] }),
  };
  if (Object.keys(options).length > 0)
    validateEffectiveSensorInputs(repoRoot, 'inventory_routes', options);
  return options;
}
