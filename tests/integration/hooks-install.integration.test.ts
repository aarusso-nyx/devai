import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { subprocessCoverageEnvironment } from '../helpers/subprocess-coverage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'packages', 'cli', 'dist', 'runtime', 'index', 'bin.js');

const skipIfNotBuilt = existsSync(BIN) ? it : it.skip;
const CLI_TIMEOUT_MS = 30_000;

function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env: subprocessCoverageEnvironment(),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface ActionEnvelope {
  readonly action_id: string;
  readonly ok: boolean;
  readonly result?: { readonly value: unknown };
  readonly error?: {
    readonly code: string;
    readonly class: string;
    readonly exit: number;
    readonly message: string;
    readonly remediation?: string;
  };
}

function envelope(text: string): ActionEnvelope {
  return JSON.parse(text) as ActionEnvelope;
}

function materializeAuthorityPolicy(): void {
  const materialized = run([
    'init',
    'bind',
    '--target',
    tempDir,
    '--as-role',
    'architect',
    '--write',
    '--format',
    'json',
  ]);
  expect(materialized.status, materialized.stderr).toBe(0);
  expect(envelope(materialized.stdout)).toMatchObject({
    action_id: 'init bind',
    ok: true,
  });
  expect(existsSync(join(tempDir, '.devai/config/authority-policy.json'))).toBe(true);
}

function applyHooks(extra: readonly string[] = []): ReturnType<typeof run> {
  return run(['init', 'apply', 'architect', '--target', tempDir, '--include', 'hooks', ...extra]);
}

function initializeGitRepository(): void {
  expect(spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir }).status).toBe(0);
  writeFileSync(join(tempDir, 'README.md'), 'fixture\n');
  expect(spawnSync('git', ['add', 'README.md'], { cwd: tempDir }).status).toBe(0);
  expect(
    spawnSync(
      'git',
      [
        '-c',
        'user.name=DEVAI Test',
        '-c',
        'user.email=devai-test@example.invalid',
        'commit',
        '-m',
        'test: initialize fixture',
      ],
      { cwd: tempDir },
    ).status,
  ).toBe(0);
}

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'devai-hooks-install-cli-'));
  const pinDirectory = join(tempDir, '.devai/pin');
  mkdirSync(pinDirectory, { recursive: true });
  writeFileSync(
    join(pinDirectory, 'constitution.md'),
    readFileSync(join(HERE, '..', '..', 'law', 'constitution.md'), 'utf8'),
  );
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('devai init apply architect --include hooks', () => {
  skipIfNotBuilt(
    'refuses missing write consent without writing the target',
    () => {
      const hookPath = join(tempDir, '.git/hooks/pre-push');
      const r = applyHooks(['--as-role', 'architect', '--format', 'json']);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(envelope(r.stderr)).toMatchObject({
        action_id: 'init apply architect',
        ok: false,
        error: {
          class: 'routing-authority',
          exit: 2,
          message: expect.stringContaining('local mutation requires --write'),
        },
      });
      expect(existsSync(hookPath)).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );

  skipIfNotBuilt(
    '--write writes an executable pre-push hook using .git/hooks when no husky dir exists',
    () => {
      materializeAuthorityPolicy();
      const r = applyHooks([
        '--hook',
        'pre-push',
        '--as-role',
        'architect',
        '--write',
        '--format',
        'json',
      ]);
      expect(r.status, r.stderr).toBe(0);
      expect(envelope(r.stdout)).toMatchObject({
        action_id: 'init apply architect',
        ok: true,
        result: { value: { included: [{ component: 'hooks', result: { executed: true } }] } },
      });
      const hookPath = join(tempDir, '.git/hooks/pre-push');
      expect(existsSync(hookPath)).toBe(true);
      expect(readFileSync(hookPath, 'utf8')).toContain('devai check --only forbidden-actions');
      expect(statSync(hookPath).mode & 0o777).toBe(0o755);
    },
    CLI_TIMEOUT_MS,
  );

  skipIfNotBuilt(
    'prefers .husky/<hook> over .git/hooks when a .husky dir is present',
    () => {
      materializeAuthorityPolicy();
      mkdirSync(join(tempDir, '.husky'), { recursive: true });
      const r = applyHooks([
        '--hook',
        'pre-commit',
        '--as-role',
        'architect',
        '--write',
        '--format',
        'json',
      ]);
      expect(r.status, r.stderr).toBe(0);
      expect(envelope(r.stdout)).toMatchObject({
        action_id: 'init apply architect',
        ok: true,
        result: {
          value: { included: [{ component: 'hooks', plan: { manager: 'husky' } }] },
        },
      });
      expect(existsSync(join(tempDir, '.husky/pre-commit'))).toBe(true);
      expect(existsSync(join(tempDir, '.git/hooks/pre-commit'))).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );

  skipIfNotBuilt(
    'refuses a post-merge apply without write consent and leaves adapter state absent',
    () => {
      const hookPath = join(tempDir, '.git/hooks/post-merge');
      const r = applyHooks(['--hook', 'post-merge', '--as-role', 'architect', '--format', 'json']);
      expect(r.status).toBe(2);
      expect(envelope(r.stderr)).toMatchObject({
        action_id: 'init apply architect',
        ok: false,
        error: { message: expect.stringContaining('local mutation requires --write') },
      });
      expect(existsSync(hookPath)).toBe(false);
      expect(existsSync(join(tempDir, '.git/devai'))).toBe(false);
      expect(existsSync(join(tempDir, '.devai/config/post-merge-host-adapter.json'))).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );

  skipIfNotBuilt(
    'allows only Architect authority to install the post-merge adapter',
    () => {
      initializeGitRepository();
      mkdirSync(join(tempDir, 'law'), { recursive: true });
      writeFileSync(
        join(tempDir, 'law', 'constitution.md'),
        readFileSync(join(HERE, '..', '..', 'law', 'constitution.md'), 'utf8'),
      );
      materializeAuthorityPolicy();

      const engineer = applyHooks([
        '--hook',
        'post-merge',
        '--as-role',
        'engineer',
        '--write',
        '--format',
        'json',
      ]);
      expect(engineer.status).not.toBe(0);
      expect(envelope(engineer.stderr)).toMatchObject({
        action_id: 'init apply architect',
        ok: false,
        error: { code: 'AUTHORITY_HUMAN_ROLE_DENIED' },
      });
      expect(existsSync(join(tempDir, '.git/hooks/post-merge'))).toBe(false);

      const architect = applyHooks([
        '--hook',
        'post-merge',
        '--as-role',
        'architect',
        '--write',
        '--format',
        'json',
      ]);
      expect(architect.status, architect.stderr).toBe(0);
      expect(envelope(architect.stdout)).toMatchObject({
        action_id: 'init apply architect',
        ok: true,
        result: {
          value: { included: [{ component: 'hooks', plan: { hook: 'post-merge' } }] },
        },
      });
      const hookPath = join(tempDir, '.git/hooks/post-merge');
      expect(existsSync(hookPath)).toBe(true);
      expect(readFileSync(hookPath, 'utf8')).toContain(
        'devai round close --post-merge-receipt --host-receipt',
      );
      expect(existsSync(join(tempDir, '.devai/config/post-merge-host-adapter.json'))).toBe(true);
    },
    CLI_TIMEOUT_MS,
  );

  skipIfNotBuilt(
    '--format human output names the manager, hook, and command',
    () => {
      materializeAuthorityPolicy();
      const r = applyHooks([
        '--hook',
        'pre-push',
        '--as-role',
        'architect',
        '--write',
        '--format',
        'human',
      ]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('init apply architect');
      expect(r.stdout).toContain('git');
      expect(r.stdout).toContain('pre-push');
      expect(r.stdout).toContain('devai check --only forbidden-actions');
    },
    CLI_TIMEOUT_MS,
  );
});
// Invariants: INV-DEVAI-013
