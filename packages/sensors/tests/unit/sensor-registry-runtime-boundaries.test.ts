import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertBundledSensorRegistry,
  DIAGNOSTIC_SENSOR_KINDS,
  isSensorKind,
  renderSensorRegistryMarkdown,
  SENSOR_CELLS_BY_KIND,
  SENSOR_DESCRIPTORS,
  SENSOR_ENTRIES_BY_KIND,
  SENSOR_KINDS_BY_TIER,
  SENSOR_READING_KINDS,
  SENSOR_REGISTRY,
  sensorCellMap,
  sensorDescriptor,
  sensorTierKinds,
  type SensorRegistry,
} from '../../src/sensor-registry.js';
const policyPath = fileURLToPath(
  new URL('../../../../law/policy/sensor-registry.json', import.meta.url),
);
const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as SensorRegistry;

describe('runtime sensor registry binds immutable views to approved law bytes', () => {
  it('loads the full policy population without omitted, duplicate or invented kinds', () => {
    expect(SENSOR_REGISTRY).toEqual(policy);
    const kinds = policy.entries.map((entry) => entry.kind);
    expect(SENSOR_READING_KINDS).toEqual(kinds);
    expect(new Set(SENSOR_READING_KINDS).size).toBe(kinds.length);
    expect(Object.keys(SENSOR_ENTRIES_BY_KIND)).toEqual(kinds);
    expect(SENSOR_DESCRIPTORS.map((descriptor) => descriptor.kind)).toEqual(kinds);
    for (const entry of policy.entries) {
      expect(SENSOR_ENTRIES_BY_KIND[entry.kind]).toEqual(entry);
      expect(isSensorKind(entry.kind)).toBe(true);
      expect(SENSOR_CELLS_BY_KIND[entry.kind]).toEqual(entry.cells ?? []);
      expect(sensorDescriptor(entry.kind)?.effect).toBe(entry.effect);
      expect(sensorDescriptor(entry.kind)?.capabilities).toEqual(
        entry.effect_basis?.capabilities ?? [],
      );
    }
  });
  it.each([
    undefined,
    null,
    0,
    true,
    {},
    [],
    Object('type_check'),
    'TYPE_CHECK',
    'type_check ',
    'type',
    '__proto__',
    'constructor',
    'unknown_sensor',
  ])('rejects noncanonical kind %j', (value) => {
    expect(isSensorKind(value)).toBe(false);
    if (typeof value === 'string') expect(sensorDescriptor(value)).toBeUndefined();
  });
  it('preserves the read-only scorecard descriptor with exact cell and tier assignment', () => {
    expect(sensorDescriptor('type_check')).toEqual({
      id: 'type_check',
      title: 'Type Check',
      kind: 'type_check',
      command: 'sense run type_check',
      primaryReadingKind: 'type_check',
      readingKinds: ['type_check'],
      lifecycle: 'supported',
      emitterModule: 'packages/sensors/src/type-check.ts',
      effect: 'read',
      capabilities: [],
      cells: [{ substrate: 'F2', property: 'T8' }],
      diagnostic: false,
      tiers: ['BASELINE', 'SWEEP'],
      designNote: { state: 'active', path: 'law/policy/sensor-notes/type_check.md' },
    });
  });
  it('does not turn a remote-write diagnostic into a scorecard sensor or lose its capability', () => {
    expect(sensorDescriptor('runtime_probe_api')).toEqual({
      id: 'runtime_probe_api',
      title: 'Runtime Probe Api',
      kind: 'runtime_probe_api',
      command: 'sense run runtime_probe_api',
      primaryReadingKind: 'runtime_probe_api',
      readingKinds: ['runtime_probe_api'],
      lifecycle: 'supported',
      emitterModule: 'packages/sensors/src/runtime-probe.ts',
      effect: 'remote-write',
      capabilities: ['net:runtime-probe'],
      cells: [],
      diagnostic: true,
      tiers: ['SWEEP'],
      designNote: { state: 'active', path: 'law/policy/sensor-notes/runtime_probe_api.md' },
    });
    expect(DIAGNOSTIC_SENSOR_KINDS).toEqual(
      policy.entries.filter((entry) => entry.diagnostic === true).map((entry) => entry.kind),
    );
  });
  it.each(['BASELINE', 'TIER2', 'TIER3', 'SWEEP'] as const)(
    'retains exactly the policy %s tier membership',
    (tier) => {
      const expected = policy.entries
        .filter((entry) => entry.tiers.includes(tier))
        .map((entry) => entry.kind);
      expect(sensorTierKinds(tier)).toEqual(expected);
      expect(sensorTierKinds(tier)).toBe(SENSOR_KINDS_BY_TIER[tier]);
      expect(Object.isFrozen(sensorTierKinds(tier))).toBe(true);
    },
  );
  it('prevents callers from changing exported effects or nested policy and descriptor data', () => {
    const requireFrozen = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) requireFrozen(child);
    };
    for (const value of [
      SENSOR_REGISTRY,
      SENSOR_DESCRIPTORS,
      SENSOR_READING_KINDS,
      SENSOR_ENTRIES_BY_KIND,
      SENSOR_CELLS_BY_KIND,
      SENSOR_KINDS_BY_TIER,
      DIAGNOSTIC_SENSOR_KINDS,
    ])
      requireFrozen(value);
    const descriptor = sensorDescriptor('runtime_probe_api');
    expect(() => Object.assign(descriptor ?? {}, { effect: 'read' })).toThrow(TypeError);
    expect(sensorDescriptor('runtime_probe_api')?.effect).toBe('remote-write');
    expect(sensorCellMap()).toBe(SENSOR_CELLS_BY_KIND);
  });
  it('renders both diagnostic and scorecard standing with exact command, cell and tier evidence', () => {
    const markdown = renderSensorRegistryMarkdown();
    expect(markdown).toContain(
      'Generated from `law/policy/sensor-registry.json`. Do not hand-edit.',
    );
    expect(markdown).toContain(`Live kinds: **${policy.entries.length}**.`);
    expect(markdown.split('\n').filter((line) => line.startsWith('| `'))).toHaveLength(
      policy.entries.length,
    );
    expect(markdown).toContain(
      '| `type_check` | `sense run type_check` | `packages/sensors/src/type-check.ts` | F2:T8 | BASELINE, SWEEP | scorecard |',
    );
    expect(markdown).toContain(
      '| `runtime_probe_api` | `sense run runtime_probe_api` | `packages/sensors/src/runtime-probe.ts` | none | SWEEP | diagnostic |',
    );
    expect(markdown.endsWith('\n')).toBe(true);
  });
  it('does not certify development source registry bytes as an assembled code-bound package', () => {
    expect(() => assertBundledSensorRegistry(readFileSync(resolve(policyPath)))).toThrow(
      'rpl-package-identity-mismatch',
    );
    expect(() => assertBundledSensorRegistry(new Uint8Array())).toThrow(
      'rpl-package-identity-mismatch',
    );
  });
});
