// ADR-CHK-0009, Inspector Adversarial Acceptance IA-001 to IA-004 (issue #412): the commit-range
// author-path table admits the Engineer on `tests/` and `packages/*/tests/` only for a test file
// the commit adds or modifies, never deletes, that imports, through a relative or workspace
// import, a file under `packages/` the same commit changes. Inspector commits on those paths are
// judged exactly as before. The verb exists from constitution 1.1.0 (ADR-GOV-0026), so a
// repository whose constitution is older admits only the Inspector there.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve('.');
const CHECKER = join(ROOT, 'scripts/check-commit-range.mjs');
const POLICY = [
  'law/policy/commit-grammar.json',
  'law/policy/change-taxonomy.json',
  '.devai/config/change-taxonomy-binding.json',
  '.devai/config/adopter-policy-binding.json',
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

const constitution = (version: string) =>
  `---\nid: CONSTITUTION\n---\n\n# DEVAI Constitution — ${version}\n\n**Version:** ${version}\n`;

/** The base every range starts from: a workspace package with sources and existing tests. */
const SEED: Readonly<Record<string, string>> = {
  'README.md': '# Fixture\n',
  'packages/x/package.json': `${JSON.stringify({
    name: '@fixture/x',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        development: './src/index.ts',
        default: './dist/index.js',
      },
      './extra': { default: './dist/extra.js' },
    },
  })}\n`,
  'packages/x/src/index.ts': "export { a } from './a.js';\n",
  'packages/x/src/a.ts': 'export const a = 1;\n',
  'packages/x/src/b.ts': 'export const b = 1;\n',
  'packages/x/src/extra.ts': 'export const extra = 1;\n',
  'packages/x/tests/unit/a.test.ts': [
    "import { expect, it } from 'vitest';",
    "import { a } from '../../src/a.js';",
    '',
    "it('reads a', () => expect(a).toBe(1));",
    '',
  ].join('\n'),
  'packages/x/tests/unit/b.test.ts': [
    "import { expect, it } from 'vitest';",
    "import { b } from '../../src/b.js';",
    '',
    "it('reads b', () => expect(b).toBe(1));",
    '',
  ].join('\n'),
};

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Commit {
  readonly author: Identity;
  readonly message: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly deletes?: readonly string[];
}

function repository(version = '1.1.0') {
  const cwd = mkdtempSync(join(tmpdir(), 'devai-commit-range-focused-'));
  roots.push(cwd);
  const git = (args: readonly string[], as: Identity = ARCHITECT) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: as.name,
        GIT_AUTHOR_EMAIL: as.email,
        GIT_COMMITTER_NAME: as.name,
        GIT_COMMITTER_EMAIL: as.email,
      },
    }).trim();
  const put = (path: string, content: string) => {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };

  git(['init', '--quiet', '--initial-branch=main']);
  for (const path of POLICY) {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    if (path === '.devai/config/adopter-policy-binding.json') {
      // This generic provenance matrix predates the explicit documentation opt-in.
      const bytes = readFileSync(
        join(ROOT, 'tests/fixtures/adopter-binding-pre-selfbinding-35ba43e4.json.fixture'),
      );
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        '0d71f515870f56b65f622df0a65baf938e06bb335c930d65f73be146e5629639',
      );
      writeFileSync(join(cwd, path), bytes);
    } else execFileSync('cp', [join(ROOT, path), join(cwd, path)]);
  }
  for (const [path, content] of Object.entries(SEED)) put(path, content);
  put('law/constitution.md', constitution(version));
  git(['add', '-A']);
  // The seed is the base, outside every range under test.
  git(['commit', '--no-verify', '-qm', 'docs: seed the fixture']);
  const base = git(['rev-parse', 'HEAD']);

  const commit = ({ author, message, files = {}, deletes = [] }: Commit): string => {
    for (const [path, content] of Object.entries(files)) put(path, content);
    for (const path of deletes) git(['rm', '-q', path]);
    git(['add', '-A']);
    git(['commit', '--no-verify', '-qm', message], author);
    return git(['rev-parse', 'HEAD']);
  };

  const check = (to: string): { status: number; output: string } => {
    try {
      return {
        status: 0,
        output: execFileSync(process.execPath, [CHECKER, base, to], { cwd, encoding: 'utf8' }),
      };
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? 1,
        output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      };
    }
  };

  return { git, commit, check };
}

function expectAdmitted(spec: Commit, version?: string): void {
  const r = repository(version);
  const result = r.check(r.commit(spec));
  expect(result.status, result.output).toBe(0);
}

function expectRefused(spec: Commit, version?: string): string {
  const r = repository(version);
  const sha = r.commit(spec);
  const result = r.check(sha);
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toMatch(new RegExp(`${r.git(['rev-parse', '--short', sha])}|${sha}`, 'u'));
  return result.output;
}

const CHANGED_A = { 'packages/x/src/a.ts': 'export const a = 2;\n' };

const testImporting = (specifier: string, title = 'covers the change') =>
  [
    "import { expect, it } from 'vitest';",
    `import * as subject from '${specifier}';`,
    '',
    `it('${title}', () => expect(subject).toBeDefined());`,
    '',
  ].join('\n');

describe('ADR-CHK-0009 IA-001: an Engineer commit holding a source and its adjacent test passes', () => {
  it('admits a new package test that imports the changed source relatively', () => {
    expectAdmitted({
      author: ENGINEER,
      message: 'fix(x): change a with its regression test',
      files: {
        ...CHANGED_A,
        'packages/x/tests/unit/a-regression.test.ts': testImporting('../../src/a.js'),
      },
    });
  });

  it('admits a modified existing test that imports the changed source', () => {
    expectAdmitted({
      author: ENGINEER,
      message: 'fix(x): change a and extend its test',
      files: {
        ...CHANGED_A,
        'packages/x/tests/unit/a.test.ts': `${SEED['packages/x/tests/unit/a.test.ts'] ?? ''}it('reads a again', () => expect(a).toBe(2));\n`,
      },
    });
  });

  it('admits a root tests/ file that imports the changed package source', () => {
    expectAdmitted({
      author: ENGINEER,
      message: 'fix(x): change a with a root regression test',
      files: {
        ...CHANGED_A,
        'tests/contract/a-regression.contract.test.ts': testImporting('../../packages/x/src/a.js'),
      },
    });
  });

  it('admits a test whose workspace import resolves to the changed package entry', () => {
    expectAdmitted({
      author: ENGINEER,
      message: 'fix(x): change the entry with its regression test',
      files: {
        'packages/x/src/index.ts': "export { a } from './a.js';\nexport const entry = 1;\n",
        'packages/x/tests/unit/entry.test.ts': testImporting('@fixture/x'),
      },
    });
  });

  it('admits a test whose workspace subpath import resolves to the changed source', () => {
    expectAdmitted({
      author: ENGINEER,
      message: 'fix(x): change extra with its regression test',
      files: {
        'packages/x/src/extra.ts': 'export const extra = 2;\n',
        'packages/x/tests/unit/extra.test.ts': testImporting('@fixture/x/extra'),
      },
    });
  });
});

describe('ADR-CHK-0009 IA-002: an Engineer test that imports nothing the commit changed is refused', () => {
  it('refuses a test that imports only an unchanged source', () => {
    const output = expectRefused({
      author: ENGINEER,
      message: 'fix(x): change a and add an unrelated test',
      files: {
        ...CHANGED_A,
        'packages/x/tests/unit/b-more.test.ts': testImporting('../../src/b.js'),
      },
    });
    expect(output).toContain('packages/x/tests/unit/b-more.test.ts');
  });

  it('refuses a modified existing test that does not import the changed source', () => {
    expectRefused({
      author: ENGINEER,
      message: 'fix(x): change a and edit the b test',
      files: {
        ...CHANGED_A,
        'packages/x/tests/unit/b.test.ts': `${SEED['packages/x/tests/unit/b.test.ts'] ?? ''}it('reads b again', () => expect(b).toBe(1));\n`,
      },
    });
  });

  it('refuses a test that imports a changed file only through a comment', () => {
    expectRefused({
      author: ENGINEER,
      message: 'fix(x): change a and add a test mentioning it',
      files: {
        ...CHANGED_A,
        'packages/x/tests/unit/mention.test.ts': [
          "import { expect, it } from 'vitest';",
          "// import { a } from '../../src/a.js';",
          "it('mentions a', () => expect(1).toBe(1));",
          '',
        ].join('\n'),
      },
    });
  });

  it('refuses an Engineer test alone, with no source change in the commit', () => {
    expectRefused({
      author: ENGINEER,
      message: 'test(x): add a test as the engineer',
      files: { 'packages/x/tests/unit/a-alone.test.ts': testImporting('../../src/a.js') },
    });
  });

  it('refuses a test whose only changed import is another test-path file', () => {
    expectRefused({
      author: ENGINEER,
      message: 'fix(x): change a helper and a test that uses it',
      files: {
        ...CHANGED_A,
        'packages/x/tests/unit/helper-user.test.ts': testImporting('./a.test.js'),
        'packages/x/tests/unit/a.test.ts': `${SEED['packages/x/tests/unit/a.test.ts'] ?? ''}export const helper = 1;\n`,
      },
    });
  });

  it('refuses a non-test file under tests/ even when it imports the changed source', () => {
    // Configuration and helpers under the test class carry thresholds and fixtures the
    // focused-regression verb never reaches; only a test file is admitted.
    expectRefused({
      author: ENGINEER,
      message: 'fix(x): change a and its test configuration',
      files: {
        ...CHANGED_A,
        'tests/config/local.config.ts': testImporting('../../packages/x/src/a.js'),
      },
    });
  });
});

describe('ADR-CHK-0009 IA-003: an Engineer commit that deletes a test is refused', () => {
  it('refuses the deletion of a test, whatever else the commit changes', () => {
    const output = expectRefused({
      author: ENGINEER,
      message: 'fix(x): change a and drop its test',
      files: {
        ...CHANGED_A,
        'packages/x/tests/unit/a-new.test.ts': testImporting('../../src/a.js'),
      },
      deletes: ['packages/x/tests/unit/a.test.ts'],
    });
    expect(output).toContain('packages/x/tests/unit/a.test.ts');
  });
});

describe('ADR-CHK-0009 IA-004: Inspector commits under the test class are judged as before', () => {
  it('admits an Inspector test that imports nothing changed', () => {
    expectAdmitted({
      author: INSPECTOR,
      message: 'test(x): add a counterexample',
      files: { 'packages/x/tests/unit/b-counter.test.ts': testImporting('../../src/b.js') },
    });
  });

  it('admits an Inspector commit that deletes a test', () => {
    expectAdmitted({
      author: INSPECTOR,
      message: 'test(x): remove an obsolete test',
      deletes: ['packages/x/tests/unit/b.test.ts'],
    });
  });

  it('admits an Inspector non-test file under tests/', () => {
    expectAdmitted({
      author: INSPECTOR,
      message: 'test(x): add a test helper',
      files: { 'tests/helpers/fixture.ts': 'export const fixture = 1;\n' },
    });
  });

  it('still refuses an Inspector commit under packages/*/src', () => {
    expectRefused({
      author: INSPECTOR,
      message: 'fix(x): change a as the inspector',
      files: CHANGED_A,
    });
  });
});

describe('the focused-regression verb needs constitution 1.1.0', () => {
  it('refuses the IA-001 commit while the constitution is 1.0.2', () => {
    expectRefused(
      {
        author: ENGINEER,
        message: 'fix(x): change a with its regression test',
        files: {
          ...CHANGED_A,
          'packages/x/tests/unit/a-regression.test.ts': testImporting('../../src/a.js'),
        },
      },
      '1.0.2',
    );
  });

  it('admits the IA-001 commit under a later constitution', () => {
    expectAdmitted(
      {
        author: ENGINEER,
        message: 'fix(x): change a with its regression test',
        files: {
          ...CHANGED_A,
          'packages/x/tests/unit/a-regression.test.ts': testImporting('../../src/a.js'),
        },
      },
      '1.2.0',
    );
  });
});
