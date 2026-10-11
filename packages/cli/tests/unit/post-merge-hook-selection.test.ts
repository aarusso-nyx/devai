// ADR-AUT-0007: selection precedes every checkout-local issuer and round-close effect.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { put, snapshot } from '../../../../tests/helpers/workflow-inventory-fixture.js';
import { buildHooksInstallPlan } from '../../src/services/hooks-install/index.js';

const roots: string[] = [];
const local = {
  mode: 'host-integrated',
  adapter_config: '.devai/config/post-merge-host-adapter.json',
};
const github = {
  mode: 'host-integrated',
  adapter_config: '.devai/config/github-actions-host-adapter.json',
};
function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'DEVAI Inspector',
      GIT_AUTHOR_EMAIL: 'inspector@devai.local',
      GIT_COMMITTER_NAME: 'DEVAI Inspector',
      GIT_COMMITTER_EMAIL: 'inspector@devai.local',
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function fixture(linked = false) {
  const container = mkdtempSync(join(tmpdir(), 'devai selected hook ç '));
  roots.push(container);
  const primary = join(container, 'primary');
  mkdirSync(primary);
  git(primary, ['init', '--quiet']);
  put(primary, 'README.md', '# Fixture\n');
  git(primary, ['add', 'README.md']);
  git(primary, ['commit', '--quiet', '-m', 'fixture']);
  const root = linked ? join(container, 'linked') : primary;
  if (linked) git(primary, ['worktree', 'add', '--quiet', '-b', 'linked-fixture', root]);
  const admin = git(root, ['rev-parse', '--absolute-git-dir']);
  const plan = buildHooksInstallPlan({ targetRoot: root, hook: 'post-merge' });
  const hook = join(root, 'generated-post-merge.sh');
  put(root, 'generated-post-merge.sh', `#!/bin/sh\n${plan.command}\n`);
  const binary = join(root, 'node_modules/.bin/devai');
  put(
    root,
    'node_modules/.bin/devai',
    '#!/bin/sh\nprintf "%s\\n" "$*" >> ROUND_CLI_CALLED\nexit 0\n',
  );
  chmodSync(binary, 0o755);
  return { root, admin, hook };
}
function select(root: string, value: unknown): void {
  put(
    root,
    '.devai/config/project.json',
    JSON.stringify({
      schemaVersion: '1.0.0',
      project_type: 'platform-package',
      name: 'fixture',
      profile: 'tier1',
      authority_enforcement: value,
    }),
  );
}
function execute(root: string, hook: string) {
  return spawnSync('sh', [hook], { cwd: root, encoding: 'utf8' });
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('generated post-merge hook selected adapter dispatch', () => {
  it.each([false, true])(
    'skips absent local state in a valid GitHub checkout (linked=%s)',
    (linked) => {
      const { root, admin, hook } = fixture(linked);
      select(root, github);
      expect(existsSync(join(admin, 'devai'))).toBe(false);
      const before = snapshot(root);
      const result = execute(root, hook);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('POST_MERGE_HOOK_NOT_SELECTED');
      expect(snapshot(root)).toEqual(before);
      expect(existsSync(join(admin, 'devai'))).toBe(false);
      expect(existsSync(join(root, 'ROUND_CLI_CALLED'))).toBe(false);
    },
  );

  it.each([github, { mode: 'cli-only' }])(
    'does not invoke existing issuer or consume stale receipt when unselected: %j',
    (selection) => {
      const { root, admin, hook } = fixture();
      select(root, selection);
      put(
        admin,
        'devai/issue-post-merge-receipt.cjs',
        "require('node:fs').writeFileSync('ISSUER_CALLED', 'forbidden'); process.exitCode = 19;\n",
      );
      put(admin, 'devai/post-merge.key', 'must not read');
      put(admin, 'devai/post-merge-receipt.json', 'stale invalid receipt');
      const before = snapshot(root);
      const result = execute(root, hook);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('POST_MERGE_HOOK_NOT_SELECTED');
      expect(snapshot(root)).toEqual(before);
      expect(existsSync(join(root, 'ISSUER_CALLED'))).toBe(false);
      expect(existsSync(join(root, 'ROUND_CLI_CALLED'))).toBe(false);
    },
  );

  it.each([
    null,
    {},
    [],
    { mode: 'unknown' },
    { mode: 'host-integrated' },
    { mode: 'host-integrated', adapter_config: '.devai/config/unknown.json' },
    { ...github, extra: true },
    { mode: 'cli-only', adapter_config: 17 },
    { mode: 'cli-only', adapter_config: github.adapter_config },
  ])('refuses malformed, missing or unknown selection: %j', (selection) => {
    const { root, hook } = fixture();
    select(root, selection);
    const before = snapshot(root);
    const result = execute(root, hook);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('POST_MERGE_HOOK_SELECTION_INVALID');
    expect(result.stderr).not.toContain('POST_MERGE_HOOK_NOT_SELECTED');
    expect(snapshot(root)).toEqual(before);
  });

  it.each(['missing', 'json', 'linked'] as const)(
    'refuses %s canonical project without executing round close',
    (variant) => {
      const { root, hook } = fixture();
      if (variant === 'json') put(root, '.devai/config/project.json', '{');
      if (variant === 'linked') {
        put(root, 'external-project.json', JSON.stringify({ authority_enforcement: github }));
        mkdirSync(join(root, '.devai/config'), { recursive: true });
        symlinkSync(join(root, 'external-project.json'), join(root, '.devai/config/project.json'));
      }
      const result = execute(root, hook);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('POST_MERGE_HOOK_SELECTION_INVALID');
      expect(existsSync(join(root, 'ROUND_CLI_CALLED'))).toBe(false);
    },
  );

  it.each([
    { authority_enforcement: github },
    { schemaVersion: 'wrong', project_type: 'platform-package', authority_enforcement: github },
    { schemaVersion: '1.0.0', project_type: 'unknown', authority_enforcement: github },
    {
      schemaVersion: '1.0.0',
      project_type: 'platform-package',
      authority_enforcement: github,
      unexpected: true,
    },
    [],
  ])(
    'refuses an invalid project identity even when an unselected adapter is named: %j',
    (project) => {
      const { root, hook } = fixture();
      put(root, '.devai/config/project.json', JSON.stringify(project));
      const result = execute(root, hook);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('POST_MERGE_HOOK_SELECTION_INVALID');
      expect(result.stderr).not.toContain('POST_MERGE_HOOK_NOT_SELECTED');
      expect(existsSync(join(root, 'ROUND_CLI_CALLED'))).toBe(false);
    },
  );

  it('fails when the selected local helper is missing, without treating it as an unselected adapter', () => {
    const { root, hook } = fixture();
    select(root, local);
    const result = execute(root, hook);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('issue-post-merge-receipt.cjs');
    expect(result.stderr).not.toContain('POST_MERGE_HOOK_NOT_SELECTED');
    expect(existsSync(join(root, 'ROUND_CLI_CALLED'))).toBe(false);
  });

  it('preserves issuer failure and never forwards an existing stale receipt to round close', () => {
    const { root, admin, hook } = fixture(true);
    select(root, local);
    put(
      admin,
      'devai/issue-post-merge-receipt.cjs',
      "require('node:fs').writeFileSync('ISSUER_CALLED', 'yes'); process.exitCode = 17;\n",
    );
    put(admin, 'devai/post-merge-receipt.json', 'stale receipt must not be consumed');
    const result = execute(root, hook);
    expect(result.status, result.stderr).toBe(17);
    expect(readFileSync(join(root, 'ISSUER_CALLED'), 'utf8')).toBe('yes');
    expect(readFileSync(join(admin, 'devai/post-merge-receipt.json'), 'utf8')).toBe(
      'stale receipt must not be consumed',
    );
    expect(existsSync(join(root, 'ROUND_CLI_CALLED'))).toBe(false);
  });
});
