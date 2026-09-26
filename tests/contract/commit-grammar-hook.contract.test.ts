// ADR-GOV-0018, Inspector Adversarial Acceptance IA-001 and IA-002: the
// commit-msg hook validates the grammar and the type-to-class binding, and the
// pre-commit hook classifies staged paths and rejects a cross-family mix. Both
// hooks are run by path, exactly as git would invoke them, in a disposable
// repository that carries its own copies of the grammar and taxonomy policies.
//
// `.githooks/commit-msg` does not exist yet, so every case that exercises it is
// red: `sh` reports "No such file or directory" instead of validating anything.
// `.githooks/pre-commit` exists but only runs lint-staged
// (scripts/check-change-hygiene.mjs); it has no class-mixing check yet, so the
// cross-family case is red too.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve('.');
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HOOK_ENV = {
  ...process.env,
  PATH: `${join(root, 'node_modules/.bin')}:${process.env.PATH}`,
};

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'devai-commit-grammar-hook-'));
  roots.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '--quiet');
  git('config', 'user.name', 'Hook test');
  git('config', 'user.email', 'hook@example.invalid');

  // Fixture repository carries its own copies of the policies the hooks read.
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

  // Scaffolding so `pnpm run precommit` (which .githooks/pre-commit execs) can
  // run the real hygiene script against this fixture's own staged files.
  writeFileSync(
    join(cwd, 'package.json'),
    `${JSON.stringify(
      {
        type: 'module',
        scripts: { precommit: `node "${join(root, 'scripts/check-change-hygiene.mjs')}"` },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(cwd, 'eslint.config.mjs'),
    "export default [{files:['**/*.js'],rules:{semi:['error','always'],'no-unused-vars':'error'}}];\n",
  );

  const stage = (path: string, content: string) => {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), content);
    git('add', path);
  };

  const runCommitMsg = (subject: string, body = '') => {
    const messageFile = join(cwd, 'COMMIT_EDITMSG_FIXTURE');
    writeFileSync(messageFile, body.length > 0 ? `${subject}\n\n${body}\n` : `${subject}\n`);
    return spawnSync('sh', [join(root, '.githooks/commit-msg'), messageFile], {
      cwd,
      encoding: 'utf8',
      env: HOOK_ENV,
    });
  };

  const runPreCommit = () =>
    spawnSync('sh', [join(root, '.githooks/pre-commit')], {
      cwd,
      encoding: 'utf8',
      env: HOOK_ENV,
    });

  return { cwd, git, stage, runCommitMsg, runPreCommit };
}

describe('commit-msg hook (ADR-GOV-0018)', () => {
  it('rejects a subject outside the grammar and lists the allowed types', () => {
    const f = fixture();
    f.stage('tests/contract/fixture.contract.test.ts', 'export {};\n');
    const result = f.runCommitMsg('did some stuff');
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.status, output).not.toBe(0);
    for (const type of ['feat', 'fix', 'refactor', 'perf', 'test', 'docs']) {
      expect(output).toContain(type);
    }
  });

  it('passes a subject that matches the grammar and whose type allows its staged class', () => {
    const f = fixture();
    f.stage('tests/contract/fixture.contract.test.ts', 'export {};\n');
    const result = f.runCommitMsg('test(commit-grammar): add fixture coverage');
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.status, output).toBe(0);
  });

  it('rejects a docs: commit whose staged paths include a packages/ (code) path', () => {
    const f = fixture();
    f.stage('docs/guide/fixture.md', '# Fixture\n');
    f.stage('packages/cli/src/services/fixture.ts', 'export const fixture = 1;\n');
    const result = f.runCommitMsg('docs: update the fixture guide');
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.status, output).not.toBe(0);
    expect(output).toContain('docs');
    expect(output).toContain('code');
  });
});

describe('pre-commit hook (ADR-GOV-0018)', () => {
  it('rejects staging a product/ (plan) path together with a packages/ (code) path, naming both classes and suggesting a split', () => {
    const f = fixture();
    f.stage('product/campaigns/CMP-9999-fixture/plan.json', '{"id":"CMP-9999"}\n');
    f.stage('packages/cli/src/services/fixture.ts', 'export const fixture = 1;\n');
    const result = f.runPreCommit();
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.status, output).not.toBe(0);
    expect(output).toContain('plan');
    expect(output).toContain('code');
    expect(output.toLowerCase()).toContain('split');
  });
});
