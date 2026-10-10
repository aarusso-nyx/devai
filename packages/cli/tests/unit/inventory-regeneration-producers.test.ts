// #382 (2.3.1): regeneration drives each kind's typed producer with persistBody false, in
// dependency order, handing each dependent the staged paths of its inputs; a required
// producer that does not measure fails the run and publishes nothing.
// Contract: law/policy/sensor-notes/inventory_regeneration.md (amended 2026-10-09).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SensorStatus } from '@devai-nyx/sensors';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  INVENTORY_BODY_PATH,
  regenerateInventoryReadings,
} from '../../src/commands/sense/readings-rebuild.js';
import {
  ALL_SURFACES,
  PROOF_BODY,
  STATE_BODY,
  STATE_KINDS,
  adopter,
  put,
  read,
  type AdopterFixture,
} from './inventory-regeneration-adopter-fixture.js';

const PRODUCERS = vi.hoisted(
  () =>
    ({
      senseInventoryApi: 'inventory_api',
      senseInventoryRoutes: 'inventory_routes',
      senseInventoryDataModel: 'inventory_data_model',
      senseInventoryRbac: 'inventory_rbac',
      senseInventoryDataHandling: 'inventory_data_handling',
      senseInventoryDepGraph: 'inventory_dep_graph',
      senseInventoryCoverage: 'inventory_coverage',
    }) as const,
);
type ProducerName = keyof typeof PRODUCERS;

interface ProducerCall {
  readonly kind: string;
  readonly options: Readonly<Record<string, unknown>>;
  /** The bytes at each input path option at the moment the producer ran. */
  readonly inputs: Readonly<Record<string, string | null>>;
}

const control = vi.hoisted(() => ({
  calls: [] as ProducerCall[],
  /** Override a producer's reading status, keeping its real body. */
  status: {} as Partial<Record<string, SensorStatus>>,
  /** Replace a producer's body, keeping its real reading. */
  body: {} as Partial<Record<string, unknown>>,
}));

vi.mock('@devai-nyx/sensors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/sensors')>();
  const { readFileSync: readBytes } = await import('node:fs');
  const wrap = (name: ProducerName) => {
    const kind = PRODUCERS[name];
    const original = actual[name] as unknown as (options: Record<string, unknown>) => {
      reading: import('@devai-nyx/sensors').SensorReading;
      body: unknown;
    };
    return (options: Record<string, unknown>) => {
      const inputs: Record<string, string | null> = {};
      for (const key of ['dataModelPath', 'apiMapPath', 'routesPath']) {
        const path = options[key];
        if (typeof path !== 'string') continue;
        try {
          inputs[key] = readBytes(path, 'utf8');
        } catch {
          inputs[key] = null;
        }
      }
      control.calls.push({ kind, options: { ...options }, inputs });
      const result = original(options);
      const status = control.status[kind];
      const reading =
        status === undefined
          ? result.reading
          : actual.buildSensorReading({
              sensorName: result.reading.sensor.name,
              sensorKind: result.reading.sensor.kind as import('@devai-nyx/sensors').SensorKind,
              command: [result.reading.command],
              status,
              deterministic: true,
              tier: 'L0',
              findings: [{ severity: 'error', code: 'FIXTURE_PRODUCER_STATUS', message: status }],
            });
      return { ...result, reading, body: kind in control.body ? control.body[kind] : result.body };
    };
  };
  return {
    ...actual,
    ...Object.fromEntries(
      (Object.keys(PRODUCERS) as ProducerName[]).map((name) => [name, wrap(name)]),
    ),
  };
});

const fixtures: AdopterFixture[] = [];

afterEach(() => {
  control.calls.length = 0;
  control.status = {};
  control.body = {};
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixture(extra?: Readonly<Record<string, string>>): AdopterFixture {
  const created = adopter(extra);
  fixtures.push(created);
  return created;
}

async function regenerate(root: string) {
  return withAuthorityHostTestScope(() =>
    regenerateInventoryReadings(root, { surfaces: ALL_SURFACES }),
  );
}

function callOf(kind: string): ProducerCall {
  const call = control.calls.find((entry) => entry.kind === kind);
  if (call === undefined) throw new Error(`producer ${kind} was not called`);
  return call;
}

/** Earlier published bodies, to show a failed run leaves them byte-identical. */
function seedEarlierBodies(root: string): Readonly<Record<string, string>> {
  const earlier: Record<string, string> = { [INVENTORY_BODY_PATH]: '{"earlier":"manifest"}\n' };
  for (const kind of STATE_KINDS) earlier[STATE_BODY[kind]] = `{"earlier":"${kind}"}\n`;
  for (const [path, body] of Object.entries(earlier)) put(root, path, body);
  return earlier;
}

describe('regeneration drives the typed producers in dependency order (#382)', () => {
  it('calls every producer once with persistBody false, inputs before their dependents', async () => {
    const { root } = fixture();

    const result = await regenerate(root);

    expect(result.report.ok).toBe(true);
    const order = control.calls.map(({ kind }) => kind);
    expect([...order].sort()).toEqual([...STATE_KINDS].sort());
    for (const call of control.calls) {
      expect(call.options, call.kind).toMatchObject({ repoRoot: root, persistBody: false });
    }
    const at = (kind: string) => order.indexOf(kind);
    for (const dependent of ['inventory_rbac', 'inventory_data_handling', 'inventory_coverage']) {
      for (const input of ['inventory_api', 'inventory_routes', 'inventory_data_model']) {
        expect(at(dependent), `${input} before ${dependent}`).toBeGreaterThan(at(input));
      }
    }
  });

  it('hands each dependent the staged bytes of its inputs, never a published or proof path', async () => {
    const { root } = fixture({ [PROOF_BODY.inventory_data_model]: '{"tables":[]}\n' });
    put(root, STATE_BODY.inventory_api, '{"endpoints":[]}\n');

    const result = await regenerate(root);
    expect(result.report.ok).toBe(true);

    const published = (kind: keyof typeof STATE_BODY) => read(root, STATE_BODY[kind]);
    const expectStaged = (dependent: string, option: string, input: keyof typeof STATE_BODY) => {
      const call = callOf(dependent);
      const path = call.options[option];
      expect(typeof path, `${dependent}.${option}`).toBe('string');
      expect(path, `${dependent}.${option}`).not.toBe(join(root, STATE_BODY[input]));
      expect(String(path), `${dependent}.${option}`).not.toContain('record/proofs/');
      // The staged bytes are exactly the body that was then published for the input kind.
      expect(JSON.parse(call.inputs[option] ?? 'null'), `${dependent}.${option}`).toEqual(
        JSON.parse(published(input)),
      );
    };
    expectStaged('inventory_rbac', 'dataModelPath', 'inventory_data_model');
    expectStaged('inventory_rbac', 'apiMapPath', 'inventory_api');
    expectStaged('inventory_data_handling', 'dataModelPath', 'inventory_data_model');
    expectStaged('inventory_coverage', 'apiMapPath', 'inventory_api');
    expectStaged('inventory_coverage', 'routesPath', 'inventory_routes');
    // No staged input outlives the run.
    for (const call of control.calls) {
      for (const key of ['dataModelPath', 'apiMapPath', 'routesPath']) {
        const path = call.options[key];
        if (typeof path !== 'string') continue;
        const isPublished = (Object.values(STATE_BODY) as string[]).some(
          (body) => join(root, body) === path,
        );
        if (!isPublished) expect(existsSync(path), path).toBe(false);
      }
    }
  });

  it('passes no input path for a kind whose surface is declared absent', async () => {
    const { root } = fixture();

    await withAuthorityHostTestScope(() =>
      regenerateInventoryReadings(root, {
        surfaces: { http: false, database: false, rbac: false, actions: true },
      }),
    );

    expect(control.calls.map(({ kind }) => kind).sort()).toEqual([
      'inventory_coverage',
      'inventory_dep_graph',
    ]);
    const coverage = callOf('inventory_coverage');
    expect(coverage.options['apiMapPath']).toBeUndefined();
    expect(coverage.options['routesPath']).toBeUndefined();
  });
});

describe('a producer that does not measure is never published as PASS (#382)', () => {
  it.each([
    ['inventory_rbac', 'fail'],
    ['inventory_data_handling', 'unknown'],
    ['inventory_api', 'skipped'],
    ['inventory_data_model', 'error'],
    ['inventory_routes', 'fail'],
  ] as const)('%s reading %s fails the run and publishes nothing', async (kind, status) => {
    const { root } = fixture();
    const earlier = seedEarlierBodies(root);
    control.status[kind] = status;

    const result = await regenerate(root);

    expect(result.reading.status).toBe('fail');
    expect(result.report).toMatchObject({ ok: false, regenerated: [], obsolete: [] });
    expect(result.report.errors.join('\n')).toContain(kind);
    expect(result.reading.metrics?.[`${kind}_status`]).not.toBe('pass');
    expect(result.reading.metrics).toMatchObject({ kinds_touched: 0 });
    for (const [path, body] of Object.entries(earlier)) {
      expect(readFileSync(join(root, path), 'utf8'), path).toBe(body);
    }
  });

  it('keeps a producer REVIEW as REVIEW and publishes it', async () => {
    const { root } = fixture();
    control.status['inventory_rbac'] = 'review';

    const result = await regenerate(root);

    expect(result.reading.status).toBe('review');
    expect(result.reading.metrics).toMatchObject({ inventory_rbac_status: 'review' });
    expect(result.report.ok).toBe(true);
    expect(existsSync(join(root, STATE_BODY.inventory_rbac))).toBe(true);
  });

  it.each(['inventory_api', 'inventory_routes', 'inventory_data_model', 'inventory_rbac'] as const)(
    'refuses a schema-invalid %s body before publishing anything',
    async (kind) => {
      const { root } = fixture();
      const earlier = seedEarlierBodies(root);
      control.body[kind] = { schemaVersion: '1.0.0', bogus: true };

      const result = await regenerate(root);

      expect(result.reading.status).toBe('fail');
      expect(result.report.regenerated).toEqual([]);
      expect(result.report.errors.join('\n')).toMatch(/schema/u);
      for (const [path, body] of Object.entries(earlier)) {
        expect(readFileSync(join(root, path), 'utf8'), path).toBe(body);
      }
    },
  );
});

// INV-DEVAI-020: portability normalization must not erase a genuine producer path leak.
describe('checkout leak refusal preserves previously published inventory', () => {
  it('rejects an absolute controller/evidence path and rolls back the whole body population', async () => {
    const { root } = fixture();
    const earlier = seedEarlierBodies(root);
    const source = join(root, 'apps/api/users.controller.ts');
    control.body['inventory_api'] = {
      schemaVersion: '1.0.0',
      generatedAt: '2026-10-10T09:00:00.000Z',
      sourceRepo: root,
      endpoints: [
        {
          method: 'GET',
          path: '/users',
          controller: { file: source },
          evidence: [{ path: source, startLine: 1, endLine: 1 }],
        },
      ],
    };
    const result = await regenerate(root);
    expect(result.reading.status).toBe('fail');
    expect(result.report.ok).toBe(false);
    expect(result.report.errors.join('\n')).toContain('absolute checkout location');
    expect(result.report.regenerated).toEqual([]);
    for (const [path, body] of Object.entries(earlier)) {
      expect(readFileSync(join(root, path), 'utf8'), path).toBe(body);
    }
  });
});
