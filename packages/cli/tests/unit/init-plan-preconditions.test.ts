import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const root = mkdtempSync(join(tmpdir(), 'devai-init-plan-preconditions-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function invoke(target: string, introspect = false) {
  // Command definitions are created when the module is evaluated. Reload the
  // module after a mutation candidate is activated so static command mutants
  // remain observable through the public CAC boundary.
  vi.resetModules();
  const { initPlan } = await (import(
    '../../src/commands/init/index.js' + '?init-plan-preconditions'
  ) as Promise<typeof import('../../src/commands/init/index.js')>);
  const cli = cac('devai-init-plan-preconditions');
  initPlan.register(cli);
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = [
      'node',
      'devai',
      'init-plan',
      '--target',
      target,
      ...(introspect ? ['--introspect'] : []),
    ];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    cli.parse(process.argv, { run: false });
    await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

async function invokeBind(args: readonly string[]) {
  vi.resetModules();
  const { initBind } = await (import(
    '../../src/commands/init/index.js' + '?init-bind-depth'
  ) as Promise<typeof import('../../src/commands/init/index.js')>);
  const cli = cac('devai-init-bind-depth');
  initBind.register(cli);
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', 'init-bind', '--target', root, ...args];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    cli.parse(process.argv, { run: false });
    await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

describe('init plan target preconditions', () => {
  it('refuses a target that does not exist with its resolved path in context', async () => {
    const target = join(root, 'missing');
    const result = await invoke(target);
    expect(result.exit).toBe(5);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      class: 'precondition',
      exit: 5,
      context: { target_root: target },
    });
    expect(result.stderr).toContain(target);
  });

  it('refuses an existing non-repository directory', async () => {
    const result = await invoke(root);
    expect(result.exit).toBe(5);
    expect(JSON.parse(result.stderr)).toMatchObject({
      message: `Init target is not a Git repository: ${root}`,
      context: { target_root: root },
    });
  });

  it('applies the same repository precondition to introspection', async () => {
    const result = await invoke(root, true);
    expect(result.exit).toBe(5);
    expect(JSON.parse(result.stderr)).toMatchObject({
      class: 'precondition',
      context: { target_root: root },
    });
  });

  it('accepts a nested target when the worktree uses a .git file', async () => {
    const worktree = join(root, 'linked-worktree');
    const target = join(worktree, 'nested');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /fixture/common/worktrees/linked\n');
    const result = await invoke(target);
    expect(result.exit, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ target_root: target });
  });
});

describe('init bind plan-only routing', () => {
  it('renders the default authority-policy plan in JSON and human formats', async () => {
    const json = await invokeBind([]);
    expect(json).toEqual({
      exit: 0,
      stdout: JSON.stringify({ plan: 'authority-policy' }) + '\n',
      stderr: '',
    });
    const human = await invokeBind(['--human']);
    expect(human).toEqual({
      exit: 0,
      stdout:
        'init bind (plan only): materialize the installed authority policy; re-run with --write\n',
      stderr: '',
    });
  });

  it('rejects ambiguous selectors and invalid adapter arguments before planning', async () => {
    const ambiguous = await invokeBind(['--constitution', '--operational-law']);
    expect(ambiguous).toEqual({
      exit: 2,
      stdout: '',
      stderr: 'devai init bind: binding selectors are mutually exclusive\n',
    });
    const host = await invokeBind(['--host-adapter', 'unknown']);
    expect(host).toEqual({
      exit: 2,
      stdout: '',
      stderr: 'devai init bind --host-adapter: expected post-merge or github-actions\n',
    });
    const tracking = await invokeBind(['--tracking-adapter', 'unknown']);
    expect(tracking).toEqual({
      exit: 2,
      stdout: '',
      stderr: 'devai init bind --tracking-adapter: expected github-issues\n',
    });
    const missingRepository = await invokeBind(['--tracking-adapter', 'github-issues']);
    expect(missingRepository).toEqual({
      exit: 2,
      stdout: '',
      stderr:
        'devai init bind --tracking-adapter: --tracking-repository <owner/name> is required\n',
    });
  });

  it('builds exact installed policy plans without writing the target', async () => {
    const operational = await invokeBind(['--operational-law']);
    expect(operational.exit, operational.stderr).toBe(0);
    const operationalPlan = JSON.parse(operational.stdout) as {
      plan: Array<{
        source: string;
        target: string;
        digest_sha256: string;
        byte_identity_required: boolean;
      }>;
    };
    expect(operationalPlan.plan.map(({ source, target }) => ({ source, target }))).toEqual(
      [
        'domains.json',
        'forbidden-actions.json',
        'glob-guards.json',
        'scorecard-na.json',
        'thresholds.json',
      ].map((file) => ({
        source: `installed:law/policy/${file}`,
        target: `.devai/config/${file}`,
      })),
    );
    expect(
      operationalPlan.plan.every(
        (entry) => entry.byte_identity_required && /^[0-9a-f]{64}$/u.test(entry.digest_sha256),
      ),
    ).toBe(true);

    const subprocess = await invokeBind(['--subprocess-effects']);
    expect(subprocess.exit, subprocess.stderr).toBe(0);
    expect(JSON.parse(subprocess.stdout)).toMatchObject({
      plan: {
        source: 'installed:law/policy/subprocess-effects.json',
        target: '.devai/config/subprocess-effects.json',
        byte_identity_required: true,
      },
    });

    const adopter = await invokeBind(['--adopter-policy', 'law/policy/custom.json']);
    expect(adopter).toEqual({
      exit: 0,
      stdout:
        JSON.stringify({
          plan: { source: 'law/policy/custom.json', target: '.devai/config' },
        }) + '\n',
      stderr: '',
    });
    expect(readdirSync(root)).toEqual(['linked-worktree']);
  });

  it('plans the complete binding sequence and explicit host capabilities', async () => {
    const full = await invokeBind(['--full']);
    expect(full.exit, full.stderr).toBe(0);
    const fullPlan = JSON.parse(full.stdout) as {
      plan: Array<{ segment: string; plan: unknown }>;
    };
    expect(fullPlan.plan.map(({ segment }) => segment)).toEqual([
      'constitution',
      'operational-law',
      'subprocess-effects',
      'authority-policy',
    ]);

    const tracking = await invokeBind([
      '--tracking-adapter',
      'github-issues',
      '--tracking-repository',
      'aarusso-nyx/devai',
    ]);
    expect(tracking.exit, tracking.stderr).toBe(0);
    expect(JSON.parse(tracking.stdout)).toMatchObject({
      plan: {
        repository: 'aarusso-nyx/devai',
        config: '.devai/config/github-issues-tracking.json',
        workflow: '.github/workflows/devai-issue-tracking.yml',
        workflow_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });

    const postMerge = await invokeBind(['--host-adapter', 'post-merge']);
    expect(postMerge.exit, postMerge.stderr).toBe(0);
    expect(JSON.parse(postMerge.stdout)).toMatchObject({
      plan: { hook: 'post-merge', manager: 'git' },
    });

    const githubActions = await invokeBind(['--host-adapter', 'github-actions']);
    expect(githubActions).toEqual({
      exit: 2,
      stdout: '',
      stderr:
        'devai init bind --host-adapter github-actions: GITHUB_ACTIONS_ADAPTER_GIT_UNAVAILABLE\n',
    });
    expect(readdirSync(root)).toEqual(['linked-worktree']);
  });
});
