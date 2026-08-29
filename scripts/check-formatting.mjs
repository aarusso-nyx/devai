#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const explicitBase = process.argv[2] ?? process.env.DEVAI_FORMAT_BASE;

function git(args, allowFailure = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    if (allowFailure) return '';
    throw new Error(`FORMAT_GIT_FAILED:${args.join(':')}`);
  }
  return String(result.stdout);
}

const files = new Set();
const addLines = (value) =>
  value
    .split('\n')
    .filter(Boolean)
    .forEach((path) => files.add(path));
addLines(git(['diff', '--name-only', '--diff-filter=ACMR']));
addLines(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']));
addLines(git(['ls-files', '--others', '--exclude-standard']));

let base = explicitBase;
if (base === undefined && files.size === 0) {
  base = git(['rev-parse', '--verify', 'HEAD^'], true).trim() || undefined;
}
if (base !== undefined) {
  const resolvedBase = git(['rev-parse', '--verify', `${base}^{commit}`]).trim();
  addLines(git(['diff', '--name-only', '--diff-filter=ACMR', resolvedBase, 'HEAD']));
}

const selected = [...files].sort();
if (selected.length === 0) {
  process.stdout.write('formatting: PASS (no changed files)\n');
  process.exit(0);
}
const result = spawnSync('pnpm', ['exec', 'prettier', '--check', '--ignore-unknown', ...selected], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write(`formatting: PASS (${String(selected.length)} changed files)\n`);
