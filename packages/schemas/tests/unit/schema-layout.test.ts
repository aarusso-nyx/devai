import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function layout(bundled: boolean, sidecar: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'devai-schema-layout-'));
  roots.push(root);
  const here = join(root, 'packages/schemas/dist');
  const law = join(root, 'law/schemas');
  mkdirSync(here, { recursive: true });
  mkdirSync(dirname(law), { recursive: true });
  cpSync(join(sourceRoot, 'law/schemas'), law, { recursive: true });
  mkdirSync(join(root, 'law/policy'));
  const sensorRegistry = (kind: string) => JSON.stringify({ entries: [{ kind }] });
  writeFileSync(join(root, 'law/policy/sensor-registry.json'), sensorRegistry('source-kind'));
  writeFileSync(join(law, 'ambient-probe.schema.json'), JSON.stringify({ type: 'string' }));
  if (bundled) {
    cpSync(join(sourceRoot, 'law/schemas'), join(here, 'schemas'), { recursive: true });
  }
  if (sidecar) {
    writeFileSync(join(here, 'sensor-registry.json'), sensorRegistry('installed-kind'));
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

describe('schema source and installed asset selection', () => {
  it('discovers authored schemas and policy when no installed assets exist', async () => {
    const { registry } = await layout(false, false);
    const validate = registry.getValidator('ambient-probe.schema.json');
    expect(validate('value')).toBe(true);
    expect(validate(1)).toBe(false);
    expect(registry.loadSchema('sensor-reading.schema.json')).toHaveProperty(
      'properties.sensor.properties.kind.enum',
      ['source-kind'],
    );
  });

  it('uses the installed roster and sidecar instead of neighboring source policy', async () => {
    const { registry } = await layout(true, true);
    expect(() => registry.getValidator('ambient-probe.schema.json')).toThrow(
      'unregistered schema: ambient-probe.schema.json',
    );
    expect(registry.loadSchema('sensor-reading.schema.json')).toHaveProperty(
      'properties.sensor.properties.kind.enum',
      ['installed-kind'],
    );
    expect(registry.getValidator('error.schema.json')({})).toBe(false);
  });

  it('does not replace a missing installed schema with a neighboring authored copy', async () => {
    const { here, registry } = await layout(true, true);
    rmSync(join(here, 'schemas/error.schema.json'));
    expect(() => registry.loadSchema('error.schema.json')).toThrow(/ENOENT/);
  });

  it('uses an available package sidecar even when schemas come from the authored layout', async () => {
    const { registry } = await layout(false, true);
    expect(registry.loadSchema('sensor-reading.schema.json')).toHaveProperty(
      'properties.sensor.properties.kind.enum',
      ['installed-kind'],
    );
  });
});
