import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sensePlantCoherence } from '../../src/plant-coherence.js';

let root: string;
const now = '2026-09-08T12:00:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-wave4-plant-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(relativePath: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, 'export const value = 1;\n');
}

function sense() {
  return sensePlantCoherence({
    repoRoot: root,
    sourceGlobs: ['packages/*/src/**'],
    now,
  });
}

describe('wave4 plant-coherence boundaries', () => {
  it('distinguishes PascalCase from kebab-case and reports both buckets', () => {
    write('packages/a/src/PascalCase.ts');
    write('packages/a/src/kebab-case.ts');

    const reading = sense();
    const finding = reading.findings?.find(
      (candidate) => candidate.code === 'PLANT_COHERENCE_MIXED_CASING',
    );

    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({ dirs_scanned: 1, incoherent_dirs: 1 });
    expect(finding?.file).toBe('packages/a/src');
    expect(finding?.message).toContain('pascal');
    expect(finding?.message).toContain('kebab');
  });

  it('does not classify a leading-punctuation snake stem as snake', () => {
    write('packages/a/src/kebab-case.ts');
    write('packages/a/src/!snake_case.ts');

    const reading = sense();
    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ dirs_scanned: 1, incoherent_dirs: 0 });
    expect(reading.findings).toEqual([]);
  });

  it('does not classify a punctuated camel stem from a valid prefix', () => {
    write('packages/a/src/kebab-case.ts');
    write('packages/a/src/camelCase!.ts');

    const reading = sense();
    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ dirs_scanned: 1, incoherent_dirs: 0 });
    expect(reading.findings).toEqual([]);
  });

  it('does not classify a punctuated kebab stem from a valid prefix', () => {
    write('packages/a/src/snake_case.ts');
    write('packages/a/src/kebab-case!.ts');

    const reading = sense();
    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ dirs_scanned: 1, incoherent_dirs: 0 });
    expect(reading.findings).toEqual([]);
  });

  it('excludes a source-looking suffix after the terminal extension', () => {
    write('packages/a/src/snake_case.ts');
    write('packages/a/src/camelCase.ts');
    write('packages/a/src/sensorReading.ts.bak');

    const reading = sense();
    const finding = reading.findings?.find(
      (candidate) => candidate.code === 'PLANT_COHERENCE_MIXED_CASING',
    );

    expect(reading.status).toBe('review');
    expect(finding?.message).toContain('across 2 files.');
  });

  it('counts exactly one mixed directory at the two-bucket threshold', () => {
    write('packages/a/src/one-file.ts');
    write('packages/a/src/oneFile.ts');
    write('packages/b/src/only-file.ts');

    const reading = sense();
    const mixed = reading.findings?.filter(
      (candidate) => candidate.code === 'PLANT_COHERENCE_MIXED_CASING',
    );

    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({ dirs_scanned: 2, incoherent_dirs: 1 });
    expect(mixed).toHaveLength(1);
    expect(mixed?.[0]?.file).toBe('packages/a/src');
  });
});
