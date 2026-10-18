import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync,
}));

import { samplePopulation } from '../../src/harness/gh-api.js';
import { senseHarnessRobustness } from '../../src/harness-robustness.js';
import { senseHarnessPerformance } from '../../src/harness-performance.js';
import { senseHarnessGreenMain } from '../../src/harness-green-main.js';

const population = {
  repoRoot: '/repo',
  workflow: 'ci.yml',
  event: 'push',
  headBranch: '*',
  baseBranch: 'main',
  minimumSample: 1,
  now: '2026-10-18T12:00:00Z',
};
function runs(rows: readonly Record<string, unknown>[]) {
  spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify(rows), stderr: '' });
}
function row(headBranch: string | undefined, event = 'push') {
  return {
    databaseId: 1,
    event,
    headBranch,
    conclusion: 'success',
    attempt: 1,
    createdAt: '2026-10-17T12:00:00Z',
    updatedAt: '2026-10-17T12:01:00Z',
  };
}
afterEach(() => spawnSync.mockReset());

describe('push population base branch uses the observed pushed branch', () => {
  it('keeps only the declared pushed branch even with any head branch', () => {
    runs([row('main'), { ...row('feature/x'), databaseId: 2 }, row(undefined)]);
    const sample = samplePopulation(population);
    expect(sample.ok).toBe(true);
    if (!sample.ok) throw new Error(sample.reason);
    expect(sample.runs).toHaveLength(1);
    expect(sample.runs[0]?.headBranch).toBe('main');
    expect(sample.metrics).toMatchObject({
      population_base_branch: 'main',
      population_base_branch_verified: true,
      population_unverified: '',
    });
    expect(sample.unverifiedFinding).toBeUndefined();
  });

  it.each([senseHarnessGreenMain, senseHarnessPerformance, senseHarnessRobustness])(
    'produces a complete sensor reading for an observed main push',
    (sensor) => {
      runs([row('main')]);
      const reading = sensor(population);
      expect(reading.status).toBe('pass');
      expect(reading.findings).not.toContain(undefined);
      expect(
        reading.findings.some((finding) => finding.code === 'HARNESS_POPULATION_UNVERIFIED'),
      ).toBe(false);
    },
  );

  it.each([senseHarnessGreenMain, senseHarnessPerformance, senseHarnessRobustness])(
    'suppresses the verdict when the pushed branch is missing or mismatches',
    (sensor) => {
      runs([row('feature/x'), row(undefined)]);
      const reading = sensor(population);
      expect(reading.status).toBe('unknown');
      expect(reading.metrics.sample_size).toBe(0);
      expect(reading.findings.some((finding) => finding.code.endsWith('INSUFFICIENT_SAMPLE'))).toBe(
        true,
      );
      expect(reading.findings).not.toContain(undefined);
    },
  );

  it('applies the literal head and base constraints together', () => {
    runs([row('main'), row('feature/x')]);
    const sample = samplePopulation({ ...population, headBranch: 'feature/x' });
    expect(sample.ok).toBe(true);
    if (!sample.ok) throw new Error(sample.reason);
    expect(sample.runs).toEqual([]);
  });

  it('retains unverified base warnings for pull requests', () => {
    runs([row('feature/x', 'pull_request')]);
    const sample = samplePopulation({ ...population, event: 'pull_request' });
    expect(sample.ok).toBe(true);
    if (!sample.ok) throw new Error(sample.reason);
    expect(sample.runs).toHaveLength(1);
    expect(sample.metrics.population_base_branch_verified).toBe(false);
    expect(sample.unverifiedFinding?.code).toBe('HARNESS_POPULATION_UNVERIFIED');
  });

  it('still reports same-workflow excluded jobs as unverified', () => {
    runs([row('main')]);
    const sample = samplePopulation({
      ...population,
      excludedJobs: [{ workflow: 'ci.yml', job: 'deploy' }],
    });
    expect(sample.ok).toBe(true);
    if (!sample.ok) throw new Error(sample.reason);
    expect(sample.metrics.population_unverified).toBe('excludedJobs');
    expect(sample.unverifiedFinding?.message).toContain('excludedJobs');
    expect(sample.unverifiedFinding?.message).not.toContain('baseBranch main');
  });
});
