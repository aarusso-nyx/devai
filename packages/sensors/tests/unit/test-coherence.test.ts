import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseTestCoherence } from '../../src/test-coherence.js';

let repoRoot: string;

function seedPackage(
  root: string,
  name: string,
  sources: number,
  tests: number,
  testExt: 'test' | 'spec' = 'test',
): void {
  const pkgDir = join(root, 'packages', name);
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  mkdirSync(join(pkgDir, 'test'), { recursive: true });
  for (let i = 0; i < sources; i += 1) {
    writeFileSync(join(pkgDir, 'src', `mod${String(i)}.ts`), 'export const x = 1;\n');
  }
  for (let i = 0; i < tests; i += 1) {
    writeFileSync(
      join(pkgDir, 'test', `mod${String(i)}.${testExt}.ts`),
      "import { it } from 'vitest'; it('x', () => {});\n",
    );
  }
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'devai-test-coherence-'));
});

afterEach(() => {
  // tmp dir is fine to leak; OS reaps it
});

describe('senseTestCoherence', () => {
  it('passes when every package has ratio above the pass threshold', () => {
    seedPackage(repoRoot, 'alpha', 10, 5);
    seedPackage(repoRoot, 'beta', 10, 4);

    const reading = senseTestCoherence({ repoRoot });

    expect(reading.status).toBe('pass');
    const m = reading.metrics as Record<string, number>;
    expect(m.packages_scanned).toBe(2);
    expect(m.source_files).toBe(20);
    expect(m.test_files).toBe(9);
    expect(m.packages_below_min_ratio).toBe(0);
  });

  it('flags a package whose ratio falls below the per-package minimum', () => {
    seedPackage(repoRoot, 'alpha', 100, 1);
    seedPackage(repoRoot, 'beta', 10, 5);

    const reading = senseTestCoherence({ repoRoot });

    const m = reading.metrics as Record<string, number>;
    expect(m.packages_below_min_ratio).toBe(1);
    expect(reading.findings?.some((f) => f.code === 'TEST_COHERENCE_PACKAGE_BELOW_MIN')).toBe(true);
  });

  it('fails when global ratio is below the per-package minimum', () => {
    seedPackage(repoRoot, 'alpha', 200, 1);

    const reading = senseTestCoherence({ repoRoot });

    expect(reading.status).toBe('fail');
  });

  it('warns about mixed .test.ts vs .spec.ts naming', () => {
    seedPackage(repoRoot, 'alpha', 10, 5, 'test');
    seedPackage(repoRoot, 'beta', 10, 5, 'spec');

    const reading = senseTestCoherence({ repoRoot });

    expect(reading.findings?.some((f) => f.code === 'TEST_COHERENCE_NAMING_MIXED')).toBe(true);
    const m = reading.metrics as Record<string, number>;
    expect(m.naming_consistent).toBe(0);
  });
});
// Invariants: INV-DEVAI-002, INV-DEVAI-012
