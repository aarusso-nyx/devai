import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseTestCoherence } from '../../src/test-coherence.js';

const now = '2026-09-09T12:00:00.000Z';
let root: string;

function write(path: string, contents = 'export const value = 1;\n'): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-test-coherence-population-'));
  write('packages/alpha/src/main.ts');
  write('packages/alpha/src/legacy.js');
  write('packages/alpha/src/utility.test.ts-helper.ts');
  write('packages/alpha/src/utility.spec.ts-helper.ts');
  write('packages/alpha/src/types.d.ts', 'export interface Value { value: number }\n');
  write('packages/alpha/src/utility.test.ts');
  write('packages/alpha/src/utility.spec.ts');
  write('packages/alpha/src/fake.test.ts.bak');
  write('packages/alpha/src/fake.spec.ts.bak');
  write('packages/alpha/test/unit.test.ts');
  write('packages/alpha/test/unit.spec.ts');
  write('packages/alpha/test/README');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('test-coherence file population', () => {
  it('counts source and test conventions exactly while ignoring declarations and near-miss suffixes', () => {
    const reading = senseTestCoherence({ repoRoot: root, now });

    expect(reading.status).toBe('review');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'TEST_COHERENCE_NAMING_MIXED',
        message: 'Test-file naming mixes .test.* (2) and .spec.* (2).',
      },
    ]);
    expect(reading.metrics).toEqual({
      packages_scanned: 1,
      source_files: 4,
      test_files: 4,
      global_ratio: 1,
      packages_below_min_ratio: 0,
      naming_uses_test: 2,
      naming_uses_spec: 2,
      naming_consistent: 0,
    });
  });
});
