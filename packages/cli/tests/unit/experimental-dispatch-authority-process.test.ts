// ADR-MDL-0005 D-3/D-10: under round dispatch the broker admits only the exact adapter
// process of an in-progress agent task, at its model or the one bumped tier, inside that
// task's own attempt worktree.
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { agentCliInvocation } from '@devai-nyx/skills';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matchExperimentalAgentProcess } from '../../src/services/experimental-dispatch/authority-process.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(status = 'in_progress'): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-experimental-process-'));
  roots.push(root);
  mkdirSync(join(root, '.devai/state/tasks'), { recursive: true });
  mkdirSync(join(root, '.devai/worktrees/WT-TASK-0001-A1'), { recursive: true });
  mkdirSync(join(root, '.devai/worktrees/WT-TASK-0009-A1'), { recursive: true });
  writeFileSync(
    join(root, '.devai/state/tasks/TASK-0001.json'),
    JSON.stringify({
      id: 'TASK-0001',
      round_id: 'R-0001',
      status,
      executor: { kind: 'agent', runtime: 'claude-cli', model: 'sonnet', effort: 'medium' },
    }),
  );
  return root;
}

const argv = ['node', 'devai', 'round', 'dispatch', '--round', 'R-0001', '--task', 'TASK-0001'];

function request(
  root: string,
  model = 'sonnet',
  worktree = 'WT-TASK-0001-A1',
  symbol = 'spawn',
  runtime: 'claude-cli' | 'codex-cli' = 'claude-cli',
  argvWorktree?: string,
) {
  const cwd = join(root, '.devai/worktrees', worktree);
  const invocation = agentCliInvocation({
    runtime,
    model,
    effort: 'medium',
    worktree: argvWorktree ?? cwd,
  });
  return {
    kind: 'process',
    symbol,
    arguments: [invocation.command, [...invocation.args], { cwd, shell: false, timeout: 60_000 }],
  } as AuthorityHostEffectRequest;
}

function withArgs(
  original: AuthorityHostEffectRequest,
  edit: (args: string[]) => string[],
): AuthorityHostEffectRequest {
  const [command, args, options] = original.arguments as [string, string[], object];
  return { ...original, arguments: [command, edit([...args]), options] };
}

describe('experimental agent process matching', () => {
  it('admits the exact adapter argv in the task attempt worktree, and the bumped tier', () => {
    const root = repository();
    expect(matchExperimentalAgentProcess(root, argv, request(root))).toMatchObject({
      taskId: 'TASK-0001',
    });
    expect(matchExperimentalAgentProcess(root, argv, request(root, 'opus'))).toMatchObject({
      taskId: 'TASK-0001',
    });
  });

  it('refuses another model, another worktree, a non-running task and the sync symbol', () => {
    const root = repository();
    expect(matchExperimentalAgentProcess(root, argv, request(root, 'fable'))).toBeUndefined();
    expect(
      matchExperimentalAgentProcess(root, argv, request(root, 'sonnet', 'WT-TASK-0009-A1')),
    ).toBeUndefined();
    expect(
      matchExperimentalAgentProcess(
        root,
        argv,
        request(root, 'sonnet', 'WT-TASK-0001-A1', 'spawnSync'),
      ),
    ).toBeUndefined();
    expect(
      matchExperimentalAgentProcess(
        root,
        [...argv.slice(0, 6), '--task', 'TASK-0002'],
        request(root),
      ),
    ).toBeUndefined();
    const ready = repository('ready');
    expect(matchExperimentalAgentProcess(ready, argv, request(ready))).toBeUndefined();
  });

  it('refuses argv that differs by one flag', () => {
    const root = repository();
    expect(
      matchExperimentalAgentProcess(
        root,
        argv,
        withArgs(request(root), (args) => [...args, '--dangerously-skip-permissions']),
      ),
    ).toBeUndefined();
  });

  // ADR-MDL-0008: the provider-enforced sandbox is part of the admitted argv.
  it('refuses a claude attempt without its restricted, fail-closed sandbox flags', () => {
    const root = repository();
    const drop = (flag: string, count: number) => (args: string[]) => {
      const index = args.indexOf(flag);
      return [...args.slice(0, index), ...args.slice(index + count)];
    };
    for (const [flag, count] of [
      ['--restricted', 1],
      ['--settings', 2],
      ['--tools', 2],
      ['--permission-prompts', 2],
    ] as const) {
      expect(
        matchExperimentalAgentProcess(root, argv, withArgs(request(root), drop(flag, count))),
      ).toBeUndefined();
    }
    expect(
      matchExperimentalAgentProcess(
        root,
        argv,
        withArgs(request(root), (args) =>
          args.map((value) =>
            value.startsWith('{"sandbox"')
              ? value.replace('"enabled":true', '"enabled":false')
              : value,
          ),
        ),
      ),
    ).toBeUndefined();
  });

  it('admits codex only with its workspace-write sandbox rooted at the attempt worktree', () => {
    const root = repository();
    writeFileSync(
      join(root, '.devai/state/tasks/TASK-0001.json'),
      JSON.stringify({
        id: 'TASK-0001',
        round_id: 'R-0001',
        status: 'in_progress',
        executor: { kind: 'agent', runtime: 'codex-cli', model: 'gpt-6-luna', effort: 'medium' },
      }),
    );
    const codex = (argvWorktree?: string) =>
      request(root, 'gpt-6-luna', 'WT-TASK-0001-A1', 'spawn', 'codex-cli', argvWorktree);
    expect(matchExperimentalAgentProcess(root, argv, codex())).toMatchObject({
      taskId: 'TASK-0001',
    });
    // The sandbox root must be the spawn cwd: a --cd naming another directory is refused.
    expect(
      matchExperimentalAgentProcess(
        root,
        argv,
        codex(join(root, '.devai/worktrees/WT-TASK-0009-A1')),
      ),
    ).toBeUndefined();
    expect(
      matchExperimentalAgentProcess(
        root,
        argv,
        withArgs(codex(), (args) =>
          args.map((value) => (value === 'workspace-write' ? 'danger-full-access' : value)),
        ),
      ),
    ).toBeUndefined();
    expect(
      matchExperimentalAgentProcess(
        root,
        argv,
        withArgs(codex(), (args) => args.filter((value) => value !== '--ignore-rules')),
      ),
    ).toBeUndefined();
    expect(
      matchExperimentalAgentProcess(
        root,
        argv,
        withArgs(codex(), (args) => [...args.slice(0, -1), '--add-dir', root, '-']),
      ),
    ).toBeUndefined();
  });
});
