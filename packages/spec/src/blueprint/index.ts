/**
 * Blueprint module: load, validate, diff, and plan.
 *
 * Public API:
 *   loadBlueprint(path)              — parse + AJV-validate
 *   validateBlueprint(blueprint)     — INV-BLUEPRINT-001/-002/-003 check
 *   diffBlueprintAgainstInventory()  — compare to brownfield inventory
 *   planScaffoldFromBlueprint()      — emit a deterministic scaffold plan
 *
 * Per the INV-BLUEPRINT-* invariants,
 * landed in 18.D.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { validators } from '@devai-nyx/schemas';

// ---------------------------------------------------------------------
// Types — public surface for the blueprint module.
// Mirrors module-blueprint.schema.json; uses unknown for opaque
// fields (abac.rules[].when) to preserve the schema's design intent.
// ---------------------------------------------------------------------

export type PiiLevel = 'none' | 'low' | 'high';
export type Retention = 'default' | '90d' | '1y' | 'forever';
export type Operation = 'list' | 'get' | 'create' | 'update' | 'delete';

export interface BlueprintField {
  readonly name: string;
  readonly type: string;
  readonly nullable?: boolean;
  readonly default?: string;
  readonly unique?: boolean;
  readonly check?: string;
  readonly pii?: PiiLevel;
  readonly retention?: Retention;
}

export interface BlueprintRelation {
  readonly type: 'many-to-one' | 'one-to-many' | 'many-to-many' | 'one-to-one';
  readonly target: string;
  readonly onDelete?: 'no action' | 'cascade' | 'restrict' | 'set null';
  readonly joinTable?: string;
  readonly field?: string;
}

export interface BlueprintEntity {
  readonly name: string;
  readonly table?: string;
  readonly primaryKey?: readonly string[];
  readonly fields: readonly BlueprintField[];
  readonly relations?: readonly BlueprintRelation[];
  readonly indexes?: ReadonlyArray<{
    readonly name?: string;
    readonly columns: readonly string[];
    readonly unique?: boolean;
  }>;
}

export interface BlueprintResource {
  readonly entity: string;
  readonly path?: string;
  readonly operations?: readonly Operation[];
  readonly pagination?: 'limit-offset' | 'cursor' | 'none';
  readonly sort?: readonly string[];
  readonly filter?: readonly string[];
}

export interface BlueprintRbacPermission {
  readonly role: string;
  readonly allow: readonly string[];
}

export interface Blueprint {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly module: {
    readonly name: string;
    readonly namespace: string;
    readonly version: string;
    readonly owners?: readonly string[];
    readonly description?: string;
  };
  readonly database: {
    readonly entities: readonly BlueprintEntity[];
    readonly enums?: ReadonlyArray<{ readonly name: string; readonly values: readonly string[] }>;
  };
  readonly api?: {
    readonly basePath?: string;
    readonly resources?: readonly BlueprintResource[];
  };
  readonly auth?: {
    readonly rbac?: {
      readonly roles: readonly string[];
      readonly permissions: readonly BlueprintRbacPermission[];
    };
    readonly abac?: {
      readonly rules?: ReadonlyArray<{ readonly id: string; readonly when: unknown }>;
    };
  };
  readonly ui?: unknown;
  readonly events?: unknown;
  readonly audit?: unknown;
  readonly seed?: unknown;
  readonly ops?: unknown;
}

// ---------------------------------------------------------------------
// Load + schema-validate.
// ---------------------------------------------------------------------

export interface LoadBlueprintResult {
  readonly ok: boolean;
  readonly blueprint?: Blueprint;
  readonly errors: readonly string[];
}

/**
 * Parse a blueprint file and validate against module-blueprint.schema.json.
 * Schema failures are surfaced as structured error strings. Successful
 * load returns the typed blueprint.
 */
export function loadBlueprint(path: string): LoadBlueprintResult {
  if (!existsSync(path)) {
    return { ok: false, errors: [`blueprint file not found: ${path}`] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      errors: [`failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [`JSON parse error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const valid = validators.moduleBlueprint(parsed);
  if (!valid) {
    const errs = (validators.moduleBlueprint.errors ?? []).map(
      (e) => `${e.instancePath || '/'}: ${e.message ?? 'invalid'}`,
    );
    return { ok: false, errors: errs };
  }
  return { ok: true, blueprint: parsed as Blueprint, errors: [] };
}

// ---------------------------------------------------------------------
// Invariant check: INV-BLUEPRINT-001/-002/-003.
// ---------------------------------------------------------------------

export interface InvariantViolation {
  readonly invariant_id: 'INV-BLUEPRINT-001' | 'INV-BLUEPRINT-002' | 'INV-BLUEPRINT-003';
  readonly severity: 'gate' | 'hard-fail';
  readonly pointer: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly violations: readonly InvariantViolation[];
}

/**
 * Check a blueprint against the BLUEPRINT-domain invariants.
 * Schema validation is upstream (loadBlueprint); this function checks
 * invariants that go beyond JSON-Schema reach (cross-field consistency).
 */
export function validateBlueprint(bp: Blueprint): ValidationResult {
  const violations: InvariantViolation[] = [];

  // INV-BLUEPRINT-001: every entity has primaryKey with length >= 1.
  if (bp.database.entities.length === 0) {
    violations.push({
      invariant_id: 'INV-BLUEPRINT-001',
      severity: 'gate',
      pointer: '/database/entities',
      message: 'database.entities[] must have length >= 1',
    });
  }
  bp.database.entities.forEach((entity, idx) => {
    const pk = entity.primaryKey ?? ['id'];
    if (pk.length === 0) {
      violations.push({
        invariant_id: 'INV-BLUEPRINT-001',
        severity: 'gate',
        pointer: `/database/entities/${String(idx)}/primaryKey`,
        message: `entity '${entity.name}' primaryKey must have length >= 1`,
      });
    }
  });

  // INV-BLUEPRINT-002: every PII-flagged field has retention != 'default'.
  bp.database.entities.forEach((entity, eIdx) => {
    entity.fields.forEach((field, fIdx) => {
      const pii = field.pii ?? 'none';
      const retention = field.retention ?? 'default';
      if (pii !== 'none' && retention === 'default') {
        violations.push({
          invariant_id: 'INV-BLUEPRINT-002',
          severity: 'hard-fail',
          pointer: `/database/entities/${String(eIdx)}/fields/${String(fIdx)}`,
          message: `field '${entity.name}.${field.name}' has pii='${pii}' but retention='default' (PII requires explicit retention per INV-INVENTORY-002 + INV-BLUEPRINT-002)`,
        });
      }
    });
  });

  // INV-BLUEPRINT-003: every API operation maps to >= 1 RBAC permission.
  const resources = bp.api?.resources ?? [];
  const permissions = bp.auth?.rbac?.permissions ?? [];
  const grantsByAction = new Map<string, number>(); // action → count of roles granting
  let hasWildcard = false;
  let hasManage = false;
  for (const perm of permissions) {
    for (const allow of perm.allow) {
      if (allow === '*') hasWildcard = true;
      if (allow === 'manage') hasManage = true;
      grantsByAction.set(allow, (grantsByAction.get(allow) ?? 0) + 1);
    }
  }
  resources.forEach((resource, rIdx) => {
    const ops = resource.operations ?? [];
    ops.forEach((op, oIdx) => {
      const grantedDirectly = (grantsByAction.get(op) ?? 0) > 0;
      if (!grantedDirectly && !hasManage && !hasWildcard) {
        violations.push({
          invariant_id: 'INV-BLUEPRINT-003',
          severity: 'gate',
          pointer: `/api/resources/${String(rIdx)}/operations/${String(oIdx)}`,
          message: `operation '${op}' on resource '${resource.entity}' is declared but no rbac.permission grants it (need direct grant, 'manage' alias, or '*' wildcard)`,
        });
      }
    });
  });

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------
// Canonical-JSON sha256 of a blueprint (for INV-SCAFFOLD-001).
// Uses the current canonical form so the trio
// blueprint_id + blueprint_version + blueprint_sha256 is reproducible.
// ---------------------------------------------------------------------

import { canonicalJson } from '@devai-nyx/utils';

export function blueprintSha256(bp: Blueprint): string {
  const canonical = canonicalJson(bp as unknown as Record<string, unknown>);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

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
    return {
      status: 'no_inventory',
      deltas,
      summary: {
        missing_entities: deltas.filter((d) => d.kind === 'missing_entity').length,
        missing_fields: 0,
        missing_routes: deltas.filter((d) => d.kind === 'missing_route').length,
        missing_permissions: 0,
      },
    };
  }

  const deltas: BlueprintDiffEntry[] = [];

  // Data-model leg.
  if (dataModel !== null) {
    const inventoryTables = extractTableNames(dataModel);
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
  }

  // API leg.
  if (apiMap !== null) {
    const inventoryEndpoints = extractEndpointPaths(apiMap);
    for (const resource of blueprint.api?.resources ?? []) {
      const basePath = blueprint.api?.basePath ?? '/api';
      const resourcePath = resource.path ?? `/${toKebabSimple(resource.entity)}s`;
      for (const op of resource.operations ?? []) {
        const wantedPath = `${basePath}${resourcePath}`;
        const present = Array.from(inventoryEndpoints).some(
          (p) => p === wantedPath || p === `${wantedPath}/:id`,
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
  }

  // RBAC leg.
  if (rbac !== null) {
    const inventoryRoles = extractRoleIds(rbac);
    for (const role of blueprint.auth?.rbac?.roles ?? []) {
      if (!inventoryRoles.has(role)) {
        deltas.push({
          kind: 'missing_permission',
          target: role,
          detail: `role ${role} declared in blueprint; not present in inventory_rbac roles`,
        });
      }
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
// Scaffold plan: deterministic preview of what scaffolders would emit.
// ---------------------------------------------------------------------

export interface ScaffoldPlanTask {
  readonly operation_id: string;
  readonly target_paths: readonly string[];
  readonly templates: readonly string[];
}

export interface ScaffoldPlanResult {
  readonly blueprint_id: string;
  readonly blueprint_version: string;
  readonly blueprint_sha256: string;
  readonly module_slug: string;
  readonly tasks: readonly ScaffoldPlanTask[];
}

/**
 * Emit a scaffold plan: per-operation target paths and template ids.
 * No file writes; pure data. The plan
 * is deterministic for a given (blueprint, version) pair — its sha
 * lines up with the scaffold-evidence's blueprint_sha256.
 */
export function planScaffoldFromBlueprint(bp: Blueprint): ScaffoldPlanResult {
  const ns = bp.module.namespace;
  const moduleKebab = toKebabSimple(bp.module.name);
  const moduleSlug = `${ns}-${moduleKebab}`;
  const tasks: ScaffoldPlanTask[] = [
    {
      operation_id: 'scaffold.db',
      target_paths: [`domain/${moduleSlug}/db/migration.sql`, `domain/${moduleSlug}/db/seed.sql`],
      templates: ['db.migration', 'db.seed'],
    },
    {
      operation_id: 'scaffold.api',
      target_paths: [
        `domain/${moduleSlug}/api/src/${moduleSlug}/${moduleSlug}.module.ts`,
        ...bp.database.entities.flatMap((e) => [
          `domain/${moduleSlug}/api/src/${moduleSlug}/controllers/${toKebabSimple(e.name)}.controller.ts`,
          `domain/${moduleSlug}/api/src/${moduleSlug}/services/${toKebabSimple(e.name)}.service.ts`,
          `domain/${moduleSlug}/api/src/${moduleSlug}/dto/create-${toKebabSimple(e.name)}.dto.ts`,
          `domain/${moduleSlug}/api/src/${moduleSlug}/dto/update-${toKebabSimple(e.name)}.dto.ts`,
        ]),
      ],
      templates: [
        'api.module',
        'api.controller',
        'api.service',
        'api.dto.create',
        'api.dto.update',
      ],
    },
    {
      operation_id: 'scaffold.ui',
      target_paths: [
        `domain/${moduleSlug}/web/src/app/${moduleSlug}/${moduleSlug}.module.ts`,
        ...bp.database.entities.flatMap((e) => [
          `domain/${moduleSlug}/web/src/app/${moduleSlug}/${toKebabSimple(e.name)}-list.component.ts`,
          `domain/${moduleSlug}/web/src/app/${moduleSlug}/${toKebabSimple(e.name)}-detail.component.ts`,
          `domain/${moduleSlug}/web/src/app/${moduleSlug}/${toKebabSimple(e.name)}.service.ts`,
        ]),
      ],
      templates: ['ui.module', 'ui.list-component', 'ui.detail-component', 'ui.service'],
    },
    {
      operation_id: 'scaffold.tests',
      target_paths: bp.database.entities.flatMap((e) => [
        `domain/${moduleSlug}/api/test/${toKebabSimple(e.name)}.controller.spec.ts`,
        `domain/${moduleSlug}/api/test/${toKebabSimple(e.name)}.service.spec.ts`,
      ]),
      templates: ['tests.controller-spec', 'tests.service-spec'],
    },
    {
      operation_id: 'scaffold.docs',
      target_paths: [
        `domain/${moduleSlug}/docs/README.md`,
        `domain/${moduleSlug}/docs/ADR-0001.md`,
      ],
      templates: ['docs.readme', 'docs.adr'],
    },
    {
      operation_id: 'scaffold.ci',
      target_paths: [`.github/workflows/module-${moduleSlug}.yml`],
      templates: ['ci.workflow'],
    },
  ];
  return {
    blueprint_id: bp.id,
    blueprint_version: bp.module.version,
    blueprint_sha256: blueprintSha256(bp),
    module_slug: moduleSlug,
    tasks,
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

function extractEndpointPaths(apiMap: unknown): Set<string> {
  const out = new Set<string>();
  const am = apiMap as { endpoints?: ReadonlyArray<{ path?: string }> };
  for (const e of am.endpoints ?? []) {
    if (typeof e.path === 'string') out.add(e.path);
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

function toKebabSimple(input: string): string {
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
