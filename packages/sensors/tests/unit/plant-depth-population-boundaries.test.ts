import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sensePlantDepth } from '../../src/plant-depth.js';

let root: string;
const now = '2026-09-08T12:00:00Z';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-plant-depth-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function file(path: string, lines: number) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Array.from({ length: lines }, () => '// source').join('\n'));
}

describe('plant depth measures the exact distinct source population', () => {
  it.each([499, 500, 999, 1000])(
    'classifies %i raw lines at the documented boundaries',
    (lines) => {
      file('packages/a/src/main.ts', lines);
      const result = sensePlantDepth({ repoRoot: root, now });
      expect(result.status).toBe(lines < 500 ? 'pass' : lines < 1000 ? 'review' : 'fail');
      expect(result.metrics).toEqual({
        files_count: 1,
        lines_total: lines,
        lines_max: lines,
        lines_mean: lines,
        lines_p95: lines,
        threshold_pass: 500,
        threshold_review: 1000,
      });
      expect(result.findings?.map((f) => [f.code, f.severity])).toEqual(
        lines < 500
          ? []
          : lines < 1000
            ? [['PLANT_DEPTH_FILES_GROWING', 'warning']]
            : [['PLANT_DEPTH_FILES_BLOATED', 'error']],
      );
    },
  );

  it('computes nearest-rank p95 across an unsorted population without treating the maximum as p95', () => {
    file('packages/a/src/first.ts', 2000);
    for (let i = 1; i <= 20; i++) file(`packages/a/src/z${i}.tsx`, i);
    const result = sensePlantDepth({ repoRoot: root, now });
    expect(result.status).toBe('pass');
    expect(result.metrics).toMatchObject({
      files_count: 21,
      lines_total: 2210,
      lines_max: 2000,
      lines_mean: 105,
      lines_p95: 20,
    });
  });

  it('counts a file once when configured globs overlap', () => {
    file('packages/a/src/a.ts', 10);
    file('packages/a/src/b.ts', 30);
    const result = sensePlantDepth({
      repoRoot: root,
      sourceGlobs: ['packages/*/src/**', 'packages/a/src/a.ts'],
      now,
    });
    expect(result.metrics).toMatchObject({ files_count: 2, lines_total: 40, lines_mean: 20 });
  });

  it('honors the literal portion of a wildcard package name', () => {
    file('packages/core-app/src/a.ts', 10);
    file('packages/other/src/b.ts', 1000);
    const result = sensePlantDepth({ repoRoot: root, sourceGlobs: ['packages/core*/src/**'], now });
    expect(result.status).toBe('pass');
    expect(result.metrics?.files_count).toBe(1);
    expect(result.metrics?.lines_total).toBe(10);
  });

  it('treats regexp punctuation in a glob segment literally', () => {
    file('packages/core.v1/src/a.ts', 10);
    file('packages/coreXv1/src/b.ts', 1000);
    expect(
      sensePlantDepth({ repoRoot: root, sourceGlobs: ['packages/core.v*/src/**'] }).metrics
        ?.lines_total,
    ).toBe(10);
  });

  it('excludes declaration and non-source files and nested build directories', () => {
    file('packages/a/src/a.ts', 4);
    file('packages/a/src/component.TSX', 6);
    for (const name of ['a.d.ts', 'a.js', 'a.ts.md']) file(`packages/a/src/${name}`, 1000);
    for (const name of ['node_modules', '.git', 'dist', 'build'])
      file(`packages/a/src/${name}/nested.ts`, 1000);
    const result = sensePlantDepth({ repoRoot: root, now });
    expect(result.metrics).toMatchObject({
      files_count: 2,
      lines_total: 10,
      lines_mean: 5,
      lines_max: 6,
    });
    expect(result.sensor).toEqual({ name: 'plant-depth', kind: 'plant_depth' });
    expect(result.command).toBe('devai sense-plant-depth');
    expect(result.timestamp).toBe(now);
    expect(result.deterministic).toBe(true);
    expect(result.tier).toBe('L0');
  });

  it.each([{ globs: [] }, { globs: ['missing/**'] }, { globs: ['notes.txt'] }])(
    'reports an empty source population for $globs',
    ({ globs }) => {
      file('notes.txt', 5);
      const result = sensePlantDepth({ repoRoot: root, sourceGlobs: globs, now });
      expect(result.status).toBe('review');
      expect(result.metrics).toMatchObject({
        files_count: 0,
        lines_total: 0,
        lines_max: 0,
        lines_mean: 0,
        lines_p95: 0,
      });
      expect(result.findings?.[0]?.code).toBe('PLANT_DEPTH_NO_SOURCES');
    },
  );

  it.each([false, true])('supports a directly selected source path, absolute=%s', (absolute) => {
    file('custom/source.ts', 7);
    const result = sensePlantDepth({
      repoRoot: root,
      sourceGlobs: [absolute ? join(root, 'custom/source.ts') : 'custom/source.ts'],
      thresholds: { pass: 5, review: 7 },
      now,
    });
    expect(result.status).toBe('fail');
    expect(result.metrics).toMatchObject({
      files_count: 1,
      lines_p95: 7,
      threshold_pass: 5,
      threshold_review: 7,
    });
    expect(result.findings?.[0]?.message).toBe(
      '95th-percentile file size 7 LOC exceeds REVIEW threshold 7.',
    );
  });
});
