import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryRbac } from '../../src/inventory-rbac.js';

const NOW = '2026-09-09T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-rbac-assignment-boundary-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeModel(): string {
  const path = join(root, 'record/proofs/sensors/inventory_data_model/data-model.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      generatedAt: NOW,
      dialect: 'postgres',
      tables: [
        'roles',
        'permissions',
        'assignments',
        'assignments_backup',
        'archived_assignments',
        'assignment_log',
      ].map((name) => ({
        name,
        columns: [{ name: 'id', type: 'bigint' }],
        evidence: [{ path: `db/migrations/${name}.sql`, startLine: 1, endLine: 2 }],
      })),
    })}\n`,
  );
  return path;
}

describe('RBAC assignment table naming boundary', () => {
  it('recognizes the exact assignments join name without admitting prefixed or suffixed variants', () => {
    const result = senseInventoryRbac({
      repoRoot: root,
      dataModelPath: writeModel(),
      persistBody: false,
      now: NOW,
    });
    const body = result.body as {
      rbacIlfTables: string[];
      roles: Array<{ id: string }>;
      permissions: Array<{ id: string }>;
    };

    expect(result.reading.status).toBe('pass');
    expect(body.rbacIlfTables).toEqual(['roles', 'permissions', 'assignments']);
    expect(body.roles.map(({ id }) => id)).toEqual(['roles']);
    expect(body.permissions.map(({ id }) => id)).toEqual(['permissions']);
    expect(result.reading.metrics).toMatchObject({
      role_table_count: 1,
      permission_table_count: 1,
      join_table_count: 1,
    });
  });
});

function writeRoleJoinModel(): string {
  const path = join(root, 'record/proofs/sensors/inventory_data_model/data-model.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      generatedAt: NOW,
      dialect: 'postgres',
      tables: [
        'roles',
        'permissions',
        'user_has_role',
        'user_has_roles',
        'user_has_roles_archive',
        'model_has_role',
        'model_has_roles',
        'model_has_roles_archive',
        'xuser_has_role',
      ].map((name) => ({
        name,
        columns: [{ name: 'id', type: 'bigint' }],
        evidence: [{ path: `db/migrations/${name}.sql`, startLine: 1, endLine: 2 }],
      })),
    })}\n`,
  );
  return path;
}

describe('RBAC role join singular and plural boundaries', () => {
  it('recognizes supported user/model role joins while excluding prefixed and suffixed lookalikes', () => {
    const result = senseInventoryRbac({
      repoRoot: root,
      dataModelPath: writeRoleJoinModel(),
      persistBody: false,
      now: NOW,
    });
    const body = result.body as { rbacIlfTables: string[] };

    expect(result.reading.status).toBe('pass');
    expect(body.rbacIlfTables).toEqual([
      'roles',
      'permissions',
      'user_has_role',
      'user_has_roles',
      'model_has_role',
      'model_has_roles',
    ]);
    expect(result.reading.metrics).toMatchObject({
      role_table_count: 1,
      permission_table_count: 1,
      join_table_count: 4,
    });
  });
});
