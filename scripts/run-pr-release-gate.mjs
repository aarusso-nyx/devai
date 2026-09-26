#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bumpFloorOverRange, loadGrammar } from './check-commit-range.mjs';
import { prFailureDiagnostics } from './pr-failure-diagnostics.mjs';
import { projectChangedPaths } from '../.devai/state/pr-bootstrap/cli/services/check-runner/policy.js';
import { selectorMatches } from '../.devai/state/pr-bootstrap/cli/services/check-runner/policy.js';

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
  return projectChangedPaths([...paths]);
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
  if (report.exitCode || status) {
    process.stdout.write(
      `${JSON.stringify({ nonAttesting: true, failures: prFailureDiagnostics(root, report.execution) })}\n`,
    );
  }
  return report.exitCode || status;
}

// Commit hygiene (ADR-GOV-0018): re-apply the grammar and the single-family
// rule over the first-parent range, catching commits that bypassed the hooks.
const rangeCheck = spawnSync(
  process.execPath,
  [join(root, 'scripts/check-commit-range.mjs'), base, candidateCommit],
  { cwd: root, encoding: 'utf8' },
);
process.stderr.write(`${rangeCheck.stdout}${rangeCheck.stderr}`);
if (rangeCheck.status !== 0) process.exit(rangeCheck.status ?? 1);

// Bump floor (ADR-REL-0027): the commit types in the range set the minimum
// manifest version delta. The table below restates ADR-REL-0027 and is used
// only when the repository carries no commit grammar policy.
const FLOOR_FALLBACK = {
  subject_pattern: '^[a-z]+(\\([a-z0-9-]+\\))?(!)?: .+$',
  breaking_marker: { marker: '!', bump: 'major' },
  types: Object.fromEntries(
    [
      ...[
        ['feat', 'minor'],
        ['fix', 'patch'],
        ['perf', 'patch'],
        ['refactor', 'patch'],
      ],
      ...['test', 'docs', 'ci', 'build', 'chore', 'law', 'spec', 'plan'].map((t) => [t, 'none']),
    ].map(([type, bump_floor]) => [type, { bump_floor }]),
  ),
};
const BUMP_RANK = { none: 0, patch: 1, minor: 2, major: 3 };
function versionDelta(from, to) {
  const core = (version) => version.split(/[-+]/u)[0].split('.').map(Number);
  const [a, b] = [core(from), core(to)];
  if (b[0] !== a[0]) return b[0] > a[0] ? 'major' : 'none';
  if (b[1] !== a[1]) return b[1] > a[1] ? 'minor' : 'none';
  return b[2] > a[2] ? 'patch' : 'none';
}
const bumpFloor = bumpFloorOverRange(
  root,
  loadGrammar(root) ?? FLOOR_FALLBACK,
  base,
  candidateCommit,
);
const bumpDelta = versionDelta(currentVersion, targetVersion);
// The floor binds a pull request that changes the manifest version: its delta
// must reach the floor of its own commits. A pull request that leaves the
// version alone records the floor as an obligation for the release rollover,
// which settles it against every commit since the last published version.
if (currentVersion === targetVersion) {
  process.stdout.write(
    `${JSON.stringify({ nonAttesting: true, bumpFloor, versionDelta: bumpDelta, obligation: true })}\n`,
  );
} else if (BUMP_RANK[bumpDelta] < BUMP_RANK[bumpFloor]) {
  // The release intent schema is closed, so the blocking reason is reported
  // beside it and the gate fails before any preflight work.
  process.stdout.write(
    `${JSON.stringify({
      nonAttesting: true,
      blockingReasons: [`bump-floor-${bumpFloor}`],
      bumpFloor,
      versionDelta: bumpDelta,
      current_version: currentVersion,
      target_version: targetVersion,
    })}\n`,
  );
  process.exit(1);
}

if (currentVersion === targetVersion) process.exit(run({ target: 'affected' }));

// Release intent derives from the change-class set of the changed paths
// (ADR-GOV-0017). The law policy declares the class vocabulary and the adopter
// binding assigns paths to classes; a path two bindings reach is a load error.
function readPolicyJson(candidates) {
  const path = candidates.find((candidate) => existsSync(join(root, candidate)));
  if (path === undefined) throw new Error(`PR_RELEASE_GATE_TAXONOMY_MISSING:${candidates[0]}`);
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}
const taxonomy = readPolicyJson([
  'law/policy/change-taxonomy.json',
  '.devai/config/change-taxonomy.json',
]);
const bindings = readPolicyJson([
  '.devai/config/change-taxonomy-binding.json',
  'law/policy/adopter-defaults/change-taxonomy-binding.json',
]).bindings;
for (const entry of bindings) {
  if (!Object.hasOwn(taxonomy.classes, entry.class)) {
    throw new Error(`CHANGE_TAXONOMY_CLASS_UNKNOWN:${entry.class}`);
  }
}
function classOf(path) {
  const hits = bindings.filter((entry) => selectorMatches(entry.selector, path));
  if (hits.length > 1) throw new Error(`CHANGE_TAXONOMY_BINDING_OVERLAP:${path}`);
  return hits[0]?.class ?? null;
}
const classified = changedPaths.map((path) => ({ path, changeClass: classOf(path) }));
const classes = new Set(classified.map(({ changeClass }) => changeClass));
const METADATA_CLASSES = new Set(['plan', 'law', 'spec', 'docs', 'generated']);
const risks = new Set();
for (const { path, changeClass } of classified) {
  if (changeClass === 'ci') {
    risks.add('release-integrity');
    risks.add('test-policy');
  }
  if (changeClass === 'toolchain') {
    risks.add('toolchain');
    if (path === 'pnpm-lock.yaml') risks.add('lockfile');
  }
  if (
    (changeClass === 'law' || changeClass === 'spec') &&
    (path.startsWith('law/policy/') || path.startsWith('law/schemas/'))
  ) {
    risks.add('test-policy');
  }
  if (changeClass === 'code' && path.startsWith('packages/cli/')) risks.add('public-api');
}
const documentationOnly = [...classes].every((changeClass) => changeClass === 'docs');
const metadataOnly =
  [...classes].every((changeClass) => METADATA_CLASSES.has(changeClass)) &&
  !changedPaths.includes('law/policy/action-registry.json');
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
