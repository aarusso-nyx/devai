import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));

import { HARNESS_RUN_FIELDS } from '../../src/harness/gh-api.js';
import { senseHarnessRobustness } from '../../src/harness-robustness.js';

interface GhRun {
  readonly conclusion?: string;
  readonly attempt?: number;
}

const NOW = '2026-09-09T12:00:00.000Z';
const GH_ARGV =
  `gh run list --workflow pull-request-checks.yml --event pull_request --json ${HARNESS_RUN_FIELDS} ` +
  '--limit 1000 --created >=2026-08-10';
let root = '';
let nextId = 1;

/** The declared population: ADR-SCR-0010 requires workflow, event, and minimumSample. */
function population(minimumSample: number) {
  return {
    repoRoot: root,
    now: NOW,
    workflow: 'pull-request-checks.yml',
    event: 'pull_request',
    minimumSample,
  };
}

function setRuns(data: readonly GhRun[]): void {
  const full = data.map((run) => ({
    ...run,
    databaseId: nextId++,
    event: 'pull_request',
    headBranch: 'feature/x',
    createdAt: '2026-09-08T10:00:00Z',
    updatedAt: '2026-09-08T10:05:00Z',
  }));
  mocks.spawnSync.mockReturnValue({
    status: 0,
    signal: null,
    stdout: JSON.stringify(full),
    stderr: '',
    error: undefined,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-harness-robustness-runs-'));
  mocks.spawnSync.mockReset();
  nextId = 1;
  setRuns([]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('harness robustness run populations', () => {
  it('reads unknown, not review, when GitHub returns no runs of the population', () => {
    const reading = senseHarnessRobustness(population(1));

    expect(reading.status).toBe('unknown');
    expect(reading.findings).toEqual([
      expect.objectContaining({
        severity: 'info',
        code: 'HARNESS_ROBUSTNESS_INSUFFICIENT_SAMPLE',
      }),
      expect.objectContaining({ code: 'HARNESS_POPULATION_UNVERIFIED' }),
    ]);
    expect(reading.metrics).toMatchObject({ run_count: 0, sample_size: 0, minimum_sample: 1 });
  });

  it('counts only successful attempts greater than one as flaky runs', () => {
    setRuns([
      { conclusion: 'success', attempt: 0 },
      { conclusion: 'success', attempt: 1 },
      { conclusion: 'success', attempt: 2 },
      { conclusion: 'failure', attempt: 4 },
    ]);

    const reading = senseHarnessRobustness(population(4));

    expect(reading.status).toBe('fail');
    expect(reading.sensor).toEqual({ name: 'harness-robustness', kind: 'harness_robustness' });
    expect(reading.command).toBe(GH_ARGV);
    expect(reading.deterministic).toBe(false);
    expect(reading.tier).toBe('L2');
    expect(reading.timestamp).toBe(NOW);
    expect(reading.metrics).toMatchObject({
      run_count: 4,
      flaky_runs: 1,
      flakiness_pct: 25,
      threshold_pass: 5,
      threshold_review: 15,
    });
    expect(reading.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'HARNESS_ROBUSTNESS_DEGRADED' })]),
    );
  });

  it('reviews an exact pass-threshold flakiness rate', () => {
    setRuns([
      { conclusion: 'success', attempt: 2 },
      ...Array.from({ length: 19 }, () => ({ conclusion: 'failure', attempt: 1 })),
    ]);

    const reading = senseHarnessRobustness(population(20));

    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({ run_count: 20, flaky_runs: 1, flakiness_pct: 5 });
    expect(reading.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'HARNESS_ROBUSTNESS_FLAKY' })]),
    );
  });

  it('fails an exact review-threshold flakiness rate', () => {
    setRuns([
      { conclusion: 'success', attempt: 2 },
      { conclusion: 'success', attempt: 3 },
      { conclusion: 'success', attempt: 4 },
      ...Array.from({ length: 17 }, () => ({ conclusion: 'failure', attempt: 1 })),
    ]);

    const reading = senseHarnessRobustness(population(20));

    expect(reading.status).toBe('fail');
    expect(reading.metrics).toMatchObject({ run_count: 20, flaky_runs: 3, flakiness_pct: 15 });
    expect(reading.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'HARNESS_ROBUSTNESS_DEGRADED' })]),
    );
  });
});
