// #364, ADR-SCR-0014 IA-007: every harness sensor reads its run list to the literal limit of
// 1000. A list that returns exactly 1000 runs may have been cut, so the reading is UNKNOWN as
// truncated, with the limit named in the finding, never PASS, REVIEW, or FAIL; a list of 999
// runs is complete and reads normally.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));

import { senseHarnessGreenMain } from '../../src/harness-green-main.js';
import { senseHarnessPerformance } from '../../src/harness-performance.js';
import { senseHarnessRobustness } from '../../src/harness-robustness.js';
import type { SensorReading } from '../../src/sensor-reading.js';

const NOW = '2026-10-08T12:00:00.000Z';
const POPULATION = {
  workflow: 'pull-request-checks.yml',
  event: 'pull_request',
  minimumSample: 1,
} as const;
const LIMIT = 1000;

/** `count` passing runs, each on a branch and sha of its own, three minutes long. */
function runs(count: number) {
  const start = Date.parse('2026-10-01T00:00:00Z');
  return Array.from({ length: count }, (_, index) => {
    const created = new Date(start + index * 60_000);
    return {
      databaseId: index + 1,
      attempt: 1,
      event: 'pull_request',
      headBranch: `feature/run-${String(index)}`,
      headSha: String(index).padStart(40, '0'),
      status: 'completed',
      conclusion: 'success',
      createdAt: created.toISOString(),
      updatedAt: new Date(created.getTime() + 180_000).toISOString(),
    };
  });
}

/** One merged pull request per run, so the final-head unit has its list too. */
function pullRequests(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    baseRefName: 'main',
    headRefName: `feature/run-${String(index)}`,
    headRefOid: String(index).padStart(40, '0'),
    state: 'MERGED',
    createdAt: '2026-09-30T00:00:00.000Z',
    mergedAt: NOW,
    closedAt: NOW,
  }));
}

function stub(runCount: number, prCount = Math.min(runCount, 999)): void {
  mocks.spawnSync.mockImplementation((command: string, args: readonly string[]) => {
    if (command !== 'gh') throw new Error(`unexpected spawnSync call: ${command}`);
    const value =
      args[0] === 'run' ? runs(runCount) : args[0] === 'pr' ? pullRequests(prCount) : undefined;
    if (value === undefined) throw new Error(`unexpected gh call: ${args.join(' ')}`);
    return { status: 0, signal: null, stdout: JSON.stringify(value), stderr: '', error: undefined };
  });
}

const SENSORS: readonly (readonly [string, () => SensorReading])[] = [
  [
    'harness_green_main',
    () => senseHarnessGreenMain({ ...POPULATION, repoRoot: '/repo', now: NOW }),
  ],
  [
    'harness_green_main under pull-request-final-head',
    () =>
      senseHarnessGreenMain({
        ...POPULATION,
        outcomeUnit: 'pull-request-final-head',
        repoRoot: '/repo',
        now: NOW,
      }),
  ],
  [
    'harness_performance',
    () => senseHarnessPerformance({ ...POPULATION, repoRoot: '/repo', now: NOW }),
  ],
  [
    'harness_robustness',
    () => senseHarnessRobustness({ ...POPULATION, repoRoot: '/repo', now: NOW }),
  ],
];

beforeEach(() => {
  mocks.spawnSync.mockReset();
});

describe('harness run lists read to the literal limit (#364, ADR-SCR-0014 IA-007)', () => {
  it.each(SENSORS)('requests %s runs with --limit 1000', (_label, sense) => {
    stub(3);
    sense();
    const args = mocks.spawnSync.mock.calls[0]?.[1] as readonly string[];
    expect(args.slice(0, 2)).toEqual(['run', 'list']);
    expect(args[args.indexOf('--limit') + 1]).toBe(String(LIMIT));
  });

  it.each(SENSORS)('reads %s unknown as truncated at exactly 1000 runs', (_label, sense) => {
    stub(LIMIT);
    const reading = sense();
    expect(reading.status).toBe('unknown');
    expect(
      (reading.findings ?? []).some((finding) => finding.message.includes(String(LIMIT))),
      JSON.stringify(reading.findings),
    ).toBe(true);
  });

  it.each(SENSORS)('reads %s normally at 999 runs', (_label, sense) => {
    stub(LIMIT - 1);
    const reading = sense();
    expect(reading.status, JSON.stringify(reading.findings)).not.toBe('unknown');
  });
});
