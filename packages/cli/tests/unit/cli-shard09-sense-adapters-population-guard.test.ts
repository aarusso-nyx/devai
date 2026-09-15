import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SensorKind } from '@devai-nyx/sensors';

import '../../src/commands/sense/adapters.js';

afterEach(() => {
  vi.doUnmock('@devai-nyx/sensors');
  vi.resetModules();
});

describe('CLI shard 09 sense adapters population guard', () => {
  it('rejects registry drift with the exact diagnostic', async () => {
    const sensors =
      await vi.importActual<typeof import('@devai-nyx/sensors')>('@devai-nyx/sensors');

    const control = await (import(
      '../../src/commands/sense/adapters.js' + '?shard-09-population-control'
    ) as Promise<typeof import('../../src/commands/sense/adapters.js')>);
    expect(Object.keys(control.SENSE_SENSOR_ADAPTERS).sort()).toEqual(
      [...sensors.SENSOR_READING_KINDS].sort(),
    );
    expect(() => control.sensorAdapter('absent' as SensorKind)).toThrowError(
      new Error('SENSE_ADAPTER_MISSING:absent'),
    );

    vi.resetModules();
    vi.doMock('@devai-nyx/sensors', () => ({
      ...sensors,
      SENSOR_READING_KINDS: sensors.SENSOR_READING_KINDS.slice(1),
    }));

    await expect(
      import('../../src/commands/sense/adapters.js' + '?shard-09-population-drift') as Promise<
        typeof import('../../src/commands/sense/adapters.js')
      >,
    ).rejects.toThrowError('SENSE_ADAPTER_POPULATION_DIVERGENCE');
  });
});
