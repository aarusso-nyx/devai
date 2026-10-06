// #286: every read-modify-replace of .devai/state/worktrees.json runs under one registry
// lock published without replacement (ADR-AUT-0005). These interleavings run a second
// registry writer at the exact point the first holds the lock (its `git worktree add`), so
// they are deterministic: the second writer can neither exceed the cap nor drop an entry.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
} from '@devai-nyx/authority';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WORKTREE_CAP,
  WORKTREE_REGISTRY_LOCK,
  createWorktree,
  destroyWorktree,
  listWorktrees,
  reapWorktrees,
  releaseTaskWorktrees,
  retainWorktree,
} from '../../src/loop/worktrees.js';

let root: string;
let interleave: (() => void) | undefined;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

beforeEach(() => {
  interleave = undefined;
  root = mkdtempSync(join(tmpdir(), 'devai-worktree-registry-'));
  git('init', '--quiet', '--initial-branch=main');
  writeFileSync(join(root, '.gitignore'), '.devai/\n');
  writeFileSync(join(root, 'fixture.txt'), 'base\n');
  git('add', '.gitignore', 'fixture.txt');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'base',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run inside an authority scope; `interleave` runs once, inside the first `git worktree add`. */
function run<T>(callback: () => T): T {
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'worktree-registry-test',
    issuer_version: '1.0.0',
    invocation_id: 'worktree-registry',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'worktree-registry-receipt',
    now: () => new Date().toISOString(),
    receipt_ttl_ms: 30000,
  });
  try {
    return runWithAuthorityHostEffects(
      {
        action_id: 'worktree registry acceptance',
        invocation_id: 'worktree-registry',
        effect: 'local-write',
        receipt_store: issuer,
        apply_effect: (request: AuthorityHostEffectRequest, apply) => {
          if (request.kind === 'filesystem') {
            const path = request.arguments[0];
            if (typeof path === 'string' && !resolve(path).startsWith(resolve(root) + sep))
              throw new Error('WORKTREE_TEST_PATH_OUTSIDE_ROOT');
          }
          const argv = request.arguments[1];
          if (
            request.symbol === 'execFileSync' &&
            Array.isArray(argv) &&
            argv[0] === 'worktree' &&
            argv[1] === 'add' &&
            interleave !== undefined
          ) {
            const second = interleave;
            interleave = undefined;
            second();
          }
          return apply();
        },
      },
      callback,
    );
  } finally {
    issuer.dispose();
  }
}

function registryIds(): string[] {
  const parsed = JSON.parse(readFileSync(join(root, '.devai/state/worktrees.json'), 'utf8')) as {
    worktrees: { id: string }[];
  };
  return parsed.worktrees.map((entry) => entry.id).sort();
}

function attempt(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

const admit = (id: string, lockWaitMs?: number) =>
  createWorktree({
    repoRoot: root,
    id,
    branch: `task/${id}`,
    taskId: `TASK-${id}`,
    ...(lockWaitMs !== undefined && { lockWaitMs }),
  });

describe('serialized worktree registry updates', () => {
  it('refuses a second admitter while the first holds the lock, then keeps both entries', () => {
    let second: unknown;
    run(() => {
      interleave = () => {
        second = attempt(() => admit('WT-b', 0));
      };
      admit('WT-a');
    });
    expect(second).toMatchObject({ message: 'WORKTREE_REGISTRY_BUSY' });
    // The refused admitter created no checkout and wrote nothing.
    expect(existsSync(join(root, '.devai/worktrees/WT-b'))).toBe(false);
    expect(registryIds()).toEqual(['WT-a']);
    expect(existsSync(join(root, WORKTREE_REGISTRY_LOCK))).toBe(false);
    run(() => admit('WT-b'));
    expect(registryIds()).toEqual(['WT-a', 'WT-b']);
  });

  it('never lets two interleaved admitters take the last slot under the cap', () => {
    run(() => {
      for (let index = 1; index < WORKTREE_CAP; index += 1) admit(`WT-fill-${String(index)}`);
    });
    let second: unknown;
    run(() => {
      interleave = () => {
        second = attempt(() => admit('WT-late', 0));
      };
      admit('WT-last');
    });
    expect(second).toMatchObject({ message: 'WORKTREE_REGISTRY_BUSY' });
    const retry = run(() => attempt(() => admit('WT-late')));
    expect(String((retry as Error).message)).toMatch(/^worktree cap exceeded/u);
    expect(registryIds()).toHaveLength(WORKTREE_CAP);
    expect(registryIds()).toContain('WT-last');
    expect(existsSync(join(root, '.devai/worktrees/WT-late'))).toBe(false);
  });

  it.each([
    ['retain', () => retainWorktree({ repoRoot: root, id: 'WT-a', lockWaitMs: 0 })],
    ['release', () => releaseTaskWorktrees({ repoRoot: root, taskId: 'TASK-WT-a', lockWaitMs: 0 })],
    ['destroy', () => destroyWorktree({ repoRoot: root, id: 'WT-a', lockWaitMs: 0 })],
    ['reap', () => reapWorktrees({ repoRoot: root, lockWaitMs: 0 })],
  ])(
    'refuses an interleaved %s instead of replacing the registry from a stale read',
    (_, write) => {
      run(() => admit('WT-a'));
      let second: unknown;
      run(() => {
        interleave = () => {
          second = attempt(write);
        };
        admit('WT-b');
      });
      expect(second).toMatchObject({ message: 'WORKTREE_REGISTRY_BUSY' });
      expect(registryIds()).toEqual(['WT-a', 'WT-b']);
      expect(run(() => listWorktrees({ repoRoot: root })).map((entry) => entry.retained)).toEqual([
        undefined,
        undefined,
      ]);
    },
  );

  it('releases the lock when the guarded update fails', () => {
    run(() => {
      for (let index = 0; index < WORKTREE_CAP; index += 1) admit(`WT-fill-${String(index)}`);
    });
    const refused = run(() => attempt(() => admit('WT-over')));
    expect(String((refused as Error).message)).toMatch(/^worktree cap exceeded/u);
    expect(existsSync(join(root, WORKTREE_REGISTRY_LOCK))).toBe(false);
  });

  it('names a lock left by a gone process instead of taking it over', () => {
    run(() => admit('WT-a'));
    const gone = spawnSync(process.execPath, ['--version']).pid;
    const lock = join(root, WORKTREE_REGISTRY_LOCK);
    const body = `${JSON.stringify({ pid: gone, hostname: hostname(), token: 'gone' })}\n`;
    writeFileSync(lock, body);
    const refused = run(() => attempt(() => admit('WT-b')));
    expect(refused).toMatchObject({
      code: 'WORKTREE_REGISTRY_LOCK_STALE',
      removal: `rm "${lock}"`,
    });
    expect(readFileSync(lock, 'utf8')).toBe(body);
    expect(registryIds()).toEqual(['WT-a']);
    expect(existsSync(join(root, '.devai/worktrees/WT-b'))).toBe(false);
  });

  it('waits for a live holder up to the bound and admits once the lock is gone', () => {
    const lock = join(root, WORKTREE_REGISTRY_LOCK);
    run(() => admit('WT-a'));
    writeFileSync(
      lock,
      `${JSON.stringify({ pid: process.pid, hostname: hostname(), token: 'other' })}\n`,
    );
    const started = Date.now();
    const refused = run(() => attempt(() => admit('WT-b', 60)));
    expect(refused).toMatchObject({ message: 'WORKTREE_REGISTRY_BUSY' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    rmSync(lock);
    run(() => admit('WT-b', 0));
    expect(registryIds()).toEqual(['WT-a', 'WT-b']);
  });
});
