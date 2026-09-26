// ADR-GOV-0018, Inspector Adversarial Acceptance IA-003 and IA-004: the
// pull-request range check re-applies the commit grammar and single-family
// rule over the first-parent range from base to candidate, so a mixed commit
// that bypassed the local pre-commit hook (`--no-verify`) is still caught. A
// merge commit and a revert of a single-family commit are exempt and pass.
//
// scripts/check-commit-range.mjs does not exist yet, so every case here is red:
// node reports a MODULE_NOT_FOUND error instead of classifying anything, which
// happens to exit non-zero (masking the "blocks" case) but never names the
// commit or reports success (which is why the "passes" cases fail cleanly).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve('.');
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'devai-commit-range-hygiene-'));
  roots.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Range test');
  git('config', 'user.email', 'range@example.invalid');

  mkdirSync(join(cwd, 'law/policy'), { recursive: true });
  mkdirSync(join(cwd, '.devai/config'), { recursive: true });
  execFileSync('cp', [
    join(root, 'law/policy/commit-grammar.json'),
    join(cwd, 'law/policy/commit-grammar.json'),
  ]);
  execFileSync('cp', [
    join(root, 'law/policy/change-taxonomy.json'),
    join(cwd, 'law/policy/change-taxonomy.json'),
  ]);
  execFileSync('cp', [
    join(root, '.devai/config/change-taxonomy-binding.json'),
    join(cwd, '.devai/config/change-taxonomy-binding.json'),
  ]);

  const put = (path: string, content: string) => {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };

  put('README.md', '# Fixture\n');
  git('add', '-A');
  git('commit', '-qm', 'docs: seed the fixture readme');
  const base = git('rev-parse', 'HEAD');

  const checkRange = (from: string, to: string) =>
    execFileSync(process.execPath, [join(root, 'scripts/check-commit-range.mjs'), from, to], {
      cwd,
      encoding: 'utf8',
    });

  return { cwd, git, put, base, checkRange };
}

function runChecked(fn: () => string): { status: number; output: string } {
  try {
    return { status: 0, output: fn() };
  } catch (error) {
    const e = error as { status?: number | null; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('commit range hygiene (ADR-GOV-0018)', () => {
  it('rejects a mixed commit that bypassed the local hook, naming the commit', () => {
    const r = repo();
    r.put('product/campaigns/CMP-9999-fixture/plan.json', '{"id":"CMP-9999"}\n');
    r.put('packages/cli/src/services/fixture.ts', 'export const fixture = 1;\n');
    r.git('add', '-A');
    r.git('commit', '--no-verify', '-qm', 'feat: add fixture across families');
    const mixed = r.git('rev-parse', 'HEAD');
    const shortMixed = r.git('rev-parse', '--short', mixed);

    const result = runChecked(() => r.checkRange(r.base, mixed));

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(new RegExp(`${shortMixed}|${mixed}`, 'u'));
  });

  it('passes a merge commit without treating it as mixed', () => {
    const r = repo();
    r.git('checkout', '-qb', 'branch-a');
    r.put('tests/contract/fixture-a.contract.test.ts', 'export {};\n');
    r.git('add', '-A');
    r.git('commit', '-qm', 'test(commit-grammar): add fixture a');
    r.git('checkout', '-qb', 'branch-b', r.base);
    r.put('tests/contract/fixture-b.contract.test.ts', 'export {};\n');
    r.git('add', '-A');
    r.git('commit', '-qm', 'test(commit-grammar): add fixture b');
    r.git('checkout', '-q', 'branch-a');
    r.git('merge', '--no-ff', '-qm', 'Merge branch-b into branch-a', 'branch-b');
    const head = r.git('rev-parse', 'HEAD');

    const result = runChecked(() => r.checkRange(r.base, head));

    expect(result.status, result.output).toBe(0);
  });

  it('passes a revert of a single-family commit', () => {
    const r = repo();
    r.put('tests/contract/fixture-revert.contract.test.ts', 'export {};\n');
    r.git('add', '-A');
    const reverted = (() => {
      r.git('commit', '-qm', 'test(commit-grammar): add fixture to revert');
      return r.git('rev-parse', 'HEAD');
    })();
    r.git('revert', '--no-edit', reverted);
    const head = r.git('rev-parse', 'HEAD');

    const result = runChecked(() => r.checkRange(r.base, head));

    expect(result.status, result.output).toBe(0);
  });
});
