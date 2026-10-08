#!/usr/bin/env node
// Opt-in pre-push preflight (ADR-CHK-0001, ADR-GOV-0018), run by .githooks/pre-push as
// `pre-push-preflight.mjs <remote> [<url>]` with the pushed refs on stdin, one per line:
// `<local ref> <local sha> <remote ref> <remote sha>`.
//
// Unless `git config --get devai.prePushPreflight` is exactly `true` it exits 0 with no output.
// Otherwise it fetches `<remote> main` as the base, then for every pushed ref that is not a
// deletion runs scripts/check-commit-range.mjs over base..<local sha>; any failure refuses the
// push before the affected check starts. It then runs the gate's affected check against the
// fetched base, with the CI gate's own flags, and on failure prints the per-node summary of
// scripts/process/summarize-check-report.mjs, so the failing node (and, for a BLOCKED probe,
// the environment fix) is named. Exit: 0 clean, 1 refused.

import { spawnSync } from 'node:child_process';
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
  const result = git(['config', '--get', 'devai.prePushPreflight']);
  return result.status === 0 && result.stdout.trim() === 'true';
}

function say(text) {
  process.stderr.write(`pre-push: ${text}\n`);
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

  const fetched = git(['fetch', '--quiet', remote, BASE_BRANCH]);
  if (fetched.status !== 0) {
    relay(fetched);
    say(`could not fetch ${remote} ${BASE_BRANCH}; fetch it and push again`);
    return 1;
  }
  const base = git(['rev-parse', '--verify', 'FETCH_HEAD']).stdout.trim();
  say(`base ${remote}/${BASE_BRANCH} ${base}`);

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
