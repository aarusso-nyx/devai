import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import {
  diffBlueprintAgainstInventory,
  type Blueprint,
  type Operation,
} from '../../src/blueprint/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function compare(operation: Operation, method: string, path: string) {
  const root = mkdtempSync(join(tmpdir(), 'devai-blueprint-route-'));
  roots.push(root);
  const blueprint: Blueprint = {
    schemaVersion: '1.0.0',
    id: 'BP-ORDERS-001',
    module: { name: 'Orders', namespace: 'sales', version: '1.0.0' },
    database: {
      entities: [
        {
          name: 'Order',
          table: 'orders',
          primaryKey: ['id'],
          fields: [{ name: 'id', type: 'uuid' }],
        },
      ],
    },
    api: {
      basePath: '/api',
      resources: [{ entity: 'Order', path: '/orders', operations: [operation] }],
    },
  };
  const api = {
    schemaVersion: '1.0.0',
    generatedAt: '2026-09-07T00:00:00.000Z',
    endpoints: [
      {
        method,
        path,
        controller: { file: 'orders.controller.ts' },
        evidence: [{ path: 'orders.controller.ts', startLine: 1, endLine: 2 }],
      },
    ],
  };
  expect(
    validators.moduleBlueprint(blueprint),
    JSON.stringify(validators.moduleBlueprint.errors),
  ).toBe(true);
  expect(validators.apiMap(api), JSON.stringify(validators.apiMap.errors)).toBe(true);
  for (const [relative, value] of [
    [
      'inventory_data_model/data-model.json',
      { tables: [{ name: 'orders', columns: [{ name: 'id' }] }] },
    ],
    ['inventory_api/api-map.json', api],
  ] as const) {
    const file = join(root, '.devai/state/sensors', relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  }
  return diffBlueprintAgainstInventory({ blueprint, inventoryRoot: root });
}

const routes = [
  ['list', 'GET', '/api/orders', '/api/orders/:id'],
  ['get', 'GET', '/api/orders/:id', '/api/orders'],
  ['create', 'POST', '/api/orders', '/api/orders/:id'],
  ['update', 'PUT', '/api/orders/:id', '/api/orders'],
  ['delete', 'DELETE', '/api/orders/:id', '/api/orders'],
] as const;

it.each(routes)('accepts the scaffold controller route for %s', (operation, method, path) => {
  expect(compare(operation, method, path)).toEqual({
    status: 'aligned',
    deltas: [],
    summary: { missing_entities: 0, missing_fields: 0, missing_routes: 0, missing_permissions: 0 },
  });
});

it.each(routes)(
  'requires the HTTP method for %s, not merely the path',
  (operation, _method, path) => {
    expect(compare(operation, 'OPTIONS', path)).toMatchObject({
      status: 'has_deltas',
      summary: { missing_routes: 1 },
      deltas: [{ kind: 'missing_route', target: `${operation} /api/orders` }],
    });
  },
);

it.each(routes)(
  'distinguishes collection and item routes for %s',
  (operation, method, _path, wrongPath) => {
    expect(compare(operation, method, wrongPath)).toMatchObject({
      status: 'has_deltas',
      summary: { missing_routes: 1 },
    });
  },
);

it('recognizes an explicit PATCH item endpoint as an update operation', () => {
  expect(compare('update', 'PATCH', '/api/orders/:id').status).toBe('aligned');
});
