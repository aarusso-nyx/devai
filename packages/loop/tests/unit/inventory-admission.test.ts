import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { regenerateInventory } from '../../src/inventory/regen.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

describe('regenerateInventory admission (#294)', () => {
  it('applies the admission to an explicit checksum override too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-loop-admission-'));
    roots.push(root);
    put(root, 'kept.md', 'kept\n');
    put(root, 'ignored.md', 'ignored\n');
    const base = {
      repoRoot: root,
      timestamp: '2026-01-01T00:00:00.000Z',
      integrationHead: '0'.repeat(40),
      checksumPaths: [join(root, 'kept.md'), join(root, 'ignored.md')],
    };

    const open = await regenerateInventory(base);
    const admitted = await regenerateInventory({
      ...base,
      admitFile: (path) => relative(root, path) !== 'ignored.md',
    });

    expect(Object.keys(open.checksums)).toEqual(['ignored.md', 'kept.md']);
    expect(Object.keys(admitted.checksums)).toEqual(['kept.md']);
  });
});
