import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseSpecDepth } from '../../src/spec-depth.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

function write(relative: string, value: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function invariant(relative: string, scope: unknown): void {
  write(relative, JSON.stringify({ id: relative, type: 'data_contract', scope }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-spec-depth-components-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('spec depth component shapes', () => {
  it('ignores malformed scopes and component values while tallying valid components in order', () => {
    write('law/invariants/null-record.json', 'null');
    invariant('law/invariants/reference.txt', { components: ['not-an-invariant'] });
    invariant('law/invariants/null-scope.json', null);
    invariant('law/invariants/object-components.json', { components: { api: true } });
    invariant('law/invariants/mixed-components.json', { components: ['', 42, 'api'] });
    invariant('law/invariants/zeta.json', { components: ['alpha', 'api'] });
    invariant('law/invariants/alpha.json', { components: ['zeta', 'api'] });

    const result = senseSpecDepth({ repoRoot: root, now: NOW });

    expect(result.reading).toMatchObject({
      status: 'review',
      command: 'devai sense-spec-depth',
      deterministic: true,
      timestamp: NOW,
      metrics: { invariant_count: 6, adr_count: 0, use_case_count: 0, component_count: 3 },
    });
    expect(result.body.components).toEqual([
      { name: 'alpha', invariant_count: 1 },
      { name: 'api', invariant_count: 3 },
      { name: 'zeta', invariant_count: 1 },
    ]);
  });

  it('excludes README files only when README is the complete filename suffix', () => {
    invariant('law/invariants/INV-1.json', { components: ['api'] });
    write('docs/meta/adr/README.md', '# index\n');
    write('docs/meta/adr/readme.MD', '# index\n');
    write('docs/meta/adr/ADR-0001.md', '# decision\n');
    write('product/use-cases/README.md', '# index\n');
    write('product/use-cases/readme.md.notes.md', 'notes\n');
    write('product/use-cases/guide.md', 'guide\n');

    const result = senseSpecDepth({ repoRoot: root, now: NOW });

    expect(result.reading).toMatchObject({
      status: 'pass',
      metrics: { invariant_count: 1, adr_count: 1, use_case_count: 2, component_count: 1 },
    });
    expect(result.body).toEqual({
      invariant_count: 1,
      adr_count: 1,
      use_case_count: 2,
      components: [{ name: 'api', invariant_count: 1 }],
    });
  });
});
