import { existsSync, readFileSync } from 'node:fs';
import type { Blueprint, Operation } from './types.js';

// ---------------------------------------------------------------------
// Diff blueprint against brownfield inventory.
// ---------------------------------------------------------------------

export interface BlueprintDiffOptions {
  readonly blueprint: Blueprint;
  readonly inventoryRoot: string;
}

export interface BlueprintDiffEntry {
  readonly kind: 'missing_entity' | 'missing_field' | 'missing_route' | 'missing_permission';
  readonly target: string;
  readonly detail: string;
}

export interface BlueprintDiffResult {
  readonly status: 'aligned' | 'has_deltas' | 'no_inventory';
  readonly deltas: readonly BlueprintDiffEntry[];
  readonly summary: {
    readonly missing_entities: number;
    readonly missing_fields: number;
    readonly missing_routes: number;
    readonly missing_permissions: number;
  };
}

/**
 * Compare a blueprint to existing brownfield inventory bodies. Returns
 * the deltas (what the blueprint declares that inventory doesn't reflect).
 *
 * The inverse (what inventory has that blueprint doesn't) is intentionally
 * NOT computed — the blueprint is authority for greenfield additions;
 * brownfield code can have extras the blueprint doesn't mention without
 * that being a defect.
 *
 * Against an empty repo (no inventory bodies): status = 'no_inventory'
 * and deltas contain every entity/field/operation/permission in the
 * blueprint (i.e. "scaffold everything"). Against a populated repo:
 * status = 'aligned' (no deltas) or 'has_deltas' (deltas list).
 */
export function diffBlueprintAgainstInventory(opts: BlueprintDiffOptions): BlueprintDiffResult {
  const { blueprint, inventoryRoot } = opts;

  // Load inventory bodies if they exist.
  const dataModelPath = `${inventoryRoot}/.devai/state/sensors/inventory_data_model/data-model.json`;
  const apiMapPath = `${inventoryRoot}/.devai/state/sensors/inventory_api/api-map.json`;
  const rbacPath = `${inventoryRoot}/.devai/state/sensors/inventory_rbac/rbac.json`;

  const dataModel = readJsonOrNull(dataModelPath);
  const apiMap = readJsonOrNull(apiMapPath);
  const rbac = readJsonOrNull(rbacPath);

  if (dataModel === null && apiMap === null && rbac === null) {
    // No inventory at all → everything in the blueprint is a delta.
    const deltas: BlueprintDiffEntry[] = [];
    for (const entity of blueprint.database.entities) {
      deltas.push({
        kind: 'missing_entity',
        target: entity.name,
        detail: `entity ${entity.name} is declared in blueprint but no inventory_data_model body found`,
      });
    }
    for (const resource of blueprint.api?.resources ?? []) {
      for (const op of resource.operations ?? []) {
        deltas.push({
          kind: 'missing_route',
          target: `${op} ${resource.path ?? resource.entity}`,
          detail: `operation ${op} on ${resource.entity} declared in blueprint; no inventory_api body found`,
        });
      }
    }
    for (const role of blueprint.auth?.rbac?.roles ?? []) {
      deltas.push({
        kind: 'missing_permission',
        target: role,
        detail: `role ${role} declared in blueprint; no inventory_rbac body found`,
      });
    }
    return {
      status: 'no_inventory',
      deltas,
      summary: {
        missing_entities: deltas.filter((d) => d.kind === 'missing_entity').length,
        missing_fields: 0,
        missing_routes: deltas.filter((d) => d.kind === 'missing_route').length,
        missing_permissions: deltas.filter((d) => d.kind === 'missing_permission').length,
      },
    };
  }

  const deltas: BlueprintDiffEntry[] = [];

  // Data-model leg.
  const inventoryTables = extractTableNames(dataModel ?? {});
  for (const entity of blueprint.database.entities) {
    const expectedTable =
      entity.table ??
      deriveTableName(blueprint.module.namespace, blueprint.module.name, entity.name);
    if (!inventoryTables.has(expectedTable)) {
      deltas.push({
        kind: 'missing_entity',
        target: entity.name,
        detail: `entity ${entity.name} (table ${expectedTable}) is in blueprint but not in inventory_data_model`,
      });
    } else {
      // Table exists — check field-level coverage.
      const inventoryFields = extractFieldNames(dataModel, expectedTable);
      for (const field of entity.fields) {
        if (!inventoryFields.has(field.name)) {
          deltas.push({
            kind: 'missing_field',
            target: `${entity.name}.${field.name}`,
            detail: `field ${entity.name}.${field.name} declared in blueprint; not present on inventory table ${expectedTable}`,
          });
        }
      }
    }
  }

  // Match the operation, not just a coincidentally shared URL. PUT and PATCH
  // both implement item updates; collection and item reads remain distinct.
  const operationMethods: Readonly<Record<Operation, readonly string[]>> = {
    list: ['GET'],
    get: ['GET'],
    create: ['POST'],
    update: ['PUT', 'PATCH'],
    delete: ['DELETE'],
  };
  const inventoryEndpoints = extractEndpoints(apiMap ?? {});
  for (const resource of blueprint.api?.resources ?? []) {
    const basePath = blueprint.api?.basePath ?? '/api';
    const resourcePath = resource.path ?? `/${toKebabSimple(resource.entity)}s`;
    for (const op of resource.operations ?? []) {
      const wantedPath = `${basePath}${resourcePath}`;
      const operationPath =
        op === 'get' || op === 'update' || op === 'delete' ? `${wantedPath}/:id` : wantedPath;
      const present = operationMethods[op].some((method) =>
        inventoryEndpoints.has(`${method} ${operationPath}`),
      );
      if (!present) {
        deltas.push({
          kind: 'missing_route',
          target: `${op} ${wantedPath}`,
          detail: `operation ${op} on ${resource.entity} declared in blueprint; no matching endpoint in inventory_api`,
        });
      }
    }
  }

  // RBAC leg.
  const inventoryRoles = extractRoleIds(rbac ?? {});
  for (const role of blueprint.auth?.rbac?.roles ?? []) {
    if (!inventoryRoles.has(role)) {
      deltas.push({
        kind: 'missing_permission',
        target: role,
        detail: `role ${role} declared in blueprint; not present in inventory_rbac roles`,
      });
    }
  }

  const summary = {
    missing_entities: deltas.filter((d) => d.kind === 'missing_entity').length,
    missing_fields: deltas.filter((d) => d.kind === 'missing_field').length,
    missing_routes: deltas.filter((d) => d.kind === 'missing_route').length,
    missing_permissions: deltas.filter((d) => d.kind === 'missing_permission').length,
  };

  return {
    status: deltas.length === 0 ? 'aligned' : 'has_deltas',
    deltas,
    summary,
  };
}

// ---------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------

function readJsonOrNull(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function extractTableNames(dataModel: unknown): Set<string> {
  const out = new Set<string>();
  const dm = dataModel as { tables?: ReadonlyArray<{ name?: string }> };
  for (const t of dm.tables ?? []) {
    if (typeof t.name === 'string') out.add(t.name);
  }
  return out;
}

function extractFieldNames(dataModel: unknown, table: string): Set<string> {
  const out = new Set<string>();
  const dm = dataModel as {
    tables?: ReadonlyArray<{ name?: string; columns?: ReadonlyArray<{ name?: string }> }>;
  };
  for (const t of dm.tables ?? []) {
    if (t.name !== table) continue;
    for (const c of t.columns ?? []) {
      if (typeof c.name === 'string') out.add(c.name);
    }
  }
  return out;
}

function extractEndpoints(apiMap: unknown): Set<string> {
  const out = new Set<string>();
  const am = apiMap as { endpoints?: ReadonlyArray<{ method?: string; path?: string }> };
  for (const e of am.endpoints ?? []) {
    if (typeof e.method === 'string' && typeof e.path === 'string') {
      out.add(`${e.method} ${e.path}`);
    }
  }
  return out;
}

function extractRoleIds(rbac: unknown): Set<string> {
  const out = new Set<string>();
  const r = rbac as { roles?: ReadonlyArray<{ id?: string }> };
  for (const role of r.roles ?? []) {
    if (typeof role.id === 'string') out.add(role.id);
  }
  return out;
}

export function toKebabSimple(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

function deriveTableName(namespace: string, moduleName: string, entityName: string): string {
  return `${namespace}__${toSnake(moduleName)}_${toSnake(entityName)}`;
}

function toSnake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}
