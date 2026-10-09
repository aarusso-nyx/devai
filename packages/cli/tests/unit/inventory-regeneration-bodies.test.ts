// #382 (2.3.1): `sense run inventory_regeneration` produces every body whose plant surface is
// declared present, so the read-only sweep's dependents measure in an adopter instead of
// reading their inputs missing. Contract: law/policy/sensor-notes/inventory_regeneration.md
// (amended 2026-10-09) and docs/adopters/sensor-inputs.md "Producing the inventory bodies".
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import {
  senseInventoryApi,
  senseInventoryDataModel,
  senseInventoryRoutes,
  type SensorKind,
  type SensorReading,
} from '@devai-nyx/sensors';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { sensorAdapter } from '../../src/commands/sense/adapters.js';
import {
  INVENTORY_BODY_PATH,
  regenerateInventoryReadings,
  type RegenerationOptions,
} from '../../src/commands/sense/readings-rebuild.js';
import {
  ALL_SURFACES,
  PROOF_BODY,
  STATE_BODY,
  STATE_KINDS,
  adopter,
  git,
  put,
  read,
  type AdopterFixture,
  type StateKind,
} from './inventory-regeneration-adopter-fixture.js';

const fixtures: AdopterFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixture(extra?: Readonly<Record<string, string>>): AdopterFixture {
  const created = adopter(extra);
  fixtures.push(created);
  return created;
}

async function regenerate(root: string, options?: RegenerationOptions) {
  return withAuthorityHostTestScope(() => regenerateInventoryReadings(root, options));
}

async function sweep(
  root: string,
  kind: SensorKind,
  surfaces: RegenerationOptions['surfaces'] = ALL_SURFACES,
): Promise<SensorReading> {
  return withAuthorityHostTestScope(async () =>
    sensorAdapter(kind)({ repoRoot: root, inputs: { surfaces } }),
  );
}

/** Run the direct producers, which write their own record/proofs defaults. */
async function produceProofDefaults(
  root: string,
  kinds: readonly ('api' | 'routes' | 'data-model')[],
): Promise<void> {
  await withAuthorityHostTestScope(async () => {
    if (kinds.includes('api')) senseInventoryApi({ repoRoot: root });
    if (kinds.includes('routes')) senseInventoryRoutes({ repoRoot: root });
    if (kinds.includes('data-model')) senseInventoryDataModel({ repoRoot: root });
  });
}

function json(root: string, path: string): Record<string, unknown> {
  return JSON.parse(read(root, path)) as Record<string, unknown>;
}

function codes(reading: SensorReading): string[] {
  return (reading.findings ?? []).map((finding) => finding.code);
}

/** Every file under the given directories with its bytes, so a run can be shown to write nothing. */
function snapshot(root: string, directories: readonly string[]): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (absolute: string): void => {
    if (!existsSync(absolute)) return;
    if (statSync(absolute).isDirectory()) {
      for (const name of readdirSync(absolute)) walk(join(absolute, name));
      return;
    }
    files[relative(root, absolute)] = readFileSync(absolute, 'utf8');
  };
  for (const directory of directories) walk(join(root, directory));
  return files;
}

const BODY_VALIDATORS: Readonly<Record<StateKind, (value: unknown) => boolean>> = {
  inventory_api: validators.apiMap,
  inventory_routes: validators.routesInventory,
  inventory_data_model: validators.dataModelInventory,
  inventory_rbac: validators.rbacInventory,
  inventory_data_handling: validators.dataModelInventory,
  inventory_dep_graph: validators.depGraph,
  inventory_coverage: validators.coverageMatrix,
};

describe('inventory regeneration produces every surface-declared body (#382)', () => {
  it('regenerates all seven kinds at HEAD when every surface is declared present', async () => {
    const { root, head } = fixture();

    const result = await regenerate(root, { surfaces: ALL_SURFACES });

    // A producer REVIEW (coverage with no authored use cases) is kept; nothing reads FAIL.
    expect(['pass', 'review']).toContain(result.reading.status);
    expect(result.report).toMatchObject({ ok: true, integration_head: head, errors: [] });
    expect(result.reading.metrics).toMatchObject({
      required_kinds: 7,
      missing_required_kinds: 0,
      kinds_touched: 7,
      error_count: 0,
      integration_head: head,
      inventory_api_status: 'pass',
      inventory_routes_status: 'pass',
      inventory_data_model_status: 'pass',
      inventory_rbac_status: 'pass',
      inventory_data_handling_status: 'pass',
      inventory_dep_graph_status: 'pass',
    });
    expect(
      result.report.regenerated.map(({ kind, body_path }) => [kind, body_path]).sort(),
    ).toEqual(
      [
        ['inventory', INVENTORY_BODY_PATH],
        ...STATE_KINDS.map((kind) => [kind, STATE_BODY[kind]]),
      ].sort(),
    );
    for (const kind of STATE_KINDS) {
      expect(existsSync(join(root, STATE_BODY[kind])), STATE_BODY[kind]).toBe(true);
      expect(BODY_VALIDATORS[kind](json(root, STATE_BODY[kind])), STATE_BODY[kind]).toBe(true);
      const body = result.report.regenerated.find((entry) => entry.kind === kind);
      expect(body?.producer_reading?.input_binding).toMatchObject({
        integration_head: head,
        body_sha256: body?.sha256,
      });
    }
    // No regenerated kind is ever synthesized from a body file.
    expect(result.report.entries).toEqual([]);
    // The bodies are ignored state, so the tree stays clean for the sweep that follows.
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('names the routes body after its framework and leaves exactly one routes body', async () => {
    const { root } = fixture();
    put(root, '.devai/state/sensors/inventory_routes/routes-angular.json', '{"routes":[]}\n');
    put(root, '.devai/state/sensors/inventory_routes/routes-inventory.json', '{"routes":[]}\n');

    await regenerate(root, { surfaces: ALL_SURFACES });

    expect(readdirSync(join(root, '.devai/state/sensors/inventory_routes'))).toEqual([
      'routes-react.json',
    ]);
    expect(json(root, STATE_BODY.inventory_routes)).toMatchObject({
      framework: 'react',
      routes: [expect.objectContaining({ path: '/users/:id' })],
    });
  });

  it('feeds each dependent the bodies staged in the same run, never a published or proof body', async () => {
    // Decoys in the published state and in the committed proof defaults name a table, a
    // role and an endpoint that the source does not have.
    const decoyModel = `${JSON.stringify({ tables: [{ name: 'decoy_roles', columns: [] }] })}\n`;
    const decoyApi = `${JSON.stringify({
      endpoints: [
        {
          method: 'GET',
          path: '/decoy',
          controller: { file: 'apps/api/decoy.ts' },
          roles: ['decoy'],
        },
      ],
    })}\n`;
    const decoyRoutes = `${JSON.stringify({ framework: 'react', routes: [{ id: 'decoy', path: '/decoy' }] })}\n`;
    const { root } = fixture({
      [PROOF_BODY.inventory_data_model]: decoyModel,
      [PROOF_BODY.inventory_api]: decoyApi,
      [PROOF_BODY.inventory_routes]: decoyRoutes,
    });
    put(root, STATE_BODY.inventory_data_model, decoyModel);
    put(root, STATE_BODY.inventory_api, decoyApi);

    const result = await regenerate(root, { surfaces: ALL_SURFACES });
    expect(result.report.ok).toBe(true);

    // rbac read the staged data model (its RBAC tables) and the staged api map (its @Roles).
    const rbac = read(root, STATE_BODY.inventory_rbac);
    expect(json(root, STATE_BODY.inventory_rbac)).toMatchObject({
      rbacIlfTables: expect.arrayContaining(['roles', 'permissions', 'role_permissions']),
      roles: expect.arrayContaining([expect.objectContaining({ id: 'role:admin' })]),
    });
    expect(rbac).toContain('/users/:id');
    // data handling seeded the staged data model's PII column.
    const handling = read(root, STATE_BODY.inventory_data_handling);
    expect(handling).toContain('email');
    expect(handling).toContain('users');
    // coverage joined the staged api map and routes.
    expect(json(root, STATE_BODY.inventory_coverage)).toMatchObject({
      endpoints: expect.arrayContaining(['GET /users/:id', 'POST /users']),
      stats: { endpointCount: 2, routeCount: 1 },
    });
    for (const kind of [
      'inventory_rbac',
      'inventory_data_handling',
      'inventory_coverage',
    ] as const) {
      expect(read(root, STATE_BODY[kind]), kind).not.toContain('decoy');
    }
    // Regeneration neither writes nor removes the direct sensor defaults.
    expect(read(root, PROOF_BODY.inventory_data_model)).toBe(decoyModel);
    expect(read(root, PROOF_BODY.inventory_api)).toBe(decoyApi);
    expect(read(root, PROOF_BODY.inventory_routes)).toBe(decoyRoutes);
  });

  it('reads UNKNOWN and writes nothing on a dirty tree, whatever surfaces are declared', async () => {
    const { root, head } = fixture();
    put(root, 'apps/api/extra.ts', 'export const extra = 1;\n');

    const result = await regenerate(root, { surfaces: ALL_SURFACES });

    expect(result.reading.status).toBe('unknown');
    expect(codes(result.reading)).toEqual(['INVENTORY_REGENERATION_SOURCE_DIRTY']);
    expect(result.reading.findings?.[0]?.message).toContain(head);
    expect(result.report).toMatchObject({ ok: false, regenerated: [], obsolete: [] });
    expect(existsSync(join(root, '.devai'))).toBe(false);
  });
});

describe('the declared surfaces select the required kinds (#382)', () => {
  it('removes the bodies of surfaces later declared absent and keeps the proof defaults', async () => {
    const proofModel = '{"tables":[]}\n';
    const { root } = fixture({ [PROOF_BODY.inventory_data_model]: proofModel });
    await regenerate(root, { surfaces: ALL_SURFACES });
    for (const kind of STATE_KINDS) expect(existsSync(join(root, STATE_BODY[kind]))).toBe(true);

    const result = await regenerate(root, {
      surfaces: { http: true, database: false, rbac: false, actions: false },
    });

    expect(result.report.ok).toBe(true);
    expect(result.reading.metrics).toMatchObject({
      required_kinds: 4,
      missing_required_kinds: 0,
      obsolete_bodies_removed: 3,
    });
    expect(result.report.obsolete.map(({ kind, body_path }) => [kind, body_path]).sort()).toEqual(
      (['inventory_data_handling', 'inventory_data_model', 'inventory_rbac'] as const).map(
        (kind) => [kind, STATE_BODY[kind]],
      ),
    );
    for (const kind of [
      'inventory_data_model',
      'inventory_rbac',
      'inventory_data_handling',
    ] as const) {
      expect(existsSync(join(root, STATE_BODY[kind])), kind).toBe(false);
    }
    for (const kind of [
      'inventory_api',
      'inventory_routes',
      'inventory_dep_graph',
      'inventory_coverage',
    ] as const) {
      expect(existsSync(join(root, STATE_BODY[kind])), kind).toBe(true);
    }
    expect(read(root, PROOF_BODY.inventory_data_model)).toBe(proofModel);

    const none = await regenerate(root, {
      surfaces: { http: false, database: false, rbac: false, actions: false },
    });
    expect(none.reading.metrics).toMatchObject({ required_kinds: 1, missing_required_kinds: 0 });
    for (const kind of STATE_KINDS.filter((kind) => kind !== 'inventory_dep_graph')) {
      expect(existsSync(join(root, STATE_BODY[kind])), kind).toBe(false);
    }
    expect(readdirSync(join(root, '.devai/state/sensors/inventory_routes'))).toEqual([]);
  });

  it('does not require rbac or data handling without a database to model', async () => {
    const { root } = fixture();

    const result = await regenerate(root, {
      surfaces: { http: true, database: false, rbac: true, actions: false },
    });

    expect(result.report.ok).toBe(true);
    expect(result.report.regenerated.map(({ kind }) => kind).sort()).toEqual(
      [
        'inventory',
        'inventory_api',
        'inventory_coverage',
        'inventory_dep_graph',
        'inventory_routes',
      ].sort(),
    );
    for (const kind of [
      'inventory_data_model',
      'inventory_rbac',
      'inventory_data_handling',
    ] as const) {
      expect(existsSync(join(root, STATE_BODY[kind])), kind).toBe(false);
    }
  });

  it('produces the data model without rbac and data handling when only the database is present', async () => {
    const { root } = fixture();

    const result = await regenerate(root, {
      surfaces: { http: false, database: true, rbac: false, actions: false },
    });

    expect(result.report.ok).toBe(true);
    expect(result.report.regenerated.map(({ kind }) => kind).sort()).toEqual(
      ['inventory', 'inventory_data_model', 'inventory_dep_graph'].sort(),
    );
  });
});

describe('the sweep measures from the regenerated bodies (#382)', () => {
  it('gives every dependent a measured verdict after regeneration, writing nothing itself', async () => {
    const { root } = fixture();
    // Before regeneration the adopter's dependents read their inputs missing (the #382 report).
    expect(codes(await sweep(root, 'plant_coverage'))).toContain('PLANT_COVERAGE_NO_INVENTORY');
    expect(codes(await sweep(root, 'inventory_rbac'))).toContain('RBAC_REQUIRES_DATA_MODEL');
    expect(codes(await sweep(root, 'inventory_adherence'))).toContain(
      'INVENTORY_ADHERENCE_INPUT_MISSING',
    );

    await regenerate(root, { surfaces: ALL_SURFACES });
    const before = snapshot(root, ['.devai/state/sensors', '.devai/state/inventory', 'record']);

    const plant = await sweep(root, 'plant_coverage');
    expect(plant).toMatchObject({
      status: 'pass',
      metrics: expect.objectContaining({ endpoint_count: 2, route_count: 1, missing_files: 0 }),
    });

    const rbac = await sweep(root, 'inventory_rbac');
    expect(rbac.status).toBe('pass');
    expect(codes(rbac)).not.toContain('RBAC_REQUIRES_DATA_MODEL');

    const handling = await sweep(root, 'inventory_data_handling');
    expect(handling.status).toBe('pass');
    expect(codes(handling)).not.toContain('DATA_HANDLING_REQUIRES_DATA_MODEL');

    const coverage = await sweep(root, 'inventory_coverage');
    expect(['pass', 'review']).toContain(coverage.status);
    for (const code of [
      'COVERAGE_REQUIRES_API_MAP',
      'COVERAGE_REQUIRES_ROUTES',
      'COVERAGE_ROUTES_AMBIGUOUS',
    ]) {
      expect(codes(coverage)).not.toContain(code);
    }
    expect(coverage.metrics).toMatchObject({ endpoint_count: 2, route_count: 1 });

    const adherence = await sweep(root, 'inventory_adherence');
    expect(['pass', 'review']).toContain(adherence.status);
    expect(codes(adherence).filter((code) => code.startsWith('INVENTORY_ADHERENCE_INPUT'))).toEqual(
      [],
    );

    for (const reading of [plant, rbac, handling, coverage, adherence]) {
      expect(reading.status, reading.sensor.kind).not.toBe('unknown');
      expect(reading.evidence_path, reading.sensor.kind).toBeUndefined();
    }
    // The sweep stays read-only: persistBody false writes no body anywhere.
    expect(snapshot(root, ['.devai/state/sensors', '.devai/state/inventory', 'record'])).toEqual(
      before,
    );
  });

  it('falls back to the record/proofs defaults when no regenerated body exists', async () => {
    const { root } = fixture();
    // The direct producers write their own defaults, including routes-<framework>.json.
    await produceProofDefaults(root, ['api', 'routes', 'data-model']);
    for (const path of Object.values(PROOF_BODY)) expect(existsSync(join(root, path))).toBe(true);
    expect(existsSync(join(root, '.devai/state/sensors'))).toBe(false);

    const plant = await sweep(root, 'plant_coverage');
    expect(plant).toMatchObject({
      status: 'pass',
      metrics: expect.objectContaining({ endpoint_count: 2, route_count: 1 }),
    });
    const rbac = await sweep(root, 'inventory_rbac');
    expect(rbac.status).toBe('pass');
    expect(codes(rbac)).not.toContain('RBAC_REQUIRES_DATA_MODEL');
    expect((await sweep(root, 'inventory_data_handling')).status).toBe('pass');
    expect((await sweep(root, 'inventory_coverage')).metrics).toMatchObject({
      endpoint_count: 2,
      route_count: 1,
    });
  });

  it('prefers the regenerated state body to the record/proofs default', async () => {
    const { root } = fixture();
    await produceProofDefaults(root, ['api', 'routes']);
    // A state api map with one more endpoint, whose controller file does not exist.
    const proof = json(root, PROOF_BODY.inventory_api) as { endpoints: Record<string, unknown>[] };
    const extra = {
      ...proof.endpoints[0],
      method: 'DELETE',
      controller: { file: 'apps/api/gone.ts' },
    };
    put(
      root,
      STATE_BODY.inventory_api,
      `${JSON.stringify({ ...proof, endpoints: [...proof.endpoints, extra] })}\n`,
    );

    const plant = await sweep(root, 'plant_coverage');

    expect(plant.status).toBe('review');
    expect(plant.metrics).toMatchObject({ endpoint_count: 3, missing_files: 1 });
    expect(codes(plant)).toContain('PLANT_COVERAGE_MISSING_CONTROLLER_FILE');
  });

  it('never guesses between two routes bodies in one directory', async () => {
    const { root } = fixture();
    await regenerate(root, { surfaces: ALL_SURFACES });
    const routes = read(root, STATE_BODY.inventory_routes);
    put(root, '.devai/state/sensors/inventory_routes/routes-angular.json', routes);
    // A single proof default must not be consulted while the state directory is ambiguous.
    put(root, PROOF_BODY.inventory_routes, routes);

    const coverage = await sweep(root, 'inventory_coverage');
    expect(codes(coverage)).toContain('COVERAGE_ROUTES_AMBIGUOUS');

    const plant = await sweep(root, 'plant_coverage');
    expect(plant.metrics).toMatchObject({ route_count: 0 });
  });

  it('still reads a lone legacy routes-inventory.json default for plant coverage', async () => {
    const { root } = fixture();
    await produceProofDefaults(root, ['api', 'routes']);
    const routes = read(root, PROOF_BODY.inventory_routes);
    put(root, 'record/proofs/sensors/inventory_routes/routes-inventory.json', routes);
    // Remove the framework-named body so the legacy name is the single candidate.
    unlinkSync(join(root, PROOF_BODY.inventory_routes));

    const plant = await sweep(root, 'plant_coverage');

    expect(plant.metrics).toMatchObject({ route_count: 1 });
  });
});
