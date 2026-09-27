// ADR-SCR-0003 IA-001, IA-003, and IA-004 (sensor half): an inventory or plant sensor
// bound to a surface the repository declares absent emits skipped with the declaration
// as its reason; one that finds a surface declared absent reports review, never a skip;
// and with actions declared present, plant_coverage and inventory_coverage measure the
// action registry against its specification links as a percentage. IA-002 (the
// composer) lives in packages/loop/tests/scorecard.test.ts; the DEVAI-shaped contract
// lives in tests/contract/declared-surfaces.contract.test.ts.
//
// Interface assumptions the engineer (TASK-0228) must meet in packages/sensors/src:
//   - Every sensor below accepts an optional `surfaces` option shaped
//     `{ http, database, rbac, actions }` (all booleans), the `surfaces` object of
//     .devai/config/sensor-inputs.json that sense run resolves and the adapters deliver.
//     NEW: no options type declares it today, so it is passed through the widened local
//     type `Surfaced<T>` below and the declared cases fail until the sensors honor it.
//   - Bindings: inventory_api and inventory_routes -> http; inventory_data_model ->
//     database; inventory_rbac and inventory_data_handling -> rbac; inventory_coverage
//     and plant_coverage -> http and actions; inventory_performance -> all four (it
//     times the inventory readings, so it skips only when nothing is inventoried).
//   - A sensor whose bound surfaces are all false emits status `skipped`; its first
//     finding has code SURFACE_DECLARED_ABSENT, severity info, and a message naming
//     every bound surface and `.devai/config/sensor-inputs.json`; it carries no warning,
//     error, or critical finding.
//   - A sensor that finds evidence of a surface declared false emits `review` with a
//     finding coded SURFACE_DECLARATION_CONTRADICTED whose message names what it found
//     (an endpoint or route path, a table, a role table, a PII table or column, the
//     action registry or an action id).
//   - Without `surfaces` every surface is presumed present: no reading is skipped and
//     no SURFACE_* finding appears.
//   - With actions true, plant_coverage and inventory_coverage read
//     `<repoRoot>/law/policy/action-registry.json` (`entries[].action_id`) and link each
//     entry through `refs.actionRefs[].id` in use-case steps under
//     `<repoRoot>/product/use-cases`. They report metrics `action_count`,
//     `linked_action_count`, and `action_coverage_pct` (0 to 100). Every action linked
//     reads pass; an unlinked action reads review with a finding naming its action_id,
//     the way an unmapped route reads today. With http false they raise no finding for a
//     missing api-map or routes-inventory body.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senseInventoryApi, type InventoryApiOptions } from '../src/inventory-api.js';
import {
  senseInventoryCoverage,
  type InventoryCoverageOptions,
} from '../src/inventory-coverage.js';
import {
  senseInventoryDataHandling,
  type InventoryDataHandlingOptions,
} from '../src/inventory-data-handling.js';
import {
  senseInventoryDataModel,
  type InventoryDataModelOptions,
} from '../src/inventory-data-model.js';
import {
  senseInventoryPerformance,
  type InventoryPerformanceOptions,
} from '../src/inventory-performance.js';
import { senseInventoryRbac, type InventoryRbacOptions } from '../src/inventory-rbac.js';
import { senseInventoryRoutes, type InventoryRoutesOptions } from '../src/inventory-routes.js';
import { sensePlantCoverage, type PlantCoverageOptions } from '../src/plant-coverage.js';
import type { SensorReading } from '../src/sensor-reading.js';

/** The surfaces object of the sensor inputs declaration (ADR-SCR-0003). */
interface DeclaredSurfaces {
  readonly http: boolean;
  readonly database: boolean;
  readonly rbac: boolean;
  readonly actions: boolean;
}
type Surface = keyof DeclaredSurfaces;

/** A sensor's options widened by the declared `surfaces` the adapters deliver. */
type Surfaced<T> = T & { readonly surfaces?: DeclaredSurfaces };

const NOW = '2026-09-27T00:00:00.000Z';
const DECLARATION_FILE = '.devai/config/sensor-inputs.json';
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const ALL_PRESENT: DeclaredSurfaces = { http: true, database: true, rbac: true, actions: true };
const ALL_ABSENT: DeclaredSurfaces = { http: false, database: false, rbac: false, actions: false };
const ACTIONS_ONLY: DeclaredSurfaces = { http: false, database: false, rbac: false, actions: true };

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

interface RegistryEntry {
  readonly action_id: string;
  readonly status: string;
}
interface Registry {
  readonly counts: Readonly<Record<string, number>>;
  readonly entries: readonly RegistryEntry[];
}

const realRegistry = JSON.parse(
  readFileSync(join(REPO_ROOT, 'law/policy/action-registry.json'), 'utf8'),
) as Registry;
/** Four real registry entries, so a sensor that validates the registry accepts them. */
const FIXTURE_ACTIONS = realRegistry.entries.slice(0, 4);
const FIXTURE_ACTION_IDS = FIXTURE_ACTIONS.map((entry) => entry.action_id);

function writeRegistry(root: string): void {
  const counts: Record<string, number> = { stable: 0, preview: 0, internal: 0 };
  for (const entry of FIXTURE_ACTIONS) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  counts.total = FIXTURE_ACTIONS.length;
  write(
    root,
    'law/policy/action-registry.json',
    JSON.stringify({ ...realRegistry, counts, entries: FIXTURE_ACTIONS }, null, 2) + '\n',
  );
}

interface StepRefs {
  readonly actionRefs?: ReadonlyArray<{ readonly id: string }>;
  readonly routeIds?: readonly string[];
  readonly endpointIds?: readonly string[];
}

function writeUseCases(root: string, stepRefs: readonly StepRefs[]): void {
  write(
    root,
    'product/use-cases/fixture.json',
    JSON.stringify({
      schemaVersion: '1.0.0',
      roles: ['operator'],
      cases: [
        {
          id: 'UC-fixture',
          title: 'Exercise the fixture surfaces',
          mainFlow: stepRefs.map((refs, index) => ({
            id: `step-${String(index + 1).padStart(2, '0')}`,
            action: `Step ${String(index + 1)}`,
            actorRole: 'operator',
            refs,
          })),
        },
      ],
    }),
  );
}

function actionSteps(ids: readonly string[]): StepRefs[] {
  return ids.map((id) => ({ actionRefs: [{ id }] }));
}

function writeDeclaration(root: string, surfaces: DeclaredSurfaces): void {
  write(root, DECLARATION_FILE, JSON.stringify({ schemaVersion: '1.0.0', inputs: {}, surfaces }));
}

function writeInventoryTimings(root: string): void {
  for (const [kind, duration] of [
    ['inventory_api', 120],
    ['inventory_coverage', 80],
  ] as const) {
    write(
      root,
      `record/proofs/sensor-readings/${kind}/SR-${kind}.json`,
      JSON.stringify({ sensor: { kind }, duration_ms: duration }),
    );
  }
}

/**
 * A command-line product: no routes, tables, or roles; four registered actions and a
 * use case linking `linked` of them; a declaration naming only actions.
 */
function cliFixture(linked: readonly string[] = FIXTURE_ACTION_IDS): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-declared-surfaces-cli-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'fixture-cli', bin: { fx: 'bin.js' } }));
  write(
    root,
    'src/cli.ts',
    'export function main(argv: readonly string[]): number { return argv.length > 0 ? 0 : 1; }\n',
  );
  writeRegistry(root);
  writeUseCases(root, actionSteps(linked));
  writeDeclaration(root, ACTIONS_ONLY);
  writeInventoryTimings(root);
  return root;
}

const CONTROLLER = `
  @Controller('/users')
  @UseGuards(SessionGuard)
  export class UsersController {
    @Get(':id')
    @Roles(AdminRole, 'reader')
    getOne(@Param('id') id: string) {}

    @Post()
    @Roles(AdminRole)
    create(@Body() body: unknown) {}
  }
`;

const ROUTES = `
  export const router = createBrowserRouter([
    { path: '/users/:id', element: <UserPage /> },
    { path: '/settings', element: <Settings /> },
  ]);
`;

const SCHEMA_SQL = `
  CREATE TABLE auth.roles (
    id uuid PRIMARY KEY,
    name varchar(100) NOT NULL
  );
  CREATE TABLE auth.permissions (
    id uuid PRIMARY KEY,
    name text NOT NULL
  );
  CREATE TABLE auth.role_permissions (
    role_id uuid NOT NULL REFERENCES auth.roles(id),
    permission_id uuid NOT NULL REFERENCES auth.permissions(id),
    PRIMARY KEY (role_id, permission_id)
  );
  CREATE TABLE app.users (
    id bigint PRIMARY KEY,
    email text NOT NULL, -- @pii_class: contact @legal_basis: contract @retention: P2Y
    password_hash varchar(255),
    full_name text,
    role_id uuid REFERENCES auth.roles(id)
  );
`;

interface ServiceFixture {
  readonly root: string;
  readonly endpointPaths: readonly string[];
  readonly routePaths: readonly string[];
  readonly tableNames: readonly string[];
}

/**
 * A service: NestJS endpoints, React routes, SQL tables with roles and PII columns,
 * the four registered actions, inventory bodies at their default paths, and a use
 * case linking every route, endpoint, and action. The declaration names `surfaces`.
 */
function serviceFixture(surfaces: DeclaredSurfaces): ServiceFixture {
  const root = mkdtempSync(join(tmpdir(), 'devai-declared-surfaces-service-'));
  roots.push(root);
  write(root, 'apps/api/users.controller.ts', CONTROLLER);
  write(root, 'apps/web/routes.tsx', ROUTES);
  write(root, 'database/001-schema.sql', SCHEMA_SQL);
  writeRegistry(root);
  writeDeclaration(root, surfaces);
  writeInventoryTimings(root);

  // Inventory bodies produced with no declaration, where every surface is presumed.
  const api = senseInventoryApi({ repoRoot: root, persistBody: false, now: NOW });
  const routes = senseInventoryRoutes({
    repoRoot: root,
    scanDirs: ['apps/web'],
    framework: 'react',
    persistBody: false,
    now: NOW,
  });
  const model = senseInventoryDataModel({
    repoRoot: root,
    migrationDirs: ['database'],
    persistBody: false,
    now: NOW,
  });
  write(root, 'record/proofs/sensors/inventory_api/api-map.json', JSON.stringify(api.body));
  write(
    root,
    // The one name both plant_coverage (its default) and inventory_coverage resolve.
    'record/proofs/sensors/inventory_routes/routes-inventory.json',
    JSON.stringify(routes.body),
  );
  write(
    root,
    'record/proofs/sensors/inventory_data_model/data-model.json',
    JSON.stringify(model.body),
  );
  writeUseCases(root, [
    {
      routeIds: routes.body.routes.map((route) => route.id),
      endpointIds: api.body.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    },
    ...actionSteps(FIXTURE_ACTION_IDS),
  ]);
  return {
    root,
    endpointPaths: api.body.endpoints.map((endpoint) => endpoint.path),
    routePaths: routes.body.routes.map((route) => route.path).filter((path) => path.length > 1),
    tableNames: model.body.tables.map((table) => table.name),
  };
}

type SensorName =
  | 'inventory_api'
  | 'inventory_routes'
  | 'inventory_data_model'
  | 'inventory_rbac'
  | 'inventory_data_handling'
  | 'inventory_coverage'
  | 'plant_coverage'
  | 'inventory_performance';

const BINDINGS: Readonly<Record<SensorName, readonly Surface[]>> = {
  inventory_api: ['http'],
  inventory_routes: ['http'],
  inventory_data_model: ['database'],
  inventory_rbac: ['rbac'],
  inventory_data_handling: ['rbac'],
  inventory_coverage: ['http', 'actions'],
  plant_coverage: ['http', 'actions'],
  inventory_performance: ['http', 'database', 'rbac', 'actions'],
};

/** Run one sensor against `root` with `surfaces` (omitted: no declaration). */
function sense(name: SensorName, root: string, surfaces?: DeclaredSurfaces): SensorReading {
  const declared = surfaces === undefined ? {} : { surfaces };
  switch (name) {
    case 'inventory_api': {
      const opts: Surfaced<InventoryApiOptions> = {
        repoRoot: root,
        persistBody: false,
        now: NOW,
        ...declared,
      };
      return senseInventoryApi(opts).reading;
    }
    case 'inventory_routes': {
      const opts: Surfaced<InventoryRoutesOptions> = {
        repoRoot: root,
        framework: 'react',
        persistBody: false,
        now: NOW,
        ...declared,
      };
      return senseInventoryRoutes(opts).reading;
    }
    case 'inventory_data_model': {
      const opts: Surfaced<InventoryDataModelOptions> = {
        repoRoot: root,
        persistBody: false,
        now: NOW,
        ...declared,
      };
      return senseInventoryDataModel(opts).reading;
    }
    case 'inventory_rbac': {
      const opts: Surfaced<InventoryRbacOptions> = {
        repoRoot: root,
        persistBody: false,
        now: NOW,
        ...declared,
      };
      return senseInventoryRbac(opts).reading;
    }
    case 'inventory_data_handling': {
      const opts: Surfaced<InventoryDataHandlingOptions> = {
        repoRoot: root,
        persistBody: false,
        now: NOW,
        ...declared,
      };
      return senseInventoryDataHandling(opts).reading;
    }
    case 'inventory_coverage': {
      const opts: Surfaced<InventoryCoverageOptions> = {
        repoRoot: root,
        persistBody: false,
        now: NOW,
        ...declared,
      };
      return senseInventoryCoverage(opts).reading;
    }
    case 'plant_coverage': {
      const opts: Surfaced<PlantCoverageOptions> = { repoRoot: root, now: NOW, ...declared };
      return sensePlantCoverage(opts);
    }
    case 'inventory_performance': {
      const opts: Surfaced<InventoryPerformanceOptions> = {
        repoRoot: root,
        now: NOW,
        ...declared,
      };
      return senseInventoryPerformance(opts);
    }
  }
}

function codes(reading: SensorReading): string[] {
  return (reading.findings ?? []).map((finding) => finding.code);
}

function expectSkippedByDeclaration(reading: SensorReading, surfaces: readonly Surface[]): void {
  expect(reading.status, JSON.stringify(reading.findings)).toBe('skipped');
  const first = reading.findings?.[0];
  expect(first).toMatchObject({ code: 'SURFACE_DECLARED_ABSENT', severity: 'info' });
  expect(first?.message).toContain(DECLARATION_FILE);
  for (const surface of surfaces) expect(first?.message).toContain(surface);
  // IA-001: a skip carries no review or fail finding.
  expect((reading.findings ?? []).every((finding) => finding.severity === 'info')).toBe(true);
}

function expectMeasured(reading: SensorReading): void {
  expect(reading.status, JSON.stringify(reading.findings)).not.toBe('skipped');
  expect(codes(reading).filter((code) => code.startsWith('SURFACE_'))).toEqual([]);
}

function contradiction(reading: SensorReading): string[] {
  return (reading.findings ?? [])
    .filter((finding) => finding.code === 'SURFACE_DECLARATION_CONTRADICTED')
    .map((finding) => finding.message);
}

function expectContradicted(reading: SensorReading, found: readonly string[]): void {
  expect(reading.status, JSON.stringify(reading.findings)).toBe('review');
  const messages = contradiction(reading);
  expect(messages.length, JSON.stringify(reading.findings)).toBeGreaterThan(0);
  expect(
    messages.some((message) => found.some((item) => message.includes(item))),
    `expected a contradiction naming one of ${found.join(', ')}: ${messages.join(' | ')}`,
  ).toBe(true);
  expect(codes(reading)).not.toContain('SURFACE_DECLARED_ABSENT');
}

describe('IA-001: a sensor bound to a declared-absent surface skips with the declaration', () => {
  const absentBound: readonly SensorName[] = [
    'inventory_api',
    'inventory_routes',
    'inventory_data_model',
    'inventory_rbac',
    'inventory_data_handling',
  ];

  it.each(absentBound)(
    '%s skips on the CLI fixture that declares http, database, and rbac absent',
    (name) => {
      const root = cliFixture();
      expectSkippedByDeclaration(sense(name, root, ACTIONS_ONLY), BINDINGS[name]);
    },
  );

  it.each(['inventory_coverage', 'plant_coverage', 'inventory_performance'] as const)(
    '%s skips when every surface it is bound to is declared absent',
    (name) => {
      const root = cliFixture();
      writeDeclaration(root, ALL_ABSENT);
      rmSync(join(root, 'law'), { recursive: true, force: true });
      expectSkippedByDeclaration(sense(name, root, ALL_ABSENT), BINDINGS[name]);
    },
  );

  it.each(['inventory_coverage', 'plant_coverage', 'inventory_performance'] as const)(
    '%s still measures on the CLI fixture because actions is declared present',
    (name) => {
      expectMeasured(sense(name, cliFixture(), ACTIONS_ONLY));
    },
  );
});

describe('a declared-present surface is measured as before', () => {
  const all = Object.keys(BINDINGS) as SensorName[];

  it.each(all)('%s measures the service fixture that declares every surface', (name) => {
    const service = serviceFixture(ALL_PRESENT);
    const reading = sense(name, service.root, ALL_PRESENT);
    expectMeasured(reading);
    if (name !== 'inventory_performance') {
      expect(reading.status, JSON.stringify(reading.findings)).toBe('pass');
    }
  });

  it.each(all)('%s presumes every surface present when the declaration is omitted', (name) => {
    expectMeasured(sense(name, cliFixture(), undefined));
  });

  it('keeps the endpoint and route counts of a service beside its action measurement', () => {
    const service = serviceFixture(ALL_PRESENT);
    for (const name of ['plant_coverage', 'inventory_coverage'] as const) {
      const reading = sense(name, service.root, ALL_PRESENT);
      expect(reading.metrics?.endpoint_count).toBe(service.endpointPaths.length);
      expect(reading.metrics?.route_count).toBeGreaterThan(0);
      expect(reading.metrics?.action_count).toBe(FIXTURE_ACTIONS.length);
      expect(reading.metrics?.action_coverage_pct).toBe(100);
    }
  });
});

describe('IA-003: a declaration that names a present surface absent is caught, not skipped', () => {
  it('http: inventory_api reports the endpoints it found', () => {
    const service = serviceFixture(ALL_ABSENT);
    expectContradicted(sense('inventory_api', service.root, ALL_ABSENT), service.endpointPaths);
  });

  it('http: inventory_routes reports the routes it found', () => {
    const service = serviceFixture(ALL_ABSENT);
    const opts: Surfaced<InventoryRoutesOptions> = {
      repoRoot: service.root,
      scanDirs: ['apps/web'],
      framework: 'react',
      persistBody: false,
      now: NOW,
      surfaces: ALL_ABSENT,
    };
    expectContradicted(senseInventoryRoutes(opts).reading, service.routePaths);
  });

  it('database: inventory_data_model reports the tables it found', () => {
    const service = serviceFixture(ALL_ABSENT);
    expectContradicted(sense('inventory_data_model', service.root, ALL_ABSENT), service.tableNames);
  });

  it('rbac: inventory_rbac reports the role tables it found', () => {
    const service = serviceFixture(ALL_ABSENT);
    expectContradicted(sense('inventory_rbac', service.root, ALL_ABSENT), [
      'roles',
      'permissions',
      'role_permissions',
    ]);
  });

  it('rbac: inventory_data_handling reports the PII-bearing columns it found', () => {
    const service = serviceFixture(ALL_ABSENT);
    expectContradicted(sense('inventory_data_handling', service.root, ALL_ABSENT), [
      'users',
      'email',
      'password_hash',
      'full_name',
    ]);
  });

  it.each(['plant_coverage', 'inventory_coverage'] as const)(
    'actions: %s reports the registered actions it found',
    (name) => {
      const root = cliFixture();
      writeDeclaration(root, ALL_ABSENT);
      expectContradicted(sense(name, root, ALL_ABSENT), [
        'law/policy/action-registry.json',
        ...FIXTURE_ACTION_IDS,
      ]);
    },
  );

  it('a contradicted surface is never recorded as skipped by any sensor bound to it', () => {
    const service = serviceFixture(ALL_ABSENT);
    for (const name of Object.keys(BINDINGS) as SensorName[]) {
      if (name === 'inventory_performance') continue;
      expect(sense(name, service.root, ALL_ABSENT).status, name).not.toBe('skipped');
    }
  });
});

describe('IA-004: with actions declared present the action registry is measured', () => {
  it.each(['plant_coverage', 'inventory_coverage'] as const)(
    '%s passes at 100 percent when every action has a specification link',
    (name) => {
      const reading = sense(name, cliFixture(), ACTIONS_ONLY);
      expect(reading.status, JSON.stringify(reading.findings)).toBe('pass');
      expect(reading.metrics).toMatchObject({
        action_count: FIXTURE_ACTIONS.length,
        linked_action_count: FIXTURE_ACTIONS.length,
        action_coverage_pct: 100,
      });
      expect(codes(reading)).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/NO_INVENTORY|REQUIRES_API_MAP|REQUIRES_ROUTES/),
        ]),
      );
    },
  );

  it.each(['plant_coverage', 'inventory_coverage'] as const)(
    '%s reads review at 75 percent and names the unlinked action',
    (name) => {
      const [unlinked, ...linked] = FIXTURE_ACTION_IDS;
      const reading = sense(name, cliFixture(linked), ACTIONS_ONLY);
      expect(reading.status, JSON.stringify(reading.findings)).toBe('review');
      expect(reading.metrics).toMatchObject({
        action_count: 4,
        linked_action_count: 3,
        action_coverage_pct: 75,
      });
      expect(
        (reading.findings ?? []).some((finding) => finding.message.includes(unlinked ?? '')),
        JSON.stringify(reading.findings),
      ).toBe(true);
    },
  );

  it.each(['plant_coverage', 'inventory_coverage'] as const)(
    '%s ignores a use-case reference to an action the registry does not hold',
    (name) => {
      const root = cliFixture();
      writeUseCases(root, actionSteps([...FIXTURE_ACTION_IDS.slice(1), 'not a registered action']));
      const reading = sense(name, root, ACTIONS_ONLY);
      expect(reading.status).toBe('review');
      expect(reading.metrics).toMatchObject({ linked_action_count: 3, action_coverage_pct: 75 });
    },
  );
});
