import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { inventoryAdherence } from '../../src/commands/sense/adapter-readers.js';
import {
  INVENTORY_BODY_PATH,
  regenerateInventoryReadings,
  type RegenerationOptions,
} from '../../src/commands/sense/readings-rebuild.js';

const roots: string[] = [];
const DEP_GRAPH_BODY = '.devai/state/sensors/inventory_dep_graph/dep-graph.json';
const COVERAGE_BODY = '.devai/state/sensors/inventory_coverage/coverage-matrix.json';
const ACTIONS_ONLY = { http: false, database: false, rbac: false, actions: true } as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-inventory-regeneration-'));
  roots.push(root);
  return root;
}

function put(root: string, path: string, body: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

/** A committed TypeScript source whose state directory is ignored, as on the framework. */
function repository(
  files: Readonly<Record<string, string>> = {
    'src/a.ts': "import { b } from './b.js';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\n',
  },
): { readonly root: string; readonly head: string } {
  const root = directory();
  put(root, '.gitignore', '.devai/state/\n');
  for (const [path, body] of Object.entries(files)) put(root, path, body);
  git(root, 'init', '--quiet');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  return { root, head: git(root, 'rev-parse', 'HEAD') };
}

async function regenerate(root: string, options?: RegenerationOptions) {
  return withAuthorityHostTestScope(() => regenerateInventoryReadings(root, options));
}

function codes(reading: { readonly findings?: readonly { readonly code: string }[] }): string[] {
  return (reading.findings ?? []).map((finding) => finding.code);
}

function json(root: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
}

/** Temporary publication files left in any regenerated body directory. */
function temporaries(root: string): string[] {
  return [INVENTORY_BODY_PATH, DEP_GRAPH_BODY, COVERAGE_BODY]
    .map((path) => dirname(join(root, path)))
    .filter((path) => existsSync(path))
    .flatMap((path) => readdirSync(path).filter((name) => name.endsWith('.tmp')));
}

/** Earlier published bodies, so a failed run can be shown to leave them byte-identical. */
function seedPublishedBodies(root: string): Readonly<Record<string, string>> {
  const earlier = {
    [INVENTORY_BODY_PATH]: '{"earlier":"manifest"}\n',
    [DEP_GRAPH_BODY]: '{"graph":{"earlier.ts":[]}}\n',
  };
  for (const [path, body] of Object.entries(earlier)) put(root, path, body);
  return earlier;
}

describe('inventory regeneration from source (#237)', () => {
  it('reads unknown and writes nothing without a candidate commit', async () => {
    const root = directory();
    put(root, 'src/a.ts', 'export const a = 1;\n');

    const result = await regenerate(root, { surfaces: ACTIONS_ONLY });

    expect(result.reading).toMatchObject({
      sensor: { kind: 'inventory_regeneration' },
      status: 'unknown',
      command: 'devai sense run inventory_regeneration',
      findings: [{ code: 'INVENTORY_REGENERATION_NO_CANDIDATE' }],
    });
    expect(result.report).toMatchObject({ ok: false, integration_head: null, regenerated: [] });
    expect(existsSync(join(root, '.devai'))).toBe(false);
  });

  it('reads unknown and writes nothing on a working tree that differs from HEAD', async () => {
    const { root, head } = repository();
    put(root, 'src/c.ts', 'export const c = 3;\n');

    const result = await regenerate(root, { surfaces: ACTIONS_ONLY });

    expect(result.reading.status).toBe('unknown');
    expect(result.reading.findings).toEqual([
      expect.objectContaining({ code: 'INVENTORY_REGENERATION_SOURCE_DIRTY' }),
    ]);
    expect(result.reading.findings?.[0]?.message).toContain(head);
    expect(existsSync(join(root, '.devai'))).toBe(false);
  });

  it('regenerates the manifest and both required kinds at HEAD, then reads them up to date', async () => {
    const { root, head } = repository();
    const committedAt = new Date(git(root, 'log', '-1', '--format=%cI')).toISOString();

    const first = await regenerate(root, { surfaces: ACTIONS_ONLY });

    expect(first.reading).toMatchObject({
      status: 'pass',
      findings: [],
      metrics: {
        kinds_touched: 2,
        kinds_rebuilt: 2,
        kinds_up_to_date: 0,
        error_count: 0,
        required_kinds: 2,
        missing_required_kinds: 0,
        integration_head: head,
        inventory_dep_graph_status: 'pass',
        inventory_coverage_status: 'pass',
      },
    });
    expect(first.report).toMatchObject({ ok: true, integration_head: head, entries: [] });
    expect(
      first.report.regenerated.map(({ kind, body_path, action }) => [kind, body_path, action]),
    ).toEqual([
      ['inventory', INVENTORY_BODY_PATH, 'regenerated'],
      ['inventory_dep_graph', DEP_GRAPH_BODY, 'regenerated'],
      ['inventory_coverage', COVERAGE_BODY, 'regenerated'],
    ]);

    const inventory = json(root, INVENTORY_BODY_PATH);
    expect(validators.inventory(inventory)).toBe(true);
    expect(inventory).toMatchObject({
      integration_head: head,
      generated_at: committedAt,
      dependency_graph: [
        { id: expect.stringMatching(/^DEP-/u), file: 'src/a.ts' },
        { id: expect.stringMatching(/^DEP-/u), file: 'src/b.ts' },
      ],
    });
    expect(first.reading.metrics?.['inventory_body_sha256']).toBe(
      first.report.regenerated[0]?.sha256,
    );
    expect(validators.depGraph(json(root, DEP_GRAPH_BODY))).toBe(true);
    expect(json(root, DEP_GRAPH_BODY)).toEqual({
      graph: { 'src/a.ts': ['src/b.ts'], 'src/b.ts': [] },
    });
    expect(validators.coverageMatrix(json(root, COVERAGE_BODY))).toBe(true);
    expect(json(root, COVERAGE_BODY)).toMatchObject({ generatedAt: committedAt });
    expect(
      json(root, `.devai/state/sensor-readings/inventory_regeneration/${first.reading.id}.json`),
    ).toEqual(first.reading);
    // Regeneration writes only ignored state, so the tree stays clean for the next run.
    expect(git(root, 'status', '--porcelain')).toBe('');
    // Publication renames durable temporaries into place and leaves none behind.
    expect(temporaries(root)).toEqual([]);

    const bytes = readFileSync(join(root, INVENTORY_BODY_PATH), 'utf8');
    const second = await regenerate(root, { surfaces: ACTIONS_ONLY });
    expect(second.reading.id).not.toBe(first.reading.id);
    expect(second.reading).toMatchObject({
      status: 'pass',
      metrics: { kinds_touched: 2, kinds_rebuilt: 0, kinds_up_to_date: 2 },
    });
    expect(second.report.regenerated.map(({ action }) => action)).toEqual([
      'up-to-date',
      'up-to-date',
      'up-to-date',
    ]);
    expect(readFileSync(join(root, INVENTORY_BODY_PATH), 'utf8')).toBe(bytes);
  });

  it('keeps a producer REVIEW as REVIEW and drops coverage when its surfaces are absent', async () => {
    const presumed = repository();
    // #382: no declaration presumes every surface, so all seven kinds are required; the
    // api producer finds no controller in this source and reads REVIEW.
    const review = await regenerate(presumed.root);
    expect(review.reading).toMatchObject({
      status: 'review',
      metrics: {
        inventory_api_status: 'review',
        required_kinds: 7,
        missing_required_kinds: 0,
      },
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'INVENTORY_REGENERATION_KIND_REVIEW',
          message: expect.stringContaining('inventory_api'),
        }),
      ]),
    });
    expect(existsSync(join(presumed.root, COVERAGE_BODY))).toBe(true);

    const absent = repository();
    const pass = await regenerate(absent.root, {
      surfaces: { http: false, database: false, rbac: false, actions: false },
    });
    expect(pass.reading).toMatchObject({
      status: 'pass',
      metrics: { kinds_touched: 1, required_kinds: 1, missing_required_kinds: 0 },
    });
    expect(pass.report.regenerated.map(({ kind }) => kind)).toEqual([
      'inventory',
      'inventory_dep_graph',
    ]);
    expect(existsSync(join(absent.root, COVERAGE_BODY))).toBe(false);
  });

  it('never synthesizes any inventory kind from a body file (#382)', async () => {
    const { root } = repository();
    put(root, '.devai/state/sensors/inventory_dep_graph/stale.json', '{"graph":{}}\n');
    put(root, '.devai/state/sensors/inventory_rbac/rbac.json', '{"roles":[]}\n');

    const result = await regenerate(root, { surfaces: ACTIONS_ONLY });

    // Every kind is now a regenerated kind: rbac is not required here, so its body is
    // removed rather than rebuilt into a reading.
    expect(result.report.entries).toEqual([]);
    expect(result.report.obsolete).toEqual([
      {
        kind: 'inventory_rbac',
        body_path: '.devai/state/sensors/inventory_rbac/rbac.json',
        action: 'removed',
      },
    ]);
    expect(existsSync(join(root, '.devai/state/sensors/inventory_rbac/rbac.json'))).toBe(false);
    expect(existsSync(join(root, '.devai/state/sensor-readings/inventory_dep_graph'))).toBe(false);
    expect(existsSync(join(root, '.devai/state/sensor-readings/inventory_rbac'))).toBe(false);
    expect(result.reading).toMatchObject({
      status: 'pass',
      metrics: { kinds_touched: 2, kinds_rebuilt: 2, kinds_up_to_date: 0 },
    });
  });

  it('never reads a stray state file of an inventory kind and reviews an empty inventory', async () => {
    const malformed = repository();
    put(malformed.root, '.devai/state/sensors/inventory_api/broken.json', '{broken');
    // #382: inventory_api is a regenerated kind, so no state file of it is parsed or rebuilt.
    const stray = await regenerate(malformed.root, { surfaces: ACTIONS_ONLY });
    expect(stray.reading).toMatchObject({
      status: 'pass',
      metrics: { error_count: 0, missing_required_kinds: 0 },
    });
    expect(stray.report.entries).toEqual([]);
    expect(existsSync(join(malformed.root, '.devai/state/sensor-readings/inventory_api'))).toBe(
      false,
    );

    const empty = repository({ 'README.md': '# No TypeScript source\n' });
    const review = await regenerate(empty.root, { surfaces: ACTIONS_ONLY });
    expect(review.reading).toMatchObject({
      status: 'review',
      findings: [expect.objectContaining({ code: 'INVENTORY_REGENERATION_EMPTY_INVENTORY' })],
    });
  });

  it('never feeds a record/proofs default to a producer during regeneration (#382)', async () => {
    // Malformed proof defaults: an unreadable api-map and a schema-invalid routes body.
    // Coverage reads the api-map and routes staged in the same run, so neither is an input.
    // A producer failure that publishes nothing is covered in inventory-regeneration-producers.
    const { root } = repository({
      'src/a.ts': 'export const a = 1;\n',
      'record/proofs/sensors/inventory_api/api-map.json': '{broken',
      'record/proofs/sensors/inventory_routes/routes-test.json': `${JSON.stringify({
        routes: [{ id: 42, method: 'GET', path: '/a' }],
      })}\n`,
    });
    seedPublishedBodies(root);

    const result = await regenerate(root);

    expect(result.report).toMatchObject({ ok: true, errors: [] });
    expect(result.reading.status).not.toBe('fail');
    expect(codes(result.reading)).not.toContain('READINGS_REBUILD_ERROR');
    expect(json(root, COVERAGE_BODY)).toMatchObject({ routes: [], endpoints: [] });
    // The proof defaults stay exactly as committed.
    expect(
      readFileSync(join(root, 'record/proofs/sensors/inventory_api/api-map.json'), 'utf8'),
    ).toBe('{broken');
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(temporaries(root)).toEqual([]);
  });

  it('removes the body of a kind no longer required so it can never stand in for a PASS', async () => {
    const { root } = repository();
    await regenerate(root, { surfaces: ACTIONS_ONLY });
    expect(existsSync(join(root, COVERAGE_BODY))).toBe(true);
    put(root, '.devai/state/sensors/inventory_coverage/stray.json', '{"links":[]}\n');

    const result = await regenerate(root, {
      surfaces: { http: false, database: false, rbac: false, actions: false },
    });

    expect(result.reading).toMatchObject({
      status: 'pass',
      metrics: { required_kinds: 1, kinds_touched: 1, obsolete_bodies_removed: 1 },
    });
    expect(result.report.obsolete).toEqual([
      { kind: 'inventory_coverage', body_path: COVERAGE_BODY, action: 'removed' },
    ]);
    expect(existsSync(join(root, COVERAGE_BODY))).toBe(false);
    // Neither the removed body nor any other file of a regenerated kind is synthesized.
    expect(result.report.entries).toEqual([]);
    expect(existsSync(join(root, '.devai/state/sensor-readings/inventory_coverage'))).toBe(false);
  });

  it('fails explicitly when its own reading cannot be persisted', async () => {
    const { root } = repository();
    // A file where the reading directory belongs makes the store write fail.
    put(root, '.devai/state/sensor-readings/inventory_regeneration', 'not a directory\n');

    const result = await regenerate(root, { surfaces: ACTIONS_ONLY });

    expect(result.reading).toMatchObject({
      status: 'fail',
      findings: [
        expect.objectContaining({
          severity: 'error',
          code: 'INVENTORY_REGENERATION_READING_UNPERSISTED',
          message: expect.stringContaining('/sensor-readings/inventory_regeneration/'),
        }),
      ],
      metrics: { error_count: 1 },
    });
    expect(result.report.ok).toBe(false);
    expect(result.report.errors).toEqual([expect.stringMatching(/^persist .* failed: /u)]);
  });

  it('gives inventory_adherence a bound input it measures instead of reading it missing', async () => {
    const claimed = repository({
      'src/a.ts': "import { b } from './b.js';\nexport const a = b;\n",
      'src/b.ts': 'export const b = 1;\n',
      'law/trace.json': `${JSON.stringify({ invariants: [{ id: 'INV-TEST-001', code_areas: ['src/a.ts'] }] })}\n`,
    });
    const missing = await withAuthorityHostTestScope(() =>
      inventoryAdherence({ repoRoot: claimed.root }),
    );
    expect(missing.findings?.[0]?.code).toBe('INVENTORY_ADHERENCE_INPUT_MISSING');

    await regenerate(claimed.root, { surfaces: ACTIONS_ONLY });
    const measured = await withAuthorityHostTestScope(() =>
      inventoryAdherence({ repoRoot: claimed.root, inputs: { surfaces: ACTIONS_ONLY } }),
    );
    expect(measured).toMatchObject({
      sensor: { kind: 'inventory_adherence' },
      status: 'review',
      metrics: { total_count: 2, claimed_count: 1, orphan_count: 1 },
    });

    // A later commit leaves the regenerated body describing the earlier one.
    put(claimed.root, 'src/c.ts', 'export const c = 3;\n');
    git(claimed.root, 'add', '-A');
    git(claimed.root, 'commit', '--quiet', '-m', 'move HEAD');
    const stale = await withAuthorityHostTestScope(() =>
      inventoryAdherence({ repoRoot: claimed.root }),
    );
    expect(stale).toMatchObject({
      status: 'unknown',
      findings: [{ code: 'INVENTORY_ADHERENCE_INPUT_STALE' }],
    });
  });
});
