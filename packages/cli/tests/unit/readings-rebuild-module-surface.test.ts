import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { rebuildSensorReadings } from '../../src/commands/sense/readings-rebuild.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-readings-module-surface-'));
  roots.push(root);
  return root;
}

describe('readings rebuild module surface', () => {
  it('preserves every inventory body directory, reading kind, and sensor name literal', async () => {
    const root = repository();
    const descriptors = [
      ['inventory_data_model', 'inventory_data_model', 'inventory:data-model'],
      ['inventory_data_handling', 'inventory_data_handling', 'inventory:data-handling'],
      ['inventory_rbac', 'inventory_rbac', 'inventory:rbac'],
      ['inventory_dep_graph', 'inventory_dep_graph', 'inventory:dep-graph'],
      ['inventory_coverage', 'inventory_coverage', 'inventory:coverage'],
    ] as const;

    for (const [subdir] of descriptors) {
      const body = join(root, '.devai/state/sensors', subdir, 'body.json');
      mkdirSync(dirname(body), { recursive: true });
      writeFileSync(body, '{}\n');
    }

    const result = await withAuthorityHostTestScope(() => rebuildSensorReadings(root));

    expect(
      result.report.entries.map(({ kind, body_path, reading_path }) => ({
        kind,
        body_path,
        readingKind: basename(dirname(reading_path)),
      })),
    ).toEqual(
      descriptors.map(([subdir, kind]) => ({
        kind,
        body_path: join('.devai/state/sensors', subdir, 'body.json'),
        readingKind: kind,
      })),
    );
    expect(
      result.report.entries.map(({ reading_path }) => {
        const reading = JSON.parse(readFileSync(reading_path, 'utf8')) as {
          readonly sensor: { readonly kind: string; readonly name: string };
        };
        return { kind: reading.sensor.kind, name: reading.sensor.name };
      }),
    ).toEqual(descriptors.map(([, kind, name]) => ({ kind, name })));
  });
});
