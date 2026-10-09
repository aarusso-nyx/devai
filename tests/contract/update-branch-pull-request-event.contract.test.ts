// ADR-CHK-0008 IA-010 (2026-10-09 amendment): on pull_request_target opened, reopened, or
// ready_for_review, the update workflow from the base branch rebases only that pull request,
// when it comes from this repository, is not a draft, and is behind main. A fork or draft pull
// request skips the job before any credential is read, and no step checks out or runs
// pull-request content. The push-to-main path is unchanged. The committed workflow is read
// under a chosen event context: its job `if` and concurrency group are evaluated with the
// expression semantics GitHub documents, and its rebase script runs under bash with the step's
// own env and a stub `gh` on PATH.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  condition,
  type ExpressionValue,
  interpolate,
  render,
  evaluate,
} from '../helpers/workflow-expression.js';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOW = join(ROOT, '.github/workflows/update-pull-request-branches.yml');
const JOB = 'update-branches';
const REPOSITORY = 'example/devai';
const MAIN_SHA = 'f'.repeat(40);
const ACTIONS = ['opened', 'reopened', 'ready_for_review'] as const;

type Step = Readonly<{
  id?: string;
  uses?: string;
  run?: string;
  if?: unknown;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}>;
type Concurrency = Readonly<{ group?: unknown; 'cancel-in-progress'?: unknown }>;
type Job = Readonly<{ if?: unknown; steps: Step[]; concurrency?: Concurrency }>;
const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as {
  name: string;
  on: Record<string, Record<string, unknown> | null>;
  concurrency?: Concurrency;
  jobs: Record<string, Job>;
};
const job = workflow.jobs[JOB] as Job;
const steps = job.steps;
const rebase = steps.find((step) => step.id === 'rebase');

interface PullRequest {
  readonly number: number;
  readonly head: string;
  readonly headRepository: string;
  readonly draft: boolean;
}

const SAME_REPOSITORY: PullRequest = {
  number: 7,
  head: 'ddd4444',
  headRepository: REPOSITORY,
  draft: false,
};

function context(
  github: Record<string, ExpressionValue>,
  runnerTemp = '/tmp/runner',
): Record<string, ExpressionValue> {
  return {
    github: {
      workflow: workflow.name,
      repository: REPOSITORY,
      sha: MAIN_SHA,
      token: 'workflow-token',
      ...github,
    },
    secrets: {
      DEVAI_UPDATE_BRANCH_APP_ID: '5243994',
      DEVAI_UPDATE_BRANCH_APP_PRIVATE_KEY: 'stub-key',
      GITHUB_TOKEN: 'workflow-token',
    },
    steps: {
      credentials: { outputs: { present: 'true' } },
      'app-token': { outputs: { token: 'stub-token' } },
    },
    env: {},
    vars: {},
    runner: { temp: runnerTemp, os: 'Linux' },
    job: {},
    inputs: {},
  };
}

function pullRequestEvent(action: string, pr: PullRequest, runnerTemp?: string) {
  const pullRequest = {
    number: pr.number,
    draft: pr.draft,
    state: 'open',
    title: '$(touch /tmp/devai-pwned) "quoted"',
    head: {
      sha: pr.head,
      ref: 'feature/$(id)',
      repo: { full_name: pr.headRepository, fork: pr.headRepository !== REPOSITORY },
    },
    base: { sha: MAIN_SHA, ref: 'main', repo: { full_name: REPOSITORY } },
  };
  return context(
    {
      event_name: 'pull_request_target',
      ref: 'refs/heads/main',
      base_ref: 'main',
      head_ref: 'feature/$(id)',
      event: { action, number: pr.number, pull_request: pullRequest },
    },
    runnerTemp,
  );
}

function pushEvent(runnerTemp?: string) {
  return context(
    {
      event_name: 'push',
      ref: 'refs/heads/main',
      base_ref: '',
      head_ref: '',
      event: { ref: 'refs/heads/main', after: MAIN_SHA, before: 'e'.repeat(40) },
    },
    runnerTemp,
  );
}

function concurrency(): Concurrency {
  const declared = workflow.concurrency ?? job.concurrency;
  if (declared === undefined) throw new Error('the update workflow declares no concurrency');
  return declared;
}

function group(ctx: Record<string, ExpressionValue>): string {
  return interpolate(String(concurrency().group), ctx);
}

function cancels(ctx: Record<string, ExpressionValue>): boolean {
  return condition(concurrency()['cancel-in-progress'], ctx);
}

/** The stand-in `gh`: logs each call, lists three pull requests, and accepts each update. */
const STUB_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  *"/pulls?state=open"*)
    printf '1\\taaa1111\\n2\\tbbb2222\\n3\\tccc3333\\n'
    ;;
  *"/compare/"*)
    echo "$STUB_BEHIND"
    ;;
  *"--method PUT"*"/update-branch"*)
    echo '{}'
    ;;
  *)
    echo "stub gh: unexpected call: $*" >&2
    exit 2
    ;;
esac
`;

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

/** Runs the committed rebase script with the env its step declares, resolved under `ctx`. */
function runRebase(
  event: (runnerTemp: string) => Record<string, ExpressionValue>,
  behind = '2',
): { status: number | null; output: string; calls: string } {
  expect(rebase?.run, 'the workflow has a rebase step with a run script').toBeDefined();
  const dir = mkdtempSync(join(tmpdir(), 'devai-update-branch-event-'));
  roots.push(dir);
  const bin = join(dir, 'bin');
  const runnerTemp = join(dir, 'runner-temp');
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  writeFileSync(join(bin, 'gh'), STUB_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'summary.md'), '');
  const ctx = event(runnerTemp);
  const stepEnv = Object.fromEntries(
    Object.entries(rebase?.env ?? {}).map(([key, value]) => [key, interpolate(String(value), ctx)]),
  );
  const result = spawnSync('bash', ['-c', rebase?.run ?? 'exit 99'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: runnerTemp,
      GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
      GITHUB_OUTPUT: join(dir, 'output'),
      GITHUB_EVENT_NAME: render((ctx.github as Record<string, ExpressionValue>).event_name ?? null),
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_SHA: MAIN_SHA,
      STUB_LOG: log,
      STUB_BEHIND: behind,
      ...stepEnv,
    },
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: readFileSync(log, 'utf8'),
  };
}

const updates = (calls: string): string[] =>
  calls.split('\n').filter((line) => /--method PUT .*\/update-branch/u.test(line));

describe('update-branch on a pull request event: triggers and isolation (ADR-CHK-0008 IA-010)', () => {
  it('runs on push to main and on pull_request_target opened, reopened, ready_for_review against main', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request_target', 'push']);
    expect(workflow.on).not.toHaveProperty('pull_request');
    expect(workflow.on.push).toEqual({ branches: ['main'] });
    const target = workflow.on.pull_request_target ?? {};
    expect([...((target.types as string[] | undefined) ?? [])].sort()).toEqual([...ACTIONS].sort());
    expect(target.branches).toEqual(['main']);
    expect(target).not.toHaveProperty('paths');
    expect(target).not.toHaveProperty('paths-ignore');
  });

  it('never checks out or runs pull-request content', () => {
    const used = steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses]));
    // The App token action is the only action, and nothing checks out a ref.
    expect(used).toHaveLength(1);
    expect(used[0]).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}$/u);
    for (const step of steps) {
      expect(step.uses ?? '').not.toMatch(/checkout|^\.\//u);
      // No expression is expanded into script text: event values reach a script only
      // through env, so a crafted title or branch name is never parsed as shell.
      expect(step.run ?? '', `step ${step.id ?? '?'} interpolates into its script`).not.toMatch(
        /\$\{\{/u,
      );
      expect(step.run ?? '').not.toMatch(/\bgit\s+(?:clone|fetch|checkout|pull)\b/u);
    }
  });

  it.each(ACTIONS)('runs the job for a same-repository, ready pull request %s', (action) => {
    expect(condition(job.if, pullRequestEvent(action, SAME_REPOSITORY))).toBe(true);
  });

  it.each(ACTIONS)(
    'skips the job, before any credential step, for a fork pull request %s',
    (action) => {
      const fork = { ...SAME_REPOSITORY, headRepository: 'someone/devai' };
      expect(job.if, 'the guard is on the job, ahead of the credentials probe').toBeDefined();
      expect(condition(job.if, pullRequestEvent(action, fork))).toBe(false);
    },
  );

  it.each(ACTIONS)(
    'skips the job, before any credential step, for a draft pull request %s',
    (action) => {
      const draft = { ...SAME_REPOSITORY, draft: true };
      expect(condition(job.if, pullRequestEvent(action, draft))).toBe(false);
    },
  );

  it('skips a draft fork too, and still runs on every push to main', () => {
    const draftFork = { ...SAME_REPOSITORY, draft: true, headRepository: 'someone/devai' };
    expect(condition(job.if, pullRequestEvent('opened', draftFork))).toBe(false);
    expect(condition(job.if, pushEvent())).toBe(true);
  });

  it('reads the App secrets only in the probe and the token mint, behind the job guard', () => {
    const reading = steps
      .filter((step) => JSON.stringify(step).includes('secrets.'))
      .map((step) => step.id);
    expect(reading.sort()).toEqual(['app-token', 'credentials']);
  });
});

describe('update-branch on a pull request event: per-pull-request superseding lock (IA-009, IA-010)', () => {
  it('keys a pull request event by that pull request, never by the base ref', () => {
    const seven = group(pullRequestEvent('opened', SAME_REPOSITORY));
    for (const action of ACTIONS) {
      expect(group(pullRequestEvent(action, SAME_REPOSITORY))).toBe(seven);
      expect(cancels(pullRequestEvent(action, SAME_REPOSITORY))).toBe(true);
    }
    expect(seven).toContain(workflow.name);
    expect(seven).toMatch(/\b7\b/u);
    expect(group(pullRequestEvent('opened', { ...SAME_REPOSITORY, number: 8 }))).not.toBe(seven);
    expect(seven).not.toBe(group(pushEvent()));
  });

  it('keeps the push lock keyed by workflow and ref, superseding', () => {
    const push = group(pushEvent());
    expect(push).toContain(workflow.name);
    expect(push).toContain('refs/heads/main');
    expect(cancels(pushEvent())).toBe(true);
    // A push to another ref, were the trigger widened, would not share the main lock.
    const base = pushEvent();
    const other = {
      ...base,
      github: { ...(base.github as Record<string, ExpressionValue>), ref: 'refs/heads/release' },
    };
    expect(group(other)).not.toBe(push);
  });

  it('evaluates the documented conditional key the same way', () => {
    // The evaluator's own reading of the accepted IA-009 form, so a passing group above
    // is not an artifact of the evaluator.
    const key =
      "${{ github.workflow }}-${{ github.event_name == 'pull_request_target' && format('pr-{0}', github.event.pull_request.number) || github.ref }}";
    expect(interpolate(key, pullRequestEvent('opened', SAME_REPOSITORY))).toBe(
      `${workflow.name}-pr-7`,
    );
    expect(interpolate(key, pushEvent())).toBe(`${workflow.name}-refs/heads/main`);
    expect(evaluate("format('pr-{0}', github.event.pull_request.number)", pushEvent())).toBe('pr-');
  });
});

describe('update-branch on a pull request event: the rebase touches only that pull request (IA-010)', () => {
  it.each(ACTIONS)(
    'rebases only the event pull request on %s, with its head as the expected head',
    (action) => {
      const { status, output, calls } = runRebase((temp) =>
        pullRequestEvent(action, SAME_REPOSITORY, temp),
      );
      expect(status, output).toBe(0);
      expect(calls).not.toMatch(/pulls\?state=open/u);
      expect(updates(calls)).toHaveLength(1);
      expect(updates(calls)[0]).toMatch(
        new RegExp(
          `--method PUT repos/${REPOSITORY}/pulls/7/update-branch .*update_method=rebase.*expected_head_sha=ddd4444`,
          'u',
        ),
      );
      expect(calls).toMatch(new RegExp(`compare/${MAIN_SHA}\\.\\.\\.ddd4444`, 'u'));
      // The crafted title and branch name never reached a command.
      expect(calls).not.toMatch(/devai-pwned|feature\//u);
    },
  );

  it('leaves the event pull request alone when it is not behind main', () => {
    const { status, output, calls } = runRebase(
      (temp) => pullRequestEvent('opened', SAME_REPOSITORY, temp),
      '0',
    );
    expect(status, output).toBe(0);
    expect(updates(calls)).toEqual([]);
    expect(output).toMatch(/#7\b.*up to date/u);
  });

  it('keeps the push path: every listed pull request behind main is rebased with its own head', () => {
    const { status, output, calls } = runRebase((temp) => pushEvent(temp));
    expect(status, output).toBe(0);
    expect(calls).toMatch(new RegExp(`repos/${REPOSITORY}/pulls\\?state=open&base=main`, 'u'));
    expect(updates(calls)).toHaveLength(3);
    for (const [number, head] of [
      ['1', 'aaa1111'],
      ['2', 'bbb2222'],
      ['3', 'ccc3333'],
    ] as const) {
      expect(calls).toMatch(
        new RegExp(
          `--method PUT repos/${REPOSITORY}/pulls/${number}/update-branch .*update_method=rebase.*expected_head_sha=${head}`,
          'u',
        ),
      );
    }
    expect(calls).not.toMatch(/pulls\/7\//u);
  });
});
