// Invariants: INV-DEVAI-013, INV-DEVAI-018
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHooksInstallPlan,
  executeHooksInstallPlan,
  verifyInstalledPostMergeAdapter,
} from '../../src/services/hooks-install/index.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-hooks-install-'));
  roots.push(path);
  mkdirSync(join(path, '.git/hooks'), { recursive: true });
  return path;
}

function put(base: string, relativePath: string, body: string): string {
  const path = join(base, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

describe('hooks install planning and execution', () => {
  it('creates plain-git and Husky hooks with manager-specific shells', async () => {
    const gitRepo = root();
    const gitPlan = buildHooksInstallPlan({ targetRoot: gitRepo });
    expect(gitPlan).toMatchObject({
      manager: 'git',
      action: 'create',
      hook: 'pre-push',
    });
    expect(gitPlan.command).toContain('--since-ref "$devai_remote_sha"');
    expect(gitPlan.command).toContain('git rev-list --reverse');
    expect(gitPlan.command).toContain('DEVAI_PRE_PUSH_REF_DELETION_REFUSED');
    expect(gitPlan.content).toMatch(/^#!\/usr\/bin\/env sh\n/);

    const huskyRepo = root();
    mkdirSync(join(huskyRepo, '.husky'));
    const huskyPlan = buildHooksInstallPlan({
      targetRoot: huskyRepo,
      hook: 'pre-commit',
      command: 'pnpm lint',
      devaiVersion: '1.2.3',
    });
    expect(huskyPlan).toMatchObject({
      manager: 'husky',
      action: 'create',
      command: 'pnpm lint',
      devaiVersion: '1.2.3',
    });
    expect(huskyPlan.content).not.toContain('#!/usr/bin/env sh');

    await withAuthorityHostTestScope(() => {
      executeHooksInstallPlan(gitPlan);
      executeHooksInstallPlan(huskyPlan);
    });
    expect(readFileSync(gitPlan.path, 'utf8')).toBe(gitPlan.content);
    expect(statSync(gitPlan.path).mode & 0o111).not.toBe(0);
    expect(readFileSync(huskyPlan.path, 'utf8')).toContain('pnpm lint');
  });

  it('appends once and then replaces its exact marker block idempotently', async () => {
    const repo = root();
    const hook = put(repo, '.git/hooks/pre-push', '#!/bin/sh\nexisting-command');
    const appended = buildHooksInstallPlan({
      targetRoot: repo,
      hook: 'pre-push',
      command: 'first-command',
    });
    expect(appended.action).toBe('append');
    expect(appended.content).toContain('existing-command\n\n# >>> devai hooks install >>>');

    await withAuthorityHostTestScope(() => executeHooksInstallPlan(appended));
    const updated = buildHooksInstallPlan({
      targetRoot: repo,
      hook: 'pre-push',
      command: 'second-command',
    });
    expect(updated.action).toBe('update');
    expect(updated.content).toContain('existing-command');
    expect(updated.content).not.toContain('first-command');
    expect(updated.content.match(/# >>> devai hooks install >>>/g)).toHaveLength(1);

    await withAuthorityHostTestScope(() => executeHooksInstallPlan(updated));
    expect(readFileSync(hook, 'utf8')).toBe(updated.content);
  });

  it('passes the exact existing remote SHA as the forbidden-action lower bound', async () => {
    const repo = root();
    const fakeDevai = put(
      repo,
      'node_modules/.bin/devai',
      '#!/usr/bin/env sh\nprintf "%s\\n" "$*" >> hook-args.txt\n',
    );
    chmodSync(fakeDevai, 0o755);
    const plan = buildHooksInstallPlan({ targetRoot: repo, hook: 'pre-push' });
    await withAuthorityHostTestScope(() => executeHooksInstallPlan(plan));
    const remoteSha = 'a'.repeat(40);
    const localSha = 'b'.repeat(40);
    const invoked = spawnSync(plan.path, ['origin', 'https://example.invalid/repo.git'], {
      cwd: repo,
      encoding: 'utf8',
      input: `refs/heads/feature ${localSha} refs/heads/feature ${remoteSha}\n`,
    });

    expect(invoked.status, invoked.stderr).toBe(0);
    expect(readFileSync(join(repo, 'hook-args.txt'), 'utf8')).toBe(
      `check --only forbidden-actions --strict --since-ref ${remoteSha}\n`,
    );
  });

  it('fails closed until every post-merge adapter binding exists', async () => {
    const repo = root();
    const plan = buildHooksInstallPlan({ targetRoot: repo, hook: 'post-merge' });
    expect(plan).toMatchObject({ manager: 'git', action: 'create', hook: 'post-merge' });
    expect(plan.command).toContain('issue-post-merge-receipt.cjs');

    await expect(withAuthorityHostTestScope(() => executeHooksInstallPlan(plan))).rejects.toThrow(
      'POST_MERGE_ADAPTER_AUTHORITY_POLICY_MISSING',
    );

    put(repo, '.devai/config/authority-policy.json', '{}');
    await expect(withAuthorityHostTestScope(() => executeHooksInstallPlan(plan))).rejects.toThrow(
      'POST_MERGE_ADAPTER_CONSTITUTION_MISSING',
    );

    put(repo, 'law/constitution.md', '# Fixture constitution\n');
    await expect(withAuthorityHostTestScope(() => executeHooksInstallPlan(plan))).rejects.toThrow(
      'POST_MERGE_ADAPTER_PACKAGE_VERSION_MISSING',
    );
  });

  it('binds and reuses a signed post-merge adapter at an exact direct HEAD', async () => {
    const repo = root();
    put(repo, '.devai/config/authority-policy.json', '{"schemaVersion":"1.0.0"}\n');
    put(repo, 'law/constitution.md', '# Fixture constitution\n');
    put(repo, '.git/HEAD', 'a'.repeat(40));
    const plan = buildHooksInstallPlan({
      targetRoot: repo,
      hook: 'post-merge',
      devaiVersion: '1.0.0',
    });

    await withAuthorityHostTestScope(() => executeHooksInstallPlan(plan));
    const attestationPath = join(repo, '.devai/config/post-merge-host-adapter.json');
    const first = readFileSync(attestationPath, 'utf8');
    const attestation = JSON.parse(first) as Record<string, unknown>;
    expect(attestation).toMatchObject({
      schemaVersion: '1.0.0',
      repository_id: repo.split('/').at(-1),
      installed_at_head: 'a'.repeat(40),
      package_binding: { name: '@aarusso-nyx/devai', version: '1.0.0' },
    });
    expect(attestation['signature_hmac_sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(repo, '.git/devai/post-merge.key')).mode & 0o077).toBe(0);

    await withAuthorityHostTestScope(() => executeHooksInstallPlan(plan));
    expect(readFileSync(attestationPath, 'utf8')).toBe(first);

    writeFileSync(attestationPath, '{');
    await withAuthorityHostTestScope(() => executeHooksInstallPlan(plan));
    expect(JSON.parse(readFileSync(attestationPath, 'utf8'))).toMatchObject({
      installed_at_head: 'a'.repeat(40),
    });
  });

  it('installs and verifies the post-merge adapter from a linked Husky worktree', async () => {
    const container = mkdtempSync(join(tmpdir(), 'devai-linked-worktree-'));
    roots.push(container);
    const primary = join(container, 'primary');
    const linked = join(container, 'linked');
    mkdirSync(primary);
    expect(spawnSync('git', ['init', '--quiet'], { cwd: primary }).status).toBe(0);
    put(primary, 'README.md', '# fixture\n');
    expect(spawnSync('git', ['add', 'README.md'], { cwd: primary }).status).toBe(0);
    expect(
      spawnSync(
        'git',
        [
          '-c',
          'user.name=DEVAI Test',
          '-c',
          'user.email=devai@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'fixture',
        ],
        { cwd: primary },
      ).status,
    ).toBe(0);
    expect(
      spawnSync('git', ['worktree', 'add', '--quiet', '-b', 'linked-trial', linked], {
        cwd: primary,
      }).status,
    ).toBe(0);
    mkdirSync(join(linked, '.husky'));
    put(linked, '.devai/config/authority-policy.json', '{"schemaVersion":"1.0.0"}\n');
    put(linked, '.devai/pin/constitution.md', '# Pinned constitution\n');
    const binary = put(
      linked,
      'node_modules/.bin/devai',
      '#!/usr/bin/env sh\nif [ "$1" = "--version" ]; then echo "devai/1.1.0-rc.2"; fi\nexit 0\n',
    );
    chmodSync(binary, 0o755);

    const plan = buildHooksInstallPlan({
      targetRoot: linked,
      hook: 'post-merge',
      devaiVersion: '1.1.0-rc.2',
    });
    expect(plan).toMatchObject({
      manager: 'husky',
      path: join(linked, '.husky/post-merge'),
      hook: 'post-merge',
    });

    await withAuthorityHostTestScope(() => executeHooksInstallPlan(plan));
    const adminRoot = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: linked,
      encoding: 'utf8',
    }).stdout.trim();
    expect(statSync(join(adminRoot, 'devai/post-merge.key')).mode & 0o077).toBe(0);
    expect(spawnSync('sh', [plan.path], { cwd: linked, encoding: 'utf8' }).status).toBe(0);
    expect(readFileSync(join(adminRoot, 'devai/post-merge-receipt.json'), 'utf8')).toContain(
      '"merge_sha"',
    );
    expect(
      await withAuthorityHostTestScope(() =>
        verifyInstalledPostMergeAdapter(linked, '1.1.0-rc.2'),
      ),
    ).toMatchObject({
      ok: true,
      errors: [],
      facts: {
        hook_present: true,
        key_present: true,
        hook_local_binary: true,
        installed_head_bound: true,
      },
    });
  });

  it('resolves loose and packed symbolic HEADs and refuses unavailable identities', async () => {
    for (const [kind, setup] of [
      [
        'loose',
        (repo: string) => {
          put(repo, '.git/HEAD', 'ref: refs/heads/main\n');
          put(repo, '.git/refs/heads/main', `${'b'.repeat(40)}\n`);
        },
      ],
      [
        'packed',
        (repo: string) => {
          put(repo, '.git/HEAD', 'ref: refs/heads/main\n');
          put(repo, '.git/packed-refs', `${'c'.repeat(40)} refs/heads/main\n`);
        },
      ],
    ] as const) {
      const repo = root();
      put(repo, '.devai/config/authority-policy.json', '{}');
      put(repo, '.devai/pin/constitution.md', '# Pinned\n');
      setup(repo);
      const plan = buildHooksInstallPlan({
        targetRoot: repo,
        hook: 'post-merge',
        devaiVersion: '1.0.0-test',
      });
      await withAuthorityHostTestScope(() => executeHooksInstallPlan(plan));
      const attestation = JSON.parse(
        readFileSync(join(repo, '.devai/config/post-merge-host-adapter.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(attestation['installed_at_head'], kind).toBe(
        kind === 'loose' ? 'b'.repeat(40) : 'c'.repeat(40),
      );
    }

    const unavailable = root();
    put(unavailable, '.devai/config/authority-policy.json', '{}');
    put(unavailable, '.devai/constitution.md', '# Legacy pin\n');
    put(unavailable, '.git/HEAD', 'ref: refs/heads/missing\n');
    const plan = buildHooksInstallPlan({
      targetRoot: unavailable,
      hook: 'post-merge',
      devaiVersion: '1.0.0',
    });
    await expect(withAuthorityHostTestScope(() => executeHooksInstallPlan(plan))).rejects.toThrow(
      'POST_MERGE_ADAPTER_HEAD_UNAVAILABLE',
    );
  });
});
