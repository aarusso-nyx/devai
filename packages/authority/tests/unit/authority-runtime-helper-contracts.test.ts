import { describe, expect, it } from 'vitest';
import { declareHumanPrincipal } from '../../src/principals.js';
import { actionDocument, equal, failure } from '../../src/runtime/contracts.js';
import { HUMAN_ROLES } from '../../src/types.js';

// Runtime helper contracts written against the retained authority mutation diagnostic
// (candidate 3dfdc316, report 414957d9); mutant ids are the report's.

describe('human principal declaration', () => {
  // Mutant 5500: the refusal names every declarable role, comma separated.
  it('names every constitutional role when refusing an unknown one', () => {
    expect(() =>
      declareHumanPrincipal({
        role: 'root',
        source: 'cli-flag',
        declared_at: '2026-07-15T12:00:00Z',
      }),
    ).toThrow(`expected one of ${HUMAN_ROLES.join(', ')}`);
  });

  // Mutants 5509, 5510, 5524, 5525, 5528, 5529: each source-specific invariant is refused
  // with its own message.
  it('refuses a session id on a cli-flag declaration', () => {
    expect(() =>
      declareHumanPrincipal({
        role: 'engineer',
        source: 'cli-flag',
        declared_at: '2026-07-15T12:00:00Z',
        session_id: 'AUTH-SESSION-abcdefghijklmnop',
      } as unknown as Parameters<typeof declareHumanPrincipal>[0]),
    ).toThrow('session_id is forbidden for cli-flag declarations');
  });

  it.each([[''], ['   ']])('refuses the blank session id %j on a session declaration', (id) => {
    expect(() =>
      declareHumanPrincipal({
        role: 'engineer',
        source: 'session-state',
        session_id: id,
        declared_at: '2026-07-15T12:00:00Z',
      }),
    ).toThrow('session_id must not be empty');
  });

  it('refuses a declaration timestamp that is not a timestamp', () => {
    expect(() =>
      declareHumanPrincipal({ role: 'engineer', source: 'cli-flag', declared_at: 'yesterday' }),
    ).toThrow('declared_at must be an ISO-compatible timestamp');
  });

  it('returns the declaration provenance for each source', () => {
    expect(
      declareHumanPrincipal({
        role: 'architect',
        source: 'cli-flag',
        declared_at: '2026-07-15T12:00:00Z',
      }),
    ).toEqual({
      kind: 'human',
      role: 'architect',
      declaration: { source: 'cli-flag', declared_at: '2026-07-15T12:00:00Z' },
    });
    expect(
      declareHumanPrincipal({
        role: 'inspector',
        source: 'session-state',
        session_id: 'AUTH-SESSION-abcdefghijklmnop',
        declared_at: '2026-07-15T12:00:00Z',
      }),
    ).toEqual({
      kind: 'human',
      role: 'inspector',
      declaration: {
        source: 'session-state',
        session_id: 'AUTH-SESSION-abcdefghijklmnop',
        declared_at: '2026-07-15T12:00:00Z',
      },
    });
  });
});

describe('structural equality', () => {
  // Mutant 5595: a list prefix is not the list.
  it('distinguishes a list from a longer list sharing its prefix', () => {
    expect(equal([1], [1, 2])).toBe(false);
    expect(equal([1, 2], [1])).toBe(false);
    expect(equal([1, [2]], [1, [2]])).toBe(true);
  });

  // Mutants 5608, 5614, 5621: records compare by exact key set, including keys whose value
  // is undefined, and never equal a non-record.
  it('compares records by exact key set', () => {
    expect(equal({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(equal({ a: undefined, b: 1 }, { b: 1, c: undefined })).toBe(false);
    expect(equal({ b: 1, a: { c: 2 } }, { a: { c: 2 }, b: 1 })).toBe(true);
    expect(equal({}, 1)).toBe(false);
    expect(equal(1, {})).toBe(false);
  });
});

describe('failure records', () => {
  // Mutant 5567: a failure carries its reason, defaulting to its code.
  it('records the reason, defaulting to the code', () => {
    expect(failure('refused', 'AUTHORITY_EXAMPLE')).toEqual({
      ok: false,
      category: 'refused',
      code: 'AUTHORITY_EXAMPLE',
      reasons: ['AUTHORITY_EXAMPLE'],
    });
    expect(failure('usage-error', 'AUTHORITY_EXAMPLE', 'because').reasons).toEqual(['because']);
  });
});

describe('action contract lookup', () => {
  // Mutants 5652, 5656: a registry without a callable lookup, or one returning something
  // that is not a validated document, yields no contract.
  it('yields no contract for an uncallable registry or a bare document', () => {
    expect(actionDocument({ get: 'lookup' }, 'test mutate')).toBeUndefined();
    expect(actionDocument({ get: () => 'document' }, 'test mutate')).toBeUndefined();
    expect(actionDocument({ get: () => ({ raw: {} }) }, 'test mutate')).toBeUndefined();
    const document = { raw: {}, view: { action_id: 'test mutate' } };
    expect(actionDocument({ get: () => document }, 'test mutate')).toBe(document);
  });
});
