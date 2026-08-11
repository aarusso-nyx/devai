interface ScorecardCellLike {
  readonly substrate: string;
  readonly property: string;
  readonly verdict: string;
}

export function compileBacklogObservation(scorecard: unknown): {
  readonly count: number;
  readonly items: readonly Readonly<Record<string, unknown>>[];
} {
  if (
    typeof scorecard !== 'object' ||
    scorecard === null ||
    !Array.isArray((scorecard as { readonly cells?: unknown }).cells)
  ) {
    throw new Error('BACKLOG_SCORECARD_INVALID');
  }
  const cells = (scorecard as { readonly cells: readonly ScorecardCellLike[] }).cells;
  const items = cells
    .filter((cell) => cell.verdict === 'FAIL' || cell.verdict === 'REVIEW')
    .map((cell) =>
      Object.freeze({
        id: `BL-${cell.substrate}-${cell.property}`,
        title: `${cell.substrate} × ${cell.property} → ${cell.verdict}`,
        priority: cell.verdict === 'FAIL' ? 80 : 50,
        cell: `${cell.substrate}×${cell.property}`,
        verdict: cell.verdict,
      }),
    );
  return Object.freeze({ count: items.length, items: Object.freeze(items) });
}
