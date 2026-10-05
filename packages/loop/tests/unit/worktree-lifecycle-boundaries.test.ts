import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createAuthorityDecisionIssuer, runWithAuthorityHostEffects } from '@devai-nyx/authority';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptWorktree,
  createWorktree,
  destroyWorktree,
  holdsWorktreeCapacity,
  listWorktrees,
  reapWorktrees,
  releaseTaskWorktrees,
  retainWorktree,
  WORKTREE_CAP,
} from '../../src/loop/worktrees.js';
let root: string;
const now = '2026-09-08T12:00:00.000Z';
function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-worktree-lifecycle-'));
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
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
function run<T>(callback: () => T): T {
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'worktree-lifecycle-test',
    issuer_version: '1.0.0',
    invocation_id: 'worktree-lifecycle',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'worktree-lifecycle-receipt',
    now: () => now,
    receipt_ttl_ms: 30000,
  });
  try {
    return runWithAuthorityHostEffects(
      {
        action_id: 'worktree lifecycle acceptance',
        invocation_id: 'worktree-lifecycle',
        effect: 'local-write',
        receipt_store: issuer,
        apply_effect: (request, apply) => {
          if (request.kind === 'filesystem') {
            const path = request.arguments[0];
            if (typeof path !== 'string' || !resolve(path).startsWith(resolve(root) + sep))
              throw new Error('WORKTREE_TEST_PATH_OUTSIDE_ROOT');
          } else if (request.kind === 'process') {
            const [executable, , opts] = request.arguments;
            if (executable !== 'git' || (opts as { cwd?: unknown } | undefined)?.cwd !== root)
              throw new Error('WORKTREE_TEST_PROCESS_OUTSIDE_ROOT');
          } else throw new Error('WORKTREE_TEST_EFFECT_UNSUPPORTED');
          return apply();
        },
      },
      callback,
    );
  } finally {
    issuer.dispose();
  }
}

describe('managed worktree lifecycle in an owned temporary repository', () => {
  it('creates and records a task worktree at the default HEAD', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    const record = run(() =>
      createWorktree({ repoRoot: root, id: 'WT-task-1', branch: 'task/one', taskId: 'TASK-9701' }),
    );
    expect(record).toEqual({
      id: 'WT-task-1',
      path: resolve(root, '.devai/worktrees/WT-task-1'),
      branch: 'task/one',
      task_id: 'TASK-9701',
      created_at: now,
    });
    expect(readFileSync(join(record.path, 'fixture.txt'), 'utf8')).toBe('base\n');
    expect(git('rev-parse', 'task/one')).toBe(git('rev-parse', 'HEAD'));
    expect(run(() => listWorktrees({ repoRoot: root }))).toEqual([record]);
  });
  it('honors an explicit older base without recording optional task fields', () => {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'fixture.txt'), 'later\n');
    git('add', 'fixture.txt');
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
      'advance',
    );
    const record = run(() =>
      createWorktree({ repoRoot: root, id: 'WT-base', branch: 'from/base', baseRef: base }),
    );
    expect(readFileSync(join(record.path, 'fixture.txt'), 'utf8')).toBe('base\n');
    expect(record).not.toHaveProperty('task_id');
    expect(record).not.toHaveProperty('human_adopted');
    expect(git('rev-parse', 'from/base')).toBe(base);
  });
  it('checks out an existing human review branch without trying to recreate it', () => {
    git('branch', 'review/topic');
    const head = git('rev-parse', 'review/topic');
    const record = run(() => adoptWorktree({ repoRoot: root, branch: 'review/topic' }));
    expect(record).toMatchObject({
      id: 'WT-human-review-topic',
      branch: 'review/topic',
      human_adopted: true,
    });
    expect(git('rev-parse', 'review/topic')).toBe(head);
    expect(readFileSync(join(record.path, 'fixture.txt'), 'utf8')).toBe('base\n');
  });
  it('refuses an already checked-out branch without changing it or recording a worktree', () => {
    const before = git('rev-parse', 'main');
    expect(() =>
      run(() => createWorktree({ repoRoot: root, id: 'WT-main', branch: 'main' })),
    ).toThrow();
    expect(git('rev-parse', 'main')).toBe(before);
    expect(existsSync(join(root, '.devai/state/worktrees.json'))).toBe(false);
    expect(existsSync(join(root, '.devai/worktrees/WT-main'))).toBe(false);
  });
  it('derives the autonomous cap from round-execution.json capacity.max_workers (ADR-MDL-0007)', () => {
    const policy = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', '..', '..', 'law/policy/round-execution.json'),
        'utf8',
      ),
    ) as { capacity: { max_workers: number } };
    expect(WORKTREE_CAP).toBe(policy.capacity.max_workers);
  });
  it('enforces the autonomous cap while preserving the registry and permits a human-adopted worktree', () => {
    for (let i = 0; i < WORKTREE_CAP; i++)
      run(() => createWorktree({ repoRoot: root, id: `WT-cap-${i}`, branch: `cap/${i}` }));
    const path = join(root, '.devai/state/worktrees.json');
    const before = readFileSync(path);
    expect(() =>
      run(() => createWorktree({ repoRoot: root, id: 'WT-over', branch: 'over' })),
    ).toThrow(
      `worktree cap exceeded: ${String(WORKTREE_CAP)} autonomous worktrees already active.`,
    );
    expect(readFileSync(path)).toEqual(before);
    expect(git('branch', '--list', 'over')).toBe('');
    const adopted = run(() =>
      createWorktree({ repoRoot: root, id: 'WT-human', branch: 'human/new', humanAdopted: true }),
    );
    expect(adopted.human_adopted).toBe(true);
    expect(run(() => listWorktrees({ repoRoot: root }))).toHaveLength(WORKTREE_CAP + 1);
  });
  it('does not count retained worktrees or those left by a provably gone attempt process', () => {
    for (let i = 0; i < WORKTREE_CAP; i++) {
      run(() => createWorktree({ repoRoot: root, id: `WT-review-${i}`, branch: `review/${i}` }));
      run(() => retainWorktree({ repoRoot: root, id: `WT-review-${i}` }));
    }
    const gone = spawnSync(process.execPath, ['--version']).pid;
    run(() =>
      createWorktree({
        repoRoot: root,
        id: 'WT-crashed',
        branch: 'crashed',
        owner: { pid: gone, hostname: hostname() },
      }),
    );
    for (let i = 0; i < WORKTREE_CAP; i++)
      run(() =>
        createWorktree({
          repoRoot: root,
          id: `WT-live-${i}`,
          branch: `live/${i}`,
          owner: { pid: process.pid, hostname: hostname() },
        }),
      );
    expect(() =>
      run(() => createWorktree({ repoRoot: root, id: 'WT-over', branch: 'over' })),
    ).toThrow('worktree cap exceeded');
    const records = run(() => listWorktrees({ repoRoot: root }));
    expect(records.filter(holdsWorktreeCapacity).map((record) => record.id)).toEqual(
      Array.from({ length: WORKTREE_CAP }, (_, i) => `WT-live-${i}`),
    );
    // An owner on another host is never provably gone, so it keeps its slot.
    expect(
      holdsWorktreeCapacity({
        id: 'WT-remote',
        path: '/x',
        branch: 'remote',
        created_at: now,
        owner: { pid: gone, hostname: `${hostname()}-elsewhere` },
      }),
    ).toBe(true);
    expect(() => run(() => retainWorktree({ repoRoot: root, id: 'WT-missing' }))).toThrow(
      'WORKTREE_NOT_REGISTERED',
    );
  });
  it('releases every managed worktree bound to one task and keeps branches and other tasks', () => {
    const first = run(() =>
      createWorktree({ repoRoot: root, id: 'WT-TASK-0001-A1', branch: 'a/1', taskId: 'TASK-0001' }),
    );
    run(() =>
      createWorktree({ repoRoot: root, id: 'WT-TASK-0001-A2', branch: 'a/2', taskId: 'TASK-0001' }),
    );
    run(() =>
      createWorktree({ repoRoot: root, id: 'WT-TASK-0002-A1', branch: 'b/1', taskId: 'TASK-0002' }),
    );
    git('worktree', 'remove', '--force', first.path);
    expect(run(() => releaseTaskWorktrees({ repoRoot: root, taskId: 'TASK-0001' }))).toEqual([
      'WT-TASK-0001-A1',
      'WT-TASK-0001-A2',
    ]);
    expect(run(() => listWorktrees({ repoRoot: root })).map((record) => record.id)).toEqual([
      'WT-TASK-0002-A1',
    ]);
    expect(existsSync(join(root, '.devai/worktrees/WT-TASK-0001-A2'))).toBe(false);
    expect(
      git('branch', '--list', 'a/1', 'a/2')
        .split('\n')
        .map((line) => line.trim()),
    ).toEqual(['a/1', 'a/2']);
  });
  it('does not turn a stale human-adopted registry entry into an extra autonomous slot', () => {
    const human = run(() =>
      createWorktree({
        repoRoot: root,
        id: 'WT-human',
        branch: 'human/review',
        humanAdopted: true,
      }),
    );
    for (let i = 0; i < WORKTREE_CAP; i++)
      run(() => createWorktree({ repoRoot: root, id: `WT-auto-${i}`, branch: `auto/${i}` }));
    git('worktree', 'remove', human.path);
    const registry = join(root, '.devai/state/worktrees.json');
    const before = readFileSync(registry);
    expect(() =>
      run(() => createWorktree({ repoRoot: root, id: human.id, branch: human.branch })),
    ).toThrow('worktree cap exceeded');
    expect(readFileSync(registry)).toEqual(before);
    expect(existsSync(human.path)).toBe(false);
  });

  it('does not count human-adopted entries against the autonomous cap', () => {
    run(() =>
      createWorktree({ repoRoot: root, id: 'WT-human', branch: 'human/new', humanAdopted: true }),
    );
    for (let i = 0; i < WORKTREE_CAP; i++)
      run(() => createWorktree({ repoRoot: root, id: `WT-auto-${i}`, branch: `auto/${i}` }));
    expect(run(() => listWorktrees({ repoRoot: root }))).toHaveLength(WORKTREE_CAP + 1);
  });
  it.each(['WT-../escape', 'WT-a/b', 'wrong', 'WT-'])(
    'refuses invalid managed id %s without creating a branch or registry',
    (id) => {
      expect(() => run(() => createWorktree({ repoRoot: root, id, branch: 'unsafe' }))).toThrow(
        'invalid managed worktree id',
      );
      expect(existsSync(join(root, '.devai/state/worktrees.json'))).toBe(false);
      expect(git('branch', '--list', 'unsafe')).toBe('');
    },
  );
  it('keeps human worktrees unless forced and preserves their branch by default', () => {
    const record = run(() =>
      createWorktree({ repoRoot: root, id: 'WT-human', branch: 'human/new', humanAdopted: true }),
    );
    const before = readFileSync(join(root, '.devai/state/worktrees.json'));
    expect(() => run(() => destroyWorktree({ repoRoot: root, id: record.id }))).toThrow(
      'refusing to destroy human-adopted worktree: WT-human',
    );
    expect(readFileSync(join(root, '.devai/state/worktrees.json'))).toEqual(before);
    expect(existsSync(record.path)).toBe(true);
    run(() => destroyWorktree({ repoRoot: root, id: record.id, forceHumanAdopted: true }));
    expect(existsSync(record.path)).toBe(false);
    expect(git('branch', '--list', 'human/new')).toContain('human/new');
    expect(run(() => listWorktrees({ repoRoot: root }))).toEqual([]);
  });
  it('deletes only an explicitly selected task branch along with its worktree', () => {
    const selected = run(() =>
      createWorktree({ repoRoot: root, id: 'WT-selected', branch: 'selected' }),
    );
    const other = run(() => createWorktree({ repoRoot: root, id: 'WT-other', branch: 'other' }));
    run(() => destroyWorktree({ repoRoot: root, id: selected.id, deleteBranch: true }));
    expect(existsSync(selected.path)).toBe(false);
    expect(existsSync(other.path)).toBe(true);
    expect(git('branch', '--list', 'selected')).toBe('');
    expect(git('branch', '--list', 'other')).toContain('other');
    expect(run(() => listWorktrees({ repoRoot: root }))).toEqual([other]);
  });
  it('reaps only missing registry entries and preserves unknown directories and unrelated bytes', () => {
    const z = run(() => createWorktree({ repoRoot: root, id: 'WT-z', branch: 'z' }));
    const a = run(() => createWorktree({ repoRoot: root, id: 'WT-a', branch: 'a' }));
    const active = run(() => createWorktree({ repoRoot: root, id: 'WT-active', branch: 'active' }));
    git('worktree', 'remove', z.path);
    git('worktree', 'remove', a.path);
    const unknown = join(root, '.devai/worktrees/owner-data');
    mkdirSync(unknown);
    writeFileSync(join(unknown, 'preserve.txt'), 'preserve\n');
    expect(run(() => reapWorktrees({ repoRoot: root }))).toEqual(['WT-a', 'WT-z']);
    expect(run(() => listWorktrees({ repoRoot: root }))).toEqual([active]);
    expect(readFileSync(join(unknown, 'preserve.txt'), 'utf8')).toBe('preserve\n');
    expect(existsSync(active.path)).toBe(true);
  });
  it('sorts listing output by ID and leaves the stored order untouched', () => {
    const z = run(() => createWorktree({ repoRoot: root, id: 'WT-z', branch: 'z' }));
    const a = run(() => createWorktree({ repoRoot: root, id: 'WT-a', branch: 'a' }));
    const path = join(root, '.devai/state/worktrees.json');
    const before = readFileSync(path);
    expect(run(() => listWorktrees({ repoRoot: root }))).toEqual([a, z]);
    expect(readFileSync(path)).toEqual(before);
  });
});
