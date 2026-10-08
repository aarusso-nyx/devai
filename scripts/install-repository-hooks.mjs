#!/usr/bin/env node

// Points this worktree's hooks at .githooks: commit-msg, pre-commit, and pre-push. The
// pre-push preflight (ADR-CHK-0001) stays inactive unless `--pre-push` opts this worktree in
// by setting the worktree config devai.prePushPreflight=true; without the flag that config is
// left exactly as it was.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const prePush = process.argv.slice(2).includes('--pre-push');
execFileSync('git', ['config', '--local', 'extensions.worktreeConfig', 'true'], {
  cwd: root,
  stdio: 'inherit',
});
try {
  execFileSync('git', ['config', '--local', '--unset', 'core.hooksPath'], {
    cwd: root,
    stdio: 'ignore',
  });
} catch {
  // Absence is the desired shared state.
}
execFileSync('git', ['config', '--worktree', 'core.hooksPath', '.githooks'], {
  cwd: root,
  stdio: 'inherit',
});
if (prePush) {
  execFileSync('git', ['config', '--worktree', 'devai.prePushPreflight', 'true'], {
    cwd: root,
    stdio: 'inherit',
  });
}
process.stdout.write(
  `repository hooks: .githooks${prePush ? ' (pre-push preflight enabled for this worktree)' : ''}\n`,
);
