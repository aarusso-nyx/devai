import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAuditObservation } from '../../src/post-merge-auditor/index.js';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'DEVAI Test',
      GIT_AUTHOR_EMAIL: 'devai-test@example.invalid',
      GIT_COMMITTER_NAME: 'DEVAI Test',
      GIT_COMMITTER_EMAIL: 'devai-test@example.invalid',
    },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe('explicit Auditor observation', () => {
  it('is exact-SHA, non-promoting, atomic, and replay-idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-audit-observation-'));
    roots.push(root);
    git(root, ['init', '-b', 'main']);
    writeFileSync(join(root, 'README.md'), '# Fixture\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'test: initial']);
    const at = git(root, ['rev-parse', 'HEAD']);

    const first = await withAuthorityHostTestScope(() =>
      runAuditObservation({ repoRoot: root, at }),
    );
    const second = await withAuthorityHostTestScope(() =>
      runAuditObservation({ repoRoot: root, at }),
    );

    expect(first).toMatchObject({ status: 'completed', at, readiness_promoting: false });
    expect(first.artifacts).toHaveLength(5);
    expect(second).toEqual({ ...first, status: 'replayed' });
    await expect(
      withAuthorityHostTestScope(() => runAuditObservation({ repoRoot: root, at: 'a'.repeat(40) })),
    ).rejects.toThrow('AUDIT_OBSERVE_EXACT_HEAD_REQUIRED');
  });
});
