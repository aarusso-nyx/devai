import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@devai-nyx/sensors');
  vi.resetModules();
});

describe('CLI shard 09 sense adapters population guard', () => {
  it('rejects registry drift with the exact diagnostic', async () => {
    const sensors =
      await vi.importActual<typeof import('@devai-nyx/sensors')>('@devai-nyx/sensors');

    vi.resetModules();
    vi.doMock('@devai-nyx/sensors', () => ({
      ...sensors,
      SENSOR_READING_KINDS: sensors.SENSOR_READING_KINDS.slice(1),
    }));

    await expect(
      import('../../src/commands/sense/adapters.js?shard-09-population-drift'),
    ).rejects.toThrowError('SENSE_ADAPTER_POPULATION_DIVERGENCE');
  });
});
