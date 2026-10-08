import { spawnSync } from '@devai-nyx/authority';

/**
 * Shared `gh` CLI wrapper for Phase 28 harness sensors that need
 * GitHub Actions runtime data (28.G performance, 28.H robustness).
 * Implements the graceful-degradation contract from Phase 26.K's
 * harness_green_main: when `gh` is unavailable or auth fails, the
 * caller surfaces status='unknown' with an explicit reason code
 * rather than asserting a verdict it can't justify.
 */

export type GhResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly reason: string };

export interface GhInvokeOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export function invokeGhJson<T = unknown>(opts: GhInvokeOptions): GhResult<T> {
  const result = spawnSync('gh', [...opts.args], {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: opts.timeoutMs ?? 30_000,
  });
  if (result.error !== undefined) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { ok: false, reason: 'gh-cli-unavailable' };
    return { ok: false, reason: `gh-cli-error: ${err.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').slice(0, 256).trim();
    return { ok: false, reason: `gh-cli-nonzero-exit: ${stderr}` };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T };
  } catch (e) {
    return {
      ok: false,
      reason: `gh-cli-parse-error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * The CI population a harness sensor samples (ADR-SCR-0010), declared under
 * `harness_population_inputs` in .devai/config/sensor-inputs.json.
 */
export interface HarnessPopulation {
  /**
   * workflow, event, and minimumSample are required by the declaration schema. They are typed
   * optional so a caller that supplies no declared population (the check runner) reads
   * UNKNOWN with a diagnostic instead of an invented default population.
   */
  readonly workflow?: string;
  readonly event?: string;
  readonly headBranch?: string;
  readonly baseBranch?: string;
  readonly attempts?: 'last' | 'all';
  readonly includeCancelled?: boolean;
  readonly lookbackDays?: number;
  readonly minimumSample?: number;
  readonly excludedJobs?: readonly { readonly workflow: string; readonly job: string }[];
  /**
   * What one sampled outcome is (ADR-SCR-0014): each run (the default), or each pull request
   * judged by the latest completed run on its final head.
   */
  readonly outcomeUnit?: 'run' | 'pull-request-final-head';
}

export interface HarnessPopulationOptions extends HarnessPopulation {
  readonly repoRoot: string;
  readonly now?: string;
  readonly limit?: number;
}

/** A run row as `gh run list --json` returns it; only real gh run list fields. */
export interface HarnessRun {
  readonly attempt?: number;
  readonly conclusion?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly databaseId?: number;
  readonly event?: string;
  readonly headBranch?: string;
  readonly headSha?: string;
  readonly status?: string;
}

/** The real gh run list fields the harness sensors request. */
export const HARNESS_RUN_FIELDS =
  'attempt,conclusion,createdAt,databaseId,event,headBranch,updatedAt';
/** The run fields of the final-head population, which also needs each run's sha and status. */
export const HARNESS_GREEN_MAIN_RUN_FIELDS =
  'attempt,conclusion,createdAt,databaseId,event,headBranch,headSha,status,updatedAt';

/** A pull request row as `gh pr list --json` returns it; only real gh pr list fields. */
export interface HarnessPullRequest {
  readonly closedAt?: string | null;
  readonly headRefName?: string;
  readonly headRefOid?: string;
  readonly mergedAt?: string | null;
  readonly number?: number;
  readonly state?: string;
}

/** The exact gh pr list argv of the final-head population (ADR-SCR-0014). */
export const HARNESS_PULL_REQUEST_LIST_ARGS = [
  'pr',
  'list',
  '--state',
  'all',
  '--limit',
  '1000',
  '--json',
  'closedAt,headRefName,headRefOid,mergedAt,number,state',
] as const;

const DAY_MS = 86_400_000;
const DEFAULT_RUN_LIMIT = 300;

export interface PopulationMetrics {
  readonly [key: string]: number | string | boolean;
}

export interface PopulationFinding {
  readonly severity: 'info';
  readonly code: string;
  readonly message: string;
}

export type PopulationSample =
  | { readonly ok: false; readonly reason: string; readonly args: readonly string[] }
  | {
      readonly ok: true;
      readonly args: readonly string[];
      /** Runs inside the declared population, after every row filter. */
      readonly runs: readonly HarnessRun[];
      readonly minimum: number;
      /** The population metrics (without sample_size, which the sensor owns). */
      readonly metrics: PopulationMetrics;
      readonly unverifiedFinding: PopulationFinding;
      readonly describe: string;
    };

/**
 * Reads the declared population through the admitted gh run list shape and applies the row
 * filters gh cannot: event and literal head branch re-checks, lookback, cancelled, and last
 * attempt. Base branch and a same-workflow excluded job pair cannot be verified from gh run
 * list rows and are reported as unverified, never filtered on.
 */
export function samplePopulation(
  opts: HarnessPopulationOptions,
  fields: string = HARNESS_RUN_FIELDS,
): PopulationSample {
  const { workflow, event, minimumSample } = opts;
  if (workflow === undefined || event === undefined || minimumSample === undefined) {
    return {
      ok: false,
      reason:
        'harness-population-undeclared: workflow, event, and minimumSample are required (ADR-SCR-0010)',
      args: [],
    };
  }
  const headBranch = opts.headBranch ?? '*';
  const baseBranch = opts.baseBranch ?? 'main';
  const attempts = opts.attempts ?? 'last';
  const includeCancelled = opts.includeCancelled ?? false;
  const lookbackDays = opts.lookbackDays ?? 30;
  const nowMs = opts.now === undefined ? Date.now() : Date.parse(opts.now);
  const cutoffMs = nowMs - lookbackDays * DAY_MS;
  const created = new Date(cutoffMs).toISOString().slice(0, 10);

  const args = ['run', 'list', '--workflow', workflow, '--event', event];
  if (headBranch !== '*') args.push('--branch', headBranch);
  args.push(
    '--json',
    fields,
    '--limit',
    String(opts.limit ?? DEFAULT_RUN_LIMIT),
    '--created',
    `>=${created}`,
  );
  const result = invokeGhJson<HarnessRun[]>({ cwd: opts.repoRoot, args });
  if (!result.ok) return { ok: false, reason: result.reason, args };

  let runs = result.data.filter(
    (run) =>
      run.event === event &&
      (headBranch === '*' || run.headBranch === headBranch) &&
      run.createdAt !== undefined &&
      Date.parse(run.createdAt) >= cutoffMs,
  );
  if (attempts === 'last') {
    const best = new Map<number, HarnessRun>();
    const unkeyed: HarnessRun[] = [];
    for (const run of runs) {
      if (run.databaseId === undefined) {
        unkeyed.push(run);
        continue;
      }
      const held = best.get(run.databaseId);
      if (held === undefined || (run.attempt ?? 1) > (held.attempt ?? 1)) {
        best.set(run.databaseId, run);
      }
    }
    runs = [...best.values(), ...unkeyed];
  }
  if (!includeCancelled) runs = runs.filter((run) => run.conclusion !== 'cancelled');

  const sameWorkflowPairs = (opts.excludedJobs ?? []).filter(
    (pair) => pair.workflow === workflow,
  ).length;
  const unverified = ['baseBranch', ...(sameWorkflowPairs > 0 ? ['excludedJobs'] : [])];
  const unverifiedDetail = [
    `baseBranch ${baseBranch} (gh run list rows carry no base branch)`,
    ...(sameWorkflowPairs > 0
      ? [`excludedJobs ${String(sameWorkflowPairs)} pair(s) of ${workflow} (rows carry no jobs)`]
      : []),
  ];
  return {
    ok: true,
    args,
    runs,
    minimum: minimumSample,
    describe: `workflow ${workflow}, event ${event}, head branch ${headBranch}`,
    metrics: {
      minimum_sample: minimumSample,
      population_workflow: workflow,
      population_event: event,
      population_head_branch: headBranch,
      population_base_branch: baseBranch,
      population_attempts: attempts,
      population_include_cancelled: includeCancelled,
      population_lookback_days: lookbackDays,
      population_base_branch_verified: false,
      population_excluded_jobs_unverified: sameWorkflowPairs,
      population_unverified: unverified.join(','),
    },
    unverifiedFinding: {
      severity: 'info',
      code: 'HARNESS_POPULATION_UNVERIFIED',
      message: `Population filters unverified, not applied to the sample: ${unverifiedDetail.join('; ')}.`,
    },
  };
}

/** The UNKNOWN finding for a sample below the declared minimum. */
export function insufficientSampleFinding(
  code: string,
  sampleSize: number,
  minimum: number,
  describe: string,
  unit: string,
): PopulationFinding {
  return {
    severity: 'info',
    code,
    message: `Sample size ${String(sampleSize)} ${unit} is below the minimum sample ${String(minimum)} for ${describe}. Verdict suppressed.`,
  };
}

/** One pull request's final head and the run that judges it, if any. */
export interface PullRequestFinal {
  readonly number: number;
  readonly state: string;
  readonly headSha: string;
  /** The latest completed, non-cancelled run on the final head; undefined when there is none. */
  readonly run: HarnessRun | undefined;
}

export type FinalHeadSample =
  | {
      readonly ok: false;
      /** Which read failed: the run list or the pull request list. */
      readonly source: 'run-list' | 'pr-list';
      readonly reason: string;
      readonly args: readonly string[];
    }
  | {
      readonly ok: true;
      readonly args: readonly string[];
      /** Counted pull requests: every closed or merged one, and open ones with a final run. */
      readonly finals: readonly PullRequestFinal[];
      /** Open pull requests whose final head has no completed run yet; never counted. */
      readonly pendingOpen: readonly number[];
      readonly minimum: number;
      readonly metrics: PopulationMetrics;
      readonly unverifiedFinding: PopulationFinding;
      readonly describe: string;
    };

/**
 * The final-head population (R-0703, ADR-SCR-0014): the declared gate runs of the window grouped
 * by pull request, each judged by the latest completed, non-cancelled run on the pull request's
 * final head (its current head when open, its head at merge when merged). Two gh calls: the
 * window's runs, and every pull request with its final head. A pull request is matched to its
 * runs by head branch and head sha. An open pull request whose final head has no completed run
 * is pending and never counted; a closed or merged one without such a run is counted and is not
 * green. A failed or unparseable pull request list is a failed sample, never a per-run fallback.
 */
export function sampleFinalHeads(opts: HarnessPopulationOptions): FinalHeadSample {
  const sample = samplePopulation(opts, HARNESS_GREEN_MAIN_RUN_FIELDS);
  if (!sample.ok) return { ...sample, source: 'run-list' };
  const prArgs = [...HARNESS_PULL_REQUEST_LIST_ARGS];
  const pulls = invokeGhJson<HarnessPullRequest[]>({ cwd: opts.repoRoot, args: prArgs });
  const args = [...sample.args, '&&', 'gh', ...prArgs];
  if (!pulls.ok) return { ok: false, source: 'pr-list', reason: pulls.reason, args };
  if (!Array.isArray(pulls.data)) {
    return { ok: false, source: 'pr-list', reason: 'gh-cli-parse-error: not an array', args };
  }

  // Completed runs that reached a verdict: never cancelled or skipped (ADR-SCR-0014).
  const completed = sample.runs.filter(
    (run) =>
      run.status === 'completed' &&
      run.conclusion !== undefined &&
      run.conclusion !== '' &&
      run.conclusion !== 'cancelled' &&
      run.conclusion !== 'skipped',
  );
  const branches = new Set(sample.runs.map((run) => run.headBranch));
  const finals: PullRequestFinal[] = [];
  const pendingOpen: number[] = [];
  for (const pull of pulls.data) {
    const { number, headRefName, headRefOid, state } = pull;
    if (number === undefined || headRefName === undefined || headRefOid === undefined) continue;
    if (!branches.has(headRefName)) continue;
    const run = completed
      .filter(
        (candidate) => candidate.headBranch === headRefName && candidate.headSha === headRefOid,
      )
      .sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''))[0];
    if (run === undefined && state === 'OPEN') {
      pendingOpen.push(number);
      continue;
    }
    finals.push({ number, state: state ?? 'UNKNOWN', headSha: headRefOid, run });
  }
  return {
    ok: true,
    args,
    finals,
    pendingOpen,
    minimum: sample.minimum,
    describe: `${sample.describe}, final head per pull request`,
    metrics: {
      ...sample.metrics,
      population_outcome_unit: 'pull-request-final-head',
      population_window_runs: sample.runs.length,
      population_pending_open: pendingOpen.length,
    },
    unverifiedFinding: sample.unverifiedFinding,
  };
}
