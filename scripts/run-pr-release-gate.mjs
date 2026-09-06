#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

const cli = join(root, '.devai/state/pr-bootstrap/cli/bin.js');
function invoke(args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DEVAI_FORMAT_BASE: base },
  });
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    /* reported below */
  }
  if (!output?.result?.value)
    throw new Error(`PR_GATE_CLI_FAILED:${result.status}:${result.stderr}:${result.stdout}`);
  return { report: output.result.value, status: result.status };
}
// Materialize the existing local authority binding through its approved boundary.
invoke(['init', 'bind', '--target', root, '--as-role', 'architect', '--write']);
function run(options) {
  const args = ['check', '--run', '--as-role', 'inspector', '--write', '--base', base];
  if (options.target === 'affected') args.push('--affected');
  else {
    const intentPath = join(root, '.devai/state/pr-bootstrap/release-intent.json');
    writeFileSync(intentPath, JSON.stringify(options.releaseIntent));
    args.push(
      '--release-intent',
      intentPath,
      '--release-profile',
      join(root, 'law/policy/release-verification.json'),
      '--release-stage',
      'preflight',
    );
  }
  const { report, status } = invoke(args);
  process.stdout.write(
    `${JSON.stringify({ nonAttesting: true, tasks: report.execution, exitCode: report.exitCode })}\n`,
  );
  return report.exitCode || status;
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
