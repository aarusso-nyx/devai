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

function request(root: string, model = 'sonnet', worktree = 'WT-TASK-0001-A1', symbol = 'spawn') {
  const invocation = agentCliInvocation({ runtime: 'claude-cli', model, effort: 'medium' });
  return {
    kind: 'process',
    symbol,
    arguments: [
      invocation.command,
      [...invocation.args],
      { cwd: join(root, '.devai/worktrees', worktree), shell: false, timeout: 60_000 },
    ],
  } as AuthorityHostEffectRequest;
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
    const tampered = request(root);
    const [command, args, options] = tampered.arguments as [string, string[], object];
    expect(
      matchExperimentalAgentProcess(root, argv, {
        ...tampered,
        arguments: [command, [...args, '--dangerously-skip-permissions'], options],
      } as AuthorityHostEffectRequest),
    ).toBeUndefined();
  });
});
