// CMP-0007 R-0703, ADR-SCR-0014: with outcomeUnit pull-request-final-head, harness_green_main
// (F5:T9) counts one outcome per pull request. The default outcomeUnit run keeps the per-run
// reading and its command line unchanged. A pull
// request's final head is its (headRefName, headRefOid); its outcome is the latest completed
// gate run on that branch and sha that was neither cancelled nor skipped. Merged,
// closed-unmerged, and open pull requests with such a run are counted; an open pull request
// without one is excluded. The thresholds are unchanged: PASS at 95 % and above, REVIEW from
// 80 % up to 95 %, FAIL below 80 %.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));

import { senseHarnessGreenMain } from '../../src/harness-green-main.js';
import { senseHarnessPerformance } from '../../src/harness-performance.js';
import type { SensorReading } from '../../src/sensor-reading.js';

const NOW = '2026-10-08T12:00:00.000Z';
const POPULATION = {
  workflow: 'pull-request-checks.yml',
  event: 'pull_request',
  minimumSample: 1,
} as const;
const FINAL_HEAD = { outcomeUnit: 'pull-request-final-head' } as const;
/** The run fields every harness sensor requests under the default outcome unit. */
const RUN_FIELDS = 'attempt,conclusion,createdAt,databaseId,event,headBranch,updatedAt';
/** The run fields harness_green_main requests under pull-request-final-head. */
const GREEN_MAIN_RUN_FIELDS =
  'attempt,conclusion,createdAt,databaseId,event,headBranch,headSha,status,updatedAt';
const RUN_LIST_ARGV = (fields: string) => [
  'run',
  'list',
  '--workflow',
  'pull-request-checks.yml',
  '--event',
  'pull_request',
  '--json',
  fields,
  '--limit',
  '1000',
  '--created',
  '>=2026-09-08',
];
const PR_LIST_ARGV = [
  'pr',
  'list',
  '--state',
  'all',
  '--limit',
  '1000',
  '--json',
  'baseRefName,closedAt,createdAt,headRefName,headRefOid,mergedAt,number,state',
];

type Conclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | null;
type State = 'MERGED' | 'CLOSED' | 'OPEN';

interface Run {
  readonly databaseId: number;
  readonly headBranch: string;
  readonly headSha: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: Conclusion;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempt: number;
}

interface PullRequest {
  readonly number: number;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly state: State;
  readonly createdAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
}

/** Before every run the fixture's clock creates, so each fixture run lies in the open interval. */
const OPENED = '2026-09-30T00:00:00.000Z';

let nextId = 1;
let clock = Date.parse('2026-10-01T00:00:00Z');
const tick = (): string => new Date((clock += 60_000)).toISOString();

function run(branch: string, sha: string, conclusion: Conclusion, extra: Partial<Run> = {}): Run {
  const createdAt = tick();
  return {
    databaseId: nextId++,
    headBranch: branch,
    headSha: sha,
    event: 'pull_request',
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
    createdAt,
    updatedAt: tick(),
    attempt: 1,
    ...extra,
  };
}

function pr(
  number: number,
  branch: string,
  sha: string,
  state: State,
  extra: Partial<PullRequest> = {},
): PullRequest {
  const closed = state === 'OPEN' ? null : NOW;
  return {
    number,
    baseRefName: 'main',
    headRefName: branch,
    headRefOid: sha,
    state,
    createdAt: OPENED,
    mergedAt: state === 'MERGED' ? NOW : null,
    closedAt: closed,
    ...extra,
  };
}

interface SpawnResult {
  readonly status: number | null;
  readonly signal: null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: undefined;
}
const ok = (value: unknown): SpawnResult => ({
  status: 0,
  signal: null,
  stdout: JSON.stringify(value),
  stderr: '',
  error: undefined,
});

/** Serves the run list to `gh run list` and the pull requests to `gh pr list`. */
function stub(
  runs: readonly Run[],
  pullRequests: readonly PullRequest[],
  prList: SpawnResult = ok(pullRequests),
): void {
  mocks.spawnSync.mockImplementation((command: string, args: readonly string[]) => {
    if (command !== 'gh') throw new Error(`unexpected spawnSync call: ${command}`);
    if (args[0] === 'run' && args[1] === 'list') return ok(runs);
    if (args[0] === 'pr' && args[1] === 'list') return prList;
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  });
}

function sense(): SensorReading {
  return senseHarnessGreenMain({ ...POPULATION, ...FINAL_HEAD, repoRoot: '/repo', now: NOW });
}

function argv(call: number): readonly string[] {
  return (mocks.spawnSync.mock.calls[call]?.[1] ?? []) as readonly string[];
}

/** The sensor's counted outcomes, read back from its metrics. */
function counted(reading: SensorReading) {
  return {
    total: reading.metrics?.['run_count'],
    green: reading.metrics?.['success_count'],
    pct: reading.metrics?.['success_pct'],
  };
}

/** `count` merged pull requests whose final heads passed, numbered from `first`. */
function greenPullRequests(count: number, first = 100) {
  const runs: Run[] = [];
  const pullRequests: PullRequest[] = [];
  for (let index = 0; index < count; index += 1) {
    const number = first + index;
    const branch = `feature/green-${String(number)}`;
    const sha = `g${String(number).padStart(39, '0')}`;
    runs.push(run(branch, sha, 'success'));
    pullRequests.push(pr(number, branch, sha, 'MERGED'));
  }
  return { runs, pullRequests };
}

/** `count` closed-unmerged pull requests whose final heads failed, numbered from `first`. */
function redPullRequests(count: number, first = 500) {
  const runs: Run[] = [];
  const pullRequests: PullRequest[] = [];
  for (let index = 0; index < count; index += 1) {
    const number = first + index;
    const branch = `feature/red-${String(number)}`;
    const sha = `r${String(number).padStart(39, '0')}`;
    runs.push(run(branch, sha, 'failure'));
    pullRequests.push(pr(number, branch, sha, 'CLOSED'));
  }
  return { runs, pullRequests };
}

beforeEach(() => {
  mocks.spawnSync.mockReset();
  nextId = 1;
  clock = Date.parse('2026-10-01T00:00:00Z');
});

describe('harness_green_main: one outcome per pull request final head (R-0703)', () => {
  it('counts a pull request green when its last push passes after earlier red pushes', () => {
    const branch = 'feature/fixed';
    stub(
      [
        run(branch, 'a'.repeat(40), 'failure'),
        run(branch, 'b'.repeat(40), 'failure'),
        run(branch, 'c'.repeat(40), 'success'),
      ],
      [pr(1, branch, 'c'.repeat(40), 'MERGED')],
    );

    expect(counted(sense())).toEqual({ total: 1, green: 1, pct: 100 });
  });

  it('counts a pull request red when its final head failed, whatever passed before', () => {
    const branch = 'feature/broke';
    stub(
      [run(branch, 'a'.repeat(40), 'success'), run(branch, 'b'.repeat(40), 'failure')],
      [pr(2, branch, 'b'.repeat(40), 'OPEN')],
    );

    expect(counted(sense())).toEqual({ total: 1, green: 0, pct: 0 });
  });

  it('counts a closed-unmerged pull request with a red final head as red', () => {
    const branch = 'feature/abandoned';
    stub([run(branch, 'd'.repeat(40), 'failure')], [pr(3, branch, 'd'.repeat(40), 'CLOSED')]);

    expect(counted(sense())).toEqual({ total: 1, green: 0, pct: 0 });
  });

  it('counts a timed-out final head as red', () => {
    const branch = 'feature/slow';
    stub([run(branch, 'e'.repeat(40), 'timed_out')], [pr(4, branch, 'e'.repeat(40), 'MERGED')]);

    expect(counted(sense())).toEqual({ total: 1, green: 0, pct: 0 });
  });

  it('excludes an open pull request whose final head has only cancelled or skipped runs', () => {
    const counts = greenPullRequests(1);
    const branch = 'feature/superseded';
    const sha = 'f'.repeat(40);
    stub(
      [
        ...counts.runs,
        // An earlier head's red run does not stand in for the final head.
        run(branch, '0'.repeat(40), 'failure'),
        run(branch, sha, 'cancelled'),
        run(branch, sha, 'skipped'),
      ],
      [...counts.pullRequests, pr(5, branch, sha, 'OPEN')],
    );

    expect(counted(sense())).toEqual({ total: 1, green: 1, pct: 100 });
  });

  it.each(['MERGED', 'CLOSED'] as const)(
    'counts a %s pull request whose final head has only cancelled or skipped runs as red',
    (state) => {
      // ADR-SCR-0014 rule 5: only an open pull request may wait for its gate; one that left
      // without a completed final-head run is not green, whatever passed on an earlier head.
      const counts = greenPullRequests(1);
      const branch = `feature/left-ungated-${state.toLowerCase()}`;
      const sha = 'e'.repeat(40);
      stub(
        [
          ...counts.runs,
          run(branch, '0'.repeat(40), 'success'),
          run(branch, sha, 'cancelled'),
          run(branch, sha, 'skipped'),
        ],
        [...counts.pullRequests, pr(11, branch, sha, state)],
      );

      expect(counted(sense())).toEqual({ total: 2, green: 1, pct: 50 });
    },
  );

  it('excludes an open pull request with no completed run on its final head', () => {
    const counts = greenPullRequests(1);
    const running = 'feature/running';
    const unrun = 'feature/unrun';
    stub(
      [
        ...counts.runs,
        run(running, '1'.repeat(40), 'failure'),
        run(running, '2'.repeat(40), null),
        run(unrun, '3'.repeat(40), 'failure'),
      ],
      [
        ...counts.pullRequests,
        pr(6, running, '2'.repeat(40), 'OPEN'),
        pr(7, unrun, '4'.repeat(40), 'OPEN'),
      ],
    );

    expect(counted(sense())).toEqual({ total: 1, green: 1, pct: 100 });
  });

  it('counts the last attempt of a re-run final head', () => {
    const branch = 'feature/rerun';
    const sha = '5'.repeat(40);
    const first = run(branch, sha, 'failure');
    stub(
      [first, run(branch, sha, 'success', { databaseId: first.databaseId, attempt: 2 })],
      [pr(8, branch, sha, 'MERGED')],
    );

    expect(counted(sense())).toEqual({ total: 1, green: 1, pct: 100 });
  });

  it('counts the latest completed run when a later run on the final head is still in progress', () => {
    const branch = 'feature/rerunning';
    const sha = '6'.repeat(40);
    stub([run(branch, sha, 'success'), run(branch, sha, null)], [pr(9, branch, sha, 'MERGED')]);

    expect(counted(sense())).toEqual({ total: 1, green: 1, pct: 100 });
  });

  it('matches the final head by branch and sha, not by sha alone', () => {
    const sha = '7'.repeat(40);
    stub(
      // A green run of the same commit on another branch is not this pull request's outcome.
      [run('feature/elsewhere', sha, 'success'), run('feature/mine', sha, 'failure')],
      [pr(10, 'feature/mine', sha, 'CLOSED')],
    );

    expect(counted(sense())).toEqual({ total: 1, green: 0, pct: 0 });
  });
});

describe('harness_green_main outcome units and command lines (ADR-SCR-0014)', () => {
  it('keeps the per-run reading and run-list argv under the default outcome unit', () => {
    const branch = 'feature/default';
    // Two red pushes and a green final head: three runs per run, one green pull request per PR.
    stub(
      [
        run(branch, 'a'.repeat(40), 'failure'),
        run(branch, 'b'.repeat(40), 'failure'),
        run(branch, 'c'.repeat(40), 'success'),
      ],
      [pr(1, branch, 'c'.repeat(40), 'MERGED')],
    );

    const reading = senseHarnessGreenMain({ ...POPULATION, repoRoot: '/repo', now: NOW });

    expect(counted(reading)).toEqual({ total: 3, green: 1, pct: 33.33 });
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(argv(0)).toEqual(RUN_LIST_ARGV(RUN_FIELDS));
  });

  it('reads the same as the default when the run unit is declared explicitly', () => {
    stub([run('feature/x', 'a'.repeat(40), 'failure')], []);

    const reading = senseHarnessGreenMain({
      ...POPULATION,
      outcomeUnit: 'run',
      repoRoot: '/repo',
      now: NOW,
    });

    expect(counted(reading)).toEqual({ total: 1, green: 0, pct: 0 });
    expect(argv(0)).toEqual(RUN_LIST_ARGV(RUN_FIELDS));
  });

  it('requests the green-main run fields, then every pull request, under the final-head unit', () => {
    stub(
      [run('feature/y', 'a'.repeat(40), 'success')],
      [pr(1, 'feature/y', 'a'.repeat(40), 'OPEN')],
    );

    sense();

    expect(argv(0)).toEqual(RUN_LIST_ARGV(GREEN_MAIN_RUN_FIELDS));
    expect(argv(1)).toEqual(PR_LIST_ARGV);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['fails', { status: 1, signal: null, stdout: '', stderr: 'HTTP 502', error: undefined }],
    [
      'returns unparseable JSON',
      { status: 0, signal: null, stdout: '{not json', stderr: '', error: undefined },
    ],
  ] as const)(
    'reads unknown, never the run-only verdict, when gh pr list %s',
    (_label, failure) => {
      // Every run passed, so a fall back to the run-only reading would read PASS.
      const greens = greenPullRequests(20);
      stub(greens.runs, greens.pullRequests, failure);

      const reading = sense();

      expect(reading.status).toBe('unknown');
      expect((reading.findings ?? []).some((finding) => /PR_LIST/u.test(finding.code))).toBe(true);
      expect(reading.metrics?.['success_pct'] ?? 0).toBe(0);
    },
  );
});

// R-0703 review rulings for the final-head unit.
describe('harness_green_main final-head review rulings (R-0703)', () => {
  const UNAVAILABLE = 'HARNESS_GREEN_MAIN_PR_LIST_UNAVAILABLE';

  function unavailable(reading: SensorReading): void {
    expect(reading.status).toBe('unknown');
    expect((reading.findings ?? []).map((finding) => finding.code)).toContain(UNAVAILABLE);
    expect(reading.metrics?.['success_count'] ?? 0).toBe(0);
  }

  it.each(['MERGED', 'CLOSED'] as const)(
    'enters a %s pull request whose only window runs are cancelled, and counts it red',
    (state) => {
      // Membership is decided before cancelled and skipped runs are dropped as outcomes, so a
      // pull request seen only through cancelled runs is still in the population.
      const counts = greenPullRequests(1);
      const branch = `feature/only-cancelled-${state.toLowerCase()}`;
      const sha = 'c'.repeat(40);
      stub(
        [...counts.runs, run(branch, sha, 'cancelled'), run(branch, sha, 'cancelled')],
        [...counts.pullRequests, pr(12, branch, sha, state)],
      );

      expect(counted(sense())).toEqual({ total: 2, green: 1, pct: 50 });
    },
  );

  it('keeps an open pull request whose only window runs are cancelled out of the population', () => {
    const counts = greenPullRequests(1);
    const branch = 'feature/only-cancelled-open';
    const sha = 'c'.repeat(40);
    stub(
      [...counts.runs, run(branch, sha, 'cancelled')],
      [...counts.pullRequests, pr(13, branch, sha, 'OPEN')],
    );

    expect(counted(sense())).toEqual({ total: 1, green: 1, pct: 100 });
  });

  /** `count` pull requests, the first `gated` of them with a green final-head run. */
  function listing(count: number, gated = 3) {
    const greens = greenPullRequests(gated);
    const others = Array.from({ length: count - gated }, (_, index) =>
      pr(
        10_000 + index,
        `feature/listed-${String(index)}`,
        String(index).padStart(40, '9'),
        'OPEN',
      ),
    );
    return { runs: greens.runs, pullRequests: [...greens.pullRequests, ...others] };
  }

  it('reads unknown when gh pr list returns exactly its 1000-row limit (possible truncation)', () => {
    const { runs, pullRequests } = listing(1000);
    expect(pullRequests).toHaveLength(1000);
    stub(runs, pullRequests);

    unavailable(sense());
  });

  it('accepts an open pull request row with a null closedAt', () => {
    const greens = greenPullRequests(2);
    const branch = 'feature/open-null-closed';
    const sha = '8'.repeat(40);
    stub(
      [...greens.runs, run(branch, sha, 'failure')],
      [...greens.pullRequests, pr(30, branch, sha, 'OPEN', { closedAt: null, mergedAt: null })],
    );

    const reading = sense();
    expect(reading.status).not.toBe('unknown');
    expect(counted(reading)).toEqual({ total: 3, green: 2, pct: 66.67 });
  });

  it('reads a verdict when gh pr list returns one row fewer than its limit', () => {
    const { runs, pullRequests } = listing(999);
    stub(runs, pullRequests);

    const reading = sense();
    expect(reading.status).toBe('pass');
    expect(counted(reading)).toEqual({ total: 3, green: 3, pct: 100 });
  });

  const malformed: readonly (readonly [string, (row: Record<string, unknown>) => unknown])[] = [
    ['a missing headRefName', ({ headRefName: _drop, ...row }) => row],
    ['a missing headRefOid', ({ headRefOid: _drop, ...row }) => row],
    ['a missing number', ({ number: _drop, ...row }) => row],
    ['a missing state', ({ state: _drop, ...row }) => row],
    ['a missing baseRefName', ({ baseRefName: _drop, ...row }) => row],
    ['a missing createdAt', ({ createdAt: _drop, ...row }) => row],
    ['a numeric baseRefName', (row) => ({ ...row, baseRefName: 7 })],
    ['a non-date createdAt', (row) => ({ ...row, createdAt: 'yesterday' })],
    ['a null createdAt', (row) => ({ ...row, createdAt: null })],
    // A merged or closed pull request has a closing time; without it its lifetime is unknown.
    ['a merged state with a null closedAt', (row) => ({ ...row, closedAt: null })],
    ['a merged state without closedAt', ({ closedAt: _drop, ...row }) => row],
    [
      'a closed state with a null closedAt',
      (row) => ({ ...row, state: 'CLOSED', mergedAt: null, closedAt: null }),
    ],
    ['a numeric headRefName', (row) => ({ ...row, headRefName: 42 })],
    ['a null headRefOid', (row) => ({ ...row, headRefOid: null })],
    ['a string number', (row) => ({ ...row, number: '7' })],
    ['a numeric state', (row) => ({ ...row, state: 1 })],
    ['a row that is not an object', () => 'feature/not-an-object'],
  ];

  it.each(malformed)(
    'reads unknown, with no partial verdict, for a pr row with %s',
    (_label, edit) => {
      const greens = greenPullRequests(3);
      const [first, ...rest] = greens.pullRequests;
      if (first === undefined) throw new Error('fixture: no pull request');
      stub(greens.runs, [], ok([edit({ ...first }), ...rest]));

      unavailable(sense());
    },
  );

  it.each([
    ['an object', { pullRequests: [] }],
    ['a string', 'no pull requests'],
    ['null', null],
  ])('reads unknown when gh pr list returns %s instead of an array', (_label, value) => {
    const greens = greenPullRequests(3);
    stub(greens.runs, [], ok(value));

    unavailable(sense());
  });

  it('decides a final head by its highest attempt when every attempt is sampled', () => {
    const branch = 'feature/reattempted';
    const sha = 'a'.repeat(40);
    const first = run(branch, sha, 'success');
    // Attempt 1 passed and is listed first; attempt 2 of the same run, created at the same
    // instant, failed and decides.
    const second = { ...first, attempt: 2, conclusion: 'failure' as const, updatedAt: tick() };
    stub([first, second], [pr(14, branch, sha, 'MERGED')]);

    const reading = senseHarnessGreenMain({
      ...POPULATION,
      ...FINAL_HEAD,
      attempts: 'all',
      repoRoot: '/repo',
      now: NOW,
    });

    expect(counted(reading)).toEqual({ total: 1, green: 0, pct: 0 });
  });
});

// ADR-SCR-0014 IA-006 (#365): only pull requests against the declared base are sampled, and a
// run belongs to a pull request only when it was created while the pull request was open.
describe('harness_green_main final-head base branch and lifetime (ADR-SCR-0014 IA-006)', () => {
  const at = (iso: string): Partial<Run> => ({ createdAt: iso, updatedAt: iso });

  it('leaves out a pull request whose base is not the declared base branch', () => {
    const counts = greenPullRequests(1);
    const branch = 'feature/backport';
    const sha = '1'.repeat(40);
    stub(
      [...counts.runs, run(branch, sha, 'failure')],
      [...counts.pullRequests, pr(20, branch, sha, 'MERGED', { baseRefName: 'release/2.2' })],
    );

    expect(counted(sense())).toEqual({ total: 1, green: 1, pct: 100 });
  });

  it('does not attribute a run created before the pull request opened', () => {
    const counts = greenPullRequests(1);
    const branch = 'feature/early';
    const sha = '2'.repeat(40);
    stub(
      [...counts.runs, run(branch, sha, 'failure', at('2026-10-02T00:00:00.000Z'))],
      [
        ...counts.pullRequests,
        pr(21, branch, sha, 'MERGED', { createdAt: '2026-10-03T00:00:00.000Z' }),
      ],
    );

    // Its only run predates it, so it has no run in its lifetime and is not sampled.
    expect(counted(sense())).toEqual({ total: 1, green: 1, pct: 100 });
  });

  it('does not attribute a run created after the pull request closed', () => {
    const counts = greenPullRequests(1);
    const branch = 'feature/late';
    const sha = '3'.repeat(40);
    stub(
      [...counts.runs, run(branch, sha, 'failure', at('2026-10-06T00:00:00.000Z'))],
      [
        ...counts.pullRequests,
        pr(22, branch, sha, 'CLOSED', { closedAt: '2026-10-05T00:00:00.000Z' }),
      ],
    );

    expect(counted(sense())).toEqual({ total: 1, green: 1, pct: 100 });
  });

  it('decides a final head only from the runs inside its lifetime', () => {
    const branch = 'feature/inside';
    const sha = '4'.repeat(40);
    stub(
      [
        run(branch, sha, 'success', at('2026-10-02T00:00:00.000Z')),
        run(branch, sha, 'failure', at('2026-10-04T00:00:00.000Z')),
        run(branch, sha, 'success', at('2026-10-07T00:00:00.000Z')),
      ],
      [
        pr(23, branch, sha, 'MERGED', {
          createdAt: '2026-10-03T00:00:00.000Z',
          closedAt: '2026-10-05T00:00:00.000Z',
          mergedAt: '2026-10-05T00:00:00.000Z',
        }),
      ],
    );

    // The green runs fall before it opened and after it merged; inside, its head failed.
    expect(counted(sense())).toEqual({ total: 1, green: 0, pct: 0 });
  });

  it('keeps an open pull request open until now', () => {
    const branch = 'feature/still-open';
    const sha = '5'.repeat(40);
    stub(
      [run(branch, sha, 'failure', at('2026-10-08T11:00:00.000Z'))],
      [pr(24, branch, sha, 'OPEN', { createdAt: '2026-10-02T00:00:00.000Z' })],
    );

    expect(counted(sense())).toEqual({ total: 1, green: 0, pct: 0 });
  });

  it('never lends a reused branch name the run of a later pull request (#365)', () => {
    const branch = 'feature/reused';
    const sha = '6'.repeat(40);
    stub(
      // One green run, created while only the newer pull request was open.
      [run(branch, sha, 'success', at('2026-10-04T00:00:00.000Z'))],
      [
        pr(25, branch, sha, 'CLOSED', {
          createdAt: '2026-09-20T00:00:00.000Z',
          closedAt: '2026-09-21T00:00:00.000Z',
        }),
        pr(26, branch, sha, 'MERGED', { createdAt: '2026-10-03T00:00:00.000Z' }),
      ],
    );

    // The older pull request had no run in its own lifetime: it is not sampled and not red.
    expect(counted(sense())).toEqual({ total: 1, green: 1, pct: 100 });
  });
});

// ADR-SCR-0014 IA-008 (#370): membership filters on baseRefName, so the final-head unit has
// verified the base branch; the run unit, which reads runs without a base, has not.
describe('harness_green_main unverified population filters (ADR-SCR-0014 IA-008)', () => {
  const UNVERIFIED = 'HARNESS_POPULATION_UNVERIFIED';
  /** A declared excluded pair naming the sampled workflow, which run rows cannot apply. */
  const SAME_WORKFLOW_PAIR = {
    excludedJobs: [{ workflow: 'pull-request-checks.yml', job: 'gate' }],
  } as const;
  const OTHER_WORKFLOW_PAIR = {
    excludedJobs: [{ workflow: 'release.yml', job: 'verify-ledger' }],
  } as const;

  function finding(reading: SensorReading) {
    return (reading.findings ?? []).find((entry) => entry.code === UNVERIFIED);
  }

  function readFinalHead(extra: Record<string, unknown> = {}): SensorReading {
    const greens = greenPullRequests(2);
    stub(greens.runs, greens.pullRequests);
    return senseHarnessGreenMain({
      ...POPULATION,
      ...FINAL_HEAD,
      ...extra,
      repoRoot: '/repo',
      now: NOW,
    });
  }

  function readRuns(extra: Record<string, unknown> = {}): SensorReading {
    const greens = greenPullRequests(2);
    stub(greens.runs, greens.pullRequests);
    return senseHarnessGreenMain({ ...POPULATION, ...extra, repoRoot: '/repo', now: NOW });
  }

  it('verifies the base branch and carries no unverified finding under the final-head unit', () => {
    const reading = readFinalHead();

    expect(reading.metrics).toMatchObject({
      population_base_branch_verified: true,
      population_unverified: '',
    });
    expect(finding(reading)).toBeUndefined();
  });

  it('names only excludedJobs under the final-head unit when a pair names the sampled workflow', () => {
    const reading = readFinalHead(SAME_WORKFLOW_PAIR);

    expect(reading.metrics).toMatchObject({
      population_base_branch_verified: true,
      population_unverified: 'excludedJobs',
    });
    expect(finding(reading)?.message).toMatch(/excludedJobs/u);
    expect(finding(reading)?.message).not.toMatch(/baseBranch/u);
  });

  it('ignores a pair on another workflow under the final-head unit', () => {
    const reading = readFinalHead(OTHER_WORKFLOW_PAIR);

    expect(reading.metrics).toMatchObject({ population_unverified: '' });
    expect(finding(reading)).toBeUndefined();
  });

  it.each([
    ['omitted', {}],
    ['declared run', { outcomeUnit: 'run' }],
  ])('keeps the base branch unverified when the unit is %s', (_label, unit) => {
    const reading = readRuns(unit);

    expect(reading.metrics).toMatchObject({
      population_base_branch_verified: false,
      population_unverified: 'baseBranch',
    });
    expect(finding(reading)?.message).toMatch(/baseBranch/u);
  });

  it('lists baseBranch then excludedJobs under the run unit', () => {
    const reading = readRuns(SAME_WORKFLOW_PAIR);

    expect(reading.metrics).toMatchObject({
      population_base_branch_verified: false,
      population_unverified: 'baseBranch,excludedJobs',
    });
    expect(finding(reading)?.message).toMatch(/baseBranch.*excludedJobs/su);
  });

  it('leaves harness_performance reporting the unverified base branch', () => {
    const greens = greenPullRequests(2);
    stub(greens.runs, greens.pullRequests);

    const reading = senseHarnessPerformance({ ...POPULATION, repoRoot: '/repo', now: NOW });

    expect(reading.metrics).toMatchObject({
      population_base_branch_verified: false,
      population_unverified: 'baseBranch',
    });
    expect(finding(reading)?.message).toMatch(/baseBranch/u);
  });
});

describe('harness_green_main thresholds over pull-request outcomes (R-0703)', () => {
  function mix(green: number, red: number): void {
    const greens = greenPullRequests(green);
    const reds = redPullRequests(red);
    stub([...greens.runs, ...reds.runs], [...greens.pullRequests, ...reds.pullRequests]);
  }

  it.each([
    [19, 1, 'pass', 95],
    [20, 0, 'pass', 100],
    [18, 1, 'review', 94.74],
    [4, 1, 'review', 80],
    [79, 21, 'fail', 79],
    [3, 2, 'fail', 60],
  ] as const)('reads %i green and %i red as %s', (green, red, status, pct) => {
    mix(green, red);
    const reading = sense();
    expect(reading.status).toBe(status);
    expect(counted(reading)).toEqual({ total: green + red, green, pct });
  });
});
