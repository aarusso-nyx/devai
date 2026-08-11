import { describe, expect, it } from 'vitest';
import { createDbCapabilities } from '../../src/capabilities/database.js';
import { classifyAuthorityPath } from '../../src/capabilities/path-domains.js';

describe('machine-proof path domain', () => {
  it('classifies canonical proof records separately from general workspace mutation', () => {
    expect(classifyAuthorityPath('/repo', 'record/proofs/compliance/closures/PC-0002.json')).toBe(
      'fs:proofs',
    );
    expect(classifyAuthorityPath('/repo', 'record/derived/inventory/current.json')).toBe(
      'fs:f4-inventory',
    );
    expect(classifyAuthorityPath('/repo', 'packages/evidence/src/index.ts')).toBe('fs:workspace');
    expect(classifyAuthorityPath('/repo', '../outside')).toBe('fs:workspace');
  });

  it('classifies only the regular Constitution pointer as F5 root configuration', () => {
    expect(classifyAuthorityPath('/repo', '.devai/constitution.md')).toBe('fs:f5-config');
    expect(classifyAuthorityPath('/repo', '.devai/other.md')).toBe('fs:workspace');
  });

  it('exposes frozen read and write capabilities with a bound database query', () => {
    const calls: string[] = [];
    const client = {
      prefix: 'bound',
      query(this: { prefix: string }, value: string) {
        calls.push(`${this.prefix}:${value}`);
        return calls.length;
      },
    };
    const capabilities = createDbCapabilities(client as never);

    expect(capabilities.read.query('read' as never)).toBe(1);
    expect(capabilities.write.query('write' as never)).toBe(2);
    expect(calls).toEqual(['bound:read', 'bound:write']);
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.read)).toBe(true);
    expect(Object.isFrozen(capabilities.write)).toBe(true);
  });
});
// Invariants: INV-AUTH-002, INV-AUTH-003
