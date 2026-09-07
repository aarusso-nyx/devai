import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
function snapshot() {
  return {
    schemas: new Map(
      readdirSync(resolve(root, 'law/schemas'))
        .filter((name) => name.endsWith('.schema.json'))
        .map((name) => [name, readFileSync(resolve(root, 'law/schemas', name))]),
    ),
    sensor_registry: readFileSync(resolve(root, 'law/policy/sensor-registry.json')),
  };
}

beforeEach(() => vi.resetModules());

describe('installed schema snapshot binding', () => {
  it.each([
    'action-result.schema.json',
    'github-issues-tracking-config.schema.json',
    'triage-classify-result.schema.json',
    'release-plan-receipt.schema.json',
    'release-plan-receipt-v2.schema.json',
    'release-lifecycle-store-record.schema.json',
    'adopter-policy.schema.json',
  ])('compiles %s on first use with its complete reference closure', async (name) => {
    const registry = await import('../../src/index.js');
    registry.bindSchemaPackageSnapshot(snapshot());
    const validator = registry.getValidator(name);
    expect(validator({})).toBe(false);
    expect(validator.errors?.length).toBeGreaterThan(0);
    expect(registry.getValidator(name)).toBe(validator);
  });

  it('refuses unknown validators and missing bound documents', async () => {
    const registry = await import('../../src/index.js');
    registry.bindSchemaPackageSnapshot(snapshot());
    expect(() => registry.getValidator('not-registered.schema.json')).toThrow(
      'unregistered schema: not-registered.schema.json',
    );
    expect(() => registry.loadSchema('not-registered.schema.json')).toThrow(
      'rpl-package-identity-mismatch',
    );
  });

  it('copies input bytes and returns independent documents without changing validation', async () => {
    const registry = await import('../../src/index.js');
    const input = snapshot();
    const expected = JSON.parse(
      input.schemas.get('error.schema.json')?.toString() ?? 'null',
    ) as Record<string, unknown>;
    registry.bindSchemaPackageSnapshot(input);
    input.schemas.get('error.schema.json')?.fill(0);
    input.schemas.clear();
    input.sensor_registry.fill(0);
    const document = registry.loadSchema('error.schema.json');
    expect(document).toEqual(expected);
    document['properties'] = {};
    expect(registry.loadSchema('error.schema.json')).toEqual(expected);
    expect(registry.getValidator('error.schema.json')({})).toBe(false);
    expect(registry.loadSchema('sensor-reading.schema.json')).toHaveProperty(
      'properties.sensor.properties.kind.enum',
    );
  });

  it('allows exactly one binding even when the next binding has identical bytes', async () => {
    const registry = await import('../../src/index.js');
    registry.bindSchemaPackageSnapshot(snapshot());
    expect(() => registry.bindSchemaPackageSnapshot(snapshot())).toThrow(
      'rpl-package-identity-mismatch',
    );
  });

  it.each(['document', 'validator'] as const)(
    'refuses binding after ambient %s access',
    async (access) => {
      const registry = await import('../../src/index.js');
      if (access === 'document') registry.loadSchema('error.schema.json');
      else registry.getValidator('error.schema.json');
      expect(() => registry.bindSchemaPackageSnapshot(snapshot())).toThrow(
        'rpl-package-identity-mismatch',
      );
    },
  );

  it('rejects an incomplete population without consuming the first valid binding', async () => {
    const registry = await import('../../src/index.js');
    const input = snapshot();
    input.schemas.delete('common-defs.schema.json');
    expect(() => registry.bindSchemaPackageSnapshot(input)).toThrow(
      'rpl-package-identity-mismatch',
    );
    expect(() => registry.bindSchemaPackageSnapshot(snapshot())).not.toThrow();
  });

  it.each([
    '../error.schema.json',
    'error.schema.json/extra',
    'Error.schema.json',
    '-error.schema.json',
    'error_schema.json',
    'error.schema.json\n',
  ])('rejects an invalid member name %s before accepting a later valid binding', async (name) => {
    const registry = await import('../../src/index.js');
    const input = snapshot();
    input.schemas.set(name, Buffer.from('{}'));
    expect(() => registry.bindSchemaPackageSnapshot(input)).toThrow(
      'rpl-package-identity-mismatch',
    );
    expect(() => registry.bindSchemaPackageSnapshot(snapshot())).not.toThrow();
  });

  it.each([
    { entries: [] },
    { entries: [{ kind: '' }] },
    { entries: [{ kind: 1 }] },
    { entries: [{ kind: 'same' }, { kind: 'same' }] },
    {},
  ])('refuses an invalid live sensor kind roster %s', async (sensorRegistry) => {
    const registry = await import('../../src/index.js');
    registry.bindSchemaPackageSnapshot({
      ...snapshot(),
      sensor_registry: Buffer.from(JSON.stringify(sensorRegistry)),
    });
    expect(() => registry.loadSchema('sensor-reading.schema.json')).toThrow(
      'sensor registry has no unique live kind roster',
    );
  });

  it('uses exactly the bound sensor kinds instead of ambient policy', async () => {
    const registry = await import('../../src/index.js');
    registry.bindSchemaPackageSnapshot({
      ...snapshot(),
      sensor_registry: Buffer.from(
        JSON.stringify({ entries: [{ kind: 'bound-first' }, { kind: 'bound-second' }] }),
      ),
    });
    expect(registry.loadSchema('sensor-reading.schema.json')).toHaveProperty(
      'properties.sensor.properties.kind.enum',
      ['bound-first', 'bound-second'],
    );
  });
});
