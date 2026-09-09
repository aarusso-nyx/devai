import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseTestCoherence } from '../../src/test-coherence.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

function write(relative: string, contents = 'export const value = 1;\n'): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function packageFiles(
  name: string,
  sources: number,
  tests: number,
  extension: 'test' | 'spec' = 'test',
): void {
  for (let index = 1; index <= sources; index += 1)
    write(`packages/${name}/src/source-${index}.ts`);
  for (let index = 1; index <= tests; index += 1) {
    write(`packages/${name}/test/case-${index}.${extension}.ts`, 'it("works", () => {});\n');
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-test-coherence-boundaries-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('test coherence population boundaries', () => {
  it('distinguishes source filenames from tests, declarations, and ignored outputs', () => {
    packageFiles('alpha', 2, 2);
    write('packages/alpha/src/types.d.ts', 'export interface Types {}\n');
    write('packages/alpha/src/near.test.ts-helper.ts');
    write('packages/alpha/src/near.d.ts-helper.ts');
    write('packages/alpha/.git/ignored.ts');
    write('packages/alpha/test/near.spec.ts.bak');
    write('packages/alpha/node_modules/ignored.ts');
    write('packages/alpha/dist/generated.ts');
    write('packages/alpha/build/generated.ts');

    const reading = senseTestCoherence({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'pass',
      timestamp: NOW,
      command: 'devai sense-test-coherence',
      metrics: {
        packages_scanned: 1,
        source_files: 4,
        test_files: 2,
        global_ratio: 0.5,
        packages_below_min_ratio: 0,
        naming_uses_test: 2,
        naming_uses_spec: 0,
        naming_consistent: 1,
      },
      findings: [],
    });
  });

  it('passes when per-package and global ratios equal their configured lower bound', () => {
    packageFiles('alpha', 2, 1);
    packageFiles('beta', 2, 1, 'test');

    const reading = senseTestCoherence({
      repoRoot: root,
      minPerPackageRatio: 0.5,
      passRatio: 0.5,
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'pass',
      metrics: {
        packages_scanned: 2,
        source_files: 4,
        test_files: 2,
        global_ratio: 0.5,
        packages_below_min_ratio: 0,
        naming_uses_test: 2,
        naming_uses_spec: 0,
        naming_consistent: 1,
      },
      findings: [],
    });
  });

  it('reviews mixed naming and reports the affected package ratio precisely', () => {
    packageFiles('alpha', 3, 1, 'test');
    packageFiles('beta', 2, 1, 'spec');

    const reading = senseTestCoherence({
      repoRoot: root,
      minPerPackageRatio: 0.4,
      passRatio: 0.8,
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'review',
      metrics: {
        packages_scanned: 2,
        source_files: 5,
        test_files: 2,
        global_ratio: 0.4,
        packages_below_min_ratio: 1,
        naming_uses_test: 1,
        naming_uses_spec: 1,
        naming_consistent: 0,
      },
      findings: [
        {
          severity: 'warning',
          code: 'TEST_COHERENCE_PACKAGE_BELOW_MIN',
          message: 'Package packages/alpha has test/source ratio 0.33 (< 0.4).',
          file: 'packages/alpha',
        },
        {
          severity: 'warning',
          code: 'TEST_COHERENCE_NAMING_MIXED',
          message: 'Test-file naming mixes .test.* (1) and .spec.* (1).',
        },
      ],
    });
  });
});
