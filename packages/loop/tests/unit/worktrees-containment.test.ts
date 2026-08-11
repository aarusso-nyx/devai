// Invariants: INV-DEVAI-004, INV-DEVAI-005, INV-DEVAI-017
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { destroyWorktree } from '../../src/loop/worktrees.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

describe('managed worktree destruction containment', () => {
  it('KR-R5-019 rejects an external mutable-registry path without deleting it', async () => {
    const repo = temp('devai-worktree-repo-');
    const external = temp('devai-worktree-external-');
    const marker = join(external, 'preserve.txt');
    writeFileSync(marker, 'preserve\n');
    const registry = join(repo, '.devai/state/worktrees.json');
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(
      registry,
      `${JSON.stringify({
        worktrees: [
          {
            id: 'WT-unsafe',
            path: external,
            branch: 'unsafe',
            created_at: '2026-07-26T00:00:00.000Z',
          },
        ],
      })}\n`,
    );

    await withAuthorityHostTestScope(() => {
      expect(() => destroyWorktree({ repoRoot: repo, id: 'WT-unsafe' })).toThrow(
        'WORKTREE_REGISTRY_PATH_INVALID',
      );
    });
    expect(existsSync(marker)).toBe(true);
  });

  it('rejects traversal-shaped ids before registry interpretation', () => {
    expect(() =>
      destroyWorktree({ repoRoot: temp('devai-worktree-repo-'), id: 'WT-../escape' }),
    ).toThrow('invalid managed worktree id');
  });

  it('rejects a symlink at the exact managed path without touching its target', async () => {
    const repo = temp('devai-worktree-repo-');
    const external = temp('devai-worktree-external-');
    const marker = join(external, 'preserve.txt');
    writeFileSync(marker, 'preserve\n');
    const managed = join(repo, '.devai/worktrees/WT-linked');
    mkdirSync(dirname(managed), { recursive: true });
    symlinkSync(external, managed);
    const registry = join(repo, '.devai/state/worktrees.json');
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(
      registry,
      `${JSON.stringify({
        worktrees: [
          {
            id: 'WT-linked',
            path: managed,
            branch: 'linked',
            created_at: '2026-07-26T00:00:00.000Z',
          },
        ],
      })}\n`,
    );

    await withAuthorityHostTestScope(() => {
      expect(() => destroyWorktree({ repoRoot: repo, id: 'WT-linked' })).toThrow(
        'WORKTREE_REGISTRY_PATH_INVALID',
      );
    });
    expect(existsSync(marker)).toBe(true);
  });

  it('rejects an exact-looking directory that Git has not registered', async () => {
    const repo = temp('devai-worktree-repo-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const managed = join(repo, '.devai/worktrees/WT-unregistered');
    mkdirSync(managed, { recursive: true });
    const marker = join(managed, 'preserve.txt');
    writeFileSync(marker, 'preserve\n');
    const registry = join(repo, '.devai/state/worktrees.json');
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(
      registry,
      `${JSON.stringify({
        worktrees: [
          {
            id: 'WT-unregistered',
            path: managed,
            branch: 'unregistered',
            created_at: '2026-07-26T00:00:00.000Z',
          },
        ],
      })}\n`,
    );

    await withAuthorityHostTestScope(() => {
      expect(() => destroyWorktree({ repoRoot: repo, id: 'WT-unregistered' })).toThrow(
        'WORKTREE_GIT_REGISTRATION_MISSING',
      );
    });
    expect(existsSync(marker)).toBe(true);
  });

  it('fails closed on a corrupt registry', () => {
    const repo = temp('devai-worktree-repo-');
    const registry = join(repo, '.devai/state/worktrees.json');
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, '{not-json');
    expect(() => destroyWorktree({ repoRoot: repo, id: 'WT-corrupt' })).toThrow();
  });
});
