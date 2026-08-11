import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { buildSensorReading, type SensorReading, type SensorStatus } from './sensor-reading.js';
import type { DataModelBody, DataModelTable } from './inventory-data-model.js';

/**
 * Inventory sensor: RBAC bindings (REDOX-RBAC, Phase 17.C3).
 *
 * Consumes a data-model body (record/proofs/sensors/inventory_data_model/
 * data-model.json by default) and infers an RBAC inventory by:
 *   1. Name-pattern matching against known RBAC table shapes:
 *      roles, permissions, role_has_permissions, user_roles,
 *      model_has_permissions, role_permissions, etc. (Brazilian
 *      shop's filament/spatie pattern lives here too.)
 *   2. Foreign-key topology: a "*_has_*" or "*_to_*" join table whose
 *      FKs reference both a role-like table and a permission-like
 *      table is an RBAC binding table.
 *
 * Empty data model (no tables) surfaces status=review. Empty RBAC
 * (data model has tables but no RBAC-shaped ones) also surfaces
 * status=review — adopters with non-RBAC auth (token-only, ACL-based)
 * are legitimately RBAC-free.
 *
 * Output conforms to rbac-inventory.schema.json (Phase 17.B). Real
 * role-permission binding discovery (which guard maps to which
 * permission) requires controller-decorator parsing and lands in a
 * later sub-batch or via inventory_data_handling extensions; 17.C3
 * ships the skeleton with empty bindings + populated rbacIlfTables.
 *
 * Per Constitution Article 17 (sensor adapter uniformity); per D-57.
 */

const ROLE_LIKE_NAMES = new Set(['roles', 'role', 'app_roles', 'user_roles', 'rbac_roles']);

const PERMISSION_LIKE_NAMES = new Set([
  'permissions',
  'permission',
  'abilities',
  'ability',
  'rbac_permissions',
]);

const RBAC_JOIN_PATTERNS = [
  /^role_has_permissions?$/i,
  /^user_has_roles?$/i,
  /^role_permissions?$/i,
  /^user_roles?$/i,
  /^model_has_permissions?$/i,
  /^model_has_roles?$/i,
  /^assignments$/i,
];

export interface InventoryRbacOptions {
  readonly repoRoot: string;
  readonly dataModelPath?: string;
  /**
   * Optional path to the inventory_api body. When supplied (and the
   * body exists), the sensor synthesizes endpointBindings from
   * `endpoints[].auth.guards` and `endpoints[].auth.roles`. Each
   * unique guard / role becomes a synthetic permission id of the
   * form `guard:<Name>` or `role:<Name>`; each endpoint with any
   * guards/roles gets an EndpointBinding entry. Closes the
   * "endpointBindings always empty" gap from Phase 17.C3.
   */
  readonly apiMapPath?: string;
  readonly bodyPath?: string;
  /** False for pure observation callers that must not materialize canonical state. */
  readonly persistBody?: boolean;
  readonly now?: string;
}

export interface InventoryRbacResult {
  readonly reading: SensorReading;
  readonly body: unknown;
  readonly bodyPath: string | null;
}

function isRoleTable(t: DataModelTable): boolean {
  if (ROLE_LIKE_NAMES.has(t.name.toLowerCase())) return true;
  // Heuristic: table with a `name` column and explicit `slug` or `key`,
  // and no fk to a non-rbac table.
  const cols = new Set(t.columns.map((c) => c.name.toLowerCase()));
  return (
    cols.has('name') &&
    (cols.has('slug') || cols.has('key')) &&
    t.name.toLowerCase().includes('role')
  );
}

function isPermissionTable(t: DataModelTable): boolean {
  if (PERMISSION_LIKE_NAMES.has(t.name.toLowerCase())) return true;
  const cols = new Set(t.columns.map((c) => c.name.toLowerCase()));
  return cols.has('name') && t.name.toLowerCase().includes('permission');
}

function isRbacJoinTable(
  t: DataModelTable,
  roleNames: ReadonlySet<string>,
  permNames: ReadonlySet<string>,
): boolean {
  if (RBAC_JOIN_PATTERNS.some((re) => re.test(t.name))) return true;
  // Heuristic: a table whose FKs reference both a role-like and a permission-like table.
  const fkTargets = (t.foreign_keys ?? []).map((fk) => fk.references_table.toLowerCase());
  const hasRoleFk = fkTargets.some((t) => roleNames.has(t));
  const hasPermFk = fkTargets.some((t) => permNames.has(t));
  return hasRoleFk && hasPermFk;
}

interface ApiMapEndpoint {
  readonly id?: string;
  readonly method: string;
  readonly path: string;
  readonly auth?: {
    readonly required?: boolean;
    readonly guards?: readonly string[];
    readonly roles?: readonly string[];
  };
}

interface ApiMapBodyShape {
  readonly endpoints?: readonly ApiMapEndpoint[];
}

function endpointIdOf(e: ApiMapEndpoint): string {
  return e.id ?? `${e.method} ${e.path}`;
}

export function senseInventoryRbac(opts: InventoryRbacOptions): InventoryRbacResult {
  const t0 = Date.now();
  const generatedAt = opts.now ?? new Date().toISOString();
  const dataModelPath =
    opts.dataModelPath ??
    join(opts.repoRoot, 'record/proofs/sensors/inventory_data_model/data-model.json');
  const apiMapPath =
    opts.apiMapPath ?? join(opts.repoRoot, 'record/proofs/sensors/inventory_api/api-map.json');

  const findings: Array<{
    readonly severity: 'info' | 'warning' | 'error' | 'critical';
    readonly code: string;
    readonly message: string;
  }> = [];

  let dataModel: DataModelBody | null = null;
  let apiMap: ApiMapBodyShape | null = null;
  let status: SensorStatus = 'pass';

  if (!existsSync(dataModelPath)) {
    // R18.C.7 (D-133; INV-DEVAI-012): a required input being absent means
    // nothing was measured — status 'unknown', not 'review'. The prior
    // 'review' (exit 1) made this sensor unusable in CI on fresh checkouts
    // (the data-model body is gitignored state), which is why R17 had to
    // drop it from the gate-invariant verb smoke.
    status = 'unknown';
    findings.push({
      severity: 'info',
      code: 'RBAC_REQUIRES_DATA_MODEL',
      message: `Data-model body not found at ${dataModelPath}. Run 'devai sense run inventory_data_model' first; nothing measured.`,
    });
  } else {
    try {
      dataModel = JSON.parse(readFileSync(dataModelPath, 'utf8')) as DataModelBody;
    } catch (err) {
      status = 'error';
      findings.push({
        severity: 'critical',
        code: 'RBAC_DATA_MODEL_INVALID',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Load api-map body opportunistically. Absence is informational
  // (status stays at whatever data-model state implied) — adopters
  // may run sense rbac before sense api.
  if (existsSync(apiMapPath)) {
    try {
      apiMap = JSON.parse(readFileSync(apiMapPath, 'utf8')) as ApiMapBodyShape;
    } catch (err) {
      findings.push({
        severity: 'warning',
        code: 'RBAC_API_MAP_INVALID',
        message: `api-map at ${apiMapPath} failed to parse: ${err instanceof Error ? err.message : String(err)}. endpointBindings will be empty.`,
      });
    }
  }

  const roleTables: DataModelTable[] = [];
  const permTables: DataModelTable[] = [];
  const joinTables: DataModelTable[] = [];
  if (dataModel !== null) {
    for (const t of dataModel.tables) {
      if (isRoleTable(t)) roleTables.push(t);
      else if (isPermissionTable(t)) permTables.push(t);
    }
    const roleNames = new Set(roleTables.map((t) => t.name.toLowerCase()));
    const permNames = new Set(permTables.map((t) => t.name.toLowerCase()));
    for (const t of dataModel.tables) {
      if (roleNames.has(t.name.toLowerCase()) || permNames.has(t.name.toLowerCase())) continue;
      if (isRbacJoinTable(t, roleNames, permNames)) joinTables.push(t);
    }
  }

  const rbacIlfTables = [
    ...roleTables.map((t) => t.name),
    ...permTables.map((t) => t.name),
    ...joinTables.map((t) => t.name),
  ];

  // Synthesize endpointBindings + extra roles/permissions from api-map
  // controller-decorator info (Phase 17.C3 gap-close). The api-map's
  // `auth.guards[]` and `auth.roles[]` are populated by the NestJS
  // adapter from @UseGuards / @Roles decorators.
  const guardPermissionIds = new Set<string>();
  const rolePermissionIds = new Set<string>();
  const endpointsWithoutRole: string[] = [];
  const endpointBindings: Array<{
    permissionId: string;
    endpointId: string;
    methods?: string[];
  }> = [];
  if (apiMap?.endpoints !== undefined) {
    for (const ep of apiMap.endpoints) {
      const epId = endpointIdOf(ep);
      const guards = ep.auth?.guards ?? [];
      const roles = ep.auth?.roles ?? [];
      // Phase 22.B (closes D-A-12): an endpoint carrying an
      // explicit `auth.required === false` is deliberately public
      // (the controller method/class has a pack-configured
      // public-marker decorator like `@Public()`). Treat as
      // claimed; do not surface in endpointsWithoutRole.
      // INV-INVENTORY-003 reads this exact field as the "claimed
      // public" case.
      const explicitlyPublic = ep.auth?.required === false;
      if (explicitlyPublic) continue;
      if (guards.length === 0 && roles.length === 0) {
        // Endpoint has no auth declarations — surface in unmapped for
        // INV-INVENTORY-003 to gate against.
        endpointsWithoutRole.push(epId);
        continue;
      }
      for (const g of guards) {
        const permId = `guard:${g}`;
        guardPermissionIds.add(permId);
        endpointBindings.push({
          permissionId: permId,
          endpointId: epId,
          methods: [ep.method],
        });
      }
      for (const r of roles) {
        const permId = `role:${r}`;
        rolePermissionIds.add(permId);
        endpointBindings.push({
          permissionId: permId,
          endpointId: epId,
          methods: [ep.method],
        });
      }
    }
  }

  // Schema requires roles.minItems >= 1 and permissions.minItems >= 1.
  // If we have zero of either AND we found no controller-decorator
  // signals to fall back on, surface status=review.
  const haveControllerSignals = guardPermissionIds.size + rolePermissionIds.size > 0;
  if (
    status === 'pass' &&
    roleTables.length === 0 &&
    permTables.length === 0 &&
    !haveControllerSignals
  ) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'RBAC_INVENTORY_EMPTY',
      message: `No RBAC-shaped tables detected (roles=${String(roleTables.length)}, permissions=${String(permTables.length)}) and no @UseGuards/@Roles in api-map. Adopter may use non-RBAC auth or a non-standard naming convention.`,
    });
  }

  // Compose the full role list: data-model role tables + synthetic
  // `role:<Name>` entries from @Roles decorators.
  const roleEntries: Array<{ id: string; name?: string; evidence?: readonly unknown[] }> = [
    ...roleTables.map((t) => ({
      id: t.name,
      name: t.name,
      ...(t.evidence !== undefined && { evidence: t.evidence }),
    })),
    ...[...rolePermissionIds].map((id) => ({ id, name: id })),
  ];
  if (roleEntries.length === 0) {
    // Schema requires minItems 1 on roles[]; surface the empty state
    // with a placeholder so the body still parses for human inspection.
    roleEntries.push({ id: '__placeholder', name: '__placeholder', evidence: [] });
  }

  // Compose the full permission list: data-model permission tables +
  // synthetic `guard:<Name>` + `role:<Name>` entries.
  const permissionEntries: Array<{ id: string; name?: string; evidence?: readonly unknown[] }> = [
    ...permTables.map((t) => ({
      id: t.name,
      name: t.name,
      ...(t.evidence !== undefined && { evidence: t.evidence }),
    })),
    ...[...guardPermissionIds].map((id) => ({ id, name: id })),
    ...[...rolePermissionIds].map((id) => ({ id, name: id })),
  ];
  if (permissionEntries.length === 0) {
    permissionEntries.push({ id: '__placeholder', name: '__placeholder' });
  }

  const body = {
    schemaVersion: '1.0.0' as const,
    generatedAt,
    ...(opts.repoRoot !== undefined && { sourceRepo: opts.repoRoot }),
    rbacIlfTables,
    roles: roleEntries,
    permissions: permissionEntries,
    bindings: {
      endpointBindings,
      routeBindings: [] as Array<{ permissionId: string; routeId: string }>,
      entityBindings: [] as Array<{ permissionId: string; entity: string }>,
    },
    unmapped: {
      rolesWithoutPermissions: roleTables.map((t) => t.name),
      permissionsWithoutBindings: permTables.map((t) => t.name),
      endpointsWithoutRole,
      routesWithoutRole: [] as string[],
    },
    stats: {
      roleCount: roleTables.length,
      permissionCount: permTables.length,
      endpointBindingCount: endpointBindings.length,
      routeBindingCount: 0,
      entityBindingCount: 0,
    },
  };

  if (status === 'pass') {
    const ok = validators.rbacInventory(body);
    if (!ok) {
      status = 'error';
      findings.push({
        severity: 'critical',
        code: 'RBAC_SCHEMA_INVALID',
        message: `body fails rbac-inventory.schema.json: ${JSON.stringify(validators.rbacInventory.errors)}`,
      });
    }
  }

  let bodyPath: string | null = null;
  if ((status === 'pass' || status === 'review') && opts.persistBody !== false) {
    bodyPath =
      opts.bodyPath ?? join(opts.repoRoot, 'record/proofs/sensors/inventory_rbac/rbac.json');
    try {
      mkdirSync(dirname(bodyPath), { recursive: true });
      writeFileSync(bodyPath, JSON.stringify(body, null, 2) + '\n');
    } catch (err) {
      status = 'error';
      bodyPath = null;
      findings.push({
        severity: 'critical',
        code: 'RBAC_WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const rbacHash = createHash('sha256').update(JSON.stringify(rbacIlfTables)).digest('hex');

  const reading = buildSensorReading({
    sensorName: 'inventory:rbac',
    sensorKind: 'inventory_rbac',
    sensorVersion: '1.0.0',
    command: ['devai', 'sense', 'rbac', '--repo-root', opts.repoRoot],
    status,
    deterministic: true,
    tier: 'L0',
    duration_ms: Date.now() - t0,
    timestamp: generatedAt,
    ...(findings.length > 0 && { findings }),
    metrics: {
      role_table_count: roleTables.length,
      permission_table_count: permTables.length,
      join_table_count: joinTables.length,
      endpoint_binding_count: endpointBindings.length,
      endpoints_without_role_count: endpointsWithoutRole.length,
      synthetic_guard_permission_count: guardPermissionIds.size,
      synthetic_role_permission_count: rolePermissionIds.size,
      rbac_hash: rbacHash,
    },
    ...(bodyPath !== null && { evidence_path: bodyPath }),
  });

  return { reading, body, bodyPath };
}
