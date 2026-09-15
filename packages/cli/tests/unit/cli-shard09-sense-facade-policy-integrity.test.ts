import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@devai-nyx/sensors/registry');
  vi.doUnmock('@devai-nyx/sensors/presets');
  vi.resetModules();
});

describe('CLI shard 09 sense facade policy', () => {
  it('rejects every malformed canonical population with its exact diagnostic', async () => {
    const registry = await vi.importActual<typeof import('@devai-nyx/sensors/registry')>(
      '@devai-nyx/sensors/registry',
    );
    const presets = await vi.importActual<typeof import('@devai-nyx/sensors/presets')>(
      '@devai-nyx/sensors/presets',
    );
    const sweep = presets.sensePreset('sweep');
    if (sweep === undefined) throw new Error('sweep preset fixture missing');
    const baseline = presets.sensePreset('baseline');
    if (baseline === undefined) throw new Error('baseline preset fixture missing');
    const firstEntry = registry.SENSOR_REGISTRY.entries[0];
    if (firstEntry === undefined) throw new Error('sensor registry fixture missing');
    const baselineMember = baseline.members[0];
    if (baselineMember === undefined) throw new Error('baseline member fixture missing');
    const sweepExclusion = sweep.excluded[0];
    if (sweepExclusion === undefined) throw new Error('sweep exclusion fixture missing');

    type Registry = typeof registry.SENSOR_REGISTRY;
    type Policy = typeof presets.SENSE_PRESET_POLICY;
    type Preset = NonNullable<ReturnType<typeof presets.sensePreset>>;
    type Fixture = {
      readonly diagnostic: string;
      readonly registry?: Registry;
      readonly policy?: Policy;
      readonly resolvePreset?: (name: string) => Preset | undefined;
    };

    const withPresets = (changed: readonly Preset[]): Policy => ({
      ...presets.SENSE_PRESET_POLICY,
      presets: changed,
    });
    const replacePreset = (name: string, replacement: Preset): Policy =>
      withPresets(
        presets.SENSE_PRESET_POLICY.presets.map((preset) =>
          preset.name === name ? replacement : preset,
        ),
      );

    const fixtures: readonly Fixture[] = [
      {
        diagnostic: 'SENSE_SENSOR_KIND_DUPLICATE',
        registry: {
          ...registry.SENSOR_REGISTRY,
          entries: [...registry.SENSOR_REGISTRY.entries, firstEntry],
        },
      },
      {
        diagnostic: 'SENSE_PRESET_DUPLICATE',
        policy: withPresets([...presets.SENSE_PRESET_POLICY.presets, baseline]),
      },
      {
        diagnostic: 'SENSE_PRESET_MEMBER_DUPLICATE:baseline',
        policy: replacePreset('baseline', {
          ...baseline,
          members: [...baseline.members, baselineMember],
        }),
      },
      {
        diagnostic: 'SENSE_PRESET_EXCLUSION_DUPLICATE:sweep',
        policy: replacePreset('sweep', {
          ...sweep,
          excluded: [...sweep.excluded, sweepExclusion],
        }),
      },
      {
        diagnostic: 'SENSE_PRESET_KIND_UNKNOWN:baseline:missing_kind',
        policy: replacePreset('baseline', {
          ...baseline,
          members: [...baseline.members, 'missing_kind'],
        }),
      },
      {
        diagnostic: 'SENSE_SWEEP_PRESET_MISSING',
        resolvePreset: (name) => (name === 'sweep' ? undefined : presets.sensePreset(name)),
      },
      {
        diagnostic: 'SENSE_SWEEP_READ_POPULATION_DIVERGENCE',
        resolvePreset: (name) =>
          name === 'sweep'
            ? { ...sweep, members: [...sweep.members].reverse() }
            : presets.sensePreset(name),
      },
      {
        diagnostic: 'SENSE_SWEEP_EXCLUSION_POPULATION_DIVERGENCE',
        resolvePreset: (name) =>
          name === 'sweep'
            ? { ...sweep, excluded: [...sweep.excluded].reverse() }
            : presets.sensePreset(name),
      },
    ];

    for (const fixture of fixtures) {
      vi.resetModules();
      vi.doMock('@devai-nyx/sensors/registry', () => ({
        ...registry,
        SENSOR_REGISTRY: fixture.registry ?? registry.SENSOR_REGISTRY,
      }));
      vi.doMock('@devai-nyx/sensors/presets', () => ({
        ...presets,
        SENSE_PRESET_POLICY: fixture.policy ?? presets.SENSE_PRESET_POLICY,
        sensePreset: fixture.resolvePreset ?? presets.sensePreset,
      }));
      const facade = await import('../../src/commands/sense/facade.js');
      expect(() => facade.resolveSenseSelection({ kind: 'type_check' })).toThrowError(
        fixture.diagnostic,
      );
    }
  });
});
