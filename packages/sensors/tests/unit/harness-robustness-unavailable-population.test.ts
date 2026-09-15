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
  result: { ok: false, reason: 'gh-cli-unavailable' } as GhResult<GhRun[]>,
}));

vi.mock('../../src/harness/gh-api.js', () => ({
  invokeGhJson: () => ghState.result,
}));

import { senseHarnessRobustness } from '../../src/harness-robustness.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-harness-robustness-unavailable-'));
  ghState.result = { ok: false, reason: 'gh-cli-unavailable' };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('harness robustness unavailable and empty populations', () => {
  it('reports GitHub CLI failure as an explicit unknown observation', () => {
    ghState.result = { ok: false, reason: 'gh-cli-error: permission denied' };

    const reading = senseHarnessRobustness({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'unknown',
      deterministic: false,
      tier: 'L2',
      timestamp: NOW,
      sensor: { name: 'harness-robustness', kind: 'harness_robustness' },
      command: 'gh run list --branch main --json conclusion,attempt --limit 100',
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_ROBUSTNESS_GH_UNAVAILABLE',
          message: 'Skipped: gh-cli-error: permission denied',
        },
      ],
      metrics: { run_count: 0 },
    });
  });

  it('reports an empty successful run population as review with zero flakiness', () => {
    ghState.result = { ok: true, data: [] };

    const reading = senseHarnessRobustness({
      repoRoot: root,
      branch: 'release',
      limit: 25,
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'review',
      deterministic: false,
      tier: 'L2',
      timestamp: NOW,
      sensor: { name: 'harness-robustness', kind: 'harness_robustness' },
      command: 'gh run list --branch release --json conclusion,attempt --limit 25',
      findings: [
        {
          severity: 'warning',
          code: 'HARNESS_ROBUSTNESS_NO_RUNS',
          message: 'No CI runs found on branch release.',
        },
      ],
      metrics: { run_count: 0, flaky_runs: 0, flakiness_pct: 0 },
    });
  });
});
