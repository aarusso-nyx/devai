import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhResult } from '../../src/harness/gh-api.js';

interface GhRun {
  readonly conclusion?: string;
  readonly attempt?: number;
}

const ghState = vi.hoisted(() => ({
  result: { ok: true, data: [] as GhRun[] } as GhResult<GhRun[]>,
}));

vi.mock('../../src/harness/gh-api.js', () => ({
  invokeGhJson: () => ghState.result,
}));

import { senseHarnessRobustness } from '../../src/harness-robustness.js';

const now = '2026-09-09T12:00:00.000Z';
let root = '';

function setRuns(data: readonly GhRun[]): void {
  ghState.result = { ok: true, data: [...data] };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-harness-robustness-runs-'));
  setRuns([]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('harness robustness run populations', () => {
  it('reports review when GitHub returns no runs', () => {
    const reading = senseHarnessRobustness({ repoRoot: root, now });

    expect(reading.status).toBe('review');
    expect(reading.findings).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'HARNESS_ROBUSTNESS_NO_RUNS',
      }),
    ]);
    expect(reading.metrics).toEqual({ run_count: 0, flaky_runs: 0, flakiness_pct: 0 });
  });

  it('counts only successful attempts greater than one as flaky runs', () => {
    setRuns([
      { conclusion: 'success', attempt: 0 },
      { conclusion: 'success', attempt: 1 },
      { conclusion: 'success', attempt: 2 },
      { conclusion: 'failure', attempt: 4 },
    ]);

    const reading = senseHarnessRobustness({ repoRoot: root, now });

    expect(reading.status).toBe('fail');
    expect(reading.sensor).toEqual({ name: 'harness-robustness', kind: 'harness_robustness' });
    expect(reading.command).toBe('gh run list --branch main --json conclusion,attempt --limit 100');
    expect(reading.deterministic).toBe(false);
    expect(reading.tier).toBe('L2');
    expect(reading.timestamp).toBe(now);
    expect(reading.metrics).toEqual({
      run_count: 4,
      flaky_runs: 1,
      flakiness_pct: 25,
      threshold_pass: 5,
      threshold_review: 15,
    });
    expect(reading.findings).toEqual([
      expect.objectContaining({ code: 'HARNESS_ROBUSTNESS_DEGRADED' }),
    ]);
  });

  it('reviews an exact pass-threshold flakiness rate', () => {
    setRuns([
      { conclusion: 'success', attempt: 2 },
      ...Array.from({ length: 19 }, () => ({ conclusion: 'failure', attempt: 1 })),
    ]);

    const reading = senseHarnessRobustness({ repoRoot: root, now });

    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({ run_count: 20, flaky_runs: 1, flakiness_pct: 5 });
    expect(reading.findings).toEqual([
      expect.objectContaining({ code: 'HARNESS_ROBUSTNESS_FLAKY' }),
    ]);
  });

  it('fails an exact review-threshold flakiness rate', () => {
    setRuns([
      { conclusion: 'success', attempt: 2 },
      { conclusion: 'success', attempt: 3 },
      { conclusion: 'success', attempt: 4 },
      ...Array.from({ length: 17 }, () => ({ conclusion: 'failure', attempt: 1 })),
    ]);

    const reading = senseHarnessRobustness({ repoRoot: root, now });

    expect(reading.status).toBe('fail');
    expect(reading.metrics).toMatchObject({ run_count: 20, flaky_runs: 3, flakiness_pct: 15 });
    expect(reading.findings).toEqual([
      expect.objectContaining({ code: 'HARNESS_ROBUSTNESS_DEGRADED' }),
    ]);
  });
});
