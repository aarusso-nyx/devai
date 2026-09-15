import { expect, it } from 'vitest';
import { compileBacklogObservation } from '../../src/operations/backlog.js';

it.each(
  [
    null,
    undefined,
    false,
    42,
    'scorecard',
    [],
    {},
    { cells: null },
    { cells: {} },
    { cells: 'cells' },
    Object.assign(() => undefined, { cells: [] }),
  ].map((value, index) => ({ value, index })),
)(
  'refuses invalid scorecard root or cell population $index with the contract code',
  ({ value }) => {
    expect(() => compileBacklogObservation(value)).toThrow('BACKLOG_SCORECARD_INVALID');
  },
);

it('selects FAIL and REVIEW in source order and preserves their exact identities and priorities', () => {
  const cells = Object.freeze([
    Object.freeze({ substrate: 'F1', property: 'T1', verdict: 'PASS' }),
    Object.freeze({ substrate: 'F3', property: 'T7', verdict: 'REVIEW' }),
    Object.freeze({ substrate: 'F2', property: 'T4', verdict: 'N/A' }),
    Object.freeze({ substrate: 'F1', property: 'T2', verdict: 'FAIL' }),
    Object.freeze({ substrate: 'F5', property: 'T9', verdict: 'UNKNOWN' }),
  ]);
  const scorecard = Object.freeze({ cells });
  const before = JSON.stringify(scorecard);
  const result = compileBacklogObservation(scorecard);
  expect(result).toEqual({
    count: 2,
    items: [
      { id: 'BL-F3-T7', title: 'F3 × T7 → REVIEW', priority: 50, cell: 'F3×T7', verdict: 'REVIEW' },
      { id: 'BL-F1-T2', title: 'F1 × T2 → FAIL', priority: 80, cell: 'F1×T2', verdict: 'FAIL' },
    ],
  });
  expect(JSON.stringify(scorecard)).toBe(before);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.items)).toBe(true);
  for (const item of result.items) expect(Object.isFrozen(item)).toBe(true);
});

it('returns an immutable empty observation when no cells require backlog work', () => {
  const result = compileBacklogObservation({ cells: [] });
  expect(result).toEqual({ count: 0, items: [] });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.items)).toBe(true);
});

it('snapshots item values without retaining mutable aliases to the input cells', () => {
  const cell = { substrate: 'F2', property: 'T5', verdict: 'FAIL' };
  const result = compileBacklogObservation({ cells: [cell] });
  cell.substrate = 'F4';
  cell.verdict = 'PASS';
  expect(result).toEqual({
    count: 1,
    items: [
      { id: 'BL-F2-T5', title: 'F2 × T5 → FAIL', priority: 80, cell: 'F2×T5', verdict: 'FAIL' },
    ],
  });
});
