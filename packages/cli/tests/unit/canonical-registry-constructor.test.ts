import { describe, expect, it } from 'vitest';
import { canonicalRegistry, validateActionSurface } from '../../src/define-command.js';
import { buildTrustedAuthoritySources } from '../../src/authority/policy.js';

describe('canonical action registry constructor', () => {
  it('always constructs the complete 43-action surface without handler registration', () => {
    const first = canonicalRegistry();
    const second = canonicalRegistry();
    expect(first).toHaveLength(43);
    expect(first.map((entry) => entry.name)).toContain('audit observe');
    expect(first.map((entry) => entry.name)).toContain('triage classify');
    expect(second).toEqual(first);
    validateActionSurface(first);
  });

  it('derives identical policy provenance from repeated constructions', () => {
    const root = process.cwd();
    const first = buildTrustedAuthoritySources(canonicalRegistry(), root, '1.1.0-rc.1');
    const second = buildTrustedAuthoritySources(canonicalRegistry(), root, '1.1.0-rc.1');
    expect(second.provenance).toEqual(first.provenance);
  });
});
