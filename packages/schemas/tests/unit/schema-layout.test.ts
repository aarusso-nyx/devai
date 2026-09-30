import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Invariants: INV-DEVAI-001
const sourceRoot = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];

afterEach(() => {
  vi.doUnmock('node:url');
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const VALID_ROSTER = JSON.stringify({ entries: [{ kind: 'roster-kind' }] });
// The loader refuses a roster with no live kind, so a malformed roster at the location the
// layout must NOT select proves which roster was selected without reading the enum.
const MALFORMED_ROSTER = JSON.stringify({ entries: [] });

type Roster = 'valid' | 'malformed';

async function layout(
  bundled: boolean,
  sidecar: Roster | undefined,
  sourcePolicy: Roster = 'valid',
) {
  const root = mkdtempSync(join(tmpdir(), 'devai-schema-layout-'));
  roots.push(root);
  const here = join(root, 'packages/schemas/dist');
  const law = join(root, 'law/schemas');
  mkdirSync(here, { recursive: true });
  mkdirSync(dirname(law), { recursive: true });
  cpSync(join(sourceRoot, 'law/schemas'), law, { recursive: true });
  mkdirSync(join(root, 'law/policy'));
  const roster = (state: Roster) => (state === 'valid' ? VALID_ROSTER : MALFORMED_ROSTER);
  writeFileSync(join(root, 'law/policy/sensor-registry.json'), roster(sourcePolicy));
  writeFileSync(join(law, 'ambient-probe.schema.json'), JSON.stringify({ type: 'string' }));
  // Each schema location carries its own distinct kind enum, so the loaded enum names the
  // schema file that was selected and can never be mistaken for a roster's kinds.
  withKindEnum(join(law, 'sensor-reading.schema.json'), ['authored-schema-kind']);
  if (bundled) {
    cpSync(join(sourceRoot, 'law/schemas'), join(here, 'schemas'), { recursive: true });
    withKindEnum(join(here, 'schemas/sensor-reading.schema.json'), ['installed-schema-kind']);
  }
  if (sidecar !== undefined) {
    writeFileSync(join(here, 'sensor-registry.json'), roster(sidecar));
  }
  vi.resetModules();
  // Relocate only this module's origin; all asset reads use the real fixture filesystem.
  vi.doMock('node:url', async () => {
    const actual = await vi.importActual<typeof import('node:url')>('node:url');
    return {
      ...actual,
      fileURLToPath: (...args: Parameters<typeof actual.fileURLToPath>) => {
        const path = actual.fileURLToPath(...args);
        return path.endsWith('/packages/schemas/src/index.ts') ? join(here, 'index.js') : path;
      },
    };
  });
  return { here, law, registry: await import('../../src/index.js') };
}

function withKindEnum(path: string, kinds: readonly string[]): void {
  const schema = JSON.parse(readFileSync(path, 'utf8')) as {
    properties: { sensor: { properties: { kind: { enum: readonly string[] } } } };
  };
  schema.properties.sensor.properties.kind.enum = kinds;
  writeFileSync(path, JSON.stringify(schema));
}

const KIND_ENUM = 'properties.sensor.properties.kind.enum';
const UNUSABLE_ROSTER = 'sensor registry has no unique live kind roster';

describe('schema source and installed asset selection', () => {
  it('discovers authored schemas and policy when no installed assets exist', async () => {
    const { registry } = await layout(false, undefined);
    const validate = registry.getValidator('ambient-probe.schema.json');
    expect(validate('value')).toBe(true);
    expect(validate(1)).toBe(false);
    expect(registry.loadSchema('sensor-reading.schema.json')).toHaveProperty(KIND_ENUM, [
      'authored-schema-kind',
    ]);

    // The neighboring source policy is the roster read: making it unusable is refused.
    const unusable = await layout(false, undefined, 'malformed');
    expect(() => unusable.registry.loadSchema('sensor-reading.schema.json')).toThrow(
      UNUSABLE_ROSTER,
    );
  });

  it('uses the installed roster and sidecar instead of neighboring source policy', async () => {
    // The neighboring source roster is unusable: loading succeeds only from the sidecar.
    const { registry } = await layout(true, 'valid', 'malformed');
    expect(() => registry.getValidator('ambient-probe.schema.json')).toThrow(
      'unregistered schema: ambient-probe.schema.json',
    );
    expect(registry.loadSchema('sensor-reading.schema.json')).toHaveProperty(KIND_ENUM, [
      'installed-schema-kind',
    ]);
    expect(registry.getValidator('error.schema.json')({})).toBe(false);

    const unusable = await layout(true, 'malformed', 'valid');
    expect(() => unusable.registry.loadSchema('sensor-reading.schema.json')).toThrow(
      UNUSABLE_ROSTER,
    );
  });

  it('does not replace a missing installed schema with a neighboring authored copy', async () => {
    const { here, registry } = await layout(true, 'valid');
    rmSync(join(here, 'schemas/error.schema.json'));
    expect(() => registry.loadSchema('error.schema.json')).toThrow(/ENOENT/);
  });

  it('uses an available package sidecar even when schemas come from the authored layout', async () => {
    const { registry } = await layout(false, 'valid', 'malformed');
    expect(registry.loadSchema('sensor-reading.schema.json')).toHaveProperty(KIND_ENUM, [
      'authored-schema-kind',
    ]);

    const unusable = await layout(false, 'malformed', 'valid');
    expect(() => unusable.registry.loadSchema('sensor-reading.schema.json')).toThrow(
      UNUSABLE_ROSTER,
    );
  });
});
