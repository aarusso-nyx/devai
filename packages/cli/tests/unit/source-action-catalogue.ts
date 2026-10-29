import { expect } from 'vitest';
import { expectCurrentActionIds as expectB1ActionIds } from './historical-action-catalogue.js';

const SOURCE_ACTIONS = [
  'source apply architect',
  'source apply engineer',
  'source apply inspector',
];

/** Current population, preserving the exact historical B1 population as a subset. */
export function expectCurrentActionIds(ids: readonly string[]): void {
  expect(ids).toHaveLength(77);
  for (const action of SOURCE_ACTIONS) expect(ids.filter((id) => id === action)).toHaveLength(1);
  expectB1ActionIds(ids.filter((id) => !SOURCE_ACTIONS.includes(id)));
}
