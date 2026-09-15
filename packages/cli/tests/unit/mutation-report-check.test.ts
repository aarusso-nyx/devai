import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { checkMutationReport } from '../../src/commands/mutation/report-check.js';

let root = '';

async function fixture(
  current: { mutation_score: number; survived: number },
  baseline?: { mutation_score: number; survived: number },
) {
  root = mkdtempSync(join(tmpdir(), 'devai-mutation-report-check-'));
  writeFileSync(join(root, 'current.json'), `${JSON.stringify(current)}\n`);
  writeFileSync(
    join(root, 'thresholds.json'),
    `${JSON.stringify({ mutation: { score_min: 60, survived_max: 0 } })}\n`,
  );
  if (baseline !== undefined) {
    writeFileSync(join(root, 'baseline.json'), `${JSON.stringify(baseline)}\n`);
  }
  return await withAuthorityHostTestScope(() =>
    checkMutationReport({
      repoRoot: root,
      current: 'current.json',
      baseline: 'baseline.json',
      thresholds: 'thresholds.json',
    }),
  );
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('mutation report score-only acceptance', () => {
  it('reports survivors without using their count or regression as an acceptance criterion', async () => {
    const result = await fixture(
      { mutation_score: 65, survived: 999 },
      { mutation_score: 60, survived: 1 },
    );

    expect(result).toMatchObject({
      ok: true,
      current: { mutation_score: 65, survived: 999 },
      baseline: { mutation_score: 60, survived: 1 },
      findings: [],
    });
  });

  it('still rejects a score below the canonical floor', async () => {
    const result = await fixture({ mutation_score: 59, survived: 0 });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      { kind: 'below_threshold', message: 'mutation score 59.0% < threshold 60%' },
    ]);
  });

  it('reports an available baseline without turning it into another numerical threshold', async () => {
    const result = await fixture(
      { mutation_score: 65, survived: 0 },
      { mutation_score: 70, survived: 999 },
    );

    expect(result).toMatchObject({
      ok: true,
      baseline: { mutation_score: 70, survived: 999 },
      findings: [],
    });
  });
});
