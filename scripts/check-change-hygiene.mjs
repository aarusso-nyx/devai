#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const changed = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
  encoding: 'utf8',
});
if (changed.status !== 0) process.exit(changed.status ?? 1);
const files = changed.stdout.split('\n').filter(Boolean);
if (files.length === 0) process.exit(0);

run('pnpm', ['exec', 'prettier', '--check', '--ignore-unknown', ...files]);
const lintable = files.filter((file) => /\.[cm]?[jt]sx?$/u.test(file));
if (lintable.length > 0) {
  run('pnpm', ['exec', 'eslint', '--max-warnings=0', '--no-warn-ignored', ...lintable]);
}
run('pnpm', ['run', 'lint']);
run('pnpm', ['run', 'devai:prepare']);
run('pnpm', ['run', 'test:schemas']);
run('git', ['diff', '--cached', '--check']);
