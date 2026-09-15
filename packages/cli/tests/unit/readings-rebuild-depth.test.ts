import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { rebuildSensorReadings } from '../../src/commands/sense/readings-rebuild.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-readings-rebuild-'));
  roots.push(root);
  return root;
}

function put(root: string, path: string, body: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
}

async function rebuild(root: string) {
  return withAuthorityHostTestScope(() => rebuildSensorReadings(root));
}

function persistedAggregate(root: string, id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(root, '.devai/state/sensor-readings/inventory_regeneration', `${id}.json`),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

describe('inventory SensorReading reconstruction', () => {
  it('records review when no inventory body exists', async () => {
    const root = repository();
    const result = await rebuild(root);

    expect(result.report).toEqual({
      ok: true,
      repo_root: root,
      entries: [],
      created: 0,
      skipped: 0,
      errors: [],
    });
    expect(result.reading).toMatchObject({
      sensor: { name: 'inventory-regeneration', kind: 'inventory_regeneration' },
      status: 'review',
      deterministic: true,
      metrics: { kinds_touched: 0, kinds_rebuilt: 0, kinds_up_to_date: 0, error_count: 0 },
      findings: [{ code: 'INVENTORY_REGENERATION_NO_KINDS_TOUCHED' }],
    });
    expect(persistedAggregate(root, result.reading.id)).toEqual(result.reading);
  });

  it('creates deterministic per-kind readings and then skips their existing paths', async () => {
    const root = repository();
    put(root, '.devai/state/sensors/inventory_api/b.json', '{"routes":2}\n');
    put(root, '.devai/state/sensors/inventory_api/a.json', '{"routes":1}\n');
    put(root, '.devai/state/sensors/inventory_routes/routes.json', '{"count":3}\n');
    put(root, '.devai/state/sensors/inventory_routes/ignored.txt', 'not JSON');

    const first = await rebuild(root);
    expect(first.report).toMatchObject({ ok: true, created: 3, skipped: 0, errors: [] });
    expect(
      first.report.entries.map(({ kind, body_path, action }) => ({ kind, body_path, action })),
    ).toEqual([
      {
        kind: 'inventory_api',
        body_path: '.devai/state/sensors/inventory_api/a.json',
        action: 'created',
      },
      {
        kind: 'inventory_api',
        body_path: '.devai/state/sensors/inventory_api/b.json',
        action: 'created',
      },
      {
        kind: 'inventory_routes',
        body_path: '.devai/state/sensors/inventory_routes/routes.json',
        action: 'created',
      },
    ]);
    expect(first.reading).toMatchObject({
      status: 'pass',
      findings: [],
      metrics: { kinds_touched: 2, kinds_rebuilt: 3, kinds_up_to_date: 0, error_count: 0 },
    });

    const generated = first.report.entries.map(({ reading_path }) => ({
      path: reading_path,
      value: JSON.parse(readFileSync(reading_path, 'utf8')) as Record<string, unknown>,
    }));
    expect(generated.map(({ value }) => value)).toEqual([
      expect.objectContaining({
        sensor: { name: 'inventory:api', kind: 'inventory_api', version: '1.0.0' },
        status: 'pass',
        evidence_path: join(root, '.devai/state/sensors/inventory_api/a.json'),
        findings: [expect.objectContaining({ code: 'REBUILT_FROM_BODY' })],
      }),
      expect.objectContaining({
        sensor: { name: 'inventory:api', kind: 'inventory_api', version: '1.0.0' },
        evidence_path: join(root, '.devai/state/sensors/inventory_api/b.json'),
      }),
      expect.objectContaining({
        sensor: { name: 'inventory:routes', kind: 'inventory_routes', version: '1.0.0' },
        evidence_path: join(root, '.devai/state/sensors/inventory_routes/routes.json'),
      }),
    ]);

    const second = await rebuild(root);
    expect(second.report).toMatchObject({ ok: true, created: 0, skipped: 3, errors: [] });
    expect(second.report.entries.map(({ action }) => action)).toEqual([
      'skipped-exists',
      'skipped-exists',
      'skipped-exists',
    ]);
    expect(second.report.entries.map(({ reading_path }) => reading_path)).toEqual(
      generated.map(({ path }) => path),
    );
    expect(second.reading).toMatchObject({
      status: 'pass',
      metrics: { kinds_touched: 2, kinds_rebuilt: 0, kinds_up_to_date: 3, error_count: 0 },
    });
  });

  it('fails the aggregate while preserving a bounded malformed-body diagnostic', async () => {
    const root = repository();
    put(root, '.devai/state/sensors/inventory_rbac/broken.json', '{broken');

    const result = await rebuild(root);
    expect(result.report.ok).toBe(false);
    expect(result.report).toMatchObject({ entries: [], created: 0, skipped: 0 });
    expect(result.report.errors).toHaveLength(1);
    expect(result.report.errors[0]).toContain(
      'parse .devai/state/sensors/inventory_rbac/broken.json failed:',
    );
    expect(result.reading).toMatchObject({
      status: 'fail',
      metrics: { kinds_touched: 0, kinds_rebuilt: 0, kinds_up_to_date: 0, error_count: 1 },
      findings: [
        expect.objectContaining({
          severity: 'error',
          code: 'READINGS_REBUILD_ERROR',
          message: expect.stringContaining('inventory_rbac/broken.json'),
        }),
      ],
    });
    expect(
      readdirSync(join(root, '.devai/state/sensor-readings/inventory_regeneration')),
    ).toContain(`${result.reading.id}.json`);
  });
});
