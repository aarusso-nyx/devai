/**
 * Boundary behaviour of the blueprint slice: what loadBlueprint reports for
 * unreadable/unparseable/schema-rejected inputs, how the invariant checker
 * binds pointers and defaults, how the inventory diff distinguishes a partial
 * inventory from an absent one, and which properties of the scaffold plan are
 * contractual rather than incidental.
 *
 * Normal blueprint fixtures are schema-validated before use. Explicit direct-API
 * refusal cases below identify their deliberately schema-invalid input. Sensor bodies under
 * .devai/state/sensors are read raw by the diff (no validation, no schema
 * gate), so untrusted/garbled bodies are part of that function's domain and
 * are exercised as such.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import {
  blueprintSha256,
  diffBlueprintAgainstInventory,
  loadBlueprint,
  planScaffoldFromBlueprint,
  validateBlueprint,
  type Blueprint,
  type BlueprintDiffResult,
} from '../../src/blueprint/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-blueprint-slice-'));
  roots.push(path);
  return path;
}

function writeFile(root: string, relative: string, body: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function writeSensor(root: string, sensor: string, file: string, value: unknown): void {
  writeFile(
    root,
    join('.devai/state/sensors', sensor, file),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

/** Fixtures are only meaningful if the schema would accept them. */
function schemaValid(bp: Blueprint): Blueprint {
  expect(validators.moduleBlueprint(bp), JSON.stringify(validators.moduleBlueprint.errors)).toBe(
    true,
  );
  return bp;
}

/** Census of the deltas the diff actually emitted, by kind. */
function censusOf(result: BlueprintDiffResult): BlueprintDiffResult['summary'] {
  const count = (kind: string): number => result.deltas.filter((d) => d.kind === kind).length;
  return {
    missing_entities: count('missing_entity'),
    missing_fields: count('missing_field'),
    missing_routes: count('missing_route'),
    missing_permissions: count('missing_permission'),
  };
}

const base = (): Blueprint =>
  schemaValid({
    schemaVersion: '1.0.0',
    id: 'BP-ORDERFLOW-001',
    module: { name: 'OrderFlow', namespace: 'shop', version: '1.2.3' },
    database: {
      entities: [
        {
          name: 'Widget',
          table: 'widgets',
          primaryKey: ['id'],
          fields: [{ name: 'id', type: 'uuid' }],
        },
      ],
    },
  });

describe('loadBlueprint reports why an input was refused', () => {
  it('refuses a path that does not exist and names it', () => {
    const missing = join(tempRoot(), 'nope', 'blueprint.json');
    const result = loadBlueprint(missing);
    expect(result.ok).toBe(false);
    expect(result.blueprint).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(missing);
  });

  it('refuses a file that is not JSON without throwing', () => {
    const path = writeFile(tempRoot(), 'blueprint.json', '{"module": ');
    const result = loadBlueprint(path);
    expect(result.ok).toBe(false);
    expect(result.blueprint).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).not.toBe('');
  });

  it('binds a root-level schema failure to the root pointer', () => {
    const path = writeFile(
      tempRoot(),
      'blueprint.json',
      JSON.stringify({
        schemaVersion: '1.0.0',
        id: 'BP-ORDERFLOW-001',
        module: { name: 'OrderFlow', namespace: 'shop', version: '1.2.3' },
      }),
    );
    const result = loadBlueprint(path);
    expect(result.ok).toBe(false);
    expect(result.blueprint).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    // Root failures have an empty instancePath; the report still points somewhere.
    expect(result.errors[0]).toMatch(/^\/: .+/);
    expect(result.errors[0]).toContain('database');
    expect(result.errors[0]).not.toMatch(/: invalid$/);
  });

  it('binds a nested schema failure to the offending member, not the root', () => {
    const bp = base();
    const path = writeFile(
      tempRoot(),
      'blueprint.json',
      JSON.stringify({
        ...bp,
        database: {
          entities: [
            {
              ...bp.database.entities[0],
              fields: [{ name: 'id', type: 'uuid', pii: 'extreme' }],
            },
          ],
        },
      }),
    );
    const result = loadBlueprint(path);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^\/database\/entities\/0\/fields\/0\/pii: .+/);
    expect(result.errors[0]).not.toMatch(/: invalid$/);
  });

  it('returns the parsed document unaltered when the schema accepts it', () => {
    const bp = base();
    const body = JSON.stringify(bp);
    const path = writeFile(tempRoot(), 'blueprint.json', body);
    const result = loadBlueprint(path);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.blueprint).toEqual(JSON.parse(body));
  });
});

describe('validateBlueprint binds violations to the element that caused them', () => {
  it('treats an omitted primaryKey as the documented default, not as a violation', () => {
    const bp = schemaValid({
      ...base(),
      database: {
        entities: [{ name: 'Widget', fields: [{ name: 'id', type: 'uuid' }] }],
      },
    });
    expect(validateBlueprint(bp)).toEqual({ ok: true, violations: [] });
  });

  it('reports an entity-less database as a gate violation with a non-empty message', () => {
    // Schema-rejected upstream (database.entities has minItems 1); the invariant
    // is the declared defence-in-depth check for callers that skip loadBlueprint.
    const bp = { ...base(), database: { entities: [] } } as Blueprint;
    const result = validateBlueprint(bp);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      invariant_id: 'INV-BLUEPRINT-001',
      severity: 'gate',
      pointer: '/database/entities',
    });
    expect(result.violations[0]?.message).not.toBe('');
  });

  it('points INV-BLUEPRINT-001 at the entity whose primaryKey is empty', () => {
    // Also schema-rejected upstream (primaryKey has minItems 1); same declared
    // defence-in-depth check, and the pointer must name the second entity.
    const bp = {
      ...base(),
      database: {
        entities: [
          { name: 'Widget', primaryKey: ['id'], fields: [{ name: 'id', type: 'uuid' }] },
          { name: 'Gadget', primaryKey: [], fields: [{ name: 'id', type: 'uuid' }] },
        ],
      },
    } as Blueprint;
    const result = validateBlueprint(bp);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      invariant_id: 'INV-BLUEPRINT-001',
      severity: 'gate',
      pointer: '/database/entities/1/primaryKey',
    });
    expect(result.violations[0]?.message).toContain('Gadget');
  });

  it('points INV-BLUEPRINT-002 at the exact field index and hard-fails it', () => {
    const bp = schemaValid({
      ...base(),
      database: {
        entities: [
          { name: 'Widget', fields: [{ name: 'id', type: 'uuid' }] },
          {
            name: 'Customer',
            fields: [
              { name: 'id', type: 'uuid' },
              { name: 'nickname', type: 'text', pii: 'low', retention: '90d' },
              { name: 'tax_id', type: 'text', pii: 'high' },
            ],
          },
        ],
      },
    });
    const result = validateBlueprint(bp);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    const violation = result.violations[0];
    expect(violation).toMatchObject({
      invariant_id: 'INV-BLUEPRINT-002',
      severity: 'hard-fail',
      pointer: '/database/entities/1/fields/2',
    });
    expect(violation?.message).toContain('Customer.tax_id');
    expect(violation?.message).toContain('high');
  });

  const withRbac = (allow: readonly string[]): Blueprint =>
    schemaValid({
      ...base(),
      api: {
        basePath: '/api',
        resources: [
          { entity: 'Widget', path: '/widgets', operations: ['list'] },
          { entity: 'Widget', path: '/widgets', operations: ['list', 'get', 'create'] },
        ],
      },
      auth: { rbac: { roles: ['admin'], permissions: [{ role: 'admin', allow }] } },
    });

  it('points INV-BLUEPRINT-003 at the ungranted resource/operation pair', () => {
    const result = validateBlueprint(withRbac(['list', 'get']));
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      invariant_id: 'INV-BLUEPRINT-003',
      severity: 'gate',
      pointer: '/api/resources/1/operations/2',
    });
    expect(result.violations[0]?.message).toContain('create');
  });

  const grants: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['a direct grant', ['list', 'get', 'create']],
    ["the 'manage' alias", ['manage']],
    ["the '*' wildcard", ['*']],
  ];

  it.each(grants)('accepts every declared operation under %s', (_label, allow) => {
    expect(validateBlueprint(withRbac(allow))).toEqual({ ok: true, violations: [] });
  });
});

describe('diffBlueprintAgainstInventory separates absent inventory from partial inventory', () => {
  const bp = (): Blueprint =>
    schemaValid({
      ...base(),
      api: { basePath: '/api', resources: [{ entity: 'Widget', operations: ['list'] }] },
      auth: { rbac: { roles: ['admin'], permissions: [{ role: 'admin', allow: ['manage'] }] } },
    });

  const dataModel = { tables: [{ name: 'widgets', columns: [{ name: 'id' }] }] };
  const apiMap = { endpoints: [{ method: 'GET', path: '/api/widgets' }] };
  const rbac = { roles: [{ id: 'admin' }] };

  const partials: ReadonlyArray<
    readonly [string, string, string, unknown, BlueprintDiffResult['summary']]
  > = [
    [
      'only the data-model body',
      'inventory_data_model',
      'data-model.json',
      dataModel,
      { missing_entities: 0, missing_fields: 0, missing_routes: 1, missing_permissions: 1 },
    ],
    [
      'only the api-map body',
      'inventory_api',
      'api-map.json',
      apiMap,
      { missing_entities: 1, missing_fields: 0, missing_routes: 0, missing_permissions: 1 },
    ],
    [
      'only the rbac body',
      'inventory_rbac',
      'rbac.json',
      rbac,
      { missing_entities: 1, missing_fields: 0, missing_routes: 1, missing_permissions: 0 },
    ],
  ];

  it.each(partials)(
    'reads a repo with %s as a populated inventory',
    (_label, sensor, file, body, summary) => {
      const root = tempRoot();
      writeSensor(root, sensor, file, body);
      const result = diffBlueprintAgainstInventory({ blueprint: bp(), inventoryRoot: root });
      expect(result.status).toBe('has_deltas');
      expect(result.summary).toEqual(summary);
      expect(censusOf(result)).toEqual(result.summary);
    },
  );

  it('reads unparseable sensor bodies as absent inventory rather than throwing', () => {
    // Current behaviour: a garbled body is indistinguishable from a missing one.
    const root = tempRoot();
    writeSensor(root, 'inventory_data_model', 'data-model.json', '{"tables": [');
    writeSensor(root, 'inventory_api', 'api-map.json', 'not json at all');
    writeSensor(root, 'inventory_rbac', 'rbac.json', '');
    const result = diffBlueprintAgainstInventory({ blueprint: bp(), inventoryRoot: root });
    expect(result.status).toBe('no_inventory');
  });
});

describe('diffBlueprintAgainstInventory against an empty repo', () => {
  it('names each declared resource by path when it has one and by entity otherwise', () => {
    const bp = schemaValid({
      ...base(),
      database: {
        entities: [
          { name: 'Widget', table: 'widgets', fields: [{ name: 'id', type: 'uuid' }] },
          { name: 'Gadget', fields: [{ name: 'id', type: 'uuid' }] },
        ],
      },
      api: {
        basePath: '/api',
        resources: [
          { entity: 'Widget', operations: ['list'] },
          { entity: 'Gadget', path: '/gadgets', operations: ['create'] },
        ],
      },
      auth: { rbac: { roles: ['admin'], permissions: [{ role: 'admin', allow: ['manage'] }] } },
    });
    const result = diffBlueprintAgainstInventory({ blueprint: bp, inventoryRoot: tempRoot() });

    expect(result.status).toBe('no_inventory');
    expect(result.deltas.map((d) => [d.kind, d.target])).toEqual([
      ['missing_entity', 'Widget'],
      ['missing_entity', 'Gadget'],
      ['missing_route', 'list Widget'],
      ['missing_route', 'create /gadgets'],
      ['missing_permission', 'admin'],
    ]);
    for (const delta of result.deltas) expect(delta.detail, delta.kind).not.toBe('');
    expect(result.deltas[0]?.detail).toContain('Widget');
    expect(result.deltas[3]?.detail).toContain('Gadget');
    expect(result.deltas[4]?.detail).toContain('admin');
    // The summary is a census of what was emitted, not an independent count.
    expect(result.summary).toEqual(censusOf(result));
    expect(result.summary).toEqual({
      missing_entities: 2,
      missing_fields: 0,
      missing_routes: 2,
      missing_permissions: 1,
    });
  });
});

describe('diffBlueprintAgainstInventory against a populated repo', () => {
  const populated = (): BlueprintDiffResult => {
    const bp = schemaValid({
      ...base(),
      database: {
        entities: [
          {
            name: 'Widget',
            table: 'widgets',
            fields: [
              { name: 'id', type: 'uuid' },
              { name: 'label', type: 'text' },
              { name: 'nickname', type: 'text' },
            ],
          },
          { name: 'Gadget', fields: [{ name: 'id', type: 'uuid' }] },
        ],
      },
      api: {
        basePath: '/api',
        resources: [{ entity: 'Widget', path: '/widgets', operations: ['list', 'delete'] }],
      },
      auth: {
        rbac: {
          roles: ['admin', 'auditor', 'support'],
          permissions: [{ role: 'admin', allow: ['manage'] }],
        },
      },
    });
    const root = tempRoot();
    writeSensor(root, 'inventory_data_model', 'data-model.json', {
      tables: [
        { name: 'widgets', columns: [{ name: 'id' }] },
        // 'nickname' lives on a different table: column lookup is per-table.
        { name: 'gizmos', columns: [{ name: 'nickname' }] },
      ],
    });
    writeSensor(root, 'inventory_api', 'api-map.json', {
      endpoints: [{ method: 'GET', path: '/api/widgets' }],
    });
    writeSensor(root, 'inventory_rbac', 'rbac.json', { roles: [{ id: 'owner' }] });
    return diffBlueprintAgainstInventory({ blueprint: bp, inventoryRoot: root });
  };

  it('counts each delta kind separately and consistently with the deltas', () => {
    const result = populated();
    expect(result.status).toBe('has_deltas');
    expect(result.summary).toEqual({
      missing_entities: 1,
      missing_fields: 2,
      missing_routes: 1,
      missing_permissions: 3,
    });
    expect(censusOf(result)).toEqual(result.summary);
  });

  it('emits data-model, route and role deltas in that order with bound targets', () => {
    const result = populated();
    expect(result.deltas.map((d) => [d.kind, d.target])).toEqual([
      ['missing_field', 'Widget.label'],
      ['missing_field', 'Widget.nickname'],
      ['missing_entity', 'Gadget'],
      ['missing_route', 'delete /api/widgets'],
      ['missing_permission', 'admin'],
      ['missing_permission', 'auditor'],
      ['missing_permission', 'support'],
    ]);
    for (const delta of result.deltas) expect(delta.detail).not.toBe('');
    // An entity with no explicit table is looked up under the derived name.
    expect(result.deltas[2]?.detail).toContain('shop__order_flow_gadget');
    expect(result.deltas[0]?.detail).toContain('widgets');
  });

  it('falls back to the default base path when the blueprint omits one', () => {
    const bp = schemaValid({
      ...base(),
      api: { resources: [{ entity: 'Widget', path: '/widgets', operations: ['list'] }] },
    });
    const root = tempRoot();
    writeSensor(root, 'inventory_api', 'api-map.json', {
      endpoints: [{ method: 'GET', path: '/api/widgets' }],
    });
    writeSensor(root, 'inventory_data_model', 'data-model.json', {
      tables: [{ name: 'widgets', columns: [{ name: 'id' }] }],
    });
    const result = diffBlueprintAgainstInventory({ blueprint: bp, inventoryRoot: root });
    expect(result).toEqual({
      status: 'aligned',
      deltas: [],
      summary: {
        missing_entities: 0,
        missing_fields: 0,
        missing_routes: 0,
        missing_permissions: 0,
      },
    });
  });

  it('does not accept an endpoint whose method or path is not a string', () => {
    const bp = schemaValid({
      ...base(),
      api: {
        basePath: '/api',
        resources: [{ entity: 'Widget', path: '/widgets', operations: ['list', 'delete'] }],
      },
    });
    const root = tempRoot();
    writeSensor(root, 'inventory_data_model', 'data-model.json', {
      tables: [{ name: 'widgets', columns: [{ name: 'id' }] }],
    });
    writeSensor(root, 'inventory_api', 'api-map.json', {
      endpoints: [
        // Array members stringify to exactly the key the lookup wants; the
        // type guard is what keeps them from counting as real endpoints.
        { method: ['GET'], path: '/api/widgets' },
        { method: 'DELETE', path: ['/api/widgets/:id'] },
      ],
    });
    const result = diffBlueprintAgainstInventory({ blueprint: bp, inventoryRoot: root });
    expect(result.summary.missing_routes).toBe(2);
    expect(result.deltas.map((d) => d.target)).toEqual([
      'list /api/widgets',
      'delete /api/widgets',
    ]);
  });
});

describe('planScaffoldFromBlueprint emits a deterministic slice', () => {
  const withEntities = (names: readonly string[]): Blueprint =>
    schemaValid({
      ...base(),
      database: {
        entities: names.map((name) => ({ name, fields: [{ name: 'id', type: 'uuid' }] })),
      },
    });

  const planSha = (bp: Blueprint): string => planScaffoldFromBlueprint(bp).blueprint_sha256;

  it('binds identity fields to the blueprint it was given', () => {
    const bp = withEntities(['Widget']);
    const plan = planScaffoldFromBlueprint(bp);
    expect(plan.blueprint_id).toBe('BP-ORDERFLOW-001');
    expect(plan.blueprint_version).toBe('1.2.3');
    expect(plan.blueprint_sha256).toBe(blueprintSha256(bp));
    expect(plan.module_slug).toBe('shop-order-flow');
  });

  it('repeats itself exactly, and re-keys to the same sha under key reordering', () => {
    const bp = withEntities(['Widget', 'LineItem']);
    expect(planScaffoldFromBlueprint(bp)).toEqual(planScaffoldFromBlueprint(bp));

    const reordered = JSON.parse(
      JSON.stringify({
        database: bp.database,
        module: bp.module,
        id: bp.id,
        schemaVersion: '1.0.0',
      }),
    ) as Blueprint;
    expect(planScaffoldFromBlueprint(reordered).blueprint_sha256).toBe(planSha(bp));

    const bumped = { ...bp, module: { ...bp.module, version: '1.2.4' } } as Blueprint;
    const bumpedPlan = planScaffoldFromBlueprint(bumped);
    expect(bumpedPlan.blueprint_version).toBe('1.2.4');
    expect(bumpedPlan.blueprint_sha256).not.toBe(planSha(bp));
  });

  it('gives every task a distinct id, at least one target and at least one template', () => {
    const plan = planScaffoldFromBlueprint(withEntities(['Widget', 'LineItem']));
    const ids = plan.tasks.map((t) => t.operation_id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toBe('');

    for (const task of plan.tasks) {
      expect(task.target_paths.length, task.operation_id).toBeGreaterThan(0);
      expect(task.templates.length, task.operation_id).toBeGreaterThan(0);
      expect(new Set(task.templates).size, task.operation_id).toBe(task.templates.length);
      for (const template of task.templates) expect(template, task.operation_id).not.toBe('');
    }
  });

  it('writes every target under the module slug and never twice', () => {
    const plan = planScaffoldFromBlueprint(withEntities(['Widget', 'LineItem']));
    const paths = plan.tasks.flatMap((t) => t.target_paths);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      const owned =
        path.startsWith(`domain/${plan.module_slug}/`) ||
        path === `.github/workflows/module-${plan.module_slug}.yml`;
      expect(owned, path).toBe(true);
    }
  });

  it('adds per-entity targets, kebab-cased, for the entity that was added', () => {
    const one = planScaffoldFromBlueprint(withEntities(['Widget']));
    const two = planScaffoldFromBlueprint(withEntities(['Widget', 'LineItem']));
    const byId = new Map(two.tasks.map((t) => [t.operation_id, t]));

    const perEntity: string[] = [];
    for (const task of one.tasks) {
      const after = byId.get(task.operation_id);
      expect(after, task.operation_id).toBeDefined();
      const added = (after?.target_paths ?? []).filter((p) => !task.target_paths.includes(p));
      for (const path of added) expect(path, task.operation_id).toContain('line-item');
      if (added.length > 0) perEntity.push(task.operation_id);
      // Nothing the single-entity plan produced may disappear.
      for (const path of task.target_paths) expect(after?.target_paths).toContain(path);
    }
    expect(perEntity).toEqual(['scaffold.api', 'scaffold.ui', 'scaffold.tests']);
  });
});
