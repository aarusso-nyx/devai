import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';
import { schemaExample } from '../fixtures/governance-v15.js';
const validate = getValidator('evidence.schema.json');
const provenance = {
  source_chain_path: 'custody/original-chain.json',
  source_chain_sha256: 'a'.repeat(64),
  source_entry_id: 'EV-0123456789abcdef',
  source_entry_sequence: 7,
  source_entry_manifest_hash: 'b'.repeat(64),
  fork_sequence: 6,
};
const record = () => ({
  ...schemaExample<Record<string, unknown>>('evidence.schema.json'),
  recovered_from: structuredClone(provenance),
});
describe('ADR-EVI-0006 closed recovered_from provenance', () => {
  it('accepts exact closed provenance beside unchanged legacy evidence', () => {
    expect(validate(schemaExample('evidence.schema.json'))).toBe(true);
    expect(validate(record()), JSON.stringify(validate.errors)).toBe(true);
  });
  it.each(Object.keys(provenance))('refuses omitted %s', (key) => {
    const candidate = record();
    Reflect.deleteProperty(candidate.recovered_from, key);
    expect(validate(candidate)).toBe(false);
  });
  it.each([
    ['source_chain_path', '../outside.json'],
    ['source_chain_path', '/absolute.json'],
    ['source_chain_path', 'record/proofs/chain.json'],
    ['source_chain_sha256', 'A'.repeat(64)],
    ['source_entry_id', 'not-an-id'],
    ['source_entry_sequence', 0],
    ['fork_sequence', 0],
    ['source_entry_manifest_hash', 'not-a-digest'],
    ['permission', 'write-anything'],
  ])('refuses malformed or widened %s', (key, value) => {
    expect(validate({ ...record(), recovered_from: { ...provenance, [key]: value } })).toBe(false);
  });
});
