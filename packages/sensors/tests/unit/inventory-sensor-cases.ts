import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  decoratorArgIdentifiers,
  decoratorFirstStringArg,
  decoratorName,
  findDecoratorByName,
  parseSource,
  walkFiles,
  walkTs,
  walkTsxJsx,
} from '../../src/inventory-walker.js';
import { senseInventoryApi } from '../../src/inventory-api.js';
import { senseInventoryRoutes } from '../../src/inventory-routes.js';
import { senseInventoryDataModel } from '../../src/inventory-data-model.js';
import { senseInventoryDepGraph } from '../../src/inventory-dep-graph.js';
import { senseInventoryDataHandling } from '../../src/inventory-data-handling.js';
import { senseInventoryRbac } from '../../src/inventory-rbac.js';
import { senseInventoryCoverage } from '../../src/inventory-coverage.js';
import { senseDocsDrift } from '../../src/docs-drift.js';
import { senseHarnessCoherence } from '../../src/harness-coherence.js';
import { senseHarnessCoverage } from '../../src/harness-coverage.js';
import { senseHarnessDepth } from '../../src/harness-depth.js';
import { senseHarnessGreenMain } from '../../src/harness-green-main.js';
import { senseHarnessIdiomaticity } from '../../src/harness-idiomaticity.js';
import { senseHarnessInvariantAlignment } from '../../src/harness-invariant-alignment.js';
import { senseHarnessPerformance } from '../../src/harness-performance.js';
import { senseHarnessRobustness } from '../../src/harness-robustness.js';
import { senseHarnessSecurity } from '../../src/harness-security.js';
import { senseInventoryAdherence } from '../../src/inventory-adherence.js';
import { senseInventoryDeterminism } from '../../src/inventory-determinism.js';
import { senseInventoryPerformance } from '../../src/inventory-performance.js';
import { sensePlantCoherence } from '../../src/plant-coherence.js';
import { sensePlantCoverage } from '../../src/plant-coverage.js';
import { sensePlantDepth } from '../../src/plant-depth.js';
import { senseSpecAlignment } from '../../src/spec-alignment.js';
import { senseSpecDepth } from '../../src/spec-depth.js';
import { senseSpecFreshness } from '../../src/spec-freshness.js';
import { senseSpecIdiomaticity } from '../../src/spec-idiomaticity.js';
import { senseSpecPerformanceTargets } from '../../src/spec-performance-targets.js';
import { senseSpecRobustnessTargets } from '../../src/spec-robustness-targets.js';
import { senseSpecSecurityCoverage } from '../../src/spec-security-coverage.js';
import { senseTestCoherence } from '../../src/test-coherence.js';
import { senseTestCoverageDepth } from '../../src/test-coverage-depth.js';
import { senseTestIdiomaticity } from '../../src/test-idiomaticity.js';
import { senseTestInvariantAlignment } from '../../src/test-invariant-alignment.js';
import { senseTestPerformanceCoverage } from '../../src/test-performance-coverage.js';
import { senseTestRobustnessCoverage } from '../../src/test-robustness-coverage.js';
import { senseTestSecurityCoverage } from '../../src/test-security-coverage.js';
import { senseTestWeakening } from '../../src/test-weakening.js';

const roots: string[] = [];
const NOW = '2026-07-24T00:00:00.000Z';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-inventory-sensors-'));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, source: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function buildFixture(): string {
  const root = fixtureRoot();
  write(
    root,
    'apps/api/users.controller.ts',
    `
      @Controller('/users')
      @UseGuards(SessionGuard)
      export class UsersController {
        @Get(':id')
        @Roles(AdminRole, 'reader')
        getOne(@Param('id') id: string, @Query(\`expand\`) expand: string, @Headers('x-id') header: string) {}

        @Post()
        create(@Body() body: unknown) {}

        @Get('health')
        @Public()
        health() {}

        @Patch(':id')
        patch(@Param() id: string) {}

        notAnEndpoint() {}
      }

      class NotAController {
        @Get() ignored() {}
      }
    `,
  );
  write(
    root,
    'apps/web/routes.tsx',
    `
      const direct = <Route path="/users/:id" element={<UserPage />} />;
      const expression = <Route path={'/health'} element={lazyPage()} />;
      const empty = <Route path />;
      export const router = createBrowserRouter([
        { path: '/', element: <Home />, children: [
          { path: '/settings', element: <Settings /> },
          { path: \`/literal\`, element: Settings },
        ]},
      ]);
      export const routes = useRoutes([{ path: '/other', element: OtherPage }]);
    `,
  );
  write(
    root,
    'apps/angular/app.routes.ts',
    `
      export const routes: Routes = [
        { path: 'dashboard', component: DashboardComponent, children: [
          { path: 'child', loadComponent: () => import('./child').then(m => m.ChildComponent) },
          { path: 'lazy', loadChildren: () => import('./lazy') },
          { path: 'old', redirectTo: 'dashboard' },
        ]},
      ];
      provideRouter([{ path: 'provided', component: ProvidedComponent }]);
      RouterModule.forRoot([{ path: 'root', component: RootComponent }]);
      RouterModule.forChild([{ path: 'child-root', component: ChildRootComponent }]);
    `,
  );
  write(
    root,
    'database/001-schema.sql',
    `
      CREATE TABLE auth.roles (
        id uuid PRIMARY KEY,
        name varchar(100) NOT NULL,
        slug text UNIQUE
      );

      CREATE TABLE auth.permissions (
        id uuid,
        name text NOT NULL,
        CONSTRAINT permissions_pk PRIMARY KEY (id),
        UNIQUE (name)
      );

      CREATE TABLE auth.role_permissions (
        role_id uuid NOT NULL,
        permission_id uuid NOT NULL,
        CONSTRAINT role_fk FOREIGN KEY (role_id) REFERENCES auth.roles(id) ON DELETE CASCADE,
        CONSTRAINT permission_fk FOREIGN KEY (permission_id) REFERENCES auth.permissions(id) ON UPDATE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      );

      CREATE TABLE app.users (
        id bigint GENERATED ALWAYS AS IDENTITY,
        email text NOT NULL, -- @pii_class: contact @legal_basis: contract @retention: P2Y
        password_hash varchar(255),
        full_name text,
        address text,
        ip_address inet,
        balance numeric(10, 2) DEFAULT 0,
        active boolean DEFAULT true,
        score double precision NOT NULL,
        display_name character varying(64) NOT NULL,
        seen_at timestamp with time zone NOT NULL,
        role_id uuid REFERENCES auth.roles(id),
        CONSTRAINT users_pk PRIMARY KEY (id)
      );

      CREATE TABLE core.pii_map (
        table_schema text,
        table_name text,
        column_name text,
        category text,
        strategy text,
        legal_basis text,
        retention text
      );

      INSERT INTO core.pii_map
        (table_schema, table_name, column_name, category, strategy, legal_basis, retention)
      VALUES
        ('app', 'users', 'full_name', 'personal', 'mask', 'consent', 'P1Y'),
        ('app', 'users', 'ip_address', 'ip', 'truncate', 'legitimate-interest', 'P90D')
      ON CONFLICT DO NOTHING;
    `,
  );
  write(root, 'packages/core/src/a.ts', `import { b } from './b.js'; export { c } from 'pkg-c';`);
  write(root, 'packages/core/src/b.ts', `import fs from 'node:fs'; export const b = fs;`);
  write(root, 'packages/core/src/ignored.d.ts', 'export type Ignored = string;');
  write(root, 'packages/core/src/view.jsx', 'export const View = <div />;');
  write(root, 'node_modules/ignored.ts', 'export const ignored = true;');
  return root;
}

describe('inventory walker behavior', () => {
  it('walks selected extensions, skips declarations and ignored directories, and parses sources', () => {
    const root = buildFixture();
    const all = walkFiles(root, {
      extensions: ['ts', 'tsx', 'jsx', 'sql'],
      skipDeclarations: false,
    });
    const ts = walkTs(root);
    const jsx = walkTsxJsx(root);

    expect(all.some((path) => path.endsWith('001-schema.sql'))).toBe(true);
    expect(all.some((path) => path.includes('node_modules'))).toBe(false);
    expect(ts.some((path) => path.endsWith('ignored.d.ts'))).toBe(false);
    expect(jsx.some((path) => path.endsWith('view.jsx'))).toBe(true);
    expect(walkFiles(join(root, 'missing'))).toEqual([]);
    expect(parseSource(join(root, 'missing.ts'))).toBeNull();
  });

  it('extracts decorator names, literals, identifiers, and lookup matches', () => {
    const root = buildFixture();
    const source = parseSource(join(root, 'apps/api/users.controller.ts'));
    expect(source).not.toBeNull();
    const decorators: ts.Decorator[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.canHaveDecorators(node)) decorators.push(...(ts.getDecorators(node) ?? []));
      ts.forEachChild(node, visit);
    };
    visit(source as ts.SourceFile);

    const controller = findDecoratorByName(decorators, 'Controller');
    const roles = findDecoratorByName(decorators, 'Roles');
    expect(controller).toBeDefined();
    expect(decoratorName(controller as ts.Decorator)).toBe('Controller');
    expect(decoratorFirstStringArg(controller as ts.Decorator)).toBe('/users');
    expect(decoratorArgIdentifiers(roles as ts.Decorator)).toEqual(['AdminRole', 'reader']);
    expect(findDecoratorByName(undefined, 'Missing')).toBeUndefined();
  });
});

describe('source inventory sensors', () => {
  it('extracts authenticated and explicitly public NestJS endpoints deterministically', () => {
    const root = buildFixture();
    const result = senseInventoryApi({
      repoRoot: root,
      scanDirs: ['apps/api', 'apps/api', 'missing'],
      persistBody: false,
      publicMarkerDecorators: ['Public'],
      stack: { backend: 'nestjs', frontend: 'react', db: 'postgres' },
      now: NOW,
    });

    expect(result.reading.status).toBe('pass');
    expect(result.bodyPath).toBeNull();
    expect(result.body.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual([
      'POST /users',
      'GET /users/:id',
      'PATCH /users/:id',
      'GET /users/health',
    ]);
    expect(
      result.body.endpoints.find(
        (endpoint) => endpoint.method === 'GET' && endpoint.path === '/users/:id',
      )?.auth,
    ).toMatchObject({
      required: true,
      guards: ['SessionGuard'],
      roles: ['AdminRole', 'reader'],
    });
    expect(
      result.body.endpoints.find((endpoint) => endpoint.path.endsWith('health'))?.auth,
    ).toEqual({
      guards: ['SessionGuard'],
      required: false,
    });
  });

  it('reports a clean empty API scan as review and persists an observed body', () => {
    const root = fixtureRoot();
    write(root, 'src/plain.ts', 'export const plain = true;');
    const empty = senseInventoryApi({
      repoRoot: root,
      scanDirs: ['missing'],
      persistBody: false,
      now: NOW,
    });
    expect(empty.reading).toMatchObject({ status: 'review' });
    expect(empty.reading.findings?.[0]?.code).toBe('API_INVENTORY_EMPTY');

    write(root, 'one.controller.ts', `@Controller() class One { @Get() index() {} }`);
    const persisted = senseInventoryApi({ repoRoot: root, now: NOW });
    expect(persisted.reading.status).toBe('error');
    expect(persisted.bodyPath).toBeNull();
    expect(persisted.reading.findings?.[0]?.code).toBe('API_INVENTORY_WRITE_FAILED');
  });

  it('extracts React route elements, object children, literals, and alternate scan directories', () => {
    const root = buildFixture();
    const result = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['apps/web', 'apps/web', 'missing'],
      persistBody: false,
      framework: 'react',
      now: NOW,
    });

    expect(result.reading.status).toBe('pass');
    expect(result.body.routes.map((route) => route.path)).toEqual([
      '',
      '/',
      '/health',
      '/literal',
      '/other',
      '/settings',
      '/users/:id',
    ]);
    expect(result.body.routes.find((route) => route.path === '/settings')?.parentId).toBeDefined();
    expect(result.body.routes.find((route) => route.path === '/users/:id')?.component?.name).toBe(
      'UserPage',
    );
  });

  it('extracts Angular typed, provided, root, child, redirect, and lazy routes', () => {
    const root = buildFixture();
    const result = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['apps/angular'],
      framework: 'angular',
      persistBody: false,
      now: NOW,
    });

    expect(result.reading.status).toBe('pass');
    expect(result.body.routes.map((route) => route.path)).toEqual([
      'child',
      'child-root',
      'dashboard',
      'lazy',
      'old',
      'provided',
      'root',
    ]);
    expect(result.body.routes.find((route) => route.path === 'child')?.component?.name).toBe(
      'ChildComponent',
    );
  });

  it('builds deterministic local and external dependency edges', () => {
    const root = buildFixture();
    const result = senseInventoryDepGraph({
      repoRoot: root,
      scanDir: join(root, 'packages'),
      persistBody: false,
      now: NOW,
    });

    expect(result.reading.status).toBe('pass');
    expect(result.body.graph['packages/core/src/a.ts']).toEqual([
      'packages/core/src/b.ts',
      'pkg-c',
    ]);
    expect(result.body.graph['packages/core/src/b.ts']).toEqual(['node:fs']);
  });
});

describe('data and coverage inventory sensors', () => {
  it('parses SQL tables, keys, constraints, defaults, annotations, and PII registry rows', () => {
    const root = buildFixture();
    const result = senseInventoryDataModel({
      repoRoot: root,
      migrationDirs: ['missing', 'database'],
      piiRegistryTable: 'pii_map',
      persistBody: false,
      now: NOW,
    });

    expect(result.reading.status).toBe('pass');
    expect(result.body.tables.map((table) => table.name)).toEqual([
      'permissions',
      'pii_map',
      'role_permissions',
      'roles',
      'users',
    ]);
    const users = result.body.tables.find((table) => table.name === 'users');
    expect(users?.primary_key).toEqual(['id']);
    expect(users?.columns.find((column) => column.name === 'email')).toMatchObject({
      nullable: false,
      pii_class: 'contact',
      legal_basis: 'contract',
      retention: 'P2Y',
    });
    expect(users?.columns.find((column) => column.name === 'full_name')).toMatchObject({
      pii_class: 'personal',
      legal_basis: 'consent',
      retention: 'P1Y',
    });
    expect(users?.columns.find((column) => column.name === 'active')?.default).toBe('true');
    expect(users?.columns.find((column) => column.name === 'score')).toMatchObject({
      type: 'double precision',
      nullable: false,
    });
    expect(users?.columns.find((column) => column.name === 'display_name')).toMatchObject({
      type: 'character varying(64)',
      nullable: false,
    });
    expect(users?.columns.find((column) => column.name === 'seen_at')).toMatchObject({
      type: 'timestamp with time zone',
      nullable: false,
    });
    expect(result.bodyPath).toBeNull();
  });

  it('seeds PII classifications and derives RBAC tables and endpoint bindings', () => {
    const root = buildFixture();
    const model = senseInventoryDataModel({
      repoRoot: root,
      migrationDirs: ['database'],
      piiRegistryTable: 'pii_map',
      persistBody: false,
      now: NOW,
    });
    const api = senseInventoryApi({
      repoRoot: root,
      scanDirs: ['apps/api'],
      publicMarkerDecorators: ['Public'],
      persistBody: false,
      now: NOW,
    });
    write(
      root,
      'record/proofs/sensors/inventory_data_model/data-model.json',
      JSON.stringify(model.body),
    );
    write(root, 'record/proofs/sensors/inventory_api/api-map.json', JSON.stringify(api.body));
    const handling = senseInventoryDataHandling({
      repoRoot: root,
      persistBody: false,
      now: NOW,
    });
    const rbac = senseInventoryRbac({
      repoRoot: root,
      persistBody: false,
      now: NOW,
    });

    expect(model.reading.status).toBe('pass');
    expect(api.reading.status).toBe('pass');
    expect(handling.reading.status).toBe('pass');
    expect(
      handling.body?.tables
        .find((table) => table.name === 'users')
        ?.columns.find((column) => column.name === 'password_hash')?.pii_class,
    ).toBe('credentials');
    expect(rbac.reading.status).toBe('pass');
    const rbacBody = rbac.body as {
      rbacIlfTables: string[];
      bindings: { endpointBindings: Array<{ permissionId: string }> };
      unmapped: { endpointsWithoutRole: string[] };
    };
    expect(rbacBody.rbacIlfTables).toEqual(
      expect.arrayContaining(['roles', 'permissions', 'role_permissions']),
    );
    expect(rbacBody.bindings.endpointBindings.map((binding) => binding.permissionId)).toEqual(
      expect.arrayContaining(['guard:SessionGuard', 'role:AdminRole', 'role:reader']),
    );
    expect(rbacBody.unmapped.endpointsWithoutRole).toEqual([]);
  });

  it('reports missing and malformed prerequisite bodies honestly', () => {
    const root = fixtureRoot();
    expect(
      senseInventoryDataHandling({ repoRoot: root, persistBody: false, now: NOW }).reading,
    ).toMatchObject({ status: 'review' });
    expect(
      senseInventoryRbac({ repoRoot: root, persistBody: false, now: NOW }).reading,
    ).toMatchObject({ status: 'unknown' });

    const bad = write(root, 'bad.json', '{bad');
    expect(
      senseInventoryDataHandling({
        repoRoot: root,
        dataModelPath: bad,
        persistBody: false,
        now: NOW,
      }).reading.status,
    ).toBe('error');
    expect(
      senseInventoryRbac({
        repoRoot: root,
        dataModelPath: bad,
        apiMapPath: bad,
        persistBody: false,
        now: NOW,
      }).reading.status,
    ).toBe('error');
  });

  it('synthesizes paired, route-only, and endpoint-only use-case links', () => {
    const root = buildFixture();
    const api = senseInventoryApi({
      repoRoot: root,
      scanDirs: ['apps/api'],
      persistBody: false,
      now: NOW,
    });
    const routes = senseInventoryRoutes({
      repoRoot: root,
      scanDirs: ['apps/web'],
      framework: 'react',
      persistBody: false,
      now: NOW,
    });
    write(root, 'record/proofs/sensors/inventory_api/api-map.json', JSON.stringify(api.body));
    write(
      root,
      'record/proofs/sensors/inventory_routes/routes-react.json',
      JSON.stringify(routes.body),
    );
    const routeIds = routes.body.routes.map((route) => route.id);
    const endpointIds = api.body.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    write(
      root,
      'product/use-cases/inventory.json',
      JSON.stringify({
        schemaVersion: '1.0.0',
        roles: ['operator'],
        cases: [
          {
            id: 'UC-inventory',
            title: 'Exercise inventory links',
            mainFlow: [
              {
                action: 'paired',
                actorRole: 'operator',
                refs: { routeIds: [routeIds[0]], endpointIds: [endpointIds[0]] },
              },
              {
                action: 'route only',
                actorRole: 'operator',
                refs: { routeIds: [routeIds[1], 'missing-route'] },
              },
              {
                action: 'endpoint only',
                actorRole: 'operator',
                refs: { endpointIds: [endpointIds[1], 'missing-endpoint'] },
              },
            ],
          },
        ],
      }),
    );
    write(root, 'product/use-cases/bad.json', '{bad');

    const result = senseInventoryCoverage({
      repoRoot: root,
      framework: 'react',
      persistBody: false,
      now: NOW,
    });
    const body = result.body as {
      links: Array<{ linkKind: string }>;
      stats: { linkCount: number };
      unmapped: { routes: string[]; endpoints: string[] };
    };

    expect(result.reading.status).toBe('review');
    expect(body.links.map((link) => link.linkKind)).toEqual([
      'paired',
      'route-only',
      'endpoint-only',
    ]);
    expect(body.stats.linkCount).toBe(3);
    expect(result.reading.findings?.map((finding) => finding.code)).toContain(
      'COVERAGE_USE_CASES_PARSE_FAILED',
    );
  });

  it('auto-resolves exactly one routes body and reviews ambiguous bodies without guessing', () => {
    const root = fixtureRoot();
    write(
      root,
      'record/proofs/sensors/inventory_api/api-map.json',
      JSON.stringify({ endpoints: [] }),
    );
    write(
      root,
      'record/proofs/sensors/inventory_routes/routes-angular.json',
      JSON.stringify({
        framework: 'angular',
        routes: [{ id: 'route-angular', path: '/angular' }],
      }),
    );

    const exactOne = senseInventoryCoverage({
      repoRoot: root,
      persistBody: false,
      now: NOW,
    });
    expect((exactOne.body as { routes: string[] }).routes).toEqual(['route-angular']);
    expect(exactOne.reading.findings?.map((finding) => finding.code)).not.toContain(
      'COVERAGE_ROUTES_AMBIGUOUS',
    );

    write(
      root,
      'record/proofs/sensors/inventory_routes/routes-react.json',
      JSON.stringify({
        framework: 'react',
        routes: [{ id: 'route-react', path: '/react' }],
      }),
    );
    const ambiguous = senseInventoryCoverage({
      repoRoot: root,
      persistBody: false,
      now: NOW,
    });
    expect(ambiguous.reading.status).toBe('review');
    expect((ambiguous.body as { routes: string[] }).routes).toEqual([]);
    expect(ambiguous.reading.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'COVERAGE_ROUTES_AMBIGUOUS',
          message: expect.stringContaining('routes-angular.json, routes-react.json'),
        }),
      ]),
    );
  });

  it('reports absent and invalid coverage inputs without emitting a body file', () => {
    const root = fixtureRoot();
    const absent = senseInventoryCoverage({ repoRoot: root, persistBody: false, now: NOW });
    expect(absent.reading.status).toBe('review');
    expect(absent.reading.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'COVERAGE_REQUIRES_ROUTES',
          message: expect.stringContaining('devai sense run inventory_routes'),
        }),
      ]),
    );
    expect(absent.reading.findings?.map((finding) => finding.message).join('\n')).not.toContain(
      'routes-react.json',
    );

    const badApi = write(root, 'api.json', '{bad');
    const badRoutes = write(root, 'routes.json', '{bad');
    const invalid = senseInventoryCoverage({
      repoRoot: root,
      apiMapPath: badApi,
      routesPath: badRoutes,
      persistBody: false,
      now: NOW,
    });
    expect(invalid.reading.status).toBe('error');
    expect(invalid.bodyPath).toBeNull();
  });
});

describe('static quality sensor families', () => {
  it('reports schema-valid readings across populated spec, plant, test, and harness substrate', () => {
    const root = buildFixture();
    write(
      root,
      'law/invariants/INV-FIXTURE.json',
      JSON.stringify({
        id: 'INV-FIXTURE',
        severity: 'gate',
        statement: 'The fixture must stay observable and secure.',
        rationale: 'Exercises static sensor behavior.',
        scope: { components: ['fixture'], code_areas: ['apps/**'] },
        measurable_via: ['pnpm test', 'pnpm run test:security', 'pnpm run test:performance'],
      }),
    );
    write(
      root,
      'docs/meta/adr/ADR-0001.md',
      '# ADR-0001\n\n## Context\nFixture context.\n\n## Decision\nUse deterministic tests.\n',
    );
    write(
      root,
      '.github/workflows/ci.yml',
      `name: CI
on:
  pull_request_target:
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test
      - run: pnpm run test:security
      - run: pnpm run test:performance
`,
    );
    write(
      root,
      'packages/demo/src/MixedCase.ts',
      'export function demo(value: string) { if (!value) throw new Error("missing"); return value; }',
    );
    write(root, 'packages/demo/src/mixed_case.ts', 'export const mixed = true;');
    write(
      root,
      'packages/demo/test/demo.integration.test.ts',
      `describe('demo security performance edge cases', () => {
        beforeEach(() => {});
        it('rejects unauthorized traversal under load', () => {
          vi.mock('fixture');
          vi.fn();
          expect(() => { throw new Error('denied'); }).toThrow();
          expect('../../etc/passwd').toContain('..');
        });
      });`,
    );
    write(
      root,
      'record/proofs/sensor-readings/inventory_api/one.json',
      JSON.stringify({ sensor: { kind: 'inventory_api' }, duration_ms: 25 }),
    );
    write(
      root,
      'record/proofs/sensor-readings/inventory_api/two.json',
      JSON.stringify({ sensor: { kind: 'inventory_api' }, duration_ms: 250 }),
    );
    write(root, 'record/proofs/sensor-readings/inventory_api/bad.json', '{bad');

    const readings = [
      senseDocsDrift({ repoRoot: root, now: NOW }),
      senseHarnessCoherence({ repoRoot: root, now: NOW }),
      senseHarnessCoverage({ repoRoot: root, now: NOW }),
      senseHarnessDepth({ repoRoot: root, now: NOW }),
      senseHarnessIdiomaticity({ repoRoot: root, now: NOW }),
      senseHarnessInvariantAlignment({ repoRoot: root, candidateHead: 'candidate', now: NOW }),
      senseHarnessSecurity({ repoRoot: root, now: NOW }).reading,
      senseInventoryAdherence({
        report: {
          counts: { total: 3, claimed: 1, orphan: 2 },
          orphans: [
            { kind: 'route', id: '/unclaimed', file: 'apps/web/routes.tsx' },
            { kind: 'endpoint', id: 'GET /unclaimed' },
          ],
        },
        maxOrphans: 1,
        now: NOW,
      }),
      senseInventoryDeterminism({ canonicalA: 'a', canonicalB: 'b', now: NOW }),
      senseInventoryPerformance({
        repoRoot: root,
        thresholds: { pass: 20, review: 100 },
        now: NOW,
      }),
      sensePlantCoherence({ repoRoot: root, now: NOW }),
      sensePlantCoverage({ repoRoot: root, now: NOW }),
      sensePlantDepth({ repoRoot: root, now: NOW }),
      senseSpecAlignment({ repoRoot: root, now: NOW }),
      senseSpecDepth({ repoRoot: root, now: NOW }).reading,
      senseSpecFreshness({
        repoRoot: root,
        thresholdDays: 0,
        now: new Date(NOW),
      }).reading,
      senseSpecIdiomaticity({
        validationResult: {
          ok: false,
          files_scanned: 2,
          errors: [
            {
              severity: 'warning',
              code: 'STATEMENT_LACKS_CNL_MODAL',
              message: 'missing modal',
              file: 'one.json',
            },
            { severity: 'error', code: 'INVALID_INVARIANT', message: 'invalid' },
          ],
        },
        now: NOW,
      }),
      senseSpecPerformanceTargets({ repoRoot: root, now: NOW }),
      senseSpecRobustnessTargets({ repoRoot: root, now: NOW }),
      senseSpecSecurityCoverage({ repoRoot: root, now: NOW }),
      senseTestCoherence({ repoRoot: root, now: NOW }),
      senseTestCoverageDepth({
        summary: { lines_total: 10, lines_covered: 4 },
        thresholds: { pass: 80, review: 50 },
        now: NOW,
      }),
      senseTestIdiomaticity({
        repoRoot: root,
        thresholds: { review: 0, fail: 0.5 },
        now: NOW,
      }),
      senseTestInvariantAlignment({ repoRoot: root, now: NOW }),
      senseTestPerformanceCoverage({ repoRoot: root, now: NOW }),
      senseTestRobustnessCoverage({ repoRoot: root, now: NOW }),
      senseTestSecurityCoverage({ repoRoot: root, now: NOW }),
      senseTestWeakening({
        cwd: root,
        files: ['packages/demo/test/demo.integration.test.ts'],
      }),
    ];

    expect(readings).toHaveLength(28);
    for (const reading of readings) {
      expect(reading.schemaVersion).toBe('1.0.0');
      expect(['pass', 'review', 'fail', 'unknown', 'error']).toContain(reading.status);
    }
    expect(readings.some((reading) => reading.status === 'fail')).toBe(true);
    expect(readings.some((reading) => reading.status === 'review')).toBe(true);
    expect(() => senseHarnessGreenMain({ repoRoot: root, now: NOW })).toThrow(
      'AUTHORITY_FINAL_BOUNDARY_REQUIRED',
    );
    expect(() => senseHarnessPerformance({ repoRoot: root, now: NOW })).toThrow(
      'AUTHORITY_FINAL_BOUNDARY_REQUIRED',
    );
    expect(() => senseHarnessRobustness({ repoRoot: root, now: NOW })).toThrow(
      'AUTHORITY_FINAL_BOUNDARY_REQUIRED',
    );
  });

  it('handles absent substrate across every static quality family', () => {
    const root = fixtureRoot();
    const readings = [
      senseDocsDrift({ repoRoot: root, now: NOW }),
      senseHarnessCoherence({ repoRoot: root, now: NOW }),
      senseHarnessCoverage({ repoRoot: root, now: NOW }),
      senseHarnessDepth({ repoRoot: root, now: NOW }),
      senseHarnessIdiomaticity({ repoRoot: root, now: NOW }),
      senseHarnessInvariantAlignment({ repoRoot: root, candidateHead: 'candidate', now: NOW }),
      senseHarnessSecurity({ repoRoot: root, now: NOW }).reading,
      senseInventoryAdherence({
        report: { counts: { total: 0, claimed: 0, orphan: 0 } },
        now: NOW,
      }),
      senseInventoryDeterminism({ canonicalA: 'same', canonicalB: 'same', now: NOW }),
      senseInventoryPerformance({ repoRoot: root, now: NOW }),
      sensePlantCoherence({ repoRoot: root, now: NOW }),
      sensePlantCoverage({ repoRoot: root, now: NOW }),
      sensePlantDepth({ repoRoot: root, now: NOW }),
      senseSpecAlignment({ repoRoot: root, now: NOW }),
      senseSpecDepth({ repoRoot: root, now: NOW }).reading,
      senseSpecFreshness({ repoRoot: root, now: new Date(NOW) }).reading,
      senseSpecIdiomaticity({ validationResult: { ok: true, errors: [] }, now: NOW }),
      senseSpecPerformanceTargets({ repoRoot: root, now: NOW }),
      senseSpecRobustnessTargets({ repoRoot: root, now: NOW }),
      senseSpecSecurityCoverage({ repoRoot: root, now: NOW }),
      senseTestCoherence({ repoRoot: root, now: NOW }),
      senseTestCoverageDepth({ summary: null, now: NOW }),
      senseTestIdiomaticity({ repoRoot: root, now: NOW }),
      senseTestInvariantAlignment({ repoRoot: root, now: NOW }),
      senseTestPerformanceCoverage({ repoRoot: root, now: NOW }),
      senseTestRobustnessCoverage({ repoRoot: root, now: NOW }),
      senseTestSecurityCoverage({ repoRoot: root, now: NOW }),
      senseTestWeakening({ cwd: root, files: [] }),
    ];
    expect(readings).toHaveLength(28);
    expect(readings.every((reading) => reading.schemaVersion === '1.0.0')).toBe(true);
  });
});
