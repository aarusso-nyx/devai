#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
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
process.stdout.write('repository hooks: .githooks\n');
