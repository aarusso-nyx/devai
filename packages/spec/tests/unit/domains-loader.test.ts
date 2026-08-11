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
