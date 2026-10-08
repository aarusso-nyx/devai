// ADR-CHK-0008, Inspector Adversarial Acceptance IA-006 to IA-008 (CMP-0007 TASK-0729): the
// pull-request range check judges every commit's provenance on real git ranges. A commit's
// role is its author identity; its author must be admitted by the author-path table for every
// path it changes; its committer must be the author's own role or the update-branch App; and
// no commit in the range may have more than one parent. Each refusal names the commit.
//
// Red until TASK-0728 extends scripts/check-commit-range.mjs on the same branch.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve('.');
const CHECKER = join(ROOT, 'scripts/check-commit-range.mjs');
const POLICY = [
  'law/policy/commit-grammar.json',
  'law/policy/change-taxonomy.json',
  '.devai/config/change-taxonomy-binding.json',
] as const;

interface Identity {
  readonly name: string;
  readonly email: string;
}
const role = (name: string): Identity => ({
  name: `DEVAI ${name}`,
  email: `${name.toLowerCase()}@devai.local`,
});
const ARCHITECT = role('Architect');
const ENGINEER = role('Engineer');
const INSPECTOR = role('Inspector');
const OWNER = role('Owner');
const MACHINE = role('Machine');
/** The update-branch GitHub App the Owner names devai-update-branch at OE-02. */
const UPDATE_APP: Identity = {
  name: 'devai-update-branch[bot]',
  email: '123456789+devai-update-branch[bot]@users.noreply.github.com',
};
const STRANGER: Identity = { name: 'Range Test', email: 'range@example.invalid' };

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Commit {
  readonly author: Identity;
  readonly committer?: Identity;
  readonly message: string;
  readonly files: Readonly<Record<string, string>>;
}

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'devai-commit-range-provenance-'));
  roots.push(cwd);
  const env = (author: Identity, committer: Identity) => ({
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  });
  const git = (args: readonly string[], as: Identity = OWNER, by: Identity = as) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: env(as, by) }).trim();
  const put = (path: string, content: string) => {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };

  git(['init', '--quiet', '--initial-branch=main']);
  for (const path of POLICY) {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    execFileSync('cp', [join(ROOT, path), join(cwd, path)]);
  }
  put('README.md', '# Fixture\n');
  git(['add', '-A']);
  // The seed is the base, outside every range under test.
  git(['commit', '--no-verify', '-qm', 'docs: seed the fixture readme'], ARCHITECT);
  const base = git(['rev-parse', 'HEAD']);

  const commit = ({ author, committer = author, message, files }: Commit): string => {
    for (const [path, content] of Object.entries(files)) put(path, content);
    git(['add', '-A']);
    git(['commit', '--no-verify', '-qm', message], author, committer);
    return git(['rev-parse', 'HEAD']);
  };

  const check = (from: string, to: string): { status: number; output: string } => {
    try {
      return {
        status: 0,
        output: execFileSync(process.execPath, [CHECKER, from, to], { cwd, encoding: 'utf8' }),
      };
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? 1,
        output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      };
    }
  };

  return { git, commit, check, base };
}

/** The commit's short and full sha, either of which a refusal may name. */
function names(git: ReturnType<typeof repository>['git'], sha: string): RegExp {
  return new RegExp(`${git(['rev-parse', '--short', sha])}|${sha}`, 'u');
}

function expectRefused(commitSpec: Commit): void {
  const r = repository();
  const sha = r.commit(commitSpec);
  const result = r.check(r.base, sha);
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toMatch(names(r.git, sha));
}

function expectAdmitted(commitSpec: Commit): void {
  const r = repository();
  const sha = r.commit(commitSpec);
  const result = r.check(r.base, sha);
  expect(result.status, result.output).toBe(0);
}

describe('commit-range provenance refusals (ADR-CHK-0008)', () => {
  it('refuses a merge commit inside a pull-request range (IA-007)', () => {
    const r = repository();
    r.git(['checkout', '-qb', 'branch-a']);
    r.commit({
      author: INSPECTOR,
      message: 'test(commit-grammar): add fixture a',
      files: { 'tests/contract/fixture-a.contract.test.ts': 'export {};\n' },
    });
    r.git(['checkout', '-qb', 'branch-b', r.base]);
    r.commit({
      author: INSPECTOR,
      message: 'test(commit-grammar): add fixture b',
      files: { 'tests/contract/fixture-b.contract.test.ts': 'export {};\n' },
    });
    r.git(['checkout', '-q', 'branch-a']);
    r.git(
      ['merge', '--no-ff', '--no-verify', '-qm', 'Merge branch-b into branch-a', 'branch-b'],
      INSPECTOR,
    );
    const merge = r.git(['rev-parse', 'HEAD']);

    const result = r.check(r.base, merge);

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(names(r.git, merge));
  });

  it('refuses an author that is not a DEVAI role identity', () => {
    expectRefused({
      author: STRANGER,
      message: 'test(commit-grammar): add a fixture under a personal identity',
      files: { 'tests/contract/stranger.contract.test.ts': 'export {};\n' },
    });
  });

  it('refuses a role-looking author with the wrong email', () => {
    expectRefused({
      author: { name: 'DEVAI Inspector', email: 'inspector@example.invalid' },
      message: 'test(commit-grammar): add a fixture under a lookalike identity',
      files: { 'tests/contract/lookalike.contract.test.ts': 'export {};\n' },
    });
  });

  it.each([
    [
      'an Architect commit under packages/',
      ARCHITECT,
      'feat(cli): add a fixture source',
      'packages/cli/src/fixture.ts',
      'export const fixture = 1;\n',
    ],
    [
      'an Engineer commit under law/',
      ENGINEER,
      'law(policy): add a fixture policy',
      'law/policy/fixture.json',
      '{}\n',
    ],
    [
      'an Engineer commit under docs/',
      ENGINEER,
      'docs(reference): add a fixture page',
      'docs/reference/fixture.md',
      '# Fixture\n',
    ],
    [
      'an Inspector commit under packages/*/src',
      INSPECTOR,
      'fix(cli): change a fixture source',
      'packages/cli/src/inspected.ts',
      'export const inspected = 1;\n',
    ],
    [
      'an Owner commit under tests/',
      OWNER,
      'test(commit-grammar): add a fixture as the owner',
      'tests/contract/owner.contract.test.ts',
      'export {};\n',
    ],
  ] as const)('refuses %s, outside the author row', (_label, author, message, path, content) => {
    expectRefused({ author, message, files: { [path]: content } });
  });

  it('refuses a committed file under scratch/ other than its README', () => {
    expectRefused({
      author: ARCHITECT,
      message: 'docs(operations): commit a scratch note',
      files: { 'scratch/notes.md': '# Notes\n' },
    });
  });

  it('refuses a path that no row of the table names', () => {
    expectRefused({
      author: ENGINEER,
      message: 'chore: add an unlisted root file',
      files: { 'unlisted-root-file.txt': 'unlisted\n' },
    });
  });

  it('refuses one commit that mixes the paths of two roles', () => {
    // feat admits both the code and tests classes, so only the author-path table refuses it.
    expectRefused({
      author: ENGINEER,
      message: 'feat(cli): add a source with its test',
      files: {
        'packages/cli/src/mixed.ts': 'export const mixed = 1;\n',
        'tests/contract/mixed.contract.test.ts': 'export {};\n',
      },
    });
  });

  it.each([
    ['a personal identity', STRANGER],
    ['another role', ENGINEER],
    ['the machine identity', MACHINE],
    [
      'a bot that is not the update-branch App',
      {
        name: 'some-other-app[bot]',
        email: '42+some-other-app[bot]@users.noreply.github.com',
      },
    ],
  ] as const)('refuses a committer that is %s (IA-006)', (_label, committer) => {
    expectRefused({
      author: INSPECTOR,
      committer,
      message: 'test(commit-grammar): add a fixture committed by someone else',
      files: { 'tests/contract/committer.contract.test.ts': 'export {};\n' },
    });
  });

  it('names the refused commit and admits its clean predecessor in the same range', () => {
    const r = repository();
    r.commit({
      author: INSPECTOR,
      message: 'test(commit-grammar): add a clean fixture',
      files: { 'tests/contract/clean.contract.test.ts': 'export {};\n' },
    });
    const clean = r.git(['rev-parse', 'HEAD']);
    const bad = r.commit({
      author: ARCHITECT,
      message: 'feat(cli): add a source as the architect',
      files: { 'packages/cli/src/architect.ts': 'export const architect = 1;\n' },
    });

    const result = r.check(r.base, bad);

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(names(r.git, bad));
    expect(r.check(r.base, clean).status).toBe(0);
  });
});

describe('commit-range provenance admitted cases (ADR-CHK-0008)', () => {
  it('admits a role commit committed by the same role', () => {
    expectAdmitted({
      author: INSPECTOR,
      message: 'test(commit-grammar): add a fixture as the inspector',
      files: { 'tests/contract/inspector.contract.test.ts': 'export {};\n' },
    });
  });

  it('admits a rebase-updated commit committed by the update-branch App (IA-006)', () => {
    expectAdmitted({
      author: INSPECTOR,
      committer: UPDATE_APP,
      message: 'test(commit-grammar): add a fixture the App rebased',
      files: { 'tests/contract/rebased.contract.test.ts': 'export {};\n' },
    });
  });

  it('admits an Engineer commit under packages/ and an Architect commit under docs/ in one range', () => {
    const r = repository();
    r.commit({
      author: ENGINEER,
      message: 'feat(cli): add a fixture source',
      files: { 'packages/cli/src/engineered.ts': 'export const engineered = 1;\n' },
    });
    const head = r.commit({
      author: ARCHITECT,
      message: 'docs(reference): add a fixture page',
      files: { 'docs/reference/architected.md': '# Architected\n' },
    });

    const result = r.check(r.base, head);

    expect(result.status, result.output).toBe(0);
  });

  it('admits a Machine commit under record/ (IA-008)', () => {
    expectAdmitted({
      author: MACHINE,
      message: 'plan(record): record a fixture proof',
      files: { 'record/proofs/fixture.json': '{"fixture":true}\n' },
    });
  });

  it('admits an Architect commit pairing law/policy with its .devai/config copy (IA-008)', () => {
    expectAdmitted({
      author: ARCHITECT,
      message: 'law(policy): amend the domains policy and its materialized copy',
      files: {
        'law/policy/domains.json': '{"schemaVersion":"1.0.0"}\n',
        '.devai/config/domains.json': '{"schemaVersion":"1.0.0"}\n',
      },
    });
  });

  it('admits an Owner commit under law/glossary/, a joint row', () => {
    expectAdmitted({
      author: OWNER,
      message: 'law(glossary): define a fixture term',
      files: { 'law/glossary/fixture.md': '# Fixture term\n' },
    });
  });
});
