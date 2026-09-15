import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateJourneys } from '../../src/spec/journey-validator.js';

// Invariants: INV-DEVAI-001
let root: string;
const schema = JSON.parse(
  readFileSync(new URL('../../../../law/schemas/journey.schema.json', import.meta.url), 'utf8'),
) as { examples: Array<Record<string, unknown>> };
function record(overrides: Record<string, unknown> = {}) {
  return { ...structuredClone(schema.examples[0]), ...overrides };
}
function write(name: string, value: unknown) {
  const file = join(root, name);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}
function check(ids: string[] = []) {
  return validateJourneys({ journeysDir: root, invariantIds: new Set(ids) });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-journey-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('journey validation against the real schema and invariant catalog', () => {
  it('accepts an empty or absent journey directory without inventing records', () => {
    const empty = { ok: true, errors: [], files_scanned: 0, journeys: [], xrefs: [] };
    expect(check()).toEqual(empty);
    expect(
      validateJourneys({ journeysDir: join(root, 'absent'), invariantIds: new Set() }),
    ).toEqual(empty);
    const regularFile = write('not-a-directory', 'Keep these unrelated bytes');
    expect(validateJourneys({ journeysDir: regularFile, invariantIds: new Set() })).toEqual(empty);
    expect(readFileSync(regularFile, 'utf8')).toBe('Keep these unrelated bytes');
  });

  it('loads sorted journey files while ignoring other prefixes, extensions and nested records', () => {
    const second = write('JNY-002.json', record({ id: 'JNY-002' }));
    const first = write('JNY-001.json', record());
    write('INV-001.json', 'invalid');
    write('JNY-003.txt', 'invalid');
    mkdirSync(join(root, 'nested'));
    write('nested/JNY-004.json', 'invalid');
    expect(check()).toEqual({
      ok: true,
      errors: [],
      files_scanned: 2,
      xrefs: [],
      journeys: [
        { id: 'JNY-001', file: first, related_invariants: [] },
        { id: 'JNY-002', file: second, related_invariants: [] },
      ],
    });
  });

  it('retains exact cross-reference attribution for related invariants and every measurable criterion', () => {
    const file = write(
      'JNY-001.json',
      record({
        related_invariants: ['INV-A', 'INV-B'],
        acceptance_criteria: [
          { id: 'AC-001', statement: 'First', measurable_via: ['INV-B', 'INV-C'] },
          { id: 'AC-002', statement: 'Second', measurable_via: ['INV-A'] },
        ],
      }),
    );
    const result = check(['INV-A', 'INV-B', 'INV-C']);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.xrefs).toEqual(
      [
        ['/related_invariants/0', 'INV-A'],
        ['/related_invariants/1', 'INV-B'],
        ['/acceptance_criteria/0/measurable_via/0', 'INV-B'],
        ['/acceptance_criteria/0/measurable_via/1', 'INV-C'],
        ['/acceptance_criteria/1/measurable_via/0', 'INV-A'],
      ].map(([field, target_id]) => ({
        source_file: file,
        source_id: 'JNY-001',
        field,
        target_id,
        target_kind: 'invariant',
      })),
    );
    expect(result.journeys).toEqual([
      { id: 'JNY-001', file, related_invariants: ['INV-A', 'INV-B'] },
    ]);
  });

  it('aggregates missing references in both fields while retaining the loaded journey', () => {
    const file = write(
      'JNY-001.json',
      record({
        related_invariants: ['INV-OK', 'INV-MISSING'],
        acceptance_criteria: [
          { id: 'AC-001', statement: 'First' },
          { id: 'AC-002', statement: 'Second', measurable_via: ['INV-OK', 'INV-OTHER'] },
        ],
      }),
    );
    const result = check(['INV-OK']);
    expect(result.ok).toBe(false);
    expect(result.files_scanned).toBe(1);
    expect(result.journeys).toHaveLength(1);
    expect(result.xrefs).toHaveLength(4);
    expect(result.errors).toEqual([
      {
        file,
        pointer: '/related_invariants/1',
        message: "related_invariants[1] 'INV-MISSING' does not exist in the invariant catalog",
      },
      {
        file,
        pointer: '/acceptance_criteria/1/measurable_via/1',
        message:
          "acceptance_criteria[1].measurable_via[1] 'INV-OTHER' does not exist in the invariant catalog",
      },
    ]);
  });

  it('reports filename identity mismatch and duplicate identities together', () => {
    const first = write('JNY-001.json', record());
    const second = write('JNY-002.json', record());
    const result = check();
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        file: second,
        message: "filename 'JNY-002.json' does not match id 'JNY-001' (expected JNY-001.json)",
      },
      {
        file: `${first} | ${second}`,
        message: `duplicate journey id 'JNY-001' across files: ${first}, ${second}`,
      },
    ]);
    expect(result.journeys).toHaveLength(2);
  });

  it('continues after malformed JSON and schema failures without treating either as a journey', () => {
    const malformed = write('JNY-001.json', '{');
    const invalid = write('JNY-002.json', record({ id: 'JNY-002', unexpected: true }));
    const invalidTitle = write('JNY-004.json', record({ id: 'JNY-004', title: '' }));
    const valid = write('JNY-003.json', record({ id: 'JNY-003' }));
    const result = check();
    expect(result.ok).toBe(false);
    expect(result.files_scanned).toBe(4);
    expect(result.journeys).toEqual([{ file: valid, id: 'JNY-003', related_invariants: [] }]);
    expect(result.xrefs).toEqual([]);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        { file: malformed, message: expect.stringMatching(/^JSON parse error: /) },
        {
          file: invalid,
          pointer: undefined,
          message: 'must NOT have additional properties (additionalProperties)',
        },
        {
          file: invalidTitle,
          pointer: '/title',
          message: 'must NOT have fewer than 1 characters (minLength)',
        },
      ]),
    );
    expect(result.errors).toHaveLength(3);
  });

  it.each([
    { acceptance_criteria: [] },
    { related_invariants: ['not-an-invariant'] },
    { id: 'JNY-1' },
    { schemaVersion: '2.0.0' },
  ])('refuses schema-invalid record %j', (overrides) => {
    write('JNY-001.json', record(overrides));
    const result = check();
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.journeys).toEqual([]);
    expect(result.xrefs).toEqual([]);
  });
});
