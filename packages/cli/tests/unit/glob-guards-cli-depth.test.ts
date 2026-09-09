import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkGlobGuards } from '../../src/commands/check/glob-guards.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-glob-guards-cli-depth-'));
  roots.push(value);
  return value;
}

function put(base: string, relativePath: string, value: string): void {
  const path = join(base, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function registry(
  base: string,
  guards: readonly object[],
  relativePath = '.devai/config/glob-guards.json',
): string {
  const path = join(base, relativePath);
  put(base, relativePath, `${JSON.stringify({ schemaVersion: '1.0.0', guards })}\n`);
  return path;
}

describe('check glob-guards report aggregation', () => {
  it('reports every guard and fails only the guard whose population is below its minimum', () => {
    const base = root();
    put(base, 'docs/invariants/INV-001.json', '{}');
    const report = checkGlobGuards({
      repoRoot: base,
      registryPath: registry(base, [
        { id: 'PRESENT', pattern: 'docs/invariants/*.json' },
        { id: 'MISSING', pattern: 'docs/missing/*.json' },
      ]),
    });

    expect(report.registry_entries).toBe(2);
    expect(report.results).toEqual([
      expect.objectContaining({
        id: 'PRESENT',
        pattern: 'docs/invariants/*.json',
        min_matches: 1,
        match_count: 1,
        ok: true,
      }),
      expect.objectContaining({
        id: 'MISSING',
        pattern: 'docs/missing/*.json',
        min_matches: 1,
        match_count: 0,
        ok: false,
        sample_matches: [],
      }),
    ]);
    expect(report.failing).toEqual(['MISSING']);
    expect(report.ok).toBe(false);
  });

  it('returns an all-pass report when every declared guard meets its threshold', () => {
    const base = root();
    put(base, 'src/one.ts', 'export {}');
    put(base, 'src/two.ts', 'export {}');
    const report = checkGlobGuards({
      repoRoot: base,
      registryPath: registry(base, [{ id: 'SOURCE_FILES', pattern: 'src/*.ts', min_matches: 2 }]),
    });

    expect(report.registry_entries).toBe(1);
    expect(report.results).toEqual([
      expect.objectContaining({
        id: 'SOURCE_FILES',
        min_matches: 2,
        match_count: 2,
        ok: true,
      }),
    ]);
    expect(report.failing).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
