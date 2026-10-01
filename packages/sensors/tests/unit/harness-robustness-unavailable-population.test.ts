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

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

function population(extra: Record<string, unknown> = {}) {
  return {
    repoRoot: root,
    now: NOW,
    workflow: 'pull-request-checks.yml',
    event: 'pull_request',
    minimumSample: 1,
    ...extra,
  };
}

function reply(value: { status: number; stdout?: string; stderr?: string }): void {
  mocks.spawnSync.mockReturnValue({
    signal: null,
    stdout: '',
    stderr: '',
    error: undefined,
    ...value,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-harness-robustness-unavailable-'));
  mocks.spawnSync.mockReset();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('harness robustness unavailable and empty populations', () => {
  it('reports GitHub CLI failure as an explicit unknown observation', () => {
    reply({ status: 1, stderr: 'permission denied' });

    const reading = senseHarnessRobustness(population());

    expect(reading).toMatchObject({
      status: 'unknown',
      deterministic: false,
      tier: 'L2',
      timestamp: NOW,
      sensor: { name: 'harness-robustness', kind: 'harness_robustness' },
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_ROBUSTNESS_GH_UNAVAILABLE',
          message: 'Skipped: gh-cli-nonzero-exit: permission denied',
        },
      ],
      metrics: { run_count: 0 },
    });
    expect(reading.command).toContain('gh run list --workflow pull-request-checks.yml');
  });

  it('reports an undeclared population as unknown with the reason, never an invented default', () => {
    const reading = senseHarnessRobustness({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('unknown');
    expect(reading.findings?.[0]).toMatchObject({
      code: 'HARNESS_ROBUSTNESS_GH_UNAVAILABLE',
    });
    expect(reading.findings?.[0]?.message).toContain('harness-population-undeclared');
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it('reports an empty successful run population as unknown with the sample size', () => {
    reply({ status: 0, stdout: '[]' });

    const reading = senseHarnessRobustness(
      population({ headBranch: 'release', event: 'push', minimumSample: 3, limit: 25 }),
    );

    expect(reading).toMatchObject({
      status: 'unknown',
      deterministic: false,
      tier: 'L2',
      timestamp: NOW,
      sensor: { name: 'harness-robustness', kind: 'harness_robustness' },
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_ROBUSTNESS_INSUFFICIENT_SAMPLE',
        },
        { code: 'HARNESS_POPULATION_UNVERIFIED' },
      ],
      metrics: {
        run_count: 0,
        sample_size: 0,
        minimum_sample: 3,
        population_head_branch: 'release',
        population_event: 'push',
      },
    });
    expect(reading.command).toContain('--branch release');
    expect(reading.command).toContain('--limit 25');
    expect(reading.findings?.[0]?.message).toContain('head branch release');
  });
});
