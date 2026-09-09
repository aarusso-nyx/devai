import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseSpecDepth } from '../../src/spec-depth.js';

let root: string;

function write(path: string, contents: string): void {
  const fullPath = join(root, path);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-spec-depth-scope-'));
  mkdirSync(join(root, 'law/invariants'), { recursive: true });
  mkdirSync(join(root, 'docs/meta/adr'), { recursive: true });
  mkdirSync(join(root, 'product/use-cases'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('spec-depth component scope population', () => {
  it('ignores malformed scope records while preserving valid duplicate component references', () => {
    write('law/invariants/null-record.json', 'null\n');
    write('law/invariants/null-scope.json', JSON.stringify({ id: 'INV-NULL-SCOPE', scope: null }));
    write(
      'law/invariants/valid.json',
      JSON.stringify({
        id: 'INV-VALID',
        scope: { components: ['api', 'api', '', 'cli'] },
      }),
    );
    write('docs/meta/adr/ADR-0001.md', '# Component decision\n');

    const result = senseSpecDepth({ repoRoot: root, now: '2026-09-09T12:00:00.000Z' });

    expect(result.reading.status).toBe('pass');
    expect(result.reading.findings).toEqual([]);
    expect(result.reading.metrics).toMatchObject({
      invariant_count: 3,
      adr_count: 1,
      use_case_count: 0,
      component_count: 2,
    });
    expect(result.body).toEqual({
      invariant_count: 3,
      adr_count: 1,
      use_case_count: 0,
      components: [
        { name: 'api', invariant_count: 2 },
        { name: 'cli', invariant_count: 1 },
      ],
    });
  });
});
