import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseSpecDepth } from '../../src/spec-depth.js';

let root: string;

function write(path: string, contents = ''): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-spec-depth-files-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('spec-depth authored file population', () => {
  it('counts supported extensions case-insensitively while filtering README names and suffix lookalikes', () => {
    write('law/invariants/INV-1.JSON', JSON.stringify({ id: 'INV-1', scope: { components: [] } }));
    write('law/invariants/.json.backup');

    write('docs/meta/adr/decision.md', '# Decision\n');
    write('docs/meta/adr/readme.md.notes.md', '# Notes\n');
    write('docs/meta/adr/README.MD', '# Readme\n');
    write('docs/meta/adr/readme.md', '# Readme\n');
    write('docs/meta/adr/.md.backup');

    write('product/use-cases/case.JSON', '{}');
    write('product/use-cases/guide.MD', '# Guide\n');
    write('product/use-cases/readme.md', '# Readme\n');
    write('product/use-cases/.json.backup');
    write('product/use-cases/.md.backup');

    const result = senseSpecDepth({ repoRoot: root, now: '2026-09-09T12:00:00.000Z' });

    expect(result.reading.status).toBe('pass');
    expect(result.reading.findings).toEqual([]);
    expect(result.reading.metrics).toMatchObject({
      invariant_count: 1,
      adr_count: 2,
      use_case_count: 2,
      component_count: 0,
    });
    expect(result.body).toEqual({
      invariant_count: 1,
      adr_count: 2,
      use_case_count: 2,
      components: [],
    });
  });
});
