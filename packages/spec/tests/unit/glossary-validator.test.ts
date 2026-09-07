import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateGlossary } from '../../src/spec/glossary-validator.js';

// Invariants: INV-DEVAI-001
let root: string;
const schema = JSON.parse(
  readFileSync(
    new URL('../../../../law/schemas/glossary-entry.schema.json', import.meta.url),
    'utf8',
  ),
) as { examples: Array<Record<string, unknown>> };
function record(overrides: Record<string, unknown> = {}) {
  const value = { ...structuredClone(schema.examples[0]), ...overrides };
  delete value['see_also'];
  delete value['related_invariants'];
  return { ...value, ...overrides };
}
function write(name: string, value: unknown) {
  const file = join(root, name);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}
function check(ids: string[] = []) {
  return validateGlossary({ glossaryDir: root, invariantIds: new Set(ids) });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-glossary-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('glossary identity and reference validation', () => {
  it('accepts the real schema example without optional references', () => {
    const file = write('GE-001.json', record());
    expect(check()).toEqual({
      ok: true,
      errors: [],
      files_scanned: 1,
      entries: [{ id: 'GE-001', term: 'Owner', file }],
    });
  });
  it('resolves forward and backward glossary references against the complete population', () => {
    const first = write(
      'GE-001.json',
      record({ see_also: ['GE-002'], related_invariants: ['INV-A', 'INV-B'] }),
    );
    const second = write(
      'GE-002.json',
      record({ id: 'GE-002', term: 'Architect', see_also: ['GE-001'] }),
    );
    expect(check(['INV-A', 'INV-B'])).toEqual({
      ok: true,
      errors: [],
      files_scanned: 2,
      entries: [
        { id: 'GE-001', term: 'Owner', file: first },
        { id: 'GE-002', term: 'Architect', file: second },
      ],
    });
  });
  it('reports each missing reference at its actual array index', () => {
    const file = write(
      'GE-001.json',
      record({ see_also: ['GE-001', 'GE-999'], related_invariants: ['INV-OK', 'INV-MISSING'] }),
    );
    const result = check(['INV-OK']);
    expect(result.ok).toBe(false);
    expect(result.entries).toHaveLength(1);
    expect(result.errors).toEqual([
      {
        file,
        pointer: '/related_invariants/1',
        message: "related_invariants[1] 'INV-MISSING' does not exist in the invariant catalog",
      },
      {
        file,
        pointer: '/see_also/1',
        message: "see_also[1] 'GE-999' does not exist in the glossary catalog",
      },
    ]);
  });
  it('rejects case-insensitive duplicate terms even when identities differ', () => {
    const first = write('GE-001.json', record());
    const second = write('GE-002.json', record({ id: 'GE-002', term: 'OWNER' }));
    expect(check().errors).toEqual([
      {
        file: `${first} | ${second}`,
        message: `duplicate glossary term (case-insensitive) 'owner' across files: ${first}, ${second}`,
      },
    ]);
    expect(check().ok).toBe(false);
  });
  it('reports duplicate IDs independently of filename and term errors', () => {
    const first = write('GE-001.json', record());
    const second = write('GE-002.json', record({ term: 'Architect' }));
    expect(check()).toMatchObject({
      ok: false,
      files_scanned: 2,
      errors: [
        {
          file: second,
          message: "filename 'GE-002.json' does not match id 'GE-001' (expected GE-001.json)",
        },
        {
          file: `${first} | ${second}`,
          message: `duplicate glossary id 'GE-001' across files: ${first}, ${second}`,
        },
      ],
    });
  });
  it('does not use a schema-invalid record to satisfy a cross-reference', () => {
    const first = write('GE-001.json', record({ see_also: ['GE-002'] }));
    const invalid = write('GE-002.json', record({ id: 'GE-002', term: '' }));
    const malformed = write('GE-003.json', '{');
    const result = check();
    expect(result.ok).toBe(false);
    expect(result.files_scanned).toBe(3);
    expect(result.entries).toEqual([{ id: 'GE-001', term: 'Owner', file: first }]);
    expect(result.errors).toEqual([
      { file: invalid, pointer: '/term', message: expect.stringContaining('(minLength)') },
      { file: malformed, message: expect.stringMatching(/^JSON parse error: /) },
      {
        file: first,
        pointer: '/see_also/0',
        message: "see_also[0] 'GE-002' does not exist in the glossary catalog",
      },
    ]);
  });
  it.each([{ unexpected: true }, { authority: 'unknown' }, { see_also: ['not-a-glossary-id'] }])(
    'rejects schema violation %j',
    (overrides) => {
      write('GE-001.json', record(overrides));
      expect(check()).toMatchObject({ ok: false, entries: [], files_scanned: 1 });
      expect(check().errors).not.toEqual([]);
    },
  );
  it('ignores unrelated files and accepts a missing directory', () => {
    write('INV-001.json', '{');
    write('GE-001.txt', '{');
    const empty = { ok: true, errors: [], files_scanned: 0, entries: [] };
    expect(check()).toEqual(empty);
    expect(
      validateGlossary({ glossaryDir: join(root, 'missing'), invariantIds: new Set() }),
    ).toEqual(empty);
  });
});
