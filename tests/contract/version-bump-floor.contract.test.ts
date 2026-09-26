// ADR-REL-0027, Inspector Adversarial Acceptance IA-001 and IA-002: the
// pull-request gate computes the minimum version bump over the first-parent
// range from the commit grammar (feat -> minor, fix/perf/refactor -> patch, a
// breaking marker -> major) and blocks a candidate whose manifest version
// delta falls below that floor. Reused pattern: this copies (does not import)
// the disposable-repository and stub-bootstrap helpers from
// tests/contract/pr-release-intent-classes.contract.test.ts, because that file
// does not export them.
//
// scripts/run-pr-release-gate.mjs has no bump-floor computation yet: it only
// derives change_kind/risks from changed paths and never reads commit
// messages, so every case here is red. The "blocks" cases are red because the
// gate exits 0 and reports no `blocking-reasons`. The "passes" cases already
// pass today (nothing blocks them) since no enforcement exists yet.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve('.');
const COPIED_FILES = [
  'law/policy/change-taxonomy.json',
  'law/policy/adopter-defaults/change-taxonomy-binding.json',
  'law/policy/release-verification.json',
  '.devai/config/change-taxonomy.json',
  '.devai/config/change-taxonomy-binding.json',
] as const;
const BOOTSTRAP = '.devai/state/pr-bootstrap';
const INTENT_PATH = `${BOOTSTRAP}/release-intent.json`;

// Mirrors projectChangedPaths and selectorMatches in
// packages/cli/src/services/check-runner/policy.ts for the stubbed bootstrap.
const STUB_POLICY = `const HARNESS = ['.devai/state/', 'record/', 'scratch/'];
export function projectChangedPaths(paths) {
  return [...new Set(paths)].filter((path) => !HARNESS.some((prefix) => path.startsWith(prefix))).sort();
}
function globExpression(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/';
      expression += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[|\\\\{}()[\\]^$+?.]/gu, '\\\\$&');
  }
  return new RegExp(expression + '$', 'u');
}
export function selectorMatches(selector, path) {
  if (selector.kind === 'exact') return path === selector.pattern;
  if (selector.kind === 'prefix') return path.startsWith(selector.pattern);
  return globExpression(selector.pattern).test(path);
}
`;
const STUB_CLI = `process.stdout.write(JSON.stringify({ result: { value: { exitCode: 0, execution: [] } } }));\n`;

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

function cliPackage(version: string): string {
  return `${JSON.stringify({ name: '@aarusso-nyx/devai', version })}\n`;
}

interface Scenario {
  readonly baseVersion: string;
  readonly commitMessage: string;
  readonly changedPath: string;
  readonly changedContent: string;
  readonly targetVersion: string;
}

interface GateRun {
  readonly status: number;
  readonly output: string;
  readonly intent: Record<string, unknown> | undefined;
}

/** Commit one change on top of a base, bump the manifest in the worktree only, run the gate. */
function runGate(scenario: Scenario): GateRun {
  const root = mkdtempSync(join(tmpdir(), 'devai-version-bump-floor-'));
  roots.push(root);
  const git = (args: readonly string[]) => execFileSyncTrimmed(root, args);
  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  cpSync(join(REPOSITORY_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  for (const path of COPIED_FILES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, path), join(root, path));
  }
  put(root, '.gitignore', '.devai/state/\n');
  put(root, 'packages/cli/package.json', cliPackage(scenario.baseVersion));
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);

  put(root, scenario.changedPath, scenario.changedContent);
  git(['add', '-A']);
  git(['commit', '-qm', scenario.commitMessage]);

  // The gate reads the target version from the worktree and the current
  // version from the base commit; leaving the bump uncommitted keeps it out
  // of the changed-path population so each diff stays within one class.
  put(root, 'packages/cli/package.json', cliPackage(scenario.targetVersion));
  put(root, `${BOOTSTRAP}/package.json`, '{"type":"module"}\n');
  put(root, `${BOOTSTRAP}/cli/services/check-runner/policy.js`, STUB_POLICY);
  put(root, `${BOOTSTRAP}/cli/bin.js`, STUB_CLI);

  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/run-pr-release-gate.mjs'), base],
    { cwd: root, encoding: 'utf8' },
  );
  const intentFile = join(root, INTENT_PATH);
  const intent = existsSync(intentFile)
    ? (JSON.parse(readFileSync(intentFile, 'utf8')) as Record<string, unknown>)
    : undefined;
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${intent === undefined ? '' : JSON.stringify(intent)}`,
    intent,
  };
}

function execFileSyncTrimmed(cwd: string, args: readonly string[]): string {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
}

describe('version bump floor (ADR-REL-0027)', () => {
  it('blocks a feat commit whose candidate version is only a patch above base (bump-floor-minor)', () => {
    const run = runGate({
      baseVersion: '1.5.6',
      commitMessage: 'feat: add fixture capability',
      changedPath: 'packages/cli/src/services/fixture.ts',
      changedContent: 'export const fixture = 1;\n',
      targetVersion: '1.5.7',
    });

    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain('bump-floor-minor');
  });

  it('passes a feat commit whose candidate version is a minor bump above base', () => {
    const run = runGate({
      baseVersion: '1.5.6',
      commitMessage: 'feat: add fixture capability',
      changedPath: 'packages/cli/src/services/fixture.ts',
      changedContent: 'export const fixture = 1;\n',
      targetVersion: '1.6.0',
    });

    expect(run.status, run.output).toBe(0);
  });

  it('blocks a breaking-marker commit whose candidate version is only a minor bump (bump-floor-major)', () => {
    const run = runGate({
      baseVersion: '1.5.6',
      commitMessage: 'feat!: add breaking fixture capability',
      changedPath: 'packages/cli/src/services/fixture.ts',
      changedContent: 'export const fixture = 1;\n',
      targetVersion: '1.6.0',
    });

    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain('bump-floor-major');
  });

  it('passes a docs-only commit with no version bump', () => {
    const run = runGate({
      baseVersion: '1.5.6',
      commitMessage: 'docs: update the fixture guide',
      changedPath: 'docs/guide/fixture.md',
      changedContent: '# Fixture\n',
      targetVersion: '1.5.6',
    });

    expect(run.status, run.output).toBe(0);
  });
});
