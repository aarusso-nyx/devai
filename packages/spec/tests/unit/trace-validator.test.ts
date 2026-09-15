import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateTrace } from '../../src/spec/trace-validator.js';

// Invariants: INV-DEVAI-001
let root: string;
let tracePath: string;
const id = 'INV-AUTH-001';
function write(path: string, value: unknown) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
  return full;
}
function trace(entries: unknown[]) {
  write('law/trace.json', {
    schemaVersion: '1.0.0',
    version: '1.0.0',
    invariants: entries,
    test_corpus: [],
  });
}
function entry(path: string, target_type?: string) {
  return {
    id,
    tests: [{ suite: 'unit', path, ...(target_type === undefined ? {} : { target_type }) }],
  };
}
function check(ids = [id]) {
  return validateTrace({ tracePath, repoRoot: root, invariantIds: new Set(ids) });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-trace-'));
  tracePath = join(root, 'law/trace.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('trace declared target and catalog boundaries', () => {
  it('requires the trace only when invariants exist', () => {
    expect(check([])).toEqual({
      ok: true,
      errors: [],
      files_scanned: 0,
      trace_invariants_count: 0,
    });
    expect(check()).toEqual({
      ok: false,
      errors: [{ file: tracePath, message: 'trace file missing but 1 invariants are defined' }],
      files_scanned: 0,
      trace_invariants_count: 0,
    });
  });
  it('accepts a contained test with spaces and non-ASCII bytes and infers the repository root', () => {
    const path = 'tests/unité example.test.ts';
    write(path, 'export {};');
    trace([entry(path)]);
    const expected = { ok: true, errors: [], files_scanned: 1, trace_invariants_count: 1 };
    expect(check()).toEqual(expected);
    expect(validateTrace({ tracePath, invariantIds: new Set([id]) })).toEqual(expected);
  });
  it.each([
    ['config-attestation', 'config/policy.json'],
    ['script', 'scripts/verify.mjs'],
  ])('accepts an explicitly declared %s as its declared file kind', (kind, path) => {
    write(path, '{}');
    trace([entry(path, kind)]);
    expect(check()).toEqual({ ok: true, errors: [], files_scanned: 1, trace_invariants_count: 1 });
  });
  it.each([undefined, 'test'])(
    'does not count a configuration file as an executable test for kind %s',
    (kind) => {
      write('config/policy.json', '{}');
      trace([entry('config/policy.json', kind)]);
      expect(check()).toMatchObject({
        ok: false,
        errors: [
          {
            file: tracePath,
            pointer: '/invariants/0/tests/0/path',
            message: expect.stringContaining('not a contained executable test file'),
          },
        ],
      });
    },
  );
  it.each(['../outside.test.ts', '/absolute.test.ts', 'missing.test.ts', 'tests'])(
    'refuses invalid test target %s',
    (path) => {
      mkdirSync(join(root, 'tests'));
      trace([entry(path)]);
      expect(check().ok).toBe(false);
      expect(check().errors).toContainEqual({
        file: tracePath,
        pointer: '/invariants/0/tests/0/path',
        message: expect.stringContaining('not a contained executable test file'),
      });
    },
  );
  it('reports unknown referenced invariants and missing defined invariants together', () => {
    write('a.test.ts', 'export {};');
    trace([entry('a.test.ts')]);
    expect(check(['INV-SEC-001'])).toEqual({
      ok: false,
      files_scanned: 1,
      trace_invariants_count: 1,
      errors: [
        {
          file: tracePath,
          pointer: '/invariants/0/id',
          message: "trace references unknown invariant 'INV-AUTH-001'",
        },
        { file: tracePath, message: "invariant 'INV-SEC-001' has no trace entry" },
      ],
    });
  });
  it('reports malformed JSON without claiming a trace population', () => {
    write('law/trace.json', '{');
    expect(check()).toEqual({
      ok: false,
      errors: [{ file: tracePath, message: expect.stringMatching(/^JSON parse error:/) }],
      files_scanned: 1,
      trace_invariants_count: 0,
    });
  });
  it.each([null, { id }, { id, tests: [null] }, { id, tests: [{ path: 123 }] }])(
    'rejects malformed entries without crashing the path inspection %j',
    (value) => {
      trace([value]);
      const result = check();
      expect(result.ok).toBe(false);
      expect(result.trace_invariants_count).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    },
  );
});

it.each(['config-attestation', 'script'])(
  'preserves containment and file existence for declared %s',
  (kind) => {
    mkdirSync(join(root, 'directory'));
    trace([
      {
        id,
        tests: ['../outside', 'missing', 'directory'].map((path) => ({
          suite: 'unit',
          path,
          target_type: kind,
        })),
      },
    ]);
    const result = check();
    expect(result.ok).toBe(false);
    for (const index of [0, 1, 2])
      expect(result.errors).toContainEqual({
        file: tracePath,
        pointer: `/invariants/0/tests/${index}/path`,
        message: expect.stringContaining('not a contained regular file'),
      });
  },
);
it('refuses an unknown declared kind even when the target is a valid test', () => {
  write('valid.test.ts', 'export {};');
  trace([entry('valid.test.ts', 'anything')]);
  const result = check();
  expect(result.ok).toBe(false);
  expect(result.trace_invariants_count).toBe(0);
  expect(result.errors).toContainEqual({
    file: tracePath,
    pointer: '/invariants/0/tests/0/target_type',
    message: expect.stringContaining('(enum)'),
  });
});
