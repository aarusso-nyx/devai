import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senseInventoryDepGraph } from '../../src/inventory-dep-graph.js';

const NOW = '2026-09-08T12:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-dep-graph-boundaries-'));
  roots.push(root);
  return root;
}

describe('dependency graph population boundaries', () => {
  it('resolves relative .js imports, preserves externals, deduplicates edges, and sorts keys', () => {
    const root = fixtureRoot();
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    const b = join(src, 'b.ts');
    writeFileSync(b, 'export const value = 1;\n');
    const a = join(src, 'a.ts');
    writeFileSync(
      a,
      [
        "import { value } from './b.js';",
        "import './b.js';",
        "import fs from 'node:fs';",
        "export { value } from '/" + b.slice(1) + "';",
        'const ignored = 1;',
        '',
      ].join('\n'),
    );
    writeFileSync(join(src, 'z.ts'), 'export const z = 1;\n');
    mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'ignored', 'bad.ts'), "import './never.ts';\n");

    const result = senseInventoryDepGraph({ repoRoot: root, persistBody: false, now: NOW });

    expect(result.reading).toMatchObject({
      status: 'pass',
      sensor: { name: 'inventory:dep-graph', kind: 'inventory_dep_graph', version: '1.0.0' },
      command: `devai sense dep-graph --repo-root ${root}`,
      timestamp: NOW,
      deterministic: true,
      metrics: { node_count: 3, edge_count: 2 },
    });
    expect(Object.keys(result.body.graph)).toEqual(['src/a.ts', 'src/b.ts', 'src/z.ts']);
    expect(result.body.graph['src/a.ts']).toEqual(['node:fs', 'src/b.ts']);
    expect(result.body.graph['src/b.ts']).toEqual([]);
    expect(result.body.graph['src/z.ts']).toEqual([]);
    expect(result.body.graph['node_modules/ignored/bad.ts']).toBeUndefined();
  });

  it('retains absolute local imports as resolved repository paths and reports edge totals', () => {
    const root = fixtureRoot();
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    const target = join(src, 'target.ts');
    writeFileSync(target, 'export const target = true;\n');
    writeFileSync(join(src, 'entry.ts'), `export * from '${target}';\n`);

    const result = senseInventoryDepGraph({
      repoRoot: root,
      scanDir: src,
      persistBody: false,
      now: NOW,
    });

    expect(result.body.graph['src/entry.ts']).toEqual(['src/target.ts']);
    expect(result.body.graph['src/target.ts']).toEqual([]);
    expect(result.reading.metrics).toMatchObject({ node_count: 2, edge_count: 1 });
  });
  it('uses explicitly supplied ignore directories instead of default exclusions', () => {
    const root = fixtureRoot();
    for (const folder of ['vendor', 'node_modules']) {
      mkdirSync(join(root, folder), { recursive: true });
      writeFileSync(join(root, folder, 'entry.ts'), 'export const entry = 1;\n');
    }
    const result = senseInventoryDepGraph({
      repoRoot: root,
      ignoreDirs: new Set(['vendor']),
      persistBody: false,
      now: NOW,
    });
    expect(result.reading.status).toBe('pass');
    expect(result.body.graph).toEqual({ 'node_modules/entry.ts': [] });
    expect(result.reading.metrics).toMatchObject({ node_count: 1, edge_count: 0 });
  });

  it('sorts file keys across a directory and a neighboring TypeScript file', () => {
    const root = fixtureRoot();
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'a', 'nested.ts'), 'export const nested = 1;\n');
    writeFileSync(join(root, 'a.ts'), 'export const sibling = 1;\n');
    const result = senseInventoryDepGraph({ repoRoot: root, persistBody: false, now: NOW });
    expect(Object.keys(result.body.graph)).toEqual(['a.ts', 'a/nested.ts']);
    expect(result.reading.status).toBe('pass');
  });
});
