#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCheckTasks } from '../packages/cli/dist/services/check-runner/index.js';

const root = resolve(import.meta.dirname, '..');
const base = process.argv.slice(2).find((argument) => argument !== '--');
if (!/^[a-f0-9]{40}$/u.test(base ?? '')) throw new Error('PR_RELEASE_GATE_BASE_INVALID');

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function packageVersionAt(commit) {
  return JSON.parse(git(['show', `${commit}:packages/cli/package.json`])).version;
}

function changedPathsBetween(baseCommit, candidateCommit) {
  const fields = execFileSync(
    'git',
    ['diff', '--name-status', '-z', '-M', '--find-renames', baseCommit, candidateCommit],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  const paths = new Set();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const before = fields[index++];
    if (status === undefined || before === undefined) {
      throw new Error('PR_RELEASE_GATE_CHANGED_PATHS_INVALID');
    }
    paths.add(before);
    if (status.startsWith('R') || status.startsWith('C')) {
      const after = fields[index++];
      if (after === undefined) throw new Error('PR_RELEASE_GATE_CHANGED_PATHS_INVALID');
      paths.add(after);
    }
  }
  return [...paths].sort();
}

const candidateCommit = git(['rev-parse', 'HEAD^{commit}']);
const candidateTree = git(['rev-parse', 'HEAD^{tree}']);
const baseTree = git(['rev-parse', `${base}^{tree}`]);
const currentVersion = packageVersionAt(base);
const targetVersion = JSON.parse(
  readFileSync(join(root, 'packages/cli/package.json'), 'utf8'),
).version;
const changedPaths = changedPathsBetween(base, candidateCommit);

function executeTask(argv, cwd, timeout, environment) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    timeout,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { errorCode: result.error.code } : {}),
  };
}
function run(options) {
  const report = runCheckTasks({
    repoRoot: root,
    baseCommit: base,
    operation: 'execute',
    environment: { DEVAI_FORMAT_BASE: base },
    executeTask,
    ...options,
  });
  // No candidate receipt or protected artifact is exposed by PR orchestration.
  process.stdout.write(
    `${JSON.stringify({
      nonAttesting: true,
      tasks: report.execution,
      exitCode: report.exitCode,
    })}\n`,
  );
  return report.exitCode;
}
if (currentVersion === targetVersion) process.exit(run({ target: 'affected' }));

const risks = new Set();
for (const path of changedPaths) {
  if (
    /^(?:\.github\/workflows\/release\.yml|scripts\/(?:check-publishable|create-release|release-|stage-release)|packages\/cli\/src\/services\/(?:check-runner|release-))/u.test(
      path,
    )
  ) {
    risks.add('release-integrity');
  }
  if (
    /^(?:test-tasks\.json|tests\/config\/|law\/(?:policy|schemas)\/|packages\/cli\/src\/services\/mutation-)/u.test(
      path,
    )
  ) {
    risks.add('test-policy');
  }
  if (/^(?:packages\/cli\/package\.json|packages\/cli\/src\/)/u.test(path)) risks.add('public-api');
  if (path === 'pnpm-lock.yaml') risks.add('lockfile');
  if (/^(?:package\.json|pnpm-lock\.yaml|tsconfig)/u.test(path)) risks.add('toolchain');
}
const documentationOnly = changedPaths.every((path) =>
  /^(?:docs\/|README\.md$|CHANGELOG\.md$)/u.test(path),
);
const metadataOnly = changedPaths.every((path) =>
  /(?:^|\/)(?:package\.json|[^/]+\.md)$/u.test(path),
);
const intent = {
  schemaVersion: '1.0.0',
  release_unit: '@aarusso-nyx/devai',
  current_version: currentVersion,
  target_version: targetVersion,
  support: 'current',
  change_kind: documentationOnly ? 'documentation' : metadataOnly ? 'metadata' : 'behavioral',
  changed_paths: changedPaths,
  changed_packages: [],
  risks: [...risks].sort(),
  candidate: { commit: candidateCommit, tree: candidateTree },
  base: { commit: base, tree: baseTree },
};
const preflight = run({
  target: 'release',
  releaseIntent: intent,
  releaseProfile: JSON.parse(
    readFileSync(join(root, 'law/policy/release-verification.json'), 'utf8'),
  ),
  releaseStage: 'preflight',
});
// Profile preflight establishes the floor; affected selection runs afterwards
// against the same cache and reuses only exact matching keys.
const affected = run({ target: 'affected' });
process.exitCode = preflight || affected;
