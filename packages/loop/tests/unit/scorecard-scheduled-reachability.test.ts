import { describe, expect, it } from 'vitest';
import { scheduledScorecardCells } from '../../src/loop/scorecard.js';

const APPROVED_SCHEDULED_CELLS = [
  { substrate: 'F1', property: 'T2' },
  { substrate: 'F1', property: 'T3' },
  { substrate: 'F1', property: 'T4' },
  { substrate: 'F1', property: 'T5' },
  { substrate: 'F1', property: 'T6' },
  { substrate: 'F1', property: 'T7' },
  { substrate: 'F1', property: 'T8' },
  { substrate: 'F1', property: 'T9' },
  { substrate: 'F2', property: 'T1' },
  { substrate: 'F2', property: 'T2' },
  { substrate: 'F2', property: 'T3' },
  { substrate: 'F2', property: 'T4' },
  { substrate: 'F2', property: 'T5' },
  { substrate: 'F2', property: 'T6' },
  { substrate: 'F2', property: 'T7' },
  { substrate: 'F2', property: 'T8' },
  { substrate: 'F2', property: 'T9' },
  { substrate: 'F3', property: 'T1' },
  { substrate: 'F3', property: 'T2' },
  { substrate: 'F3', property: 'T3' },
  { substrate: 'F3', property: 'T4' },
  { substrate: 'F3', property: 'T5' },
  { substrate: 'F3', property: 'T6' },
  { substrate: 'F3', property: 'T7' },
  { substrate: 'F3', property: 'T8' },
  { substrate: 'F3', property: 'T9' },
  { substrate: 'F4', property: 'T1' },
  { substrate: 'F4', property: 'T2' },
  { substrate: 'F4', property: 'T3' },
  { substrate: 'F4', property: 'T4' },
  { substrate: 'F4', property: 'T6' },
  { substrate: 'F4', property: 'T7' },
  { substrate: 'F4', property: 'T8' },
  { substrate: 'F4', property: 'T9' },
  { substrate: 'F5', property: 'T1' },
  { substrate: 'F5', property: 'T2' },
  { substrate: 'F5', property: 'T3' },
  { substrate: 'F5', property: 'T4' },
  { substrate: 'F5', property: 'T5' },
  { substrate: 'F5', property: 'T6' },
  { substrate: 'F5', property: 'T7' },
  { substrate: 'F5', property: 'T8' },
  { substrate: 'F5', property: 'T9' },
] as const;

describe('scheduled scorecard reachability', () => {
  it('exposes the approved DII-104 registry cell population exactly once in canonical order', () => {
    const cells = scheduledScorecardCells();

    expect(cells).toEqual(APPROVED_SCHEDULED_CELLS);
    expect(new Set(cells.map((cell) => `${cell.substrate}:${cell.property}`)).size).toBe(
      APPROVED_SCHEDULED_CELLS.length,
    );
  });
});
