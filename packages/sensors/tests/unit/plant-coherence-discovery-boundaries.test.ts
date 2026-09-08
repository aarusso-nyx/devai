import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sensePlantCoherence } from '../../src/plant-coherence.js';

const now = '2026-09-08T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-plant-coherence-discovery-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(relativePath: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'export const value = 1;\n');
}

function mixed(relativeDir: string): void {
  write(`${relativeDir}/one-file.ts`);
  write(`${relativeDir}/oneFile.ts`);
}

function findingMessage(reading: ReturnType<typeof sensePlantCoherence>): string {
  const finding = reading.findings?.find(
    (candidate) => candidate.code === 'PLANT_COHERENCE_MIXED_CASING',
  );
  if (finding?.message === undefined) throw new Error('mixed casing finding missing');
  return finding.message;
}

describe('plant coherence source discovery and review boundaries', () => {
  it('does not scan excluded subtrees or an empty directory (8190, 8192, 8194, 8196, 8199, 8202, 8205, 8206)', () => {
    write('packages/a/src/only-file.ts');
    for (const excluded of ['node_modules', '.git', 'dist', 'build'])
      mixed(`packages/a/src/${excluded}`);
    mkdirSync(join(root, 'packages/a/src/empty'), { recursive: true });

    const reading = sensePlantCoherence({ repoRoot: root, now });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ dirs_scanned: 1, incoherent_dirs: 0 });
    expect(reading.findings).toEqual([]);
  });

  it('excludes declaration files while reporting real source files, and treats a selected file as no directory', () => {
    write('packages/a/src/one-file.ts');
    write('packages/a/src/oneFile.ts');
    write('packages/a/src/legacy.d.ts');

    const directory = sensePlantCoherence({ repoRoot: root, now });
    expect(directory.status).toBe('review');
    expect(directory.metrics).toMatchObject({ dirs_scanned: 1, incoherent_dirs: 1 });
    expect(findingMessage(directory)).toContain('across 2 files.');

    const selectedFile = sensePlantCoherence({
      repoRoot: root,
      sourceGlobs: ['packages/a/src/one-file.ts'],
      now,
    });
    expect(selectedFile.status).toBe('review');
    expect(selectedFile.metrics).toMatchObject({ dirs_scanned: 0, incoherent_dirs: 0 });
    expect(selectedFile.findings?.[0]?.code).toBe('PLANT_COHERENCE_NO_DIRS');
  });

  it('keeps a zero-incoherence directory passing when the review limit is zero (8299)', () => {
    write('packages/a/src/one-file.ts');
    write('packages/a/src/two-file.ts');

    const reading = sensePlantCoherence({ repoRoot: root, maxReviewIncoherent: 0, now });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({
      dirs_scanned: 1,
      incoherent_dirs: 0,
      max_review_incoherent: 0,
    });
    expect(reading.findings).toEqual([]);
  });

  it('classifies mixed-directory counts below, equal to, and above the review limit (8304, 8305)', () => {
    mixed('packages/a/src');
    mixed('packages/b/src');

    const below = sensePlantCoherence({ repoRoot: root, maxReviewIncoherent: 3, now });
    const equal = sensePlantCoherence({ repoRoot: root, maxReviewIncoherent: 2, now });
    const above = sensePlantCoherence({ repoRoot: root, maxReviewIncoherent: 1, now });
    const zero = sensePlantCoherence({ repoRoot: root, maxReviewIncoherent: 0, now });

    expect(below.status).toBe('review');
    expect(equal.status).toBe('review');
    expect(above.status).toBe('fail');
    expect(zero.status).toBe('fail');
    for (const reading of [below, equal, above, zero]) {
      expect(reading.metrics).toMatchObject({ dirs_scanned: 2, incoherent_dirs: 2 });
    }
  });
});
