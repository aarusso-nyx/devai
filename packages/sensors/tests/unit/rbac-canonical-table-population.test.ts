import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryRbac } from '../../src/inventory-rbac.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-rbac-canonical-tables-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeModel(): string {
  const path = join(root, 'record/proofs/sensors/inventory_data_model/data-model.json');
  const roleNames = ['roles', 'role', 'app_roles', 'user_roles', 'rbac_roles'];
  const permissionNames = ['permissions', 'permission', 'abilities', 'ability', 'rbac_permissions'];
  const joinNames = [
    'role_has_permission',
    'role_has_permissions',
    'user_has_role',
    'user_has_roles',
  ];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: '1.0.0',
      generatedAt: NOW,
      dialect: 'postgres',
      tables: [...roleNames, ...permissionNames, ...joinNames].map((name) => ({
        name,
        columns: [{ name: 'id', type: 'bigint' }],
        evidence: [{ path: `db/migrations/${name}.sql`, startLine: 1, endLine: 2 }],
      })),
    }),
  );
  return path;
}

describe('RBAC canonical table population', () => {
  it('populates canonical role, permission, and singular/plural join table names', () => {
    const dataModelPath = writeModel();
    const result = senseInventoryRbac({
      repoRoot: root,
      dataModelPath,
      persistBody: false,
      now: NOW,
    });
    const body = result.body as {
      rbacIlfTables: string[];
      roles: Array<{ id: string; name?: string }>;
      permissions: Array<{ id: string; name?: string }>;
      bindings: { endpointBindings: unknown[] };
      unmapped: { rolesWithoutPermissions: string[]; permissionsWithoutBindings: string[] };
    };

    expect(result.reading.status).toBe('pass');
    expect(body.rbacIlfTables).toEqual([
      'roles',
      'role',
      'app_roles',
      'user_roles',
      'rbac_roles',
      'permissions',
      'permission',
      'abilities',
      'ability',
      'rbac_permissions',
      'role_has_permission',
      'role_has_permissions',
      'user_has_role',
      'user_has_roles',
    ]);
    expect(body.roles.map((entry) => entry.id)).toEqual([
      'roles',
      'role',
      'app_roles',
      'user_roles',
      'rbac_roles',
    ]);
    expect(body.permissions.map((entry) => entry.id)).toEqual([
      'permissions',
      'permission',
      'abilities',
      'ability',
      'rbac_permissions',
    ]);
    expect(body.bindings.endpointBindings).toEqual([]);
    expect(body.unmapped.rolesWithoutPermissions).toEqual([
      'roles',
      'role',
      'app_roles',
      'user_roles',
      'rbac_roles',
    ]);
    expect(body.unmapped.permissionsWithoutBindings).toEqual([
      'permissions',
      'permission',
      'abilities',
      'ability',
      'rbac_permissions',
    ]);
    expect(result.reading.metrics).toMatchObject({
      role_table_count: 5,
      permission_table_count: 5,
      join_table_count: 4,
      endpoint_binding_count: 0,
    });
  });
});
