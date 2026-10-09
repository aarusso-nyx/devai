// ADR-CHK-0008 IA-002 (#363 review): the update workflow's rebase loop reports a pull request
// it cannot judge or update and carries on with the others. The committed rebase script runs
// under bash with a stub `gh` on PATH that serves three same-repository pull requests and fails
// the compare call for the second; the first and third are still rebased, the second is
// reported, and the step ends successfully. The script reads the env its step declares,
// resolved under a push-to-main context, so the push path is pinned on every event shape the
// workflow accepts (IA-010 amendment).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type ExpressionValue, interpolate } from '../helpers/workflow-expression.js';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOW = join(ROOT, '.github/workflows/update-pull-request-branches.yml');

type Step = Readonly<{ id?: string; run?: string; env?: Record<string, unknown> }>;
const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as {
  name: string;
  jobs: Record<string, { steps: Step[] }>;
};
const STEP = Object.values(workflow.jobs)
  .flatMap((job) => job.steps)
  .find((step) => step.id === 'rebase');
const REBASE = STEP?.run;

/** A push to main: the step's declared env, resolved as the runner would. */
function pushEnv(runnerTemp: string): Record<string, string> {
  const context: Record<string, ExpressionValue> = {
    github: {
      workflow: workflow.name,
      event_name: 'push',
      ref: 'refs/heads/main',
      repository: 'example/devai',
      sha: 'f'.repeat(40),
      event: { ref: 'refs/heads/main', after: 'f'.repeat(40) },
    },
    steps: { 'app-token': { outputs: { token: 'stub-token' } } },
    secrets: {},
    env: {},
    vars: {},
    runner: { temp: runnerTemp },
  };
  return Object.fromEntries(
    Object.entries(STEP?.env ?? {}).map(([key, value]) => [
      key,
      interpolate(String(value), context),
    ]),
  );
}

/**
 * The stand-in `gh`: it logs each call, lists the pull requests the jq filter would keep,
 * fails the compare call for pull request 2, and accepts every update-branch request.
 */
const STUB_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  *"/pulls?state=open"*)
    printf '1\\taaa1111\\n2\\tbbb2222\\n3\\tccc3333\\n'
    ;;
  *"/compare/"*bbb2222*)
    echo 'HTTP 502: compare unavailable' >&2
    exit 1
    ;;
  *"/compare/"*)
    echo 2
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

describe('update-branch rebase loop (ADR-CHK-0008 IA-002)', () => {
  it('reports a pull request whose compare fails and still rebases the others', () => {
    expect(REBASE, 'the workflow has a rebase step with a run script').toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), 'devai-update-branch-loop-'));
    roots.push(dir);
    const bin = join(dir, 'bin');
    const runnerTemp = join(dir, 'runner-temp');
    mkdirSync(bin);
    mkdirSync(runnerTemp);
    writeFileSync(join(bin, 'gh'), STUB_GH);
    chmodSync(join(bin, 'gh'), 0o755);
    const summary = join(dir, 'summary.md');
    const log = join(dir, 'gh.log');
    writeFileSync(summary, '');
    writeFileSync(log, '');

    const result = spawnSync('bash', ['-c', REBASE ?? 'exit 99'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: runnerTemp,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: join(dir, 'output'),
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'example/devai',
        GITHUB_SHA: 'f'.repeat(40),
        ...pushEnv(runnerTemp),
        STUB_LOG: log,
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    const calls = readFileSync(log, 'utf8');

    expect(result.status, output).toBe(0);
    // Pull requests 1 and 3 were rebased with the rebase method and their exact heads.
    for (const [number, head] of [
      ['1', 'aaa1111'],
      ['3', 'ccc3333'],
    ] as const) {
      expect(calls).toMatch(
        new RegExp(
          `--method PUT repos/example/devai/pulls/${number}/update-branch .*update_method=rebase.*expected_head_sha=${head}`,
          'u',
        ),
      );
    }
    // Pull request 2 was never updated, and it was reported in the log and the summary.
    expect(calls).not.toMatch(/pulls\/2\/update-branch/u);
    expect(output).toMatch(/#2\b/u);
    expect(readFileSync(summary, 'utf8')).toMatch(/#2\b/u);
  });
});
