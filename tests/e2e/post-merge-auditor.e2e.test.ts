// Invariants: INV-DEVAI-018
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..', '..', 'packages', 'cli');
const REAL_BIN = join(PKG_ROOT, 'dist', 'runtime', 'index', 'bin.js');
const CONSTITUTION = join(PKG_ROOT, '..', '..', 'law', 'constitution.md');
const skipIfNotBuilt = existsSync(REAL_BIN) ? it : it.skip;
const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'DEVAI Test',
  GIT_AUTHOR_EMAIL: 'devai-test@example.invalid',
  GIT_COMMITTER_NAME: 'DEVAI Test',
  GIT_COMMITTER_EMAIL: 'devai-test@example.invalid',
};

let repo = '';
let shimDir = '';

function git(args: readonly string[], env = gitEnv) {
  return spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
}

function commitFile(name: string, content: string): void {
  writeFileSync(join(repo, name), content);
  expect(git(['add', name]).status).toBe(0);
  expect(git(['commit', '-m', `test: ${name}`]).status).toBe(0);
}

function materializeAuthorityPolicy(): void {
  const constitution = spawnSync(
    'node',
    [
      REAL_BIN,
      'init',
      'bind',
      '--constitution',
      '--target',
      repo,
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ],
    { cwd: repo, env: gitEnv, encoding: 'utf8' },
  );
  expect(constitution.status, constitution.stderr).toBe(0);

  const result = spawnSync(
    'node',
    [
      REAL_BIN,
      'init',
      'bind',
      '--target',
      repo,
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ],
    { cwd: repo, env: gitEnv, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(repo, '.devai/config/authority-policy.json'))).toBe(true);
}

function install() {
  return spawnSync(
    'node',
    [
      REAL_BIN,
      'init',
      'apply',
      'architect',
      '--target',
      repo,
      '--include',
      'hooks',
      '--hook',
      'post-merge',
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ],
    { cwd: repo, env: gitEnv, encoding: 'utf8' },
  );
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'devai-r21-post-merge-e2e-'));
  expect(git(['init', '-b', 'main']).status).toBe(0);
  writeFileSync(join(repo, '.gitignore'), '.devai/state/\n.devai/worktrees/\nscratch/worktrees/\n');
  mkdirSync(join(repo, 'law'), { recursive: true });
  writeFileSync(join(repo, 'law', 'constitution.md'), readFileSync(CONSTITUTION, 'utf8'));
  commitFile('README.md', 'initial\n');
  commitFile('law/constitution.md', readFileSync(CONSTITUTION, 'utf8'));
  expect(git(['add', '.gitignore']).status).toBe(0);
  expect(git(['commit', '-m', 'test: ignore runtime state']).status).toBe(0);
  shimDir = mkdtempSync(join(tmpdir(), 'devai-r21-bin-'));
  const shim = join(shimDir, 'devai');
  writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(REAL_BIN)} "$@"\n`);
  chmodSync(shim, 0o755);
  gitEnv.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
});

function runHookAsync(): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(join(repo, '.git/hooks/post-merge'), [], {
      cwd: repo,
      env: gitEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

describe('Article 34 post-merge Auditor composite', () => {
  skipIfNotBuilt(
    'refuses a missing host receipt before creating state or a worktree',
    () => {
      const result = spawnSync(
        'node',
        [REAL_BIN, 'round', 'close', '--post-merge-receipt', '--repo-root', repo],
        {
          cwd: repo,
          env: gitEnv,
          encoding: 'utf8',
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/host receipt missing/i);
      expect(existsSync(join(repo, '.devai/state/post-merge-auditor'))).toBe(false);
      expect(existsSync(join(repo, '.devai/worktrees/auditor-post-merge'))).toBe(false);
    },
    90_000,
  );

  skipIfNotBuilt(
    'refuses a forged host receipt before creating state or a worktree',
    () => {
      materializeAuthorityPolicy();
      const forged = join(repo, 'forged-host-receipt.json');
      writeFileSync(
        forged,
        JSON.stringify({
          schemaVersion: '1.0.0',
          repository: repo,
          merge_sha: '1111111111111111111111111111111111111111',
          issuer: 'untrusted-caller',
          signature: 'forged',
        }),
      );
      const result = spawnSync(
        'node',
        [
          REAL_BIN,
          'round',
          'close',
          '--post-merge-receipt',
          '--host-receipt',
          forged,
          '--repo-root',
          repo,
        ],
        { cwd: repo, env: gitEnv, encoding: 'utf8' },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/host receipt (?:invalid|unverified)/i);
      expect(existsSync(join(repo, '.devai/state/post-merge-auditor'))).toBe(false);
      expect(existsSync(join(repo, '.devai/worktrees/auditor-post-merge'))).toBe(false);
    },
    90_000,
  );

  skipIfNotBuilt(
    'processes every merge exactly once in persistent isolated state and leaves tracked roots clean',
    async () => {
      materializeAuthorityPolicy();
      const installed = install();
      expect(installed.status, installed.stderr).toBe(0);
      expect(existsSync(join(repo, '.git/hooks/post-merge'))).toBe(true);
      expect(git(['add', '.devai/config', '.devai/pin', '.devai/constitution.md']).status).toBe(0);
      expect(git(['commit', '-m', 'test: authority and host adapter']).status).toBe(0);

      for (const [branch, file] of [
        ['feature-one', 'one.txt'],
        ['feature-two', 'two.txt'],
      ] as const) {
        expect(git(['checkout', '-b', branch]).status).toBe(0);
        commitFile(file, `${branch}\n`);
        expect(git(['checkout', 'main']).status).toBe(0);
        const merged = git(['merge', '--no-ff', branch, '-m', `merge ${branch}`]);
        expect(merged.status, merged.stderr).toBe(0);
      }

      const stateRoot = join(repo, '.git/devai/post-merge-observations');
      const bundles = readdirSync(stateRoot).filter((entry) => /^[0-9a-f]{40}$/.test(entry));
      expect(bundles).toHaveLength(2);
      expect(existsSync(join(repo, '.devai/worktrees/auditor-post-merge/.git'))).toBe(true);

      const replays = await Promise.all([runHookAsync(), runHookAsync()]);
      expect(replays.every((result) => result.status === 0)).toBe(true);
      expect(replays.map((result) => result.stderr).join('\n')).toBe('\n');
      expect(readdirSync(stateRoot).filter((entry) => /^[0-9a-f]{40}$/.test(entry))).toHaveLength(
        2,
      );
      expect(git(['status', '--porcelain']).stdout).toBe('');
      const worktreeStatus = spawnSync('git', ['status', '--porcelain'], {
        cwd: join(repo, '.devai/worktrees/auditor-post-merge'),
        encoding: 'utf8',
      }).stdout;
      expect(worktreeStatus).toBe('');
    },
    90_000,
  );

  skipIfNotBuilt(
    'returns busy under the repository lock and processes after release',
    () => {
      materializeAuthorityPolicy();
      expect(install().status).toBe(0);
      expect(git(['add', '.devai/config', '.devai/pin', '.devai/constitution.md']).status).toBe(0);
      expect(git(['commit', '-m', 'test: authority and host adapter']).status).toBe(0);
      expect(git(['checkout', '-b', 'feature-lock']).status).toBe(0);
      commitFile('lock.txt', 'lock fixture\n');
      expect(git(['checkout', 'main']).status).toBe(0);

      const lockPath = join(repo, '.git/devai/post-merge.lock');
      mkdirSync(lockPath);
      const merged = git(['merge', '--no-ff', 'feature-lock', '-m', 'merge lock fixture']);
      expect(merged.status, merged.stderr).toBe(0);
      expect(existsSync(join(repo, '.devai/worktrees/auditor-post-merge'))).toBe(false);

      const locked = spawnSync(join(repo, '.git/hooks/post-merge'), [], {
        cwd: repo,
        env: gitEnv,
        encoding: 'utf8',
      });
      expect(locked.status, locked.stderr).toBe(0);
      expect(locked.stdout).toContain('"status":"busy"');
      expect(existsSync(join(repo, '.devai/worktrees/auditor-post-merge'))).toBe(false);

      rmSync(lockPath, { recursive: true, force: true });
      const replay = spawnSync(join(repo, '.git/hooks/post-merge'), [], {
        cwd: repo,
        env: gitEnv,
        encoding: 'utf8',
      });
      expect(replay.status, replay.stderr).toBe(0);
      const mergeSha = git(['rev-parse', 'HEAD']).stdout.trim();
      expect(
        JSON.parse(
          readFileSync(
            join(repo, '.git/devai/post-merge-observations', mergeSha, 'status.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({ status: 'completed' });
      expect(git(['status', '--porcelain']).stdout).toBe('');
    },
    90_000,
  );

  skipIfNotBuilt(
    'reports an injected observation failure without undoing the merge',
    () => {
      materializeAuthorityPolicy();
      expect(install().status).toBe(0);
      expect(git(['add', '.devai/config', '.devai/pin', '.devai/constitution.md']).status).toBe(0);
      expect(git(['commit', '-m', 'test: authority and host adapter']).status).toBe(0);
      expect(git(['checkout', '-b', 'feature-failure']).status).toBe(0);
      commitFile('failure.txt', 'failure fixture\n');
      expect(git(['checkout', 'main']).status).toBe(0);
      const before = git(['rev-parse', 'HEAD']).stdout.trim();
      const merged = git(['merge', '--no-ff', 'feature-failure', '-m', 'merge failure fixture'], {
        ...gitEnv,
        DEVAI_TEST_POST_MERGE_FAIL: '1',
      });
      const after = git(['rev-parse', 'HEAD']).stdout.trim();

      expect(after).not.toBe(before);
      expect(git(['merge-base', '--is-ancestor', before, after]).status).toBe(0);
      const injectedFailure = `${merged.stdout}\n${merged.stderr}`
        .split(/\r?\n/u)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((entry) => entry?.['code'] === 'POST_MERGE_OBSERVATION_INJECTED_FAILURE');
      expect(injectedFailure).toMatchObject({
        code: 'POST_MERGE_OBSERVATION_INJECTED_FAILURE',
        operation: 'close-post-merge',
        exit: 2,
      });
      const failed = join(repo, '.git/devai/post-merge-observations', after, 'status.json');
      expect(JSON.parse(readFileSync(failed, 'utf8'))).toMatchObject({ status: 'error' });
    },
    90_000,
  );

  skipIfNotBuilt(
    'retries a failed merge after a human resolves the observation failure',
    () => {
      materializeAuthorityPolicy();
      expect(install().status).toBe(0);
      expect(git(['add', '.devai/config', '.devai/pin', '.devai/constitution.md']).status).toBe(0);
      expect(git(['commit', '-m', 'test: authority and host adapter']).status).toBe(0);
      expect(git(['checkout', '-b', 'feature-retry']).status).toBe(0);
      commitFile('retry.txt', 'retry fixture\n');
      expect(git(['checkout', 'main']).status).toBe(0);
      const merged = git(['merge', '--no-ff', 'feature-retry', '-m', 'merge retry fixture'], {
        ...gitEnv,
        DEVAI_TEST_POST_MERGE_FAIL: '1',
      });
      expect(merged.status).toBe(0);

      const mergeSha = git(['rev-parse', 'HEAD']).stdout.trim();
      const bundle = join(repo, '.git/devai/post-merge-observations', mergeSha);
      expect(JSON.parse(readFileSync(join(bundle, 'status.json'), 'utf8'))).toMatchObject({
        status: 'error',
      });

      // ADR-004 Decision 7 makes failed state durable "until a human resolves
      // and reruns it". The rerun must therefore replace the failed attempt,
      // not treat the existence of its bundle directory as completed work.
      const retry = spawnSync(join(repo, '.git/hooks/post-merge'), [], {
        cwd: repo,
        env: gitEnv,
        encoding: 'utf8',
      });
      expect(retry.status, retry.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(bundle, 'status.json'), 'utf8'))).toMatchObject({
        status: 'completed',
      });
      expect(existsSync(join(bundle, 'inventory.json'))).toBe(true);
      expect(existsSync(join(bundle, 'scorecard.json'))).toBe(true);
      expect(git(['status', '--porcelain']).stdout).toBe('');
    },
    90_000,
  );
});
