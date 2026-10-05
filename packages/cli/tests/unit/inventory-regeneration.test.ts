import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function json(root: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
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
    // No declaration presumes the http surface, whose api-map body is absent.
    const review = await regenerate(presumed.root);
    expect(review.reading).toMatchObject({
      status: 'review',
      metrics: { inventory_coverage_status: 'review', required_kinds: 2 },
      findings: [
        expect.objectContaining({
          code: 'INVENTORY_REGENERATION_KIND_REVIEW',
          message: expect.stringContaining('inventory_coverage'),
        }),
      ],
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

  it('never synthesizes a regenerated kind from a body file and still rebuilds the others', async () => {
    const { root } = repository();
    put(root, '.devai/state/sensors/inventory_dep_graph/stale.json', '{"graph":{}}\n');
    put(root, '.devai/state/sensors/inventory_rbac/rbac.json', '{"roles":[]}\n');

    const result = await regenerate(root, { surfaces: ACTIONS_ONLY });

    expect(result.report.entries.map(({ kind, action }) => [kind, action])).toEqual([
      ['inventory_rbac', 'created'],
    ]);
    expect(existsSync(join(root, '.devai/state/sensor-readings/inventory_dep_graph'))).toBe(false);
    expect(result.reading).toMatchObject({
      status: 'pass',
      metrics: { kinds_touched: 3, kinds_rebuilt: 3, kinds_up_to_date: 0 },
    });
  });

  it('fails on a malformed body of a rebuilt kind and reviews an empty inventory', async () => {
    const malformed = repository();
    put(malformed.root, '.devai/state/sensors/inventory_api/broken.json', '{broken');
    const fail = await regenerate(malformed.root, { surfaces: ACTIONS_ONLY });
    expect(fail.reading).toMatchObject({
      status: 'fail',
      metrics: { error_count: 1, missing_required_kinds: 0 },
      findings: [
        expect.objectContaining({
          code: 'READINGS_REBUILD_ERROR',
          message: expect.stringContaining('inventory_api/broken.json'),
        }),
      ],
    });

    const empty = repository({ 'README.md': '# No TypeScript source\n' });
    const review = await regenerate(empty.root, { surfaces: ACTIONS_ONLY });
    expect(review.reading).toMatchObject({
      status: 'review',
      findings: [expect.objectContaining({ code: 'INVENTORY_REGENERATION_EMPTY_INVENTORY' })],
    });
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
