// Adapter protocol tests: all callbacks are injected; no shell or external process runs.
import { describe, expect, it, vi } from 'vitest';
import {
  executeRoutineExecutor,
  validateRoutineExecutor,
  type RoutineExecutorRequest,
  type RoutineActionRegistryEntry,
  type RoutineAuthority,
} from '../../src/loop/routine-executor.js';
function routine(overrides: Partial<RoutineExecutorRequest> = {}): RoutineExecutorRequest {
  return {
    kind: 'routine',
    argv: ['node', 'fixture.mjs'],
    cwd: 'workspace dir',
    inputs: ['input.json'],
    outputs: ['output.json'],
    effects: ['read'],
    timeout_ms: 7123,
    authority_checks: ['discipline'],
    ...overrides,
  };
}
const authority: RoutineAuthority = {
  discipline: 'engineer',
  capabilities: ['fs.read'],
  write: false,
  allow_publish: false,
};
function action(): RoutineActionRegistryEntry {
  return {
    action_id: 'fixture observe',
    internal_binding: 'fixture-observer',
    effect: 'read',
    authority_contract: {
      effect: 'read',
      capabilities: ['fs.read'],
      subject: { kind: 'human', allowed_roles: ['engineer'] },
      consent: { write: false, allow_publish: false },
    },
  };
}

describe('routine dispatch preserves literal arguments and the selected authority path', () => {
  it('passes spaces, Unicode, metacharacters, repeated and empty arguments literally with shell disabled', async () => {
    const executor = routine({
      argv: [
        'node',
        'ação com espaços.mjs',
        'same',
        'same',
        '',
        '$(do-not-run)',
        '; do-not-run',
        'a|b',
      ],
    });
    const runArgv = vi.fn(async () => ({
      exit_code: 0,
      stdout: 'exact output\n',
      stderr: 'exact diagnostic\n',
    }));
    const runAction = vi.fn();
    const invokeLlm = vi.fn();
    const before = JSON.stringify(executor);
    expect(await executeRoutineExecutor({ executor, runArgv, runAction, invokeLlm })).toEqual({
      ok: true,
      resolved: {
        source: 'literal-argv',
        argv: executor.argv,
        cwd: executor.cwd,
        effects: ['read'],
        timeout_ms: 7123,
      },
      process: { exit_code: 0, stdout: 'exact output\n', stderr: 'exact diagnostic\n' },
    });
    expect(runArgv).toHaveBeenCalledExactlyOnceWith(executor.argv, {
      cwd: 'workspace dir',
      shell: false,
      timeout: 7123,
    });
    expect(runAction).not.toHaveBeenCalled();
    expect(invokeLlm).not.toHaveBeenCalled();
    expect(JSON.stringify(executor)).toBe(before);
  });
  it.each([
    'bash',
    'cmd',
    'cmd.exe',
    'csh',
    'dash',
    'fish',
    'ksh',
    'powershell',
    'powershell.exe',
    'pwsh',
    'pwsh.exe',
    'sh',
    'tcsh',
    'zsh',
  ])(
    'refuses %s even as an uppercase executable basename in a Windows-style path',
    async (name) => {
      const runArgv = vi.fn();
      const runAction = vi.fn();
      const result = await executeRoutineExecutor({
        executor: routine({ argv: [`C:\\tools\\${name.toUpperCase()}`, '-c', 'unsafe'] }),
        runArgv,
        runAction,
      });
      expect(result).toEqual({
        ok: false,
        code: 'TASK_ROUTINE_SHELL_FORBIDDEN',
        message: `shell executable ${name} is forbidden for literal argv`,
      });
      expect(runArgv).not.toHaveBeenCalled();
      expect(runAction).not.toHaveBeenCalled();
    },
  );
  it('does not mistake a non-shell executable containing a shell name for a shell', () => {
    const executor = routine({ argv: ['/tools/bash-parser', 'fixture'] });
    expect(validateRoutineExecutor({ executor })).toEqual({
      ok: true,
      source: 'literal-argv',
      argv: executor.argv,
    });
  });
  it('delivers the exact registered action, paths, limits, and authority decision input', async () => {
    const selected = action();
    const executor = routine({ argv: undefined, action_id: selected.action_id });
    const runArgv = vi.fn();
    const runAction = vi.fn(async () => ({ exit_code: 0, stdout: 'observed' }));
    const authorize = vi.fn(() => true);
    expect(
      await executeRoutineExecutor({
        executor,
        authority,
        authorize,
        actionRegistry: [selected],
        runArgv,
        runAction,
      }),
    ).toEqual({
      ok: true,
      resolved: {
        source: 'registered-action',
        action_id: selected.action_id,
        cwd: executor.cwd,
        effects: ['read'],
        timeout_ms: 7123,
      },
      process: { exit_code: 0, stdout: 'observed' },
    });
    expect(authorize).toHaveBeenCalledExactlyOnceWith({
      discipline: 'engineer',
      executor,
      action: selected,
    });
    expect(runAction).toHaveBeenCalledExactlyOnceWith(selected, {
      cwd: executor.cwd,
      shell: false,
      timeout: 7123,
      inputs: ['input.json'],
      outputs: ['output.json'],
    });
    expect(runArgv).not.toHaveBeenCalled();
  });
  it('requires the initiating discipline for derived-machine actions', () => {
    const selected = action();
    const executor = routine({ argv: undefined, action_id: selected.action_id });
    const permitted = {
      ...selected,
      authority_contract: {
        ...selected.authority_contract,
        subject: {
          kind: 'derived-machine' as const,
          initiator: { allowed_roles: ['engineer'] as const },
        },
      },
    };
    const denied = {
      ...permitted,
      authority_contract: {
        ...permitted.authority_contract,
        subject: {
          kind: 'derived-machine' as const,
          initiator: { allowed_roles: ['owner'] as const },
        },
      },
    };
    expect(validateRoutineExecutor({ executor, authority, actionRegistry: [permitted] })).toEqual({
      ok: true,
      source: 'registered-action',
      action: permitted,
    });
    expect(validateRoutineExecutor({ executor, authority, actionRegistry: [denied] })).toEqual({
      ok: false,
      code: 'TASK_ROUTINE_DISCIPLINE_FORBIDDEN',
      message: 'discipline engineer is not authorized for fixture observe',
    });
  });
  it('still checks capabilities when a registered action has no role restriction', () => {
    const selected = action();
    const executor = routine({ argv: undefined, action_id: selected.action_id });
    const unrestricted = {
      ...selected,
      authority_contract: { ...selected.authority_contract, subject: { kind: 'none' as const } },
    };
    expect(
      validateRoutineExecutor({ executor, authority, actionRegistry: [unrestricted] }),
    ).toEqual({ ok: true, source: 'registered-action', action: unrestricted });
    expect(
      validateRoutineExecutor({
        executor,
        authority: { ...authority, capabilities: [] },
        actionRegistry: [unrestricted],
      }),
    ).toEqual({
      ok: false,
      code: 'TASK_ROUTINE_CAPABILITY_UNAUTHORIZED',
      message: 'task authority does not grant: fs.read',
    });
  });
  it.each([null, -1, 1, 137])(
    'retains failed exit identity %s instead of reporting completion',
    async (exit_code) => {
      const result = await executeRoutineExecutor({
        executor: routine(),
        runArgv: async () => ({ exit_code }),
      });
      expect(result).toEqual({
        ok: false,
        code: 'TASK_ROUTINE_PROCESS_FAILED',
        message: `routine process exited with ${String(exit_code)}`,
      });
    },
  );
  it('returns an explicit authority refusal unchanged and never reaches either adapter', async () => {
    const runArgv = vi.fn();
    const runAction = vi.fn();
    const denied = { ok: false as const, code: 'FIXTURE_REFUSAL', message: 'scope unavailable' };
    expect(
      await executeRoutineExecutor({
        executor: routine(),
        authority,
        authorize: () => denied,
        runArgv,
        runAction,
      }),
    ).toBe(denied);
    expect(runArgv).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
  });
});
