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

// Invariants: INV-DEVAI-001

describe('lazy schema reference isolation', () => {
  it.each([
    'error.schema.json',
    'glob-guards.schema.json',
    'github-issues-tracking-policy.schema.json',
    'triage.schema.json',
    'release-intent.schema.json',
    'release-policy-resolution.schema.json',
    'release-lifecycle-store-head.schema.json',
    'release-lifecycle-state.schema.json',
  ])('does not parse unrelated %s while compiling an invariant', async (name) => {
    const registry = await import('../../src/index.js');
    const input = snapshot();
    input.schemas.set(name, Buffer.from('{'));
    registry.bindSchemaPackageSnapshot(input);
    const validate = registry.getValidator('invariant.schema.json');
    expect(validate({})).toBe(false);
    expect(validate.errors?.length).toBeGreaterThan(0);
    expect(() => registry.loadSchema(name)).toThrow(SyntaxError);
  });

  it.each([
    ['error.schema.json', 'action-result.schema.json'],
    ['github-issues-tracking-policy.schema.json', 'github-issues-tracking-config.schema.json'],
    ['triage.schema.json', 'triage-classify-result.schema.json'],
    ['release-intent.schema.json', 'release-plan-receipt.schema.json'],
    ['release-policy-resolution.schema.json', 'release-plan-receipt-v2.schema.json'],
    ['release-lifecycle-store-head.schema.json', 'release-lifecycle-store-record.schema.json'],
    ['release-lifecycle-state.schema.json', 'release-lifecycle-store-record.schema.json'],
  ])(
    'reuses previously compiled %s when subsequently compiling %s',
    async (dependency, consumer) => {
      const registry = await import('../../src/index.js');
      registry.bindSchemaPackageSnapshot(snapshot());
      const first = registry.getValidator(dependency);
      const next = registry.getValidator(consumer);
      expect(next({})).toBe(false);
      expect(next.errors?.length).toBeGreaterThan(0);
      expect(registry.getValidator(dependency)).toBe(first);
      expect(registry.getValidator(consumer)).toBe(next);
    },
  );

  it.each(['common-defs.schema.json', 'record-meta.schema.json'])(
    'returns an already registered shared schema %s without duplicate registration',
    async (name) => {
      const registry = await import('../../src/index.js');
      registry.bindSchemaPackageSnapshot(snapshot());
      registry.getValidator('invariant.schema.json');
      const validator = registry.getValidator(name);
      expect(typeof validator).toBe('function');
      expect(registry.getValidator(name)).toBe(validator);
    },
  );
});

it.each(['', 42, null])(
  'rejects an invalid sensor kind %j even when another kind is valid',
  async (kind) => {
    const registry = await import('../../src/index.js');
    registry.bindSchemaPackageSnapshot({
      ...snapshot(),
      sensor_registry: Buffer.from(JSON.stringify({ entries: [{ kind: 'valid-kind' }, { kind }] })),
    });
    expect(() => registry.loadSchema('sensor-reading.schema.json')).toThrow(
      'sensor registry has no unique live kind roster',
    );
  },
);

it('reports exactly the meta-schema failures from the bound population without dropping compliant members', async () => {
  const registry = await import('../../src/index.js');
  const input = snapshot();
  // Give each declared member an independently known valid meta-schema envelope.
  for (const name of registry.ROSTER) {
    if (name === 'meta.schema.json') continue;
    const original = JSON.parse(input.schemas.get(name)?.toString() ?? 'null') as Record<
      string,
      unknown
    >;
    input.schemas.set(
      name,
      Buffer.from(
        JSON.stringify({
          ...original,
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id: `https://devai.nyxk.com.br/schemas/${name}`,
          title: 'Valid schema',
          description: 'A complete schema description.',
          schema_version: '1.0.0',
          examples: [{}],
        }),
      ),
    );
  }
  input.schemas.set(
    'error.schema.json',
    Buffer.from(
      JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'https://devai.nyxk.com.br/schemas/error.schema.json',
        title: 'x',
        description: 'A complete schema description.',
        schema_version: '1.0.0',
        examples: [{}],
      }),
    ),
  );
  registry.bindSchemaPackageSnapshot(input);
  const report = registry.metaGate();
  expect(report.noncompliant).toEqual([
    { name: 'error.schema.json', errors: ['/title must NOT have fewer than 3 characters'] },
  ]);
  expect(report.compliant).toEqual(registry.ROSTER.filter((name) => name !== 'error.schema.json'));
  expect(report.compliant).not.toContain('error.schema.json');
  expect(report.compliant).toContain('action-result.schema.json');
  expect(new Set([...report.compliant, ...report.noncompliant.map((row) => row.name)])).toEqual(
    new Set(registry.ROSTER),
  );
  expect(report.compliant.length + report.noncompliant.length).toBe(registry.ROSTER.length);
});
