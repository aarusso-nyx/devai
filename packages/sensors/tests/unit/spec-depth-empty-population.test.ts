import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseSpecDepth } from '../../src/spec-depth.js';

const now = '2026-09-09T12:00:00.000Z';
let root: string;

function write(path: string, contents: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function invariant(): void {
  write(
    'law/invariants/INV-1.json',
    JSON.stringify({ id: 'INV-1', scope: { components: ['api'] } }),
  );
}

function adr(): void {
  write('docs/meta/adr/ADR-0001.md', '# Component decision\n');
}

function reading() {
  return senseSpecDepth({ repoRoot: root, now });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-spec-depth-empty-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('spec-depth empty-population classifications', () => {
  it('fails closed when neither invariants nor ADRs exist', () => {
    const result = reading();

    expect(result.reading.status).toBe('fail');
    expect(result.reading.findings).toMatchObject([
      { severity: 'error', code: 'SPEC_DEPTH_NO_AUTHORED_SPEC' },
    ]);
    expect(result.reading.metrics).toMatchObject({
      invariant_count: 0,
      adr_count: 0,
      use_case_count: 0,
      component_count: 0,
    });
    expect(result.body).toEqual({
      invariant_count: 0,
      adr_count: 0,
      use_case_count: 0,
      components: [],
    });
  });

  it('reviews an invariant-only repository as incomplete specification coverage', () => {
    invariant();
    const result = reading();

    expect(result.reading.status).toBe('review');
    expect(result.reading.findings).toMatchObject([
      { severity: 'warning', code: 'SPEC_DEPTH_PARTIAL' },
    ]);
    expect(result.reading.metrics).toMatchObject({ invariant_count: 1, adr_count: 0 });
    expect(result.body.components).toEqual([{ name: 'api', invariant_count: 1 }]);
  });

  it('reviews an ADR-only repository as incomplete specification coverage', () => {
    adr();
    const result = reading();

    expect(result.reading.status).toBe('review');
    expect(result.reading.findings).toMatchObject([
      { severity: 'warning', code: 'SPEC_DEPTH_PARTIAL' },
    ]);
    expect(result.reading.metrics).toMatchObject({ invariant_count: 0, adr_count: 1 });
    expect(result.body.components).toEqual([]);
  });

  it('passes when both load-bearing authored spec populations are present', () => {
    invariant();
    adr();
    const result = reading();

    expect(result.reading.status).toBe('pass');
    expect(result.reading.findings).toEqual([]);
    expect(result.reading.metrics).toMatchObject({ invariant_count: 1, adr_count: 1 });
    expect(result.body).toMatchObject({
      invariant_count: 1,
      adr_count: 1,
      components: [{ name: 'api', invariant_count: 1 }],
    });
  });
});
