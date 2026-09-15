import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
  const root = mkdtempSync(join(tmpdir(), 'devai-wave51-freshness-'));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, contents: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function invariant(root: string, filename: string, codeAreas: string[]): string {
  return write(
    root,
    `law/invariants/${filename}`,
    JSON.stringify({ scope: { code_areas: codeAreas } }),
  );
}

function ageInvariant(path: string): void {
  const old = new Date(NOW.getTime() - 120 * DAY_MS);
  utimesSync(path, old, old);
}

describe('spec freshness recursive directory boundaries', () => {
  it('walks nested files while excluding node_modules, .git, and dist', () => {
    const root = fixtureRoot();
    const invariantPath = invariant(root, 'nested.json', ['packages/app/src/**']);
    const sourcePath = write(
      root,
      'packages/app/src/nested/deep.ts',
      'export const deep = true;\n',
    );
    const ignoredPaths = [
      write(root, 'packages/app/src/node_modules/future.ts', 'ignored\n'),
      write(root, 'packages/app/src/.git/future.ts', 'ignored\n'),
      write(root, 'packages/app/src/dist/future.ts', 'ignored\n'),
    ];
    const future = new Date(NOW.getTime() + 10 * DAY_MS);
    for (const path of ignoredPaths) utimesSync(path, future, future);
    utimesSync(sourcePath, NOW, NOW);
    ageInvariant(invariantPath);

    const { reading, reports } = senseSpecFreshness({
      repoRoot: root,
      now: NOW,
      thresholdDays: 90,
    });
    const report = reports[0];
    expect(report).toMatchObject({
      invariant_id: 'nested',
      file: invariantPath,
      max_code_mtime_ms: statSync(sourcePath).mtimeMs,
      stale_days: 120,
      stale: true,
    });
    expect(reading).toMatchObject({
      status: 'review',
      deterministic: true,
      command: 'devai sense-spec-freshness',
      findings: [
        {
          severity: 'warning',
          code: 'SPEC_FRESHNESS_STALE',
          file: invariantPath,
          message: 'Invariant nested is 120 day(s) older than its code (threshold 90).',
        },
      ],
      metrics: { invariants_scanned: 1, stale_count: 1, threshold_days: 90 },
    });
  });

  it('uses the newest descendant file instead of the directory mtime', () => {
    const root = fixtureRoot();
    const invariantPath = invariant(root, 'directory.json', ['packages/app/src/**']);
    const sourcePath = write(root, 'packages/app/src/app.ts', 'export const app = true;\n');
    utimesSync(sourcePath, NOW, NOW);
    const codeDir = join(root, 'packages/app/src');
    const directoryFuture = new Date(NOW.getTime() + 10 * DAY_MS);
    utimesSync(codeDir, directoryFuture, directoryFuture);
    ageInvariant(invariantPath);

    const { reports } = senseSpecFreshness({ repoRoot: root, now: NOW, thresholdDays: 90 });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      invariant_id: 'directory',
      max_code_mtime_ms: statSync(sourcePath).mtimeMs,
      stale_days: 120,
      stale: true,
    });
  });
});

describe('spec freshness invariant filename fallback', () => {
  it('strips only the final json suffix from an id-less invariant filename', () => {
    const root = fixtureRoot();
    const invariantPath = invariant(root, 'name.json.part.json', ['packages/app/src/app.ts']);
    const sourcePath = write(root, 'packages/app/src/app.ts', 'export const app = true;\n');
    utimesSync(sourcePath, NOW, NOW);
    ageInvariant(invariantPath);

    const { reading, reports } = senseSpecFreshness({
      repoRoot: root,
      now: NOW,
      thresholdDays: 90,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      invariant_id: 'name.json.part',
      file: invariantPath,
      max_code_mtime_ms: statSync(sourcePath).mtimeMs,
      stale_days: 120,
      stale: true,
    });
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SPEC_FRESHNESS_STALE',
        message: 'Invariant name.json.part is 120 day(s) older than its code (threshold 90).',
        file: invariantPath,
      },
    ]);
  });
});
