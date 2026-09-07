import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blueprintSha256,
  diffBlueprintAgainstInventory,
  loadBlueprint,
  planScaffoldFromBlueprint,
  validateBlueprint,
  type Blueprint,
} from '../../src/blueprint/index.js';
import { gcStaleInvariantCandidates, suggestInvariants } from '../../src/inv-suggest/index.js';

const roots: string[] = [];
const NOW = '2026-07-24T00:00:00.000Z';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-spec-coverage-'));
  roots.push(path);
  return path;
}

function write(repo: string, rel: string, value: unknown): string {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

const blueprint: Blueprint = {
  schemaVersion: '1.0.0',
  id: 'BP-ORDERS-001',
  module: {
    name: 'OrderFlow',
    namespace: 'sales',
    version: '1.2.3',
    owners: ['commerce'],
  },
  database: {
    entities: [
      {
        name: 'OrderItem',
        table: 'orders',
        primaryKey: ['id'],
        fields: [
          { name: 'id', type: 'uuid' },
          { name: 'email', type: 'text', pii: 'high', retention: '1y' },
        ],
      },
      {
        name: 'AuditLog',
        fields: [{ name: 'id', type: 'uuid' }],
      },
    ],
  },
  api: {
    basePath: '/api',
    resources: [
      { entity: 'OrderItem', path: '/orders', operations: ['list', 'get', 'create'] },
      { entity: 'AuditLog', operations: ['get'] },
    ],
  },
  auth: {
    rbac: {
      roles: ['reader', 'writer'],
      permissions: [
        { role: 'reader', allow: ['list', 'get'] },
        { role: 'writer', allow: ['create'] },
      ],
    },
  },
};

describe('blueprint behavior', () => {
  it('loads, validates, hashes, and plans a complete blueprint deterministically', () => {
    const repo = root();
    const path = write(repo, 'blueprint.json', blueprint);
    const loaded = loadBlueprint(path);
    expect(loaded).toMatchObject({ ok: true, errors: [] });
    expect(validateBlueprint(blueprint)).toEqual({ ok: true, violations: [] });
    expect(blueprintSha256(blueprint)).toMatch(/^[a-f0-9]{64}$/);
    const plan = planScaffoldFromBlueprint(blueprint);
    expect(plan.module_slug).toBe('sales-order-flow');
    expect(plan.tasks).toHaveLength(6);
    expect(plan.tasks.flatMap((task) => task.target_paths)).toContain(
      'domain/sales-order-flow/api/src/sales-order-flow/controllers/order-item.controller.ts',
    );
  });

  it('reports load errors and every cross-field invariant violation', () => {
    const repo = root();
    expect(loadBlueprint(join(repo, 'missing.json')).errors[0]).toContain('not found');
    expect(loadBlueprint(write(repo, 'bad.json', '{bad')).errors[0]).toContain('JSON parse error');
    expect(loadBlueprint(write(repo, 'invalid.json', { schemaVersion: '1.0.0' })).ok).toBe(false);

    const invalid: Blueprint = {
      ...blueprint,
      database: {
        entities: [
          {
            name: 'OrderItem',
            primaryKey: [],
            fields: [{ name: 'email', type: 'text', pii: 'high' }],
          },
        ],
      },
      api: { resources: [{ entity: 'OrderItem', operations: ['delete'] }] },
    };
    const validation = validateBlueprint(invalid);
    expect(validation.ok).toBe(false);
    expect(validation.violations.map((violation) => violation.invariant_id)).toEqual([
      'INV-BLUEPRINT-001',
      'INV-BLUEPRINT-002',
      'INV-BLUEPRINT-003',
    ]);
    expect(
      validateBlueprint({ ...invalid, database: { entities: [] } }).violations[0]?.pointer,
    ).toBe('/database/entities');
  });

  it('diffs absent, partial, aligned, and malformed inventory', () => {
    const repo = root();
    expect(diffBlueprintAgainstInventory({ blueprint, inventoryRoot: repo })).toMatchObject({
      status: 'no_inventory',
      summary: { missing_entities: 2, missing_routes: 4 },
    });

    write(repo, '.devai/state/sensors/inventory_data_model/data-model.json', {
      tables: [
        { name: 'orders', columns: [{ name: 'id' }] },
        { name: 'sales__order_flow_audit_log', columns: [{ name: 'id' }] },
      ],
    });
    write(repo, '.devai/state/sensors/inventory_api/api-map.json', {
      endpoints: [{ path: '/api/orders' }, { path: '/api/audit-logs/:id' }],
    });
    write(repo, '.devai/state/sensors/inventory_rbac/rbac.json', {
      roles: [{ id: 'reader' }],
    });
    const partial = diffBlueprintAgainstInventory({ blueprint, inventoryRoot: repo });
    expect(partial.status).toBe('has_deltas');
    expect(partial.deltas.map((delta) => delta.kind)).toEqual([
      'missing_field',
      'missing_permission',
    ]);

    write(repo, '.devai/state/sensors/inventory_data_model/data-model.json', {
      tables: [
        { name: 'orders', columns: [{ name: 'id' }, { name: 'email' }] },
        { name: 'sales__order_flow_audit_log', columns: [{ name: 'id' }] },
      ],
    });
    write(repo, '.devai/state/sensors/inventory_rbac/rbac.json', {
      roles: [{ id: 'reader' }, { id: 'writer' }],
    });
    expect(diffBlueprintAgainstInventory({ blueprint, inventoryRoot: repo }).status).toBe(
      'aligned',
    );

    write(repo, '.devai/state/sensors/inventory_data_model/data-model.json', '{bad');
    expect(diffBlueprintAgainstInventory({ blueprint, inventoryRoot: repo }).status).toBe(
      'aligned',
    );
  });
});

describe('inventory invariant candidates', () => {
  function prepareInputs(repo: string): void {
    write(repo, 'coverage.json', {
      unmapped: { routes: ['route-a'], endpoints: ['GET /a'] },
    });
    write(repo, 'handling.json', {
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'email', pii_class: 'contact' },
            {
              name: 'name',
              pii_class: 'personal',
              legal_basis: 'consent',
              retention: 'P1Y',
            },
          ],
          evidence: [{ path: 'schema.sql', startLine: 1, endLine: 2 }],
        },
      ],
    });
    write(repo, 'graph.json', {
      graph: {
        'packages/a/src/a.ts': [
          'packages/b/internal/private.ts',
          'packages/a/internal/allowed.ts',
          'external',
        ],
      },
    });
    write(repo, 'rbac.json', {
      unmapped: { endpointsWithoutRole: ['POST /admin'] },
    });
  }

  it('suggests all five categories and preserves dry-run boundaries', () => {
    const repo = root();
    prepareInputs(repo);
    const options = {
      repoRoot: repo,
      coverageBodyPath: join(repo, 'coverage.json'),
      dataHandlingBodyPath: join(repo, 'handling.json'),
      depGraphBodyPath: join(repo, 'graph.json'),
      rbacBodyPath: join(repo, 'rbac.json'),
      now: NOW,
    };
    const result = suggestInvariants({ ...options, dryRun: true });
    expect(result.summary.total).toBe(5);
    expect(result.summary.by_category).toEqual({
      unmapped_route: 1,
      unmapped_endpoint: 1,
      unbound_endpoint: 1,
      unlabeled_pii_column: 1,
      forbidden_edge: 1,
    });
    expect(result.written_files).toEqual([]);
    expect(() => suggestInvariants({ ...options, outDir: join(repo, 'out') })).toThrow(
      'AUTHORITY_FINAL_BOUNDARY_REQUIRED',
    );
  });

  it('reports unread or malformed inputs without inventing candidates', () => {
    const repo = root();
    write(repo, 'bad.json', '{bad');
    const result = suggestInvariants({
      repoRoot: repo,
      coverageBodyPath: join(repo, 'bad.json'),
      dataHandlingBodyPath: join(repo, 'missing-a.json'),
      depGraphBodyPath: join(repo, 'missing-b.json'),
      rbacBodyPath: join(repo, 'missing-c.json'),
      dryRun: true,
      now: NOW,
    });
    expect(result.summary.total).toBe(0);
    expect(result.summary.unread_inputs).toHaveLength(3);
  });

  it.each([
    ['basis', '', 'P1Y', 'legal_basis'],
    ['retention', 'consent', '', 'retention'],
    ['both', '', '', 'legal_basis + retention'],
  ])(
    'identifies missing PII %s without flagging complete or non-PII columns',
    (_name, legal_basis, retention, missing) => {
      const repo = root();
      prepareInputs(repo);
      write(repo, 'handling.json', {
        tables: [
          {
            name: 'users',
            columns: [
              { name: 'email', pii_class: 'contact', legal_basis, retention },
              { name: 'id' },
              { name: 'public', pii_class: '' },
              { name: 'complete', pii_class: 'contact', legal_basis: 'consent', retention: 'P1Y' },
            ],
          },
        ],
      });
      const result = suggestInvariants({
        repoRoot: repo,
        dryRun: true,
        now: NOW,
        dataHandlingBodyPath: join(repo, 'handling.json'),
      });
      expect(result.summary.by_category.unlabeled_pii_column).toBe(1);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        schemaVersion: '1.0.0',
        generated_at: NOW,
        category: 'unlabeled_pii_column',
        source_sensor: 'inventory_data_handling',
        confidence: 'high',
        target: { kind: 'column', identifier: 'users.email' },
        suggested_invariant: {
          title: `Column users.email (contact) must have ${missing}`,
          severity_suggestion: 'hard-fail',
          domain_suggestion: 'INVENTORY',
          measurable_via_suggestion: ['sense data-handling', 'sense data-model'],
        },
        related_invariants: ['INV-INVENTORY-002'],
        status: 'proposed',
        tags: ['phase-17-E', 'brownfield', 'pii', 'contact'],
      });
      expect(result.candidates[0]?.target).not.toHaveProperty('evidence');
    },
  );

  it.each(['internal', '_internal', 'private', 'lib/internal'])(
    'flags cross-package %s edges while allowing same-package and public access',
    (segment) => {
      const repo = root();
      const from = 'apps/web/src/page.ts';
      const to = `packages/api/${segment}/secret.ts`;
      write(repo, 'graph.json', {
        graph: {
          [from]: [to, `apps/web/${segment}/own.ts`, 'packages/api/public.ts'],
          'unknown/file.ts': [to],
          'src/main.ts': ['src/internal/own.ts'],
        },
      });
      const result = suggestInvariants({
        repoRoot: repo,
        dryRun: true,
        now: NOW,
        depGraphBodyPath: join(repo, 'graph.json'),
      });
      expect(result.summary.by_category.forbidden_edge).toBe(1);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        generated_at: NOW,
        category: 'forbidden_edge',
        source_sensor: 'inventory_dep_graph',
        confidence: 'high',
        status: 'proposed',
        target: {
          kind: 'edge',
          identifier: `${from} -> ${to}`,
          evidence: [{ path: from, startLine: 1, endLine: 1 }],
        },
        suggested_invariant: {
          severity_suggestion: 'hard-fail',
          title: 'Cross-package internal import: apps/web → packages/api/internal',
          measurable_via_suggestion: ['sense dep-graph'],
        },
        related_invariants: ['INV-INVENTORY-004'],
        tags: ['phase-17-E', 'brownfield', 'layering'],
      });
    },
  );

  it('keeps every candidate while the original sensor findings remain present', () => {
    const repo = root();
    prepareInputs(repo);
    const options = {
      repoRoot: repo,
      coverageBodyPath: join(repo, 'coverage.json'),
      dataHandlingBodyPath: join(repo, 'handling.json'),
      depGraphBodyPath: join(repo, 'graph.json'),
      rbacBodyPath: join(repo, 'rbac.json'),
      now: NOW,
      outDir: join(repo, 'candidates'),
      dryRun: true,
    };
    const suggested = suggestInvariants(options);
    for (const candidate of suggested.candidates)
      write(repo, `candidates/${candidate.id}.json`, candidate);
    expect(gcStaleInvariantCandidates(options)).toEqual({
      scanned: 5,
      stale: 0,
      kept: 5,
      evidence: [],
      evidence_log_path: null,
    });
    write(repo, 'rbac.json', { unmapped: { endpointsWithoutRole: [] } });
    write(repo, 'handling.json', {
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'email', pii_class: 'contact', legal_basis: 'consent', retention: 'P1Y' },
          ],
        },
      ],
    });
    write(repo, 'graph.json', {
      graph: { 'packages/a/src/a.ts': ['packages/a/internal/allowed.ts', 'packages/b/public.ts'] },
    });
    const resolved = gcStaleInvariantCandidates(options);
    expect(resolved).toMatchObject({ scanned: 5, stale: 3, kept: 2, evidence_log_path: null });
    expect(resolved.evidence.map((item) => item.category).sort()).toEqual([
      'forbidden_edge',
      'unbound_endpoint',
      'unlabeled_pii_column',
    ]);
  });

  it('preserves schema-invalid candidate records even when their claimed target disappeared', () => {
    const repo = root();
    write(repo, 'coverage.json', { unmapped: { routes: [], endpoints: [] } });
    write(repo, 'candidates/INV-CANDIDATE-corrupt.json', {
      category: 'unmapped_route',
      target: { identifier: 'gone-route' },
    });
    const result = gcStaleInvariantCandidates({
      repoRoot: repo,
      outDir: join(repo, 'candidates'),
      coverageBodyPath: join(repo, 'coverage.json'),
      dryRun: true,
      now: NOW,
    });
    expect(result).toEqual({
      scanned: 1,
      stale: 0,
      kept: 1,
      evidence: [],
      evidence_log_path: null,
    });
  });

  it('classifies stale, live, malformed, and unavailable candidates during GC', () => {
    const repo = root();
    prepareInputs(repo);
    const suggested = suggestInvariants({
      repoRoot: repo,
      coverageBodyPath: join(repo, 'coverage.json'),
      dataHandlingBodyPath: join(repo, 'handling.json'),
      depGraphBodyPath: join(repo, 'graph.json'),
      rbacBodyPath: join(repo, 'rbac.json'),
      dryRun: true,
      now: NOW,
    });
    const outDir = join(repo, 'candidates');
    for (const candidate of suggested.candidates) {
      write(repo, `candidates/${candidate.id}.json`, candidate);
    }
    write(repo, 'candidates/INV-CANDIDATE-malformed.json', '{bad');
    write(repo, 'candidates/INV-CANDIDATE-null.json', 'null');

    write(repo, 'gc-coverage.json', { unmapped: { routes: ['route-a'], endpoints: [] } });
    write(repo, 'gc-handling.json', { pii: [] });
    write(repo, 'gc-graph.json', { forbiddenEdges: [] });
    write(repo, 'gc-rbac.json', { endpointsWithoutRole: [] });
    const options = {
      repoRoot: repo,
      outDir,
      coverageBodyPath: join(repo, 'gc-coverage.json'),
      dataHandlingBodyPath: join(repo, 'gc-handling.json'),
      depGraphBodyPath: join(repo, 'gc-graph.json'),
      rbacBodyPath: join(repo, 'gc-rbac.json'),
      now: NOW,
    };
    const dry = gcStaleInvariantCandidates({ ...options, dryRun: true });
    expect(dry).toMatchObject({ scanned: 7, stale: 4, kept: 3, evidence_log_path: null });
    expect(() => gcStaleInvariantCandidates(options)).toThrow('AUTHORITY_FINAL_BOUNDARY_REQUIRED');

    expect(
      gcStaleInvariantCandidates({
        repoRoot: repo,
        outDir: join(repo, 'missing'),
        now: NOW,
      }),
    ).toEqual({
      scanned: 0,
      stale: 0,
      kept: 0,
      evidence: [],
      evidence_log_path: null,
    });
  });
});
