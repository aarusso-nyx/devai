#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const candidateCommit = git(['rev-parse', 'HEAD^{commit}']);
const candidateTree = git(['rev-parse', 'HEAD^{tree}']);
const baseTree = git(['rev-parse', `${base}^{tree}`]);
const currentVersion = packageVersionAt(base);
const targetVersion = JSON.parse(
  readFileSync(join(root, 'packages/cli/package.json'), 'utf8'),
).version;
const changedPaths = git(['diff', '--name-only', `${base}..${candidateCommit}`])
  .split('\n')
  .filter(Boolean);

const cli = join(root, 'packages/cli/dist/runtime/index/bin.js');
const common = ['--repo-root', root, '--base', base, '--run', '--write', '--as-role', 'inspector'];
if (currentVersion === targetVersion) {
  const result = spawnSync(process.execPath, [cli, 'check', '--affected', ...common], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

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
const temporary = mkdtempSync(join(tmpdir(), 'devai-release-intent-'));
const intentPath = join(temporary, 'release-intent.json');
try {
  writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'check',
      '--release-intent',
      intentPath,
      '--release-profile',
      '.devai/config/release-verification.json',
      '--release-stage',
      'preflight',
      ...common,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
