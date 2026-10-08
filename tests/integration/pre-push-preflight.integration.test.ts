// CMP-0007 TASK-0727 (ADR-CHK-0001, ADR-GOV-0018): the opt-in pre-push preflight. A real
// `git push` from a fixture clone runs the repository's own .githooks/pre-push, which runs
// scripts/pre-push-preflight.mjs: it fetches main from the pushed remote, checks the pushed
// range with scripts/check-commit-range.mjs, then runs the affected check and summarizes a
// failing report. A stub bootstrap CLI stands in for the check runner and prints a scripted
// report, so the test proves the hook's wiring and refusals without running real check
// nodes. The hook stays silent and passes everything for a clone that has not opted in.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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

const ROOT = resolve(import.meta.dirname, '../..');
const PUSH_TIMEOUT_MS = 60_000;
const IDENTITY = { name: 'DEVAI Inspector', email: 'inspector@devai.local' };
/** Real repository files the hook and its scripts read, copied into each fixture clone. */
const COPIED = [
  '.githooks/pre-push',
  'scripts/pre-push-preflight.mjs',
  'scripts/check-commit-range.mjs',
  'scripts/process/summarize-check-report.mjs',
  'law/policy/commit-grammar.json',
  'law/policy/change-taxonomy.json',
  '.devai/config/change-taxonomy-binding.json',
] as const;
const STUB_CLI = '.devai/state/pr-bootstrap/cli/bin.js';
const STUB_REPORT = '.devai/state/stub-report.json';
const STUB_CALLS = '.devai/state/stub-calls.jsonl';

/**
 * The stand-in check runner. It records every invocation, refuses any call that is not an
 * affected run against an explicit base, and otherwise prints the scripted report as one
 * JSON line and exits with the scripted code.
 */
const STUB_SOURCE = `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(STUB_CALLS)}, JSON.stringify(args) + '\\n');
const base = args[args.indexOf('--base') + 1];
if (args[0] !== 'check' || !args.includes('--affected') || !args.includes('--run') || !base) {
  process.stderr.write('stub check runner: unexpected invocation ' + args.join(' ') + '\\n');
  process.exit(99);
}
const scripted = JSON.parse(readFileSync(${JSON.stringify(STUB_REPORT)}, 'utf8'));
process.stdout.write(JSON.stringify(scripted.report) + '\\n');
process.exit(scripted.exit);
`;

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

interface Result {
  readonly status: number | null;
  readonly output: string;
}

function run(cwd: string, command: string, args: readonly string[]): Result {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: PUSH_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function git(cwd: string, ...args: string[]): string {
  const result = run(cwd, 'git', args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.output}`);
  return result.output.trim();
}

function put(cwd: string, path: string, content: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
}

interface Fixture {
  readonly work: string;
  /** The main commit on the remote, which the hook fetches as the base. */
  readonly base: string;
}

/**
 * A bare `origin` holding a seeded main, and a working clone with the real hook and scripts,
 * the stub check runner, and a feature branch. The hook is wired through core.hooksPath and
 * opted in unless `optIn` is false.
 */
function fixture(optIn = true): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'devai-pre-push-'));
  roots.push(dir);
  const remote = join(dir, 'origin.git');
  const work = join(dir, 'work');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  git(dir, 'init', '--quiet', '--initial-branch=main', work);
  git(work, 'remote', 'add', 'origin', remote);

  for (const path of COPIED) {
    const source = join(ROOT, path);
    if (!existsSync(source)) throw new Error(`the repository has no ${path} yet`);
    mkdirSync(dirname(join(work, path)), { recursive: true });
    cpSync(source, join(work, path));
  }
  chmodSync(join(work, '.githooks/pre-push'), 0o755);
  put(work, '.gitignore', '.devai/state/\n');
  put(work, 'README.md', '# Fixture\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'docs: seed the fixture readme');
  // The seed reaches origin before the hook is wired, as main would already exist there.
  git(work, 'push', '-q', 'origin', 'main');
  const base = git(work, 'rev-parse', 'HEAD');

  put(work, STUB_CLI, STUB_SOURCE);
  git(work, 'config', 'core.hooksPath', '.githooks');
  if (optIn) git(work, 'config', 'devai.prePushPreflight', 'true');
  git(work, 'checkout', '-qb', 'feature');
  return { work, base };
}

function script(work: string, exit: number, report: unknown): void {
  put(work, STUB_REPORT, JSON.stringify({ exit, report }));
}

function calls(work: string): string[][] {
  const path = join(work, STUB_CALLS);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

/** A commit the commit grammar admits: one test-class file under a test type. */
function cleanCommit(work: string, name: string): void {
  put(work, `tests/contract/${name}.contract.test.ts`, 'export {};\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', `test(commit-grammar): add the ${name} fixture`);
}

function push(work: string): Result {
  return run(work, 'git', ['push', 'origin', 'feature']);
}

const PASSING = { schemaVersion: '1.0.0', operation: 'run', execution: [], exitCode: 0 };

describe('pre-push preflight (TASK-0727)', () => {
  it(
    'passes a clean push after the affected check runs against the fetched main',
    () => {
      const { work, base } = fixture();
      cleanCommit(work, 'clean');
      script(work, 0, PASSING);

      const result = push(work);

      expect(result.status, result.output).toBe(0);
      const invoked = calls(work);
      expect(invoked).toHaveLength(1);
      const [args = []] = invoked;
      expect(args.slice(0, 1)).toEqual(['check']);
      expect(args).toContain('--affected');
      expect(args).toContain('--run');
      expect(args[args.indexOf('--base') + 1]).toBe(base);
      expect(git(work, 'ls-remote', 'origin', 'refs/heads/feature')).toContain(
        git(work, 'rev-parse', 'HEAD'),
      );
    },
    PUSH_TIMEOUT_MS,
  );

  it(
    'refuses a range that fails the commit grammar before any check runs, naming the commit',
    () => {
      const { work } = fixture();
      put(work, 'tests/contract/bad.contract.test.ts', 'export {};\n');
      git(work, 'add', '-A');
      git(work, 'commit', '-qm', 'add a fixture without a type');
      const offending = git(work, 'rev-parse', '--short', 'HEAD');
      script(work, 0, PASSING);

      const result = push(work);

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(offending);
      expect(result.output).toMatch(/allowed types/u);
      expect(calls(work), 'the affected check never starts').toEqual([]);
      expect(git(work, 'ls-remote', 'origin', 'refs/heads/feature')).toBe('');
    },
    PUSH_TIMEOUT_MS,
  );

  it(
    'refuses a push whose affected check fails, naming the failing node',
    () => {
      const { work } = fixture();
      cleanCommit(work, 'failing');
      script(work, 1, {
        schemaVersion: '1.0.0',
        operation: 'run',
        execution: [
          { nodeId: 'generate', disposition: 'executed', outcome: 'PASS', reason: 'cache-miss' },
          {
            nodeId: 'lint',
            disposition: 'executed',
            outcome: 'FAIL',
            reason: 'process-exit-1',
            exitCode: 1,
          },
        ],
        exitCode: 1,
      });

      const result = push(work);

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/lint — FAIL/u);
      expect(result.output).toContain('process-exit-1');
      expect(result.output).not.toMatch(/generate — /u);
      expect(git(work, 'ls-remote', 'origin', 'refs/heads/feature')).toBe('');
    },
    PUSH_TIMEOUT_MS,
  );

  it(
    'refuses a push with a BLOCKED probe and reports its remediation',
    () => {
      const { work } = fixture();
      cleanCommit(work, 'blocked');
      const remediation = 'Restore network access to the registry at registry.example.invalid.';
      script(work, 1, {
        schemaVersion: '1.0.0',
        operation: 'run',
        execution: [
          {
            nodeId: 'preflight',
            disposition: 'executed',
            outcome: 'BLOCKED',
            reason: 'extrinsic-probe-blocked',
            remediation: [remediation],
          },
        ],
        blocked: [
          {
            nodeId: 'preflight',
            disposition: 'executed',
            reason: 'extrinsic-probe-blocked',
            remediation: [remediation],
          },
        ],
        exitCode: 1,
      });

      const result = push(work);

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/blocked: preflight/u);
      expect(result.output).toContain(remediation);
      expect(git(work, 'ls-remote', 'origin', 'refs/heads/feature')).toBe('');
    },
    PUSH_TIMEOUT_MS,
  );

  it(
    'stays silent and passes everything for a clone that has not opted in',
    () => {
      const { work } = fixture(false);
      // Both a grammar failure and a failing check would refuse an opted-in push.
      put(work, 'tests/contract/unchecked.contract.test.ts', 'export {};\n');
      git(work, 'add', '-A');
      git(work, 'commit', '-qm', 'add a fixture without a type');
      script(work, 1, { schemaVersion: '1.0.0', operation: 'run', execution: [], exitCode: 1 });

      const result = push(work);

      expect(result.status, result.output).toBe(0);
      expect(calls(work), 'the check runner never starts').toEqual([]);
      expect(result.output).not.toMatch(/check report|allowed types|preflight/iu);
      expect(git(work, 'ls-remote', 'origin', 'refs/heads/feature')).toContain(
        git(work, 'rev-parse', 'HEAD'),
      );
    },
    PUSH_TIMEOUT_MS,
  );

  it(
    'treats a value other than true as not opted in',
    () => {
      const { work } = fixture(false);
      git(work, 'config', 'devai.prePushPreflight', 'false');
      cleanCommit(work, 'opted-out');
      script(work, 1, { schemaVersion: '1.0.0', operation: 'run', execution: [], exitCode: 1 });

      const result = push(work);

      expect(result.status, result.output).toBe(0);
      expect(calls(work)).toEqual([]);
    },
    PUSH_TIMEOUT_MS,
  );

  it(
    'refuses a push of a commit other than HEAD before the affected check, naming the ref',
    () => {
      // The affected check runs on the working tree, so it can only vouch for HEAD: pushing
      // another branch's commit from here must be refused rather than checked against HEAD.
      const { work } = fixture();
      cleanCommit(work, 'elsewhere');
      const pushed = git(work, 'rev-parse', 'HEAD');
      git(work, 'checkout', '-q', 'main');
      script(work, 0, PASSING);

      const result = push(work);

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/check out/u);
      expect(result.output).toMatch(/feature/u);
      expect(result.output).toMatch(/push HEAD/u);
      expect(calls(work), 'the affected check never starts').toEqual([]);
      expect(git(work, 'ls-remote', 'origin', 'refs/heads/feature')).toBe('');
      // The same commit pushes once it is checked out.
      git(work, 'checkout', '-q', 'feature');
      expect(git(work, 'rev-parse', 'HEAD')).toBe(pushed);
      const retried = push(work);
      expect(retried.status, retried.output).toBe(0);
      expect(calls(work)).toHaveLength(1);
    },
    PUSH_TIMEOUT_MS,
  );
});
