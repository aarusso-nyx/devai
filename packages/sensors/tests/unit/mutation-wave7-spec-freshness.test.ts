import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { senseSpecFreshness } from '../../src/spec-freshness.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-01-01T00:00:00.000Z');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-wave7-freshness-'));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, contents: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function invariant(root: string): string {
  return write(
    root,
    'law/invariants/INV-001.json',
    JSON.stringify({ id: 'INV-001', scope: { code_areas: ['packages/app/src/app.ts'] } }),
  );
}

function code(root: string): string {
  return write(root, 'packages/app/src/app.ts', 'export const app = true;\n');
}

describe('wave7 spec freshness selection and fresh state', () => {
  it('scans ordinary JSON invariants and preserves equal mtimes as fresh', () => {
    const root = fixtureRoot();
    const invariantPath = invariant(root);
    const codePath = code(root);
    utimesSync(invariantPath, NOW, NOW);
    utimesSync(codePath, NOW, NOW);

    const { reading, reports } = senseSpecFreshness({
      repoRoot: root,
      now: NOW,
      thresholdDays: 90,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      invariant_id: 'INV-001',
      file: invariantPath,
      stale_days: 0,
      stale: false,
    });
    expect(reports[0]?.invariant_mtime_ms).toBe(reports[0]?.max_code_mtime_ms);
    expect(reading.metrics).toMatchObject({
      invariants_scanned: 1,
      stale_count: 0,
      threshold_days: 90,
    });
    expect(reading.findings).toEqual([]);
    expect(reading.status).toBe('pass');
    expect(reading.timestamp).toBe(NOW.toISOString());
  });

  it('reports a normal JSON invariant whose code is 120 days newer', () => {
    const root = fixtureRoot();
    const invariantPath = invariant(root);
    const codePath = code(root);
    const old = new Date(NOW.getTime() - 120 * DAY_MS);
    utimesSync(invariantPath, old, old);
    utimesSync(codePath, NOW, NOW);

    const { reading, reports } = senseSpecFreshness({
      repoRoot: root,
      now: NOW,
      thresholdDays: 90,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      invariant_id: 'INV-001',
      file: invariantPath,
      stale_days: 120,
      stale: true,
    });
    expect(reading.metrics).toMatchObject({
      invariants_scanned: 1,
      stale_count: 1,
      threshold_days: 90,
    });
    expect(reading.findings?.[0]).toMatchObject({
      code: 'SPEC_FRESHNESS_STALE',
      file: invariantPath,
    });
    expect(reading.status).toBe('review');
  });
});

describe('wave7 spec freshness threshold and malformed-record boundaries', () => {
  it('keeps exactly 90 days at the fresh threshold', () => {
    const root = fixtureRoot();
    const invariantPath = invariant(root);
    const codePath = code(root);
    const old = new Date(NOW.getTime() - 90 * DAY_MS);
    utimesSync(invariantPath, old, old);
    utimesSync(codePath, NOW, NOW);

    const { reading, reports } = senseSpecFreshness({
      repoRoot: root,
      now: NOW,
      thresholdDays: 90,
    });
    expect(reports[0]).toMatchObject({ stale_days: 90, stale: false });
    expect(reading.metrics?.stale_count).toBe(0);
    expect(reading.status).toBe('pass');
  });

  it('skips a JSON null record without throwing or counting it', () => {
    const root = fixtureRoot();
    const path = write(root, 'law/invariants/empty.json', 'null');
    utimesSync(path, NOW, NOW);

    const { reading, reports } = senseSpecFreshness({
      repoRoot: root,
      now: NOW,
      thresholdDays: 90,
    });
    expect(reports).toHaveLength(0);
    expect(reading.metrics).toMatchObject({ invariants_scanned: 0, stale_count: 0 });
    expect(reading.status).toBe('pass');
  });
});
