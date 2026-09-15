import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateTestTrace } from '../../src/spec/test-trace-validator.js';

let root: string;
function write(path: string, value: unknown): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
}
const supported = 'INV-AUTH-001';
const experimental = 'INV-AUTH-002';
function mapping(path: string, ids = [supported], lifecycle = 'supported') {
  return { path, invariant_ids: ids, lifecycle };
}
function check() {
  return validateTestTrace({ repoRoot: root });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-test-trace-'));
  write('law/invariants/supported.json', { id: supported });
  write('law/invariants/experimental.json', { id: experimental, lifecycle: 'experimental' });
  write('law/trace.json', {});
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('test trace reconciliation', () => {
  it('reconciles sorted comma-separated markers across both test roots and counts lifecycles', () => {
    write('law/invariants/second.json', { id: 'INV-SEC-003', lifecycle: 'supported' });
    write('packages/a/tests/unité.test.ts', `// Invariants: INV-SEC-003, ${supported}, \n`);
    write('tests/nested/exp.test.ts', `// Invariants: ${experimental}\n`);
    write('law/trace.json', {
      test_corpus: [
        mapping('packages/a/tests/unité.test.ts', [supported, 'INV-SEC-003']),
        mapping('tests/nested/exp.test.ts', [experimental], 'experimental'),
      ],
    });
    expect(check()).toEqual({
      ok: true,
      errors: [],
      files_scanned: 2,
      discovered_test_files: 2,
      referenced_test_files: 2,
      supported_test_files: 1,
      experimental_test_files: 1,
    });
  });

  it('ignores dependency/build trees, non-test files and package files outside tests', () => {
    for (const path of [
      'packages/a/node_modules/tests/a.test.ts',
      'packages/a/dist/tests/a.test.ts',
      'tests/node_modules/a.test.ts',
      'tests/dist/a.test.ts',
      'packages/a/src/a.test.ts',
      'tests/helper.ts',
    ])
      write(path, 'no marker');
    expect(check()).toEqual({
      ok: true,
      errors: [],
      files_scanned: 0,
      discovered_test_files: 0,
      referenced_test_files: 0,
      supported_test_files: 0,
      experimental_test_files: 0,
    });
  });

  it('aggregates missing markers and missing corpus entries without claiming referenced tests', () => {
    write('tests/a.test.ts', '// Invariants: , ,\n');
    const result = check();
    expect(result.ok).toBe(false);
    expect(result.referenced_test_files).toBe(0);
    expect(result.supported_test_files).toBe(0);
    expect(result.errors).toEqual([
      { file: 'tests/a.test.ts', message: 'missing invariant marker (`// Invariants: INV-...`)' },
      { file: 'tests/a.test.ts', message: 'test is absent from trace.test_corpus' },
    ]);
  });

  it('reports duplicate references across marker lines once while comparing the unique mapping', () => {
    write(
      'tests/a.test.ts',
      `// Invariants: ${supported}, ${supported}\n// Invariants: ${supported}\n`,
    );
    write('law/trace.json', { test_corpus: [mapping('tests/a.test.ts')] });
    expect(check().errors).toEqual([
      { file: 'tests/a.test.ts', message: `duplicate invariant reference '${supported}'` },
    ]);
  });

  it('reports unknown invariants and does not assign an unsupported readiness classification', () => {
    write('tests/a.test.ts', '// Invariants: INV-MISSING-001\n');
    write('law/trace.json', { test_corpus: [mapping('tests/a.test.ts', ['INV-MISSING-001'])] });
    const result = check();
    expect(result.errors).toEqual([
      { file: 'tests/a.test.ts', message: "unknown invariant 'INV-MISSING-001'" },
    ]);
    expect(result.supported_test_files).toBe(0);
    expect(result.experimental_test_files).toBe(0);
    expect(result.referenced_test_files).toBe(1);
  });

  it('refuses mixed lifecycles even when the canonical IDs match', () => {
    write('tests/a.test.ts', `// Invariants: ${supported}, ${experimental}\n`);
    write('law/trace.json', {
      test_corpus: [mapping('tests/a.test.ts', [experimental, supported])],
    });
    const result = check();
    expect(result.errors).toEqual([
      {
        file: 'tests/a.test.ts',
        message: 'mixed invariant lifecycles cannot share readiness provenance',
      },
    ]);
    expect(result.supported_test_files + result.experimental_test_files).toBe(0);
  });

  it('reports independent canonical mapping and lifecycle discrepancies', () => {
    write('tests/a.test.ts', `// Invariants: ${supported}\n`);
    write('law/trace.json', {
      test_corpus: [mapping('tests/a.test.ts', [experimental], 'experimental')],
    });
    expect(check().errors).toEqual([
      {
        file: 'tests/a.test.ts',
        message: `canonical invariant mapping differs: marker=[${supported}] trace=[${experimental}]`,
      },
      {
        file: 'tests/a.test.ts',
        message: 'lifecycle classification differs: marker=supported trace=experimental',
      },
    ]);
  });

  it('rejects duplicate canonical mappings without overwriting the first', () => {
    write('tests/a.test.ts', `// Invariants: ${supported}\n`);
    write('law/trace.json', {
      test_corpus: [mapping('tests/a.test.ts'), mapping('tests/a.test.ts', [experimental])],
    });
    expect(check().errors).toEqual([
      {
        file: join(root, 'law/trace.json'),
        message: "duplicate canonical test mapping 'tests/a.test.ts'",
      },
    ]);
  });

  it.each(['../outside.test.ts', 'tests/missing.test.ts', 'tests/helper.ts'])(
    'rejects invalid paths in both canonical and invariant mappings: %s',
    (path) => {
      write('tests/helper.ts', 'helper');
      write('law/trace.json', {
        test_corpus: [mapping(path)],
        invariants: [{ id: supported, tests: [{ path }] }],
      });
      expect(check().errors).toEqual(
        Array.from({ length: 2 }, () => ({
          file: path,
          message: 'trace path is not a contained executable test file',
        })),
      );
    },
  );

  it('reports a missing trace separately from a missing invariant directory', () => {
    rmSync(join(root, 'law'), { recursive: true });
    write('tests/a.test.ts', `// Invariants: ${supported}\n`);
    expect(check().errors.map((error) => error.message)).toEqual([
      `unknown invariant '${supported}'`,
      'trace file missing',
      'test is absent from trace.test_corpus',
    ]);
  });

  it('reports malformed trace JSON and leaves malformed invariant reporting to its owning validator', () => {
    write('law/trace.json', '{broken');
    write('law/invariants/bad.json', '{broken');
    write('law/invariants/no-id.json', { lifecycle: 'supported' });
    write('law/invariants/ignored.txt', '{broken');
    const result = check();
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      file: join(root, 'law/trace.json'),
      message: expect.stringContaining('trace JSON parse error:'),
    });
  });

  it('uses explicit trace and invariant locations', () => {
    write('custom/invariants/a.json', { id: 'INV-CUSTOM-001', lifecycle: 'experimental' });
    write('tests/a.test.ts', '// Invariants: INV-CUSTOM-001\n');
    write('custom/trace.json', {
      test_corpus: [mapping('tests/a.test.ts', ['INV-CUSTOM-001'], 'experimental')],
      invariants: [{ id: 'INV-CUSTOM-001', tests: [{ path: 'tests/a.test.ts' }] }],
    });
    const result = validateTestTrace({
      repoRoot: root,
      tracePath: join(root, 'custom/trace.json'),
      invariantsDir: join(root, 'custom/invariants'),
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.experimental_test_files).toBe(1);
  });
});
