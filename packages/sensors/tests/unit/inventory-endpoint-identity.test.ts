// Invariants: INV-INVENTORY-001, INV-DEVAI-001; Constitution Articles 17 and 39.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryApi } from '../../src/inventory-api.js';
import { senseInventoryCoverage } from '../../src/inventory-coverage.js';
import { qualifiedEndpointId } from '../../src/inventory-endpoint-identity.js';
import { senseInventoryRbac } from '../../src/inventory-rbac.js';

let root: string;
const NOW = '2026-10-10T12:00:00.000Z';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-endpoint ação '));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function put(path: string, body: unknown) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body));
}
function endpoint(file: string, name: string) {
  return {
    method: 'POST',
    path: '/offline-sync/sync-batches',
    controller: { file, class: name, methodName: 'sync', startLine: 3, endLine: 7 },
    evidence: [{ path: file, startLine: 3, endLine: 7 }],
    auth: { required: true, guards: ['SessionGuard'], roles: ['operator'] },
  };
}
function inputs(endpoints: unknown[], refs: string[], routeIds: string[] = []) {
  put('record/proofs/sensors/inventory_api/api-map.json', { endpoints });
  put('record/proofs/sensors/inventory_routes/routes-react.json', {
    framework: 'react',
    routes: routeIds.map((id) => ({ id, path: '/sync' })),
  });
  put('product/use-cases/sync.json', {
    schemaVersion: '1.0.0',
    roles: ['operator'],
    cases: [
      {
        id: 'UC-sync',
        title: 'Synchronize',
        mainFlow: [{ action: 'sync', refs: { endpointIds: refs, routeIds } }],
      },
    ],
  });
}
function coverage() {
  return senseInventoryCoverage({
    repoRoot: root,
    framework: 'react',
    persistBody: false,
    now: NOW,
  });
}

describe('source-qualified API endpoint identity', () => {
  it('round trips the complete tuple and normalizes path separators, evidence order and object keys', () => {
    const first = {
      ...endpoint('src\\ação.controller.ts', 'A'),
      evidence: [
        { path: 'src\\z.ts', startLine: 9, endLine: 10 },
        { path: 'src\\a.ts', startLine: 1, endLine: 2 },
      ],
    };
    const second = {
      ...first,
      controller: {
        endLine: 7,
        startLine: 3,
        methodName: 'sync',
        class: 'A',
        file: 'src/ação.controller.ts',
      },
      evidence: [...first.evidence].reverse().map((e) => ({
        endLine: e.endLine,
        startLine: e.startLine,
        path: e.path.replaceAll('\\', '/'),
      })),
    };
    const id = qualifiedEndpointId(first);
    expect(id).toBe(qualifiedEndpointId(second));
    expect(id).toMatch(/^api:v1:/u);
    expect(JSON.parse(decodeURIComponent(id.slice('api:v1:'.length)))).toEqual([
      'POST',
      '/offline-sync/sync-batches',
      second.controller,
      [
        { path: 'src/z.ts', startLine: 9, endLine: 10 },
        { path: 'src/a.ts', startLine: 1, endLine: 2 },
      ],
    ]);
    expect(
      qualifiedEndpointId({ ...second, controller: { ...second.controller, class: 'B' } }),
    ).not.toBe(id);
    expect(
      qualifiedEndpointId({
        ...second,
        evidence: [{ path: 'src/a.ts', startLine: 2, endLine: 3 }],
      }),
    ).not.toBe(id);
  });

  it('retains same-path methods from alternative controllers, including two classes in one file', () => {
    put(
      'src/alternatives.controller.ts',
      `import { Controller, Post } from '@nestjs/common';
@Controller('offline-sync')
class Baseline { @Post('sync-batches') sync() {} }
@Controller('offline-sync')
class Alternate { @Post('sync-batches') sync() {} }
`,
    );
    const result = senseInventoryApi({ repoRoot: root, persistBody: false, now: NOW });
    const endpoints = result.body.endpoints;
    expect(result.reading.status).toBe('pass');
    expect(endpoints).toHaveLength(2);
    expect(new Set(endpoints.map((e) => e.id)).size).toBe(2);
    expect(endpoints.map((e) => e.controller.class).sort()).toEqual(['Alternate', 'Baseline']);
    for (const entry of endpoints) expect(entry.id).toBe(qualifiedEndpointId(entry));
  });

  it('binds a unique legacy METHOD path reference to its qualified source endpoint', () => {
    const a = endpoint('src/a.ts', 'A');
    inputs([a], ['POST /offline-sync/sync-batches']);
    const result = coverage();
    expect(result.reading.status).toBe('pass');
    expect(result.body).toMatchObject({
      endpoints: [qualifiedEndpointId(a)],
      unmapped: { endpoints: [] },
      links: [{ endpointId: qualifiedEndpointId(a), routeId: null, linkKind: 'endpoint-only' }],
    });
  });

  it('credits no endpoint for an ambiguous legacy reference, including when a route is present', () => {
    const a = endpoint('src/a.ts', 'A');
    const b = endpoint('src/b.ts', 'B');
    inputs([a, b], ['POST /offline-sync/sync-batches'], ['route-sync']);
    const result = coverage();
    expect(result.reading.status).toBe('review');
    expect(result.reading.findings?.map((f) => f.code)).toContain('AMBIGUOUS_ENDPOINT_REFERENCE');
    expect(result.body).toMatchObject({
      endpoints: [qualifiedEndpointId(a), qualifiedEndpointId(b)],
      unmapped: { endpoints: [qualifiedEndpointId(a), qualifiedEndpointId(b)] },
    });
    expect(
      (result.body as { links: Array<{ endpointId: unknown }> }).links.every(
        (link) => link.endpointId === null,
      ),
    ).toBe(true);
  });

  it('credits exact qualified references separately and shares those IDs with RBAC', () => {
    const entries = [endpoint('src/a.ts', 'A'), endpoint('src/b.ts', 'B')];
    const ids = entries.map(qualifiedEndpointId);
    inputs(entries, ids);
    const result = coverage();
    expect(result.reading.status).toBe('pass');
    expect(result.body).toMatchObject({ endpoints: ids, unmapped: { endpoints: [] } });
    expect(
      (result.body as { links: Array<{ endpointId: string }> }).links.map((l) => l.endpointId),
    ).toEqual(ids);
    put('record/proofs/sensors/inventory_data_model/data-model.json', {
      tables: [{ name: 'roles', columns: [{ name: 'name', type: 'text' }] }],
    });
    const rbac = senseInventoryRbac({ repoRoot: root, persistBody: false, now: NOW });
    expect(rbac.reading.status).toBe('pass');
    const bindings = (
      rbac.body as {
        bindings: { endpointBindings: Array<{ endpointId: string; permissionId: string }> };
      }
    ).bindings.endpointBindings;
    expect(bindings).toHaveLength(4);
    expect(new Set(bindings.map((binding) => binding.endpointId))).toEqual(new Set(ids));
    for (const id of ids)
      expect(
        bindings
          .filter((binding) => binding.endpointId === id)
          .map((binding) => binding.permissionId)
          .sort(),
      ).toEqual(['guard:SessionGuard', 'role:operator']);
  });

  it('leaves a stale qualified reference unresolved after source evidence moves', () => {
    const previous = endpoint('src/a.ts', 'A');
    const current = {
      ...previous,
      controller: { ...previous.controller, startLine: 4, endLine: 8 },
      evidence: [{ path: 'src/a.ts', startLine: 4, endLine: 8 }],
    };
    inputs([current], [qualifiedEndpointId(previous)]);
    const result = coverage();
    expect(result.reading.status).toBe('review');
    expect(result.body).toMatchObject({
      endpoints: [qualifiedEndpointId(current)],
      links: [],
      unmapped: { endpoints: [qualifiedEndpointId(current)] },
    });
    expect(qualifiedEndpointId(current)).not.toBe(qualifiedEndpointId(previous));
  });

  it('keeps conditional guard authorization protected and unresolved without inventing static roles', () => {
    put(
      'src/conditional.controller.ts',
      `import { Controller, Post, Roles, UseGuards } from '@nestjs/common';
class PermissionGuard { canActivate(context) { return context.user?.can('sync'); } }
@Controller('offline-sync')
@UseGuards(PermissionGuard)
class Conditional { @Post('sync-batches') @Roles(isOwner ? 'admin' : 'operator') sync() {} }
`,
    );
    const api = senseInventoryApi({ repoRoot: root, persistBody: false, now: NOW });
    const entries = api.body.endpoints;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.auth).toMatchObject({
      required: true,
      guards: ['PermissionGuard'],
    });
    expect(entries[0]?.auth?.roles ?? []).toEqual([]);
    put('record/proofs/sensors/inventory_api/api-map.json', api.body);
    put('record/proofs/sensors/inventory_data_model/data-model.json', {
      tables: [{ name: 'roles', columns: [{ name: 'name', type: 'text' }] }],
    });
    const rbac = senseInventoryRbac({ repoRoot: root, persistBody: false, now: NOW });
    expect(rbac.reading.status).toBe('review');
    expect(rbac.reading.findings?.map((finding) => finding.code)).toContain(
      'RBAC_AUTHORIZATION_UNRESOLVED',
    );
    const bindings = (
      rbac.body as {
        bindings: { endpointBindings: Array<{ endpointId: string; permissionId: string }> };
      }
    ).bindings.endpointBindings;
    const observed = entries[0];
    if (observed === undefined) throw new Error('Conditional endpoint observation missing');
    expect(bindings).toEqual([
      {
        endpointId: qualifiedEndpointId(observed),
        permissionId: 'guard:PermissionGuard',
        methods: ['POST'],
      },
    ]);
    expect(bindings.some((binding) => binding.permissionId.startsWith('role:'))).toBe(false);
  });

  it('keeps conditional guard declarations protected without inventing which guard applies', () => {
    put(
      'src/conditional-guard.controller.ts',
      `import { Controller, Post, UseGuards } from '@nestjs/common';
@Controller('offline-sync')
@UseGuards(isInternal ? SessionGuard : PermissionGuard)
class ConditionalGuard { @Post('sync-batches') sync() {} }
`,
    );
    const api = senseInventoryApi({ repoRoot: root, persistBody: false, now: NOW });
    const entries = api.body.endpoints;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.auth?.required).toBe(true);
    expect(entries[0]?.auth?.guards ?? []).toEqual([]);
    expect(entries[0]?.auth?.roles ?? []).toEqual([]);
    put('record/proofs/sensors/inventory_api/api-map.json', api.body);
    put('record/proofs/sensors/inventory_data_model/data-model.json', {
      tables: [{ name: 'roles', columns: [{ name: 'name', type: 'text' }] }],
    });
    const rbac = senseInventoryRbac({ repoRoot: root, persistBody: false, now: NOW });
    expect(rbac.reading.status).toBe('review');
    expect(rbac.reading.findings?.map((finding) => finding.code)).toContain(
      'RBAC_AUTHORIZATION_UNRESOLVED',
    );
    expect(
      (rbac.body as { bindings: { endpointBindings: unknown[] } }).bindings.endpointBindings,
    ).toEqual([]);
  });

  it('retains globally unique explicit IDs without legacy ambiguity credit', () => {
    const entries = [
      { ...endpoint('src/a.ts', 'A'), id: 'baseline' },
      { ...endpoint('src/b.ts', 'B'), id: 'alternate' },
    ];
    inputs(entries, ['baseline', 'alternate']);
    const result = coverage();
    expect(result.reading.status).toBe('pass');
    expect(result.body).toMatchObject({
      endpoints: ['baseline', 'alternate'],
      unmapped: { endpoints: [] },
    });
  });

  it('refuses conflicting explicit identities without publishing a coverage or RBAC body', () => {
    inputs(
      [
        { ...endpoint('src/a.ts', 'A'), id: 'collision' },
        { ...endpoint('src/b.ts', 'B'), id: 'collision' },
      ],
      ['collision'],
    );
    const result = coverage();
    expect(result.reading.status).toBe('error');
    expect(result.reading.findings?.map((f) => f.code)).toContain('ENDPOINT_IDENTITY_COLLISION');
    expect(result.bodyPath).toBeNull();
    put('record/proofs/sensors/inventory_data_model/data-model.json', {
      tables: [{ name: 'roles', columns: [{ name: 'name', type: 'text' }] }],
    });
    const rbac = senseInventoryRbac({ repoRoot: root, persistBody: false, now: NOW });
    expect(rbac.reading.status).toBe('error');
    expect(rbac.reading.findings?.map((f) => f.code)).toContain('ENDPOINT_IDENTITY_COLLISION');
    expect(rbac.bodyPath).toBeNull();
  });
});
