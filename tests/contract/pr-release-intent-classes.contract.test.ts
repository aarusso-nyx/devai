// ADR-GOV-0017, Inspector Adversarial Acceptance IA-003: the pull-request gate
// derives the release intent's change kind and risks from the change-class set
// of the changed paths instead of from inline regular expressions. The gate
// script runs unmodified in a temporary repository; the pre-built bootstrap CLI
// it shells out to is replaced by a stub that only acknowledges the call, and
// the intent is read from the file the gate writes before invoking the CLI.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
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

interface ReleaseIntent {
  readonly change_kind: string;
  readonly changed_paths: readonly string[];
  readonly risks: readonly string[];
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

function cliPackage(version: string): string {
  return `${JSON.stringify({ name: '@aarusso-nyx/devai', version })}\n`;
}

/** Commit the changed paths on top of a base, bump the CLI version in the worktree only, run the gate. */
function deriveIntent(changed: Readonly<Record<string, string>>): ReleaseIntent {
  const root = mkdtempSync(join(tmpdir(), 'devai-pr-intent-classes-'));
  roots.push(root);
  const git = (args: readonly string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  cpSync(join(REPOSITORY_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  for (const path of COPIED_FILES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, path), join(root, path));
  }
  put(root, '.gitignore', '.devai/state/\n');
  put(root, 'packages/cli/package.json', cliPackage('1.0.0'));
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  for (const [path, content] of Object.entries(changed)) put(root, path, content);
  git(['add', '-A']);
  git(['commit', '-qm', 'candidate']);
  // The gate reads the target version from the worktree and the current
  // version from the base commit; leaving the bump uncommitted keeps it out
  // of the changed-path population so each diff stays within one class.
  put(root, 'packages/cli/package.json', cliPackage('1.0.1'));
  put(root, `${BOOTSTRAP}/package.json`, '{"type":"module"}\n');
  put(root, `${BOOTSTRAP}/cli/services/check-runner/policy.js`, STUB_POLICY);
  put(root, `${BOOTSTRAP}/cli/bin.js`, STUB_CLI);
  execFileSync(process.execPath, [join(root, 'scripts/run-pr-release-gate.mjs'), base], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const intent = JSON.parse(readFileSync(join(root, INTENT_PATH), 'utf8')) as ReleaseIntent;
  expect(intent.changed_paths).toEqual(Object.keys(changed).sort());
  return intent;
}

describe('release intent derived from change classes (ADR-GOV-0017)', () => {
  it('derives documentation for a docs-only diff', () => {
    const intent = deriveIntent({ 'docs/guide/usage.md': '# Usage\n' });
    expect(intent.change_kind).toBe('documentation');
  });

  it('derives metadata and no risk for a plan-only diff', () => {
    const intent = deriveIntent({
      'product/campaigns/CMP-9999-fixture/campaign.json': '{"id":"CMP-9999"}\n',
      'product/campaigns/CMP-9999-fixture/prompts/TASK-9999.md': '# Task\n',
    });
    expect(intent.change_kind).toBe('metadata');
    expect(intent.risks).toEqual([]);
  });

  it('derives metadata for a law-only diff without action registry changes', () => {
    const intent = deriveIntent({
      'law/adr/ADR-GOV-9999-fixture.md': '# Fixture decision\n',
      'law/policy/fixture-policy.json': '{"id":"fixture-policy"}\n',
    });
    expect(intent.change_kind).toBe('metadata');
  });

  it('derives behavioral for a code diff', () => {
    const intent = deriveIntent({
      'packages/cli/src/services/fixture.ts': 'export const fixture = 1;\n',
    });
    expect(intent.change_kind).toBe('behavioral');
  });

  it('derives release-integrity from a workflow diff', () => {
    const intent = deriveIntent({ '.github/workflows/ci.yml': 'name: ci\n' });
    expect(intent.change_kind).not.toBe('documentation');
    expect(intent.risks).toContain('release-integrity');
  });

  it('derives test-policy from a test task descriptor diff', () => {
    const intent = deriveIntent({ 'test-tasks.json': '{"schemaVersion":"1.0.0"}\n' });
    expect(intent.risks).toContain('test-policy');
  });
});
