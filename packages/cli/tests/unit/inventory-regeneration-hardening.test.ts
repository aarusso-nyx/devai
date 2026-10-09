import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  INVENTORY_BODY_PATH,
  regenerateInventoryReadings,
  type RegenerationOptions,
} from '../../src/commands/sense/readings-rebuild.js';

/** Runs after the real inventory walk and before publication: the async window of a run. */
const interleave = vi.hoisted(() => ({
  afterWalk: undefined as undefined | (() => void),
  /** Runs once the combined manifest is renamed into place, inside the publication window. */
  afterPublish: undefined as undefined | (() => void),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const original = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...original,
    renameSync: (from: string, to: string) => {
      original.renameSync(from, to);
      if (to.endsWith('/inventory/inventory.json')) interleave.afterPublish?.();
    },
  };
});

vi.mock('#runtime-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/runtime-core.js')>();
  return {
    ...original,
    regenerateInventory: async (options: Parameters<typeof original.regenerateInventory>[0]) => {
      const inventory = await original.regenerateInventory(options);
      interleave.afterWalk?.();
      return inventory;
    },
  };
});

const roots: string[] = [];
const DEP_GRAPH_BODY = '.devai/state/sensors/inventory_dep_graph/dep-graph.json';
const COVERAGE_BODY = '.devai/state/sensors/inventory_coverage/coverage-matrix.json';
const ACTIONS_ONLY = { http: false, database: false, rbac: false, actions: true } as const;

afterEach(() => {
  interleave.afterWalk = undefined;
  interleave.afterPublish = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

const SOURCES: Readonly<Record<string, string>> = {
  'src/a.ts': "import { b } from './b.js';\nexport const a = b;\n",
  'src/b.ts': 'export const b = 1;\n',
  'src/m.ts': '@Module({})\nexport class TrackedModule {}\n',
  'src/a.test.ts': "it('a', () => {});\n",
};

/** A committed repository with git-ignored files that the source walkers still match. */
function repository(
  extra: Readonly<Record<string, string>> = {},
  ignore = '',
  beforeCommit: (root: string) => void = () => undefined,
): { readonly root: string; readonly head: string; readonly tree: string } {
  const root = mkdtempSync(join(tmpdir(), 'devai-inventory-hardening-'));
  roots.push(root);
  put(root, '.gitignore', `.devai/state/\nscratch/\nCLAUDE.md\n${ignore}`);
  for (const [path, body] of Object.entries({ ...SOURCES, ...extra })) put(root, path, body);
  beforeCommit(root);
  git(root, 'init', '--quiet');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  return {
    root,
    head: git(root, 'rev-parse', 'HEAD'),
    tree: git(root, 'rev-parse', 'HEAD^{tree}'),
  };
}

async function regenerate(root: string, options?: RegenerationOptions) {
  return withAuthorityHostTestScope(() => regenerateInventoryReadings(root, options));
}

function json(root: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
}

describe('inventory regeneration is bound to the git tree at HEAD (#294)', () => {
  it('never lets a file git ignores enter a HEAD-bound body', async () => {
    const { root } = repository();
    put(root, 'scratch/leak.ts', "import { a } from '../src/a.js';\nexport const leak = a;\n");
    put(root, 'scratch/leak.test.ts', "it('leak', () => {});\n");
    put(root, 'scratch/leak-module.ts', '@Module({})\nexport class LeakModule {}\n');
    put(root, 'CLAUDE.md', '# an ignored governance file\n');
    expect(git(root, 'status', '--porcelain')).toBe('');

    const result = await regenerate(root, { surfaces: ACTIONS_ONLY });

    expect(result.reading.status).toBe('pass');
    const inventory = json(root, INVENTORY_BODY_PATH) as {
      modules: { file: string }[];
      dependency_graph: { file: string }[];
      test_inventory: { path: string }[];
      checksums: Record<string, string>;
    };
    expect(inventory.modules.map(({ file }) => file)).toEqual(['src/m.ts']);
    expect(inventory.dependency_graph.map(({ file }) => file)).toEqual([
      'src/a.test.ts',
      'src/a.ts',
      'src/b.ts',
      'src/m.ts',
    ]);
    expect(inventory.test_inventory.map(({ path }) => path)).toEqual(['src/a.test.ts']);
    expect(Object.keys(inventory.checksums)).not.toContain('CLAUDE.md');
    const graph = json(root, DEP_GRAPH_BODY) as { graph: Record<string, string[]> };
    expect(Object.keys(graph.graph)).toEqual(['src/a.test.ts', 'src/a.ts', 'src/b.ts', 'src/m.ts']);
    expect(JSON.stringify(graph)).not.toContain('scratch');
  });

  it('describes the same bodies whether or not ignored files sit in the working tree', async () => {
    const clean = repository();
    const dirty = repository();
    put(dirty.root, 'scratch/leak.ts', 'export const leak = 1;\n');
    const options = { surfaces: ACTIONS_ONLY } as const;

    await regenerate(clean.root, options);
    await regenerate(dirty.root, options);

    const strip = (root: string, head: string): string =>
      readFileSync(join(root, INVENTORY_BODY_PATH), 'utf8')
        .split(head)
        .join('<head>')
        .replace(/"generated_at": "[^"]+"/u, '"generated_at": "<time>"');
    expect(strip(dirty.root, dirty.head)).toBe(strip(clean.root, clean.head));
    expect(json(dirty.root, DEP_GRAPH_BODY)).toEqual(json(clean.root, DEP_GRAPH_BODY));
  });
});

describe('inventory regeneration verifies its snapshot before publication (#294)', () => {
  const earlier = '{"earlier":"manifest"}\n';

  function expectRefused(
    result: Awaited<ReturnType<typeof regenerate>>,
    root: string,
    detail: string,
  ): void {
    expect(result.reading.status).toBe('unknown');
    expect(result.reading.findings).toEqual([
      expect.objectContaining({
        code: 'INVENTORY_REGENERATION_SNAPSHOT_CHANGED',
        message: expect.stringContaining(detail),
      }),
    ]);
    expect(result.report).toMatchObject({ ok: false, integration_head: null, regenerated: [] });
    // Nothing was published, so the earlier manifest stands and no other body appeared.
    expect(readFileSync(join(root, INVENTORY_BODY_PATH), 'utf8')).toBe(earlier);
    expect(existsSync(join(root, DEP_GRAPH_BODY))).toBe(false);
    expect(existsSync(join(root, COVERAGE_BODY))).toBe(false);
    expect(existsSync(join(root, '.devai/state/sensor-readings'))).toBe(false);
  }

  it('refuses when a tracked file is edited while the walk is in flight', async () => {
    const { root } = repository();
    put(root, INVENTORY_BODY_PATH, earlier);
    interleave.afterWalk = () => put(root, 'src/b.ts', 'export const b = 2;\n');

    const result = await regenerate(root, { surfaces: ACTIONS_ONLY });

    expectRefused(result, root, 'working tree no longer matches');
  });

  it('refuses when HEAD moves while the walk is in flight', async () => {
    const { root, head } = repository();
    put(root, INVENTORY_BODY_PATH, earlier);
    interleave.afterWalk = () => {
      put(root, 'src/c.ts', 'export const c = 3;\n');
      git(root, 'add', '-A');
      git(root, 'commit', '--quiet', '-m', 'move HEAD');
    };

    const result = await regenerate(root, { surfaces: ACTIONS_ONLY });

    expectRefused(result, root, `HEAD moved from ${head}`);
  });

  it('refuses when a new untracked source appears while the walk is in flight', async () => {
    const { root } = repository();
    put(root, INVENTORY_BODY_PATH, earlier);
    interleave.afterWalk = () => put(root, 'src/late.ts', 'export const late = 1;\n');

    expectRefused(await regenerate(root, { surfaces: ACTIONS_ONLY }), root, 'no longer matches');
  });

  it('still publishes when only an ignored file changes during the walk', async () => {
    const { root } = repository();
    interleave.afterWalk = () => put(root, 'scratch/noise.ts', 'export const noise = 1;\n');

    const result = await regenerate(root, { surfaces: ACTIONS_ONLY });

    expect(result.reading.status).toBe('pass');
    expect(existsSync(join(root, DEP_GRAPH_BODY))).toBe(true);
  });
});

describe('inventory regeneration preserves each producer reading (#294)', () => {
  it('records the findings, metrics, command hash and input binding of every producer', async () => {
    const { root, head, tree } = repository();

    // #382: no declaration presumes every surface; the api producer finds no controller and
    // reads REVIEW, which regeneration keeps with the producer's own findings.
    const result = await regenerate(root);

    const bodies = result.report.regenerated;
    const api = bodies.find(({ kind }) => kind === 'inventory_api');
    const depGraph = bodies.find(({ kind }) => kind === 'inventory_dep_graph');
    expect(bodies.find(({ kind }) => kind === 'inventory')?.producer_reading).toBeUndefined();

    const reading = api?.producer_reading;
    expect(reading).toMatchObject({
      sensor: { kind: 'inventory_api' },
      status: 'review',
      findings: expect.arrayContaining([expect.objectContaining({ code: 'API_INVENTORY_EMPTY' })]),
      input_binding: {
        integration_head: head,
        integration_tree: tree,
        body_sha256: api?.sha256,
      },
    });
    expect(reading?.metrics).toEqual(expect.any(Object));
    expect(reading?.command_hash).toBe(
      createHash('sha256')
        .update(reading?.command ?? '')
        .digest('hex'),
    );
    expect(depGraph?.producer_reading).toMatchObject({
      sensor: { kind: 'inventory_dep_graph' },
      status: 'pass',
      findings: [],
      input_binding: { integration_head: head, body_sha256: depGraph?.sha256 },
    });

    // The aggregate keeps the same reading beside its own status.
    expect(result.reading.metrics).toMatchObject({
      integration_tree: tree,
      inventory_api_command_hash: reading?.command_hash,
      inventory_api_input_sha256: api?.sha256,
      inventory_api_finding_count: reading?.findings.length,
      inventory_dep_graph_command_hash: depGraph?.producer_reading?.command_hash,
      inventory_dep_graph_finding_count: 0,
    });
    for (const [name, value] of Object.entries(reading?.metrics ?? {})) {
      expect(result.reading.metrics?.[`inventory_api_metric_${name}`]).toBe(
        typeof value === 'boolean' ? String(value) : value,
      );
    }
    const preserved = (result.reading.findings ?? []).filter(
      ({ code }) => code === 'INVENTORY_REGENERATION_PRODUCER_FINDING',
    );
    expect(preserved.map(({ message }) => message.split(']')[0])).toEqual(
      expect.arrayContaining(['inventory_api [API_INVENTORY_EMPTY']),
    );
    // The aggregate the store keeps names no checkout location.
    expect(JSON.stringify(result.reading)).not.toContain(root);
    expect(
      json(root, `.devai/state/sensor-readings/inventory_regeneration/${result.reading.id}.json`),
    ).toEqual(result.reading);
  });
});

const USE_CASE = {
  cases: [{ id: 'UC-1', mainFlow: [{ action: 'x', refs: { actionRefs: [{ id: 'a' }] } }] }],
};
const REGISTRY = `${JSON.stringify({ entries: [{ action_id: 'a' }] })}\n`;

describe('inventory regeneration admits no ignored or linked input (#294)', () => {
  it('reads an ignored coverage input as absent', async () => {
    const { root } = repository(
      { 'law/policy/action-registry.json': REGISTRY },
      'product/use-cases/\nrecord/proofs/\n',
    );
    put(root, 'product/use-cases/linked.json', `${JSON.stringify(USE_CASE)}\n`);
    put(
      root,
      'record/proofs/sensors/inventory_api/api-map.json',
      `${JSON.stringify({ endpoints: [{ method: 'GET', path: '/ignored' }] })}\n`,
    );
    expect(git(root, 'status', '--porcelain')).toBe('');

    const result = await regenerate(root);

    const coverage = result.report.regenerated.find(({ kind }) => kind === 'inventory_coverage');
    const codes = (coverage?.producer_reading?.findings ?? []).map(({ code }) => code);
    // Neither the ignored api-map nor the ignored use case reached the tree-bound matrix:
    // #382 coverage reads only the api-map staged in the same run.
    expect(JSON.stringify(json(root, COVERAGE_BODY))).not.toContain('/ignored');
    expect(codes).toContain('COVERAGE_UNLINKED_ACTION');
    expect(coverage?.producer_reading?.metrics['linked_action_count']).toBe(0);
    expect(JSON.stringify(json(root, COVERAGE_BODY))).not.toContain('UC-1');
  });

  it('counts a tracked coverage input', async () => {
    const { root } = repository({
      'law/policy/action-registry.json': REGISTRY,
      'product/use-cases/linked.json': `${JSON.stringify(USE_CASE)}\n`,
    });

    const result = await regenerate(root);

    const coverage = result.report.regenerated.find(({ kind }) => kind === 'inventory_coverage');
    expect(coverage?.producer_reading?.metrics['linked_action_count']).toBe(1);
  });

  it('refuses a committed symlink whose target lies outside the checkout', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'devai-inventory-outside-'));
    roots.push(outside);
    put(outside, 'secret.ts', "import './leak.js';\n@Module({})\nexport class SecretModule {}\n");
    put(outside, 'readme.md', '# outside\n');
    const { root } = repository({}, '', (checkout) => {
      symlinkSync(join(outside, 'secret.ts'), join(checkout, 'src/link.ts'));
      symlinkSync(join(outside, 'readme.md'), join(checkout, 'README.md'));
    });
    expect(git(root, 'ls-files', 'src/link.ts')).toBe('src/link.ts');

    const result = await regenerate(root, { surfaces: ACTIONS_ONLY });

    expect(result.reading.status).toBe('pass');
    const graph = json(root, DEP_GRAPH_BODY) as { graph: Record<string, string[]> };
    expect(Object.keys(graph.graph)).not.toContain('src/link.ts');
    const inventory = json(root, INVENTORY_BODY_PATH) as {
      modules: { file: string }[];
      dependency_graph: { file: string }[];
      checksums: Record<string, string>;
    };
    expect(inventory.modules.map(({ file }) => file)).toEqual(['src/m.ts']);
    expect(inventory.dependency_graph.map(({ file }) => file)).not.toContain('src/link.ts');
    expect(Object.keys(inventory.checksums)).not.toContain('README.md');
  });
});

describe('inventory regeneration re-verifies around publication (#294)', () => {
  it('retracts what it published when the tree changes inside the publication window', async () => {
    const { root } = repository();
    interleave.afterPublish = () => put(root, 'src/b.ts', 'export const b = 2;\n');

    const result = await regenerate(root, { surfaces: ACTIONS_ONLY });

    expect(result.reading.status).toBe('unknown');
    expect(result.reading.findings).toEqual([
      expect.objectContaining({
        code: 'INVENTORY_REGENERATION_SNAPSHOT_CHANGED',
        message: expect.stringContaining('were removed'),
      }),
    ]);
    expect(result.report).toMatchObject({ ok: false, regenerated: [] });
    for (const path of [INVENTORY_BODY_PATH, DEP_GRAPH_BODY, COVERAGE_BODY]) {
      expect(existsSync(join(root, path))).toBe(false);
    }
  });
});
