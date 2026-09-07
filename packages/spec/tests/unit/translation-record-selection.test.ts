import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { resolveRecipeRecordPath } from '../../src/translation-validation/index.js';

const prefix = 'record/proofs/work/recipe-runs/devai-fix/test';
const schema = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../../law/schemas/translation-witness.schema.json'),
    'utf8',
  ),
) as { examples: Record<string, unknown>[] };
let root: string;
let witness: Record<string, unknown>;
function record(patch: Record<string, unknown> = {}) {
  return {
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    status: 'pass',
    evidence: { translation_witness: witness },
    ...patch,
  };
}
function put(name: string, value: unknown): void {
  writeFileSync(join(root, prefix, name), JSON.stringify(value));
}
function select(): string {
  return resolveRecipeRecordPath({
    repo_root: root,
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    witness_id: 'TW-0123456789abcdef',
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-recipe-selection-'));
  mkdirSync(join(root, prefix), { recursive: true });
  witness = structuredClone(schema.examples[0] ?? {});
  expect(validators.translationWitness(witness)).toBe(true);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('exact recipe witness selection', () => {
  it.each(['pass', 'review'])(
    'selects an exact schema-valid witness from a %s record',
    (status) => {
      put('selected.json', record({ status }));
      expect(select()).toBe(`${prefix}/selected.json`);
    },
  );

  it('does not select the last file or a different valid witness', () => {
    put('a-selected.json', record());
    put(
      'z-other.json',
      record({ evidence: { translation_witness: { ...witness, id: 'TW-fedcba9876543210' } } }),
    );
    expect(select()).toBe(`${prefix}/a-selected.json`);
  });

  it('refuses duplicate exact witnesses rather than choosing either file', () => {
    put('first.json', record());
    put('second.json', record());
    expect(select).toThrow('RECIPE_RECORD_NOT_UNIQUE');
  });

  it.each([
    { recipe_name: 'devai-verify' },
    { recipe_variant: 'other' },
    { status: 'fail' },
    { status: 'pending' },
    { evidence: null },
    { evidence: [] },
    { evidence: {} },
    { evidence: { translation_witness: null } },
  ])('refuses an ineligible envelope %j', (patch) => {
    put('record.json', record(patch));
    expect(select).toThrow('RECIPE_RECORD_NOT_FOUND');
  });

  it.each([
    { id: 'TW-fedcba9876543210' },
    { recipe_name: 'devai-verify' },
    { recipe_variant: 'other' },
    { trust: 'trusted' },
    { candidate_sha: 'invalid' },
    { unexpected_field: true },
  ])('checks embedded witness identity and full schema: %j', (patch) => {
    put('record.json', record({ evidence: { translation_witness: { ...witness, ...patch } } }));
    expect(select).toThrow('RECIPE_RECORD_NOT_FOUND');
  });

  it('ignores malformed records and non-record JSON values without hiding a valid match', () => {
    writeFileSync(join(root, prefix, 'bad.json'), '{broken');
    put('null.json', null);
    put('array.json', []);
    put('number.json', 7);
    put('selected.json', record());
    expect(select()).toBe(`${prefix}/selected.json`);
  });

  it.each(['.hidden.json', 'a..b.json', 'record.txt', 'a\\b.json'])(
    'ignores unsafe or unsupported filename %j',
    (name) => {
      put(name, record());
      expect(select).toThrow('RECIPE_RECORD_NOT_FOUND');
    },
  );

  it('does not follow record symlinks or descend into directories named as JSON', () => {
    const target = join(root, 'external.json');
    writeFileSync(target, JSON.stringify(record()));
    symlinkSync(target, join(root, prefix, 'link.json'));
    mkdirSync(join(root, prefix, 'directory.json'));
    expect(select).toThrow('RECIPE_RECORD_NOT_FOUND');
  });

  it('reports absent directories and empty populations as not found', () => {
    expect(select).toThrow('RECIPE_RECORD_NOT_FOUND');
    rmSync(join(root, prefix), { recursive: true });
    expect(select).toThrow('RECIPE_RECORD_NOT_FOUND');
  });
});
