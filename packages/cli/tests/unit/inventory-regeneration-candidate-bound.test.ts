// #382 review of #387: every regenerated body describes the candidate commit and nothing
// else. Regeneration reads only files git tracks at HEAD, a body names no checkout
// location, and a consumer that cannot read the regenerated routes directory says so
// instead of falling through to a record/proofs body.
// Contract: law/policy/sensor-notes/inventory_regeneration.md (amended 2026-10-09).
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SensorKind, SensorReading } from '@devai-nyx/sensors';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { sensorAdapter } from '../../src/commands/sense/adapters.js';
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
  git,
  put,
  read,
  type AdopterFixture,
} from './inventory-regeneration-adopter-fixture.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(extra?: Readonly<Record<string, string>>, ignore?: readonly string[]) {
  const created: AdopterFixture = adopter(extra, ignore);
  cleanups.push(created.cleanup);
  return created;
}

async function regenerate(root: string) {
  return withAuthorityHostTestScope(() =>
    regenerateInventoryReadings(root, { surfaces: ALL_SURFACES }),
  );
}

async function sweep(root: string, kind: SensorKind): Promise<SensorReading> {
  return withAuthorityHostTestScope(async () =>
    sensorAdapter(kind)({ repoRoot: root, inputs: { surfaces: ALL_SURFACES } }),
  );
}

/** Every regenerated body, including the combined manifest. */
const ALL_BODIES = [INVENTORY_BODY_PATH, ...STATE_KINDS.map((kind) => STATE_BODY[kind])];

/** Sources git ignores, each naming `leak` so any trace of them in a body is visible. */
const IGNORED_SOURCES: Readonly<Record<string, string>> = {
  'scratch/leak.controller.ts': [
    "import { Controller, Get, Roles } from '../apps/api/nest.js';",
    '',
    "@Controller('/leak')",
    'export class LeakController {',
    "  @Get('secret')",
    "  @Roles('leak-admin')",
    '  secret() {',
    "    return 'leak';",
    '  }',
    '}',
    '',
  ].join('\n'),
  'scratch/leak-routes.tsx': [
    "import { UserPage } from '../apps/web/user-page.js';",
    'export const leakRoutes = (',
    '  <Routes>',
    '    <Route path="/leak" element={<UserPage />} />',
    '  </Routes>',
    ');',
    '',
  ].join('\n'),
  'scratch/leak.sql': [
    'CREATE TABLE app.leak_table (',
    '  id uuid PRIMARY KEY,',
    '  leak_email text NOT NULL -- @pii_class: contact @legal_basis: contract @retention: P1Y',
    ');',
    '',
    'CREATE TABLE auth.leak_roles (',
    '  id uuid PRIMARY KEY,',
    '  name text NOT NULL',
    ');',
    '',
  ].join('\n'),
};

describe('regeneration reads only files tracked at the candidate HEAD (#387 review)', () => {
  it('keeps every ignored controller, route and table out of the regenerated bodies', async () => {
    const { root } = fixture({}, ['scratch/']);
    for (const [path, body] of Object.entries(IGNORED_SOURCES)) put(root, path, body);
    // The ignored sources leave the tree clean, so regeneration proceeds at HEAD.
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'ls-files', 'scratch')).toBe('');

    const result = await regenerate(root);

    expect(result.report.ok).toBe(true);
    for (const path of ALL_BODIES) {
      expect(existsSync(join(root, path)), path).toBe(true);
      const body = read(root, path);
      expect(body, path).not.toMatch(/leak/iu);
      expect(body, path).not.toContain('scratch/');
    }
    // The tracked sources are still measured.
    expect(read(root, STATE_BODY.inventory_api)).toContain('/users');
    expect(read(root, STATE_BODY.inventory_routes)).toContain('/users/:id');
    expect(read(root, STATE_BODY.inventory_data_model)).toContain('users');
    // No producer finding names an ignored file either.
    expect(JSON.stringify(result.reading)).not.toMatch(/leak/iu);
  });

  it('admits no ignored body as a required input, in either body directory', async () => {
    // Ignored proof defaults and an ignored file in the state routes directory, each naming
    // a decoy table, role, endpoint or route.
    const decoyModel = `${JSON.stringify({
      schemaVersion: '1.0.0',
      tables: [{ name: 'leak_table', columns: [{ name: 'leak_email', type: 'text' }] }],
    })}\n`;
    const decoyApi = `${JSON.stringify({
      endpoints: [{ method: 'GET', path: '/leak', controller: { file: 'apps/api/leak.ts' } }],
    })}\n`;
    const decoyRoutes = `${JSON.stringify({
      framework: 'react',
      routes: [{ id: 'leak', path: '/leak' }],
    })}\n`;
    const { root } = fixture({}, ['record/']);
    put(root, PROOF_BODY.inventory_data_model, decoyModel);
    put(root, PROOF_BODY.inventory_api, decoyApi);
    put(root, PROOF_BODY.inventory_routes, decoyRoutes);
    put(root, '.devai/state/sensors/inventory_routes/routes-leak.json', decoyRoutes);
    expect(git(root, 'status', '--porcelain')).toBe('');

    const result = await regenerate(root);

    expect(result.report.ok).toBe(true);
    for (const path of ALL_BODIES) expect(read(root, path), path).not.toMatch(/leak/iu);
    // The ignored proof defaults are neither read nor touched.
    expect(read(root, PROOF_BODY.inventory_data_model)).toBe(decoyModel);
  });
});

describe('a regenerated body names no checkout location (#387 review)', () => {
  it('regenerates byte-identical bodies for one commit from two checkout directories', async () => {
    const first = fixture();
    const parent = mkdtempSync(join(tmpdir(), 'devai-inventory-second-checkout-'));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const second = join(parent, 'elsewhere');
    git(parent, 'clone', '--quiet', first.root, second);
    expect(git(second, 'rev-parse', 'HEAD')).toBe(first.head);

    const one = await regenerate(first.root);
    const two = await regenerate(second);
    expect(one.report.ok).toBe(true);
    expect(two.report.ok).toBe(true);

    for (const path of ALL_BODIES) {
      const left = read(first.root, path);
      const right = read(second, path);
      expect(left, path).not.toContain(first.root);
      expect(right, path).not.toContain(second);
      expect(right, path).not.toContain(parent);
      expect(left, path).toBe(right);
    }
    // The data model in particular carries no sourceRepo checkout path.
    expect(JSON.parse(read(first.root, STATE_BODY.inventory_data_model))).not.toHaveProperty(
      'sourceRepo',
      first.root,
    );
    // The bodies are bound to the same content, so the producer bindings agree too.
    const digests = (result: typeof one) =>
      result.report.regenerated.map(({ kind, sha256 }) => [kind, sha256]).sort();
    expect(digests(two)).toEqual(digests(one));
  });
});

const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('an unreadable regenerated routes directory is an input error (#387 review)', () => {
  it.skipIf(!canChmod)(
    'reads an explicit error and never falls through to the record/proofs routes body',
    async () => {
      const { root } = fixture();
      await regenerate(root);
      const routes = read(root, STATE_BODY.inventory_routes);
      // A single, valid proof default the consumers must not be steered to.
      put(root, PROOF_BODY.inventory_routes, routes);
      const directory = join(root, '.devai/state/sensors/inventory_routes');
      chmodSync(directory, 0o000);
      cleanups.push(() => chmodSync(directory, 0o755));

      for (const kind of ['inventory_coverage', 'plant_coverage'] as const) {
        const reading = await sweep(root, kind);
        expect(reading.status, kind).not.toBe('pass');
        expect(['unknown', 'fail', 'error', 'review'], kind).toContain(reading.status);
        // The finding is explicit and names the directory that could not be read.
        const named = (reading.findings ?? []).filter(
          (finding) =>
            ['error', 'critical', 'warning'].includes(finding.severity) &&
            finding.message.includes('.devai/state/sensors/inventory_routes'),
        );
        expect(named.length, kind).toBeGreaterThan(0);
        // The proof routes body was not measured in its place.
        expect(reading.metrics?.['route_count'] ?? 0, kind).toBe(0);
        expect(JSON.stringify(reading), kind).not.toContain(
          'record/proofs/sensors/inventory_routes',
        );
      }
      // Restored, the state body is read again.
      chmodSync(directory, 0o755);
      expect((await sweep(root, 'plant_coverage')).metrics).toMatchObject({ route_count: 1 });
      expect(readFileSync(join(root, STATE_BODY.inventory_routes), 'utf8')).toBe(routes);
    },
  );
});
