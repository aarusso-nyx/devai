// ADR-SCR-0004 IA-004 (declaration half): DEVAI's own data handling declaration at
// law/security/data-handling.json validates against law/schemas/data-handling.schema.json
// and states, store by store, that the repository stores no personal data.
//
// This observes the declaration clauses of INV-DATA-001. The clause that the inventory
// data handling sensor reads the declaration instead of scanning for personal-data
// columns is not observed here.
//
// Interface assumptions: none beyond the committed record and its schema. The schema's
// shared identifiers resolve through law/schemas/common-defs.schema.json.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

interface Store {
  readonly path: string;
  readonly personal_data: boolean;
}

interface DataHandling {
  readonly status: string;
  readonly personal_data: { readonly stored: boolean };
  readonly stores: readonly Store[];
  readonly invariants: readonly string[];
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8')) as T;
}

const declaration = readJson<DataHandling>('law/security/data-handling.json');
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(readJson<object>('law/schemas/common-defs.schema.json'));
const validate = ajv.compile(readJson<object>('law/schemas/data-handling.schema.json'));

describe('INV-DATA-001: the repository declares that it stores no personal data', () => {
  it('validates against law/schemas/data-handling.schema.json', () => {
    const ok = validate(declaration);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('states that no personal data is stored and marks every store personal_data false', () => {
    expect(declaration.status).toBe('active');
    expect(declaration.personal_data.stored).toBe(false);
    expect(declaration.stores.length).toBeGreaterThan(0);
    const personal = declaration.stores.filter((store) => store.personal_data);
    expect(personal.map((store) => store.path)).toEqual([]);
    expect(declaration.invariants).toContain('INV-DATA-001');
  });

  it('the schema refuses a declaration whose stored flag is not a boolean or whose store has none', () => {
    const vague = { ...declaration, personal_data: { ...declaration.personal_data, stored: 'no' } };
    expect(validate(vague)).toBe(false);
    const [first, ...rest] = declaration.stores;
    const unstated = { ...declaration, stores: [{ ...first, personal_data: undefined }, ...rest] };
    expect(validate(JSON.parse(JSON.stringify(unstated)))).toBe(false);
  });
});
