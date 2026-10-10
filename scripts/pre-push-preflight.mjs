#!/usr/bin/env node
// Opt-in pre-push preflight (ADR-CHK-0001, ADR-GOV-0018), run by .githooks/pre-push as
// `pre-push-preflight.mjs <remote> [<url>]` with the pushed refs on stdin, one per line:
// `<local ref> <local sha> <remote ref> <remote sha>`.
//
// Unless the worktree-scoped `git config --worktree --get devai.prePushPreflight` is exactly
// `true` it exits 0 with no output. Otherwise it fetches `<remote> main` into a temporary ref
// (deleted afterwards) as the base, never printing the remote unless it is a configured name.
// It refuses a push of any commit other than HEAD, then for every pushed ref that is not a
// deletion runs scripts/check-commit-range.mjs over base..<peeled commit>; any failure refuses the
// push before the affected check starts. It then runs the gate's affected check against the
// fetched base, with the CI gate's own flags, and on failure prints the per-node summary of
// scripts/process/summarize-check-report.mjs, so the failing node (and, for a BLOCKED probe,
// the environment fix) is named. Exit: 0 clean, 1 refused.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const BOOTSTRAP_CLI = '.devai/state/pr-bootstrap/cli/bin.js';
const BASE_BRANCH = 'main';
const ZERO = /^0+$/u;

function git(args, options = {}) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
}

function enabled() {
  const result = git(['config', '--worktree', '--get', 'devai.prePushPreflight']);
  return result.status === 0 && result.stdout.trim() === 'true';
}

function say(text) {
  process.stderr.write(`pre-push: ${text}\n`);
}

/** The configured remote name, or a fixed label: a push URL is never printed. */
function remoteLabel(remote) {
  const names = git(['remote'])
    .stdout.split('\n')
    .map((name) => name.trim());
  return names.includes(remote) ? remote : 'the push remote';
}

/** Relays a child's captured output to this process's streams. */
function relay(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function main(argv, readStdin) {
  if (!enabled()) return 0;
  const remote = argv[0];
  if (remote === undefined || remote === '') {
    say('usage: pre-push-preflight.mjs <remote> [<url>] < pushed refs');
    return 1;
  }
  const pushed = readStdin()
    .split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length === 4)
    .filter(([, localSha]) => !ZERO.test(localSha ?? ''));
  if (pushed.length === 0) return 0;

  // The affected check runs on the working tree, so it can vouch only for the checked-out
  // commit. Annotated tags name tag objects, so peel every pushed object to a commit
  // before comparing it to HEAD; non-commit objects fail closed before fetching.
  const resolvedHead = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const head = resolvedHead.stdout.trim();
  if (resolvedHead.status !== 0 || head === '') {
    say('could not resolve HEAD to a commit; the push is refused');
    return 1;
  }
  const commits = [];
  for (const [localRef, localSha] of pushed) {
    const resolved = git(['rev-parse', '--verify', '--end-of-options', `${localSha}^{commit}`]);
    const commit = resolved.stdout.trim();
    if (resolved.status !== 0 || commit === '') {
      say(`could not resolve ${localRef} to a commit; the push is refused`);
      return 1;
    }
    if (commit !== head) {
      say(
        `pre-push preflight checks the working tree; check out ${localRef} (or push HEAD) and retry`,
      );
      return 1;
    }
    commits.push([localRef, commit]);
  }

  const label = remoteLabel(remote);
  const baseRef = `refs/devai/pre-push/${String(process.pid)}-${randomBytes(6).toString('hex')}`;
  try {
    return preflight(remote, label, baseRef, commits);
  } finally {
    git(['update-ref', '-d', baseRef]);
  }
}

function preflight(remote, label, baseRef, pushed) {
  // git's own fetch output can carry the URL, so only the fixed message is printed.
  const fetched = git(['fetch', '--quiet', remote, `+refs/heads/${BASE_BRANCH}:${baseRef}`]);
  if (fetched.status !== 0) {
    say(`could not fetch ${BASE_BRANCH} from ${label}; fetch it and push again`);
    return 1;
  }
  const base = git(['rev-parse', '--verify', `${baseRef}^{commit}`]).stdout.trim();
  say(`base ${BASE_BRANCH} from ${label} ${base}`);

  for (const [localRef, localSha] of pushed) {
    const range = spawnSync(
      process.execPath,
      [join(root, 'scripts/check-commit-range.mjs'), base, localSha],
      { cwd: root, encoding: 'utf8' },
    );
    if (range.status !== 0) {
      relay(range);
      say(`commit range ${base}..${localSha} (${localRef}) fails; the push is refused`);
      return 1;
    }
  }

  if (!existsSync(join(root, BOOTSTRAP_CLI))) {
    say(`${BOOTSTRAP_CLI} is missing; running pnpm run release:bootstrap`);
    const bootstrap = spawnSync('pnpm', ['run', 'release:bootstrap'], {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (bootstrap.status !== 0) {
      say('pnpm run release:bootstrap failed; the push is refused');
      return 1;
    }
  }

  // The CI gate's affected invocation (.github/workflows/pull-request-checks.yml), without a
  // partition, so the local plan is the one both gate jobs split.
  const report = join(mkdtempSync(join(tmpdir(), 'devai-pre-push-')), 'report.json');
  const affected = spawnSync(
    process.execPath,
    [
      join(root, BOOTSTRAP_CLI),
      'check',
      '--affected',
      '--run',
      '--base',
      base,
      '--as-role',
      'inspector',
      '--write',
      '--format',
      'json',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(report, affected.stdout ?? '');
  if (affected.status !== 0) {
    if (affected.stderr) process.stderr.write(affected.stderr);
    const summary = spawnSync(
      process.execPath,
      [join(root, 'scripts/process/summarize-check-report.mjs'), report],
      { cwd: root, encoding: 'utf8' },
    );
    relay(summary);
    say(`check --affected --run failed (report ${report}); the push is refused`);
    return 1;
  }
  say('commit range and affected check passed');
  return 0;
}

process.exitCode = main(process.argv.slice(2), () =>
  process.stdin.isTTY ? '' : readFileSync(0, 'utf8'),
);
