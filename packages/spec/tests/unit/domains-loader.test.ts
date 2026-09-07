import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDomainAllowed, loadDomains } from '../../src/spec/domains-loader.js';
import './blueprint-inventory-cases.js';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'devai-domains-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function write(name: string, content: object): string {
  const path = join(tempDir, name);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe('loadDomains', () => {
  it('merges core, framework, client into a single allowed set', () => {
    const path = write('d.json', {
      schemaVersion: '1.0.0',
      core: ['AUTH', 'SEC'],
      framework: ['DEVAI'],
      client: ['BILLING'],
    });
    const tax = loadDomains(path);
    expect(tax.all.size).toBe(4);
    expect(isDomainAllowed(tax, 'AUTH')).toBe(true);
    expect(isDomainAllowed(tax, 'DEVAI')).toBe(true);
    expect(isDomainAllowed(tax, 'BILLING')).toBe(true);
    expect(isDomainAllowed(tax, 'UNKNOWN')).toBe(false);
  });

  it('accepts missing categories (each defaults to empty)', () => {
    const path = write('d.json', { core: ['CORE'] });
    const tax = loadDomains(path);
    expect(tax.all.has('CORE')).toBe(true);
    expect(tax.framework).toEqual([]);
    expect(tax.client).toEqual([]);
  });

  it('rejects a domain code not matching the pattern', () => {
    const path = write('d.json', { core: ['lowercase'] });
    expect(() => loadDomains(path)).toThrow(/does not match pattern/);
  });

  it('rejects a non-array category', () => {
    const path = write('d.json', { core: 'AUTH' });
    expect(() => loadDomains(path)).toThrow(/must be an array/);
  });

  it('rejects malformed JSON', () => {
    const path = join(tempDir, 'bad.json');
    writeFileSync(path, '{ not valid');
    expect(() => loadDomains(path)).toThrow(/failed to parse/);
  });
});
// Invariants: INV-BLUEPRINT-002, INV-BLUEPRINT-003, INV-DEVAI-001

describe('domain taxonomy input boundaries', () => {
  it.each(['[]', '["AUTH"]', 'null', '42', 'true', '"AUTH"'])(
    'rejects non-object JSON %s',
    (json) => {
      const path = join(tempDir, 'shape.json');
      writeFileSync(path, json);
      expect(() => loadDomains(path)).toThrow(`domains: ${path} is not a JSON object`);
    },
  );
  it.each(['core', 'framework', 'client'])('rejects non-string members in %s', (category) => {
    const path = write('member.json', { [category]: ['AUTH', 123] });
    expect(() => loadDomains(path)).toThrow(`domains: '${category}' contains a non-string entry`);
  });
  it.each(['A', 'A1234567890123456', '1AUTH', 'AU-TH', 'AUTH\n'])(
    'rejects out-of-contract domain %j',
    (code) => {
      const path = write('code.json', { client: [code] });
      expect(() => loadDomains(path)).toThrow(/does not match pattern/);
    },
  );
  it('preserves category membership while deduplicating the union and accepting both length boundaries', () => {
    const core = ['AB', 'A123456789012345'];
    const framework = ['AB', 'FW'];
    const client = ['FW', 'CL'];
    const tax = loadDomains(write('boundaries.json', { core, framework, client }));
    expect(tax).toEqual({
      core,
      framework,
      client,
      all: new Set(['AB', 'A123456789012345', 'FW', 'CL']),
    });
    expect(isDomainAllowed(tax, 'ab')).toBe(false);
  });
});
