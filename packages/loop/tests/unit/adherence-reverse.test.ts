import { describe, expect, it } from 'vitest';
import {
  computeReverseAdherence,
  globToRegExp,
  type InventoryShape,
  type TraceShape,
} from '../../src/inventory/adherence-reverse.js';
import './governance-ledger-cases.js';
import './inventory-expansion-cases.js';

describe('globToRegExp', () => {
  it('matches single-star within one path segment only', () => {
    const re = globToRegExp('src/*.ts');
    expect(re.test('src/auth.ts')).toBe(true);
    expect(re.test('src/auth/login.ts')).toBe(false);
  });

  it('matches double-star across path segments', () => {
    const re = globToRegExp('packages/**');
    expect(re.test('packages/core/src/index.ts')).toBe(true);
    expect(re.test('packages/cli/test/foo.test.ts')).toBe(true);
    expect(re.test('docs/framework/arch/foo.md')).toBe(false);
  });

  it('matches a single-segment ? wildcard', () => {
    const re = globToRegExp('src/?uth.ts');
    expect(re.test('src/auth.ts')).toBe(true);
    expect(re.test('src/output.ts')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    const re = globToRegExp('a.b/c.d');
    expect(re.test('a.b/c.d')).toBe(true);
    expect(re.test('aXb/cYd')).toBe(false);
  });
});

describe('computeReverseAdherence', () => {
  const inventory: InventoryShape = {
    routes: [
      { id: 'ROUTE-1', file: 'packages/cli/src/commands/sense/test.ts' },
      { id: 'ROUTE-2', file: 'apps/orphan-app/src/route.ts' },
    ],
    modules: [{ id: 'MOD-1', file: 'packages/core/src/inventory/index.ts' }],
    components: [{ id: 'CMP-1', file: 'unknown-app/src/component.ts' }],
  };
  const trace: TraceShape = {
    invariants: [
      { id: 'INV-DEVAI-001', code_areas: ['packages/**', 'docs/**'] },
      { id: 'INV-X-002', code_areas: ['apps/known/**'] },
    ],
  };

  it('identifies claimed vs orphan surfaces correctly', () => {
    const report = computeReverseAdherence({ inventory, trace });
    expect(report.counts.total).toBe(4);
    expect(report.counts.claimed).toBe(2); // ROUTE-1 + MOD-1
    expect(report.counts.orphan).toBe(2); // ROUTE-2 + CMP-1
    expect(report.adopted.map((a) => a.surface.id).sort()).toEqual(['MOD-1', 'ROUTE-1']);
    expect(report.adopted[0]?.claimed_by).toContain('INV-DEVAI-001');
  });

  it('respects the include filter', () => {
    const report = computeReverseAdherence({ inventory, trace, include: ['route'] });
    expect(report.counts.total).toBe(2);
    expect(report.counts.claimed).toBe(1);
    expect(report.counts.orphan).toBe(1);
  });

  it('deduplicates claim ids when multiple globs of the same invariant match', () => {
    const t2: TraceShape = {
      invariants: [
        {
          id: 'INV-Y',
          code_areas: ['packages/**', 'packages/cli/**', 'packages/cli/src/**'],
        },
      ],
    };
    const i2: InventoryShape = {
      routes: [{ id: 'R', file: 'packages/cli/src/commands/sense/test.ts' }],
    };
    const report = computeReverseAdherence({ inventory: i2, trace: t2 });
    expect(report.adopted[0]?.claimed_by).toEqual(['INV-Y']);
  });

  it('handles missing inventory categories gracefully (empty surfaces)', () => {
    const report = computeReverseAdherence({ inventory: {}, trace });
    expect(report.counts.total).toBe(0);
    expect(report.orphans).toEqual([]);
    expect(report.adopted).toEqual([]);
  });
});
// Invariants: INV-DEVAI-001
