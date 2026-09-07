import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateInvariants } from '../../src/spec/invariant-validator.js';

// Invariants: INV-DEVAI-001
let root: string;
let dir: string;
const schema = JSON.parse(
  readFileSync(new URL('../../../../law/schemas/invariant.schema.json', import.meta.url), 'utf8'),
) as { examples: Array<Record<string, unknown>> };
function record(overrides: Record<string, unknown> = {}) {
  return {
    ...structuredClone(schema.examples[0]),
    authority_docs: { docs: [{ doc: 'authority.md', anchor: 'human-roles' }] },
    ...overrides,
  };
}
function write(name: string, value: unknown) {
  const file = join(dir, name);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}
function check(options: { strictCnl?: boolean; companionPatterns?: string[] } = {}) {
  return validateInvariants({
    repoRoot: root,
    invariantsDir: dir,
    domains: { all: new Set(['AUTH', 'SEC']), core: ['AUTH'], framework: ['SEC'], client: [] },
    ...options,
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-invariant-'));
  dir = join(root, 'law', 'invariants');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'authority.md'), '# Human roles\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('invariant taxonomy, authority and companion boundaries', () => {
  it('accepts the real schema record and resolves its authority heading', () => {
    const file = write('INV-AUTH-001.json', record());
    expect(check()).toEqual({
      ok: true,
      errors: [],
      files_scanned: 1,
      files_skipped: 0,
      skipped_files: [],
      invariants: [{ id: 'INV-AUTH-001', domain: 'AUTH', file }],
    });
  });
  it('excludes default companion files and reports their exact population', () => {
    const first = write('INV-AUTH-001-allowlist.json', '{');
    const second = write('INV-AUTH-001-data.json', '{');
    write('INV-AUTH-001.json', record());
    expect(check()).toMatchObject({
      ok: true,
      files_scanned: 1,
      files_skipped: 2,
      skipped_files: [first, second],
    });
    expect(check({ companionPatterns: [] })).toMatchObject({
      ok: false,
      files_scanned: 3,
      files_skipped: 0,
      skipped_files: [],
    });
  });
  it('matches custom companion patterns literally except the wildcard and anchors the complete name', () => {
    const skipped = write('INV-AUTH-[data].json', '{');
    write('INV-AUTH-XdataX.json', '{');
    write('INV-AUTH-[data].json-extra.json', '{');
    const result = check({ companionPatterns: ['INV-*-\u005bdata\u005d.json'] });
    expect(result.skipped_files).toEqual([skipped]);
    expect(result.files_scanned).toBe(2);
    expect(result.ok).toBe(false);
  });
  it('reports unknown taxonomy and ID/domain mismatch independently', () => {
    const file = write('INV-AUTH-001.json', record({ domain: 'UNKNOWN' }));
    expect(check()).toMatchObject({
      ok: false,
      errors: [
        {
          file,
          pointer: '/domain',
          message:
            "domain 'UNKNOWN' is not in the configured taxonomy (.devai/config/domains.json)",
        },
        {
          file,
          pointer: '/id',
          message: "id domain 'AUTH' does not match 'domain' field 'UNKNOWN'",
        },
      ],
    });
  });
  it('detects mismatch even when the declared domain is in the taxonomy', () => {
    write('INV-AUTH-001.json', record({ domain: 'SEC' }));
    expect(check().errors).toEqual([expect.objectContaining({ pointer: '/id' })]);
  });
  it('reports missing anchors at their actual index and continues checking other records', () => {
    const file = write(
      'INV-AUTH-001.json',
      record({
        authority_docs: {
          docs: [
            { doc: 'authority.md', anchor: 'human-roles' },
            { doc: 'authority.md', anchor: 'missing' },
            { doc: 'absent.md', anchor: 'human-roles' },
          ],
        },
      }),
    );
    const result = check();
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        file,
        pointer: '/authority_docs/docs/1/anchor',
        message: expect.stringContaining("cannot resolve anchor 'missing' in doc 'authority.md'"),
      },
      {
        file,
        pointer: '/authority_docs/docs/2/anchor',
        message: expect.stringContaining("cannot resolve anchor 'human-roles' in doc 'absent.md'"),
      },
    ]);
    expect(result.invariants).toHaveLength(1);
  });
  it('accepts absolute authority document paths', () => {
    write(
      'INV-AUTH-001.json',
      record({
        authority_docs: { docs: [{ doc: join(root, 'authority.md'), anchor: 'Human roles' }] },
      }),
    );
    expect(check().ok).toBe(true);
  });
  it.each(['MUST', 'MUST NOT', 'SHOULD', 'SHOULD NOT', 'MAY'])(
    'accepts recognized CNL modal %s',
    (modal) => {
      write('INV-AUTH-001.json', record({ statement: `The caller ${modal} declare its role.` }));
      expect(check({ strictCnl: true }).errors).toEqual([]);
    },
  );
  it.each([
    'The caller must declare its role.',
    'MUSTARD is a word.',
    'The caller declares its role.',
  ])('does not invent a recognized modal in %s', (statement) => {
    const file = write('INV-AUTH-001.json', record({ statement }));
    expect(check().ok).toBe(true);
    expect(check({ strictCnl: true }).errors).toEqual([
      {
        file,
        pointer: '/statement',
        code: 'STATEMENT_LACKS_CNL_MODAL',
        severity: 'warning',
        message: expect.stringMatching(/^cnl-warn:/),
      },
    ]);
  });
  it('aggregates invalid syntax and schema errors while retaining only valid records', () => {
    write('INV-AUTH-001.json', '{');
    write('INV-AUTH-002.json', record({ id: 'INV-AUTH-002', statement: '' }));
    const valid = write('INV-AUTH-003.json', record({ id: 'INV-AUTH-003' }));
    const result = check();
    expect(result.ok).toBe(false);
    expect(result.files_scanned).toBe(3);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.message).toMatch(/^JSON parse error:/);
    expect(result.errors[1]?.pointer).toBe('/statement');
    expect(result.invariants).toEqual([{ file: valid, id: 'INV-AUTH-003', domain: 'AUTH' }]);
  });
  it('reports duplicate identity and filename mismatch without discarding loaded records', () => {
    const first = write('INV-AUTH-001.json', record());
    const second = write('INV-AUTH-002.json', record());
    const result = check();
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        file: second,
        message:
          "filename 'INV-AUTH-002.json' does not match id 'INV-AUTH-001' (expected INV-AUTH-001.json)",
      },
      {
        file: `${first} | ${second}`,
        message: `duplicate invariant id 'INV-AUTH-001' across files: ${first}, ${second}`,
      },
    ]);
    expect(result.invariants).toHaveLength(2);
  });
});
