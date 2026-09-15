import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@devai-nyx/sensors/registry');
  vi.doUnmock('@devai-nyx/sensors/presets');
  vi.resetModules();
});

describe('CLI shard 09 sense facade authority', () => {
  it('rejects inconsistent entries and preserves exclusion fallback semantics', async () => {
    const registry = await vi.importActual<typeof import('@devai-nyx/sensors/registry')>(
      '@devai-nyx/sensors/registry',
    );
    const presets = await vi.importActual<typeof import('@devai-nyx/sensors/presets')>(
      '@devai-nyx/sensors/presets',
    );
    const build = registry.SENSOR_REGISTRY.entries.find((entry) => entry.kind === 'build');
    if (build === undefined) throw new Error('build sensor fixture missing');
    const sweep = presets.sensePreset('sweep');
    if (sweep === undefined) throw new Error('sweep preset fixture missing');

    const loadFacade = async (
      registryOverrides: Partial<typeof registry>,
      presetOverrides: Partial<typeof presets> = {},
    ): Promise<typeof import('../../src/commands/sense/facade.js')> => {
      vi.resetModules();
      vi.doMock('@devai-nyx/sensors/registry', () => ({ ...registry, ...registryOverrides }));
      vi.doMock('@devai-nyx/sensors/presets', () => ({ ...presets, ...presetOverrides }));
      return import('../../src/commands/sense/facade.js');
    };

    const missingCapabilities = await loadFacade({
      SENSOR_REGISTRY: {
        ...registry.SENSOR_REGISTRY,
        entries: registry.SENSOR_REGISTRY.entries.map((entry) =>
          entry.kind === 'build'
            ? {
                ...entry,
                effect_basis: {
                  source_paths: [],
                  rationale: '',
                  ...entry.effect_basis,
                  capabilities: [],
                },
              }
            : entry,
        ),
      },
    });
    expect(() => missingCapabilities.resolveSenseSelection({ kind: 'build' })).toThrowError(
      'SENSE_EFFECT_CAPABILITIES_MISSING:build',
    );

    const permissiveKindGuard = await loadFacade({
      isSensorKind: (value: unknown): value is never => value === 'missing_kind',
    });
    expect(() => permissiveKindGuard.resolveSenseSelection({ kind: 'missing_kind' })).toThrowError(
      'SENSE_KIND_UNKNOWN:missing_kind',
    );

    let sweepCalls = 0;
    const unknownExclusion = await loadFacade(
      {},
      {
        sensePreset: (name: string) => {
          if (name !== 'sweep') return presets.sensePreset(name);
          sweepCalls += 1;
          return sweepCalls === 1
            ? sweep
            : { ...sweep, excluded: [...sweep.excluded, 'missing_kind'] };
        },
      },
    );
    expect(() =>
      unknownExclusion.resolveSenseSelection({ preset: 'sweep' }, { roundId: 'R-0001' }),
    ).toThrowError('SENSE_KIND_UNKNOWN:missing_kind');

    const fallbackPolicy = {
      ...presets.SENSE_PRESET_POLICY,
      exclusion_reasons: Object.fromEntries(
        Object.entries(presets.SENSE_PRESET_POLICY.exclusion_reasons).filter(
          ([kind]) => kind !== 'build',
        ),
      ),
    };
    const fallback = await loadFacade({}, { SENSE_PRESET_POLICY: fallbackPolicy });
    const resolved = fallback.resolveSenseSelection({ preset: 'sweep' }, { roundId: 'R-0001' });
    expect(resolved.excluded.find((entry) => entry.kind === 'build')).toEqual({
      kind: 'build',
      effect: build.effect,
      reason: 'Excluded by the canonical sense preset policy.',
    });
  });
});
