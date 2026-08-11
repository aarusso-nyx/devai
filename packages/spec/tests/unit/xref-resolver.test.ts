import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  findDuplicateIds,
  resolveAll,
  resolveXref,
} from '../../src/spec/xref-resolver.js';

describe('buildCatalog + resolveXref', () => {
  it('returns null for a resolved reference', () => {
    const cat = buildCatalog(['INV-AUTH-001', 'INV-AUTH-002']);
    const err = resolveXref(cat, {
      source_file: 'JNY-001.json',
      source_id: 'JNY-001',
      field: 'related_invariants[0]',
      target_id: 'INV-AUTH-001',
      target_kind: 'invariant',
    });
    expect(err).toBeNull();
  });

  it('returns an XrefError for an unresolved reference', () => {
    const cat = buildCatalog(['INV-AUTH-001']);
    const err = resolveXref(cat, {
      source_file: 'JNY-001.json',
      source_id: 'JNY-001',
      field: 'related_invariants[0]',
      target_id: 'INV-AUTH-999',
      target_kind: 'invariant',
    });
    expect(err).not.toBeNull();
    expect(err?.target_id).toBe('INV-AUTH-999');
  });

  it('checks each kind against its own catalog', () => {
    const cat = buildCatalog(['INV-A-001'], ['JNY-001'], ['GE-001']);
    expect(
      resolveXref(cat, {
        source_file: 'x',
        source_id: 'INV-A-001',
        field: 'see_also',
        target_id: 'GE-001',
        target_kind: 'glossary',
      }),
    ).toBeNull();
    expect(
      resolveXref(cat, {
        source_file: 'x',
        source_id: 'INV-A-001',
        field: 'see_also',
        target_id: 'INV-A-001', // wrong kind: not in journeys
        target_kind: 'journey',
      }),
    ).not.toBeNull();
  });

  it('resolveAll collects every unresolved reference', () => {
    const cat = buildCatalog(['INV-AUTH-001']);
    const checks = [
      {
        source_file: 'a',
        source_id: 'X',
        field: 'f',
        target_id: 'INV-AUTH-001',
        target_kind: 'invariant' as const,
      },
      {
        source_file: 'b',
        source_id: 'Y',
        field: 'f',
        target_id: 'INV-AUTH-999',
        target_kind: 'invariant' as const,
      },
      {
        source_file: 'c',
        source_id: 'Z',
        field: 'f',
        target_id: 'INV-AUTH-998',
        target_kind: 'invariant' as const,
      },
    ];
    const errors = resolveAll(cat, checks);
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.target_id).sort()).toEqual(['INV-AUTH-998', 'INV-AUTH-999']);
  });
});

describe('findDuplicateIds', () => {
  it('reports an id that appears in multiple files', () => {
    const dups = findDuplicateIds([
      { id: 'INV-AUTH-001', file: 'a.json' },
      { id: 'INV-AUTH-001', file: 'b.json' },
      { id: 'INV-AUTH-002', file: 'c.json' },
    ]);
    expect(dups).toHaveLength(1);
    expect(dups[0]?.id).toBe('INV-AUTH-001');
    expect([...(dups[0]?.files ?? [])].sort()).toEqual(['a.json', 'b.json']);
  });

  it('returns empty when all ids are unique', () => {
    const dups = findDuplicateIds([
      { id: 'INV-AUTH-001', file: 'a.json' },
      { id: 'INV-AUTH-002', file: 'b.json' },
    ]);
    expect(dups).toEqual([]);
  });
});
// Invariants: INV-DEVAI-001
