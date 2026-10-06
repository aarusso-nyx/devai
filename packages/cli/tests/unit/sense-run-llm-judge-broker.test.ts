// Issue #249: the llm_judge host transports run through the production authority broker.
// `devai sense run llm_judge` in a freshly bound adopter spawns a stub `claude`/`codex`
// (no provider is ever contacted) and must reach the model bridge and return the stub's
// verdict. Before the typed local-llm rule, the broker refused the spawn with
// UNCLASSIFIED_RESOURCE, so no host-CLI review could run under governed authority.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const REVIEW_FIXTURES = resolve(import.meta.dirname, '../../../../tests/fixtures/review-replies');
const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runCli(args: readonly string[]) {
  vi.resetModules();
  const previous = {
    argv: process.argv,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...args, '--format', 'json'];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    await import('../../src/bin.js');
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function boundAdopter(): Promise<string> {
  const repo = temporary('devai-llm-judge-adopter-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const result = await runCli([
    'init',
    'bind',
    '--full',
    '--tier',
    'tier1',
    '--target',
    repo,
    '--as-role',
    'architect',
    '--write',
  ]);
  expect(result.exit, result.stderr).toBe(0);
  return repo;
}

/** A stub provider CLI: records its argv and working directory, then replays a fixture. */
function stubProvider(executable: 'claude' | 'codex', fixture: string): string {
  const bin = temporary('devai-llm-judge-stub-');
  const record = join(bin, 'record');
  const script = join(bin, executable);
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      // The Codex compatibility probe (#321) runs through the same broker: answer it as a
      // binary that honours every --disable, and record that it ran.
      `if [ "$1" = "--version" ]; then echo 'codex-cli stub-${executable}'; exit 0; fi`,
      'if [ "$1" = "features" ]; then',
      `  touch '${record}.probed'`,
      '  shift 2',
      '  while [ "$#" -gt 0 ]; do [ "$1" = "--disable" ] && echo "$2  stable  false"; shift; done',
      '  exit 0',
      'fi',
      `printf '%s\\n' "$PWD" > '${record}.cwd'`,
      `ls -A > '${record}.entries'`,
      `printf '%s\\0' "$@" > '${record}.argv'`,
      `cat '${join(REVIEW_FIXTURES, fixture)}'`,
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  return record;
}

const input = (family: string) =>
  JSON.stringify({
    family,
    model: 'offline-stub-model',
    aspect: 'issue249_broker',
    rubric: 'Review the diff for correctness.',
    evidence: 'diff --git a/a.ts b/a.ts\n-x\n+y\n',
  });

describe('#249 llm_judge host transports through the production broker (stub providers)', () => {
  it.each([
    ['claude-cli', 'claude', 'cmp0006-claude-envelope.json'],
    ['codex-cli', 'codex', 'cmp0006-codex-events.jsonl'],
  ] as const)(
    '%s review is admitted, isolated and returns the stub verdict',
    async (family, executable, fixture) => {
      const repo = await boundAdopter();
      const record = stubProvider(executable, fixture);
      const result = await runCli([
        'sense',
        'run',
        'llm_judge',
        '--repo-root',
        repo,
        '--input',
        input(family),
        '--as-role',
        'inspector',
        '--write',
        '--publish',
      ]);
      expect(result.stdout).not.toContain('UNCLASSIFIED_RESOURCE');
      expect(existsSync(`${record}.argv`), result.stdout).toBe(true);
      expect(result.exit, result.stdout).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok: boolean;
        result: { value: { counts: Record<string, number> } };
      };
      expect(payload.ok).toBe(true);
      expect(payload.result.value.counts['pass']).toBe(1);
      // The reviewer ran in an empty private workspace outside the adopter, now removed.
      const cwd = readFileSync(`${record}.cwd`, 'utf8').trim();
      expect(cwd.startsWith(repo)).toBe(false);
      expect(readFileSync(`${record}.entries`, 'utf8')).toBe('');
      expect(existsSync(cwd)).toBe(false);
      const argv = readFileSync(`${record}.argv`, 'utf8').split('\0');
      if (executable === 'claude') {
        expect(argv[argv.indexOf('--tools') + 1]).toBe('');
        expect(argv).toContain('--strict-mcp-config');
      } else {
        expect(argv).toContain('--ignore-user-config');
        expect(argv[argv.indexOf('--disable') + 1]).toBe('shell_tool');
        // The compatibility probe ran through the production broker before the review.
        expect(existsSync(`${record}.probed`)).toBe(true);
      }
      expect(readdirSync(repo)).not.toContain('workspace');
    },
  );
});
