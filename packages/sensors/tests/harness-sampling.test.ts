// ADR-SCR-0010 IA-001..IA-004: the three CI harness sensors sample the population their
// declaration names, and below the declared minimum read UNKNOWN, never FAIL and never PASS.
//
// Interface assumptions the engineer (TASK-0443) must meet in packages/sensors/src. They
// are written before the implementation and are red until it lands:
//   - senseHarnessGreenMain / senseHarnessPerformance / senseHarnessRobustness accept the
//     declared keys of harness_population_inputs flat beside repoRoot and now:
//     { repoRoot, now, workflow, event, headBranch?, baseBranch?, attempts?,
//       includeCancelled?, lookbackDays?, minimumSample, excludedJobs? }
//     (senseHarnessGreenMain also keeps `since`). Defaults: headBranch '*', baseBranch
//     'main', attempts 'last', includeCancelled false, lookbackDays 30, excludedJobs [].
//   - The gh call is `gh run list --workflow <file> --event <event> [--branch <ref>]
//     --json <fields> --limit <n> [--created >=<date>]`, with no --branch for headBranch '*'.
//   - gh run list rows are filtered again by the sensor, so a row outside the population is
//     never counted even when gh returns it. A row carries databaseId, attempt, conclusion,
//     createdAt, updatedAt, event, headBranch, baseBranch, workflowFile, and jobs (the job
//     keys the run executed). The sensor asks for those fields in --json.
//   - A run is left out by identity when its workflowFile and one of its jobs match an
//     excludedJobs pair; a duration or conclusion never leaves a run out.
//   - attempts 'last' keeps, per databaseId, the row with the highest attempt; 'all' keeps
//     every row.
//   - Below minimumSample the reading is status unknown and the finding message names the
//     sample size, the minimum, the workflow, and the event; metrics carry sample_size,
//     minimum_sample, and the population as population_workflow, population_event,
//     population_head_branch, population_base_branch, population_attempts,
//     population_include_cancelled, population_lookback_days. The population metrics are
//     present at and above the minimum too.
//   - For harness_performance the minimum counts successful runs.
// spawnSync is mocked: no real gh ever runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));

import { senseHarnessGreenMain } from '../src/harness-green-main.js';
import { senseHarnessPerformance } from '../src/harness-performance.js';
import { senseHarnessRobustness } from '../src/harness-robustness.js';
import type { SensorReading } from '../src/sensor-reading.js';

const NOW = '2026-09-08T12:00:00.000Z';
const DAY = 86_400_000;
const MIN = 60_000;

interface Row {
  readonly databaseId: number;
  readonly attempt: number;
  readonly conclusion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly event: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly workflowFile: string;
  readonly jobs: readonly string[];
}

let nextId = 1;

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * DAY).toISOString();
}

/** One in-population run: the gate on a pull request into main, created `ageDays` ago. */
function row(
  overrides: Partial<Row> & { readonly durationMs?: number; readonly ageDays?: number } = {},
): Row {
  const { durationMs = 5 * MIN, ageDays = 2, ...rest } = overrides;
  const created = daysAgo(ageDays);
  return {
    databaseId: nextId++,
    attempt: 1,
    conclusion: 'success',
    createdAt: created,
    updatedAt: new Date(Date.parse(created) + durationMs).toISOString(),
    event: 'pull_request',
    headBranch: 'feature/x',
    baseBranch: 'main',
    workflowFile: 'pull-request-checks.yml',
    jobs: ['gate'],
    ...rest,
  };
}

function rows(count: number, overrides: Parameters<typeof row>[0] = {}): Row[] {
  return Array.from({ length: count }, () => row(overrides));
}

/** `ok` successes then `bad` failures. */
function mix(ok: number, bad: number, overrides: Parameters<typeof row>[0] = {}): Row[] {
  return [...rows(ok, overrides), ...rows(bad, { ...overrides, conclusion: 'failure' })];
}

function stubGh(data: readonly Row[]): void {
  mocks.spawnSync.mockImplementation((command: string) => {
    if (command !== 'gh') throw new Error(`unexpected spawnSync call: ${command}`);
    return { status: 0, signal: null, stdout: JSON.stringify(data), stderr: '', error: undefined };
  });
}

function ghArgv(): string[] {
  const call = mocks.spawnSync.mock.calls.find((c: unknown[]) => c[0] === 'gh');
  if (call === undefined) throw new Error('gh was not called');
  return call[1] as string[];
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
}

const RELEASE_EXCLUSIONS = [
  { workflow: 'release.yml', job: 'verify-ledger' },
  { workflow: 'release.yml', job: 'build-release' },
  { workflow: 'release.yml', job: 'finalize-release' },
  { workflow: 'release.yml', job: 'deploy-pages' },
] as const;

function population(minimumSample: number, extra: Record<string, unknown> = {}) {
  return {
    repoRoot: '/repo',
    now: NOW,
    workflow: 'pull-request-checks.yml',
    event: 'pull_request',
    headBranch: '*',
    baseBranch: 'main',
    attempts: 'last' as const,
    includeCancelled: false,
    lookbackDays: 30,
    minimumSample,
    excludedJobs: RELEASE_EXCLUSIONS,
    ...extra,
  };
}

// The sensors are the units; each is exercised through the same population cases.
type Sense = (opts: ReturnType<typeof population>) => SensorReading;
const greenMain: Sense = (o) => senseHarnessGreenMain(o);
const performance: Sense = (o) => senseHarnessPerformance(o);
const robustness: Sense = (o) => senseHarnessRobustness(o);

const SENSORS: readonly (readonly [string, Sense, number])[] = [
  ['harness_green_main', greenMain, 20],
  ['harness_performance', performance, 10],
  ['harness_robustness', robustness, 20],
];

/** Runs that sit outside the population on exactly one axis each; none may be counted. */
function outsiders(): Row[] {
  return [
    row({ workflowFile: 'ci.yml', conclusion: 'failure' }),
    row({ event: 'push', conclusion: 'failure' }),
    row({ event: 'merge_group', conclusion: 'failure' }),
    row({ baseBranch: 'release/1.x', conclusion: 'failure' }),
    row({ conclusion: 'cancelled' }),
    row({ ageDays: 45, conclusion: 'failure' }),
    row({ ageDays: 31, conclusion: 'failure' }),
    row({ workflowFile: 'release.yml', jobs: ['build-release'], durationMs: 3 * DAY }),
    row({ workflowFile: 'release.yml', jobs: ['verify-ledger'], conclusion: 'failure' }),
  ];
}

beforeEach(() => {
  mocks.spawnSync.mockReset();
  nextId = 1;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(SENSORS)('%s sampling (IA-001)', (kind, sense, minimum) => {
  it('reads unknown with no runs at all, never review, pass, or fail', () => {
    stubGh([]);
    const reading = sense(population(minimum));
    expect(reading.status).toBe('unknown');
    expect(reading.metrics?.['sample_size']).toBe(0);
    expect(reading.metrics?.['minimum_sample']).toBe(minimum);
  });

  it('reads unknown one run below the minimum, with sample size, minimum, and population in the finding', () => {
    stubGh(rows(minimum - 1));
    const reading = sense(population(minimum));
    expect(reading.status).toBe('unknown');
    const message = (reading.findings ?? []).map((f) => f.message).join('\n');
    expect(message).toContain(String(minimum - 1));
    expect(message).toContain(String(minimum));
    expect(message).toContain('pull-request-checks.yml');
    expect(message).toContain('pull_request');
    expect(reading.metrics?.['sample_size']).toBe(minimum - 1);
    expect(reading.metrics?.['minimum_sample']).toBe(minimum);
  });

  it('never reads fail below the minimum even when every sampled run is bad', () => {
    stubGh(rows(minimum - 1, { conclusion: 'failure', durationMs: 3 * 60 * MIN, attempt: 3 }));
    const reading = sense(population(minimum));
    expect(reading.status).toBe('unknown');
    expect((reading.findings ?? []).some((f) => f.severity === 'error')).toBe(false);
  });

  it('never reads pass below the minimum even when every sampled run is good', () => {
    stubGh(rows(minimum - 1));
    expect(sense(population(minimum)).status).toBe('unknown');
  });

  it('states a verdict at exactly the minimum', () => {
    stubGh(rows(minimum));
    expect(sense(population(minimum)).status).not.toBe('unknown');
  });

  it('puts the population in the metrics', () => {
    stubGh(rows(minimum));
    const metrics = sense(population(minimum, { headBranch: '*', lookbackDays: 14 })).metrics ?? {};
    expect(metrics['population_workflow']).toBe('pull-request-checks.yml');
    expect(metrics['population_event']).toBe('pull_request');
    expect(metrics['population_head_branch']).toBe('*');
    expect(metrics['population_base_branch']).toBe('main');
    expect(metrics['population_attempts']).toBe('last');
    expect(metrics['population_include_cancelled']).toBe(false);
    expect(metrics['population_lookback_days']).toBe(14);
    expect(metrics['minimum_sample']).toBe(minimum);
  });

  it('puts the population in the metrics below the minimum too', () => {
    stubGh(rows(1));
    const metrics = sense(population(minimum)).metrics ?? {};
    expect(metrics['population_workflow']).toBe('pull-request-checks.yml');
    expect(metrics['population_event']).toBe('pull_request');
    expect(metrics['sample_size']).toBe(1);
  });

  it('counts only the runs inside the population toward the minimum', () => {
    // minimum - 1 in-population runs hidden among runs outside it: still below the minimum.
    stubGh([...rows(minimum - 1), ...outsiders()]);
    const reading = sense(population(minimum));
    expect(reading.status).toBe('unknown');
    expect(reading.metrics?.['sample_size']).toBe(minimum - 1);
  });

  it('asks gh for the declared workflow and event with no --branch for any head branch', () => {
    stubGh(rows(minimum));
    sense(population(minimum));
    const argv = ghArgv();
    expect(argv.slice(0, 2)).toEqual(['run', 'list']);
    expect(valueAfter(argv, '--workflow')).toBe('pull-request-checks.yml');
    expect(valueAfter(argv, '--event')).toBe('pull_request');
    expect(argv).not.toContain('--branch');
    expect(argv).toContain('--json');
    expect(argv).toContain('--limit');
  });

  it('passes a literal head branch as the single --branch option', () => {
    stubGh(rows(minimum));
    sense(population(minimum, { event: 'push', headBranch: 'main' }));
    const argv = ghArgv();
    expect(valueAfter(argv, '--event')).toBe('push');
    expect(argv.filter((a) => a === '--branch')).toHaveLength(1);
    expect(valueAfter(argv, '--branch')).toBe('main');
  });

  it('keeps only runs of the literal head branch', () => {
    stubGh([
      ...rows(minimum - 1, { event: 'push', headBranch: 'main' }),
      ...rows(5, { event: 'push', headBranch: 'feature/y' }),
    ]);
    const reading = sense(population(minimum, { event: 'push', headBranch: 'main' }));
    expect(reading.status).toBe('unknown');
    expect(reading.metrics?.['sample_size']).toBe(minimum - 1);
  });

  it('keeps every head branch when the declared head branch is *', () => {
    stubGh([...rows(10, { headBranch: 'a' }), ...rows(minimum - 10, { headBranch: 'b/c' })]);
    const reading = sense(population(minimum));
    expect(reading.metrics?.['sample_size']).toBe(minimum);
    expect(reading.status).not.toBe('unknown');
  });

  it('degrades to unknown when gh is unavailable (unchanged)', () => {
    mocks.spawnSync.mockReturnValue({
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
    });
    expect(sense(population(minimum)).status).toBe('unknown');
  });
});

describe('population filtering', () => {
  // Measured through harness_green_main: an in-population success rate of 100% with a
  // block of failing outsiders; any outsider that leaks in drops the rate and the status.
  it('leaves out runs of another workflow, event, base branch, lookback, and cancelled runs', () => {
    stubGh([...rows(20), ...outsiders()]);
    const reading = senseHarnessGreenMain(population(20));
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.['sample_size']).toBe(20);
    expect(reading.metrics?.['success_pct']).toBe(100);
  });

  it('leaves out runs older than the declared lookback and keeps those inside it', () => {
    stubGh([...rows(20, { ageDays: 29 }), ...rows(30, { ageDays: 31, conclusion: 'failure' })]);
    const reading = senseHarnessGreenMain(population(20));
    expect(reading.metrics?.['sample_size']).toBe(20);
    expect(reading.status).toBe('pass');
  });

  it('honours a shorter declared lookback', () => {
    stubGh([...rows(20, { ageDays: 10 }), ...rows(20, { ageDays: 2 })]);
    const reading = senseHarnessGreenMain(population(20, { lookbackDays: 7 }));
    expect(reading.metrics?.['sample_size']).toBe(20);
  });

  it('leaves out cancelled runs by default, from the sample and the denominator', () => {
    stubGh([...rows(20), ...rows(30, { conclusion: 'cancelled' })]);
    const reading = senseHarnessGreenMain(population(20));
    expect(reading.metrics?.['sample_size']).toBe(20);
    expect(reading.metrics?.['success_pct']).toBe(100);
    expect(reading.status).toBe('pass');
  });

  it('counts cancelled runs as runs that did not succeed when includeCancelled is true', () => {
    stubGh([...rows(20), ...rows(10, { conclusion: 'cancelled' })]);
    const reading = senseHarnessGreenMain(population(20, { includeCancelled: true }));
    expect(reading.metrics?.['sample_size']).toBe(30);
    expect(reading.metrics?.['success_pct']).toBeCloseTo(66.67, 1);
    expect(reading.status).toBe('fail');
    expect(reading.metrics?.['population_include_cancelled']).toBe(true);
  });

  it('keeps only the last attempt of a run by default', () => {
    const retried = Array.from({ length: 20 }, () => {
      const id = nextId++;
      return [
        row({ databaseId: id, attempt: 1, conclusion: 'failure' }),
        row({ databaseId: id, attempt: 2, conclusion: 'success' }),
      ];
    }).flat();
    stubGh(retried);
    const reading = senseHarnessGreenMain(population(20));
    expect(reading.metrics?.['sample_size']).toBe(20);
    expect(reading.metrics?.['success_pct']).toBe(100);
    expect(reading.status).toBe('pass');
  });

  it('keeps every attempt when attempts is all', () => {
    const retried = Array.from({ length: 20 }, () => {
      const id = nextId++;
      return [
        row({ databaseId: id, attempt: 1, conclusion: 'failure' }),
        row({ databaseId: id, attempt: 2, conclusion: 'success' }),
      ];
    }).flat();
    stubGh(retried);
    const reading = senseHarnessGreenMain(population(20, { attempts: 'all' }));
    expect(reading.metrics?.['sample_size']).toBe(40);
    expect(reading.metrics?.['success_pct']).toBe(50);
    expect(reading.status).toBe('fail');
  });

  it('leaves out an excluded workflow-and-job pair by identity, never a slow run of the sampled workflow', () => {
    stubGh([
      ...rows(10),
      row({
        workflowFile: 'release.yml',
        jobs: ['verify-ledger', 'deploy-pages'],
        durationMs: 4 * DAY,
      }),
    ]);
    const reading = senseHarnessPerformance(population(10));
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.['sample_size']).toBe(10);
    expect(reading.metrics?.['p95_ms']).toBe(5 * MIN);
  });

  it('keeps a long run of the sampled workflow in the sample, where it can drive FAIL', () => {
    stubGh(rows(10, { durationMs: 40 * MIN }));
    const reading = senseHarnessPerformance(population(10));
    expect(reading.status).toBe('fail');
    expect(reading.metrics?.['sample_size']).toBe(10);
  });

  it('does not exclude a run whose job is not on the excluded list', () => {
    stubGh([
      ...rows(9),
      row({ workflowFile: 'release.yml', jobs: ['control-commit-summary'], event: 'pull_request' }),
    ]);
    // The workflow is outside the population anyway, so it is not counted either way.
    const reading = senseHarnessPerformance(
      population(10, { workflow: 'release.yml', excludedJobs: [] }),
    );
    expect(reading.metrics?.['sample_size']).toBe(1);
    expect(reading.status).toBe('unknown');
  });
});

describe('harness_green_main verdict at and above the minimum', () => {
  it('reads FAIL below eighty percent success', () => {
    stubGh(mix(15, 5));
    const reading = senseHarnessGreenMain(population(20));
    expect(reading.status).toBe('fail');
    expect(reading.metrics?.['success_pct']).toBe(75);
  });

  it('reads REVIEW from eighty to below ninety-five percent', () => {
    stubGh(mix(17, 3));
    expect(senseHarnessGreenMain(population(20)).status).toBe('review');
  });

  it('reads PASS at ninety-five percent or more', () => {
    stubGh(mix(19, 1));
    expect(senseHarnessGreenMain(population(20)).status).toBe('pass');
  });

  it('reads the same failures as unknown one run short of the minimum', () => {
    stubGh(mix(14, 5));
    const reading = senseHarnessGreenMain(population(20));
    expect(reading.status).toBe('unknown');
    expect(reading.metrics?.['sample_size']).toBe(19);
  });

  it('applies the since filter after the population filter', () => {
    // 25 in-population runs: 12 recent failures, 13 older successes. since keeps the recent
    // 12 (at or above the sensor min_sample_size of 5), and the population filter has
    // already removed the outsiders, so only in-population recent runs are measured.
    stubGh([
      ...rows(12, { ageDays: 3, conclusion: 'failure' }),
      ...rows(13, { ageDays: 20 }),
      ...rows(40, { ageDays: 3, event: 'push', conclusion: 'success' }),
    ]);
    const reading = senseHarnessGreenMain({ ...population(20), since: daysAgo(10) });
    expect(reading.metrics?.['run_count'] ?? reading.metrics?.['sample_size']).toBe(12);
    expect(reading.metrics?.['success_pct']).toBe(0);
  });

  it('does not let since widen the population beyond the lookback', () => {
    stubGh([...rows(6, { ageDays: 5 }), ...rows(30, { ageDays: 60, conclusion: 'failure' })]);
    const reading = senseHarnessGreenMain({ ...population(5), since: daysAgo(90) });
    expect(reading.metrics?.['sample_size']).toBe(6);
    expect(reading.status).toBe('pass');
  });
});

describe('harness_performance verdict and minimum of successful runs', () => {
  it('counts successful runs toward the minimum, not every run', () => {
    stubGh([...rows(9), ...rows(30, { conclusion: 'failure' })]);
    const reading = senseHarnessPerformance(population(10));
    expect(reading.status).toBe('unknown');
    expect(reading.metrics?.['sample_size']).toBe(9);
    expect(reading.metrics?.['minimum_sample']).toBe(10);
  });

  it('reads PASS under the median and p95 pass thresholds at the minimum', () => {
    stubGh(rows(10, { durationMs: 8 * MIN }));
    const reading = senseHarnessPerformance(population(10));
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.['median_ms']).toBe(8 * MIN);
  });

  it('reads REVIEW between the pass and review thresholds', () => {
    stubGh(rows(10, { durationMs: 15 * MIN }));
    expect(senseHarnessPerformance(population(10)).status).toBe('review');
  });

  it('reads FAIL above the review thresholds', () => {
    stubGh(rows(10, { durationMs: 25 * MIN }));
    expect(senseHarnessPerformance(population(10)).status).toBe('fail');
  });

  it('drops cancelled runs from the sample', () => {
    stubGh([
      ...rows(10, { durationMs: 8 * MIN }),
      ...rows(10, { conclusion: 'cancelled', durationMs: 90 * MIN }),
    ]);
    const reading = senseHarnessPerformance(population(10));
    expect(reading.status).toBe('pass');
  });
});

describe('harness_robustness verdict and last-attempt sampling', () => {
  it('reads PASS when no sampled run needed a retry', () => {
    stubGh(rows(20));
    const reading = senseHarnessRobustness(population(20));
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.['flakiness_pct']).toBe(0);
  });

  it('reads FAIL when fifteen percent or more of the sample passed only on a retry', () => {
    stubGh([...rows(16), ...rows(4, { attempt: 2 })]);
    const reading = senseHarnessRobustness(population(20));
    expect(reading.status).toBe('fail');
    expect(reading.metrics?.['flakiness_pct']).toBe(20);
  });

  it('measures a rerun against the last attempt only, once', () => {
    const id = nextId++;
    stubGh([
      row({ databaseId: id, attempt: 1, conclusion: 'failure' }),
      row({ databaseId: id, attempt: 2, conclusion: 'success' }),
      ...rows(19),
    ]);
    const reading = senseHarnessRobustness(population(20));
    expect(reading.metrics?.['sample_size']).toBe(20);
    expect(reading.metrics?.['flaky_runs']).toBe(1);
    expect(reading.status).toBe('pass');
  });
});
