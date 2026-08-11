import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, beforeEach, describe, expect, it } from 'vitest';
import { gatherGitContext } from '../../src/evidence/git-context.js';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

aroundEach((runTest) => withAuthorityHostTestScope(runTest));

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'devai-git-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('gatherGitContext', () => {
  it('returns null head and empty dirty_files outside a git repository', () => {
    const ctx = gatherGitContext(tempDir);
    expect(ctx.head_sha).toBeNull();
    expect(ctx.dirty_files).toEqual([]);
  });

  it('returns the head SHA and no dirty files in a clean repo', () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tempDir });
    writeFileSync(join(tempDir, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tempDir });

    const ctx = gatherGitContext(tempDir);
    expect(ctx.head_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(ctx.dirty_files).toEqual([]);
  });

  it('lists modified and untracked files when present', () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tempDir });
    writeFileSync(join(tempDir, 'tracked.txt'), 'v1\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tempDir });
    // Modify tracked, add new untracked.
    writeFileSync(join(tempDir, 'tracked.txt'), 'v2\n');
    writeFileSync(join(tempDir, 'new.txt'), 'fresh\n');

    const ctx = gatherGitContext(tempDir);
    expect(ctx.head_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(ctx.dirty_files.sort()).toEqual(['new.txt', 'tracked.txt']);
  });
});
// Invariants: INV-DEVAI-001
