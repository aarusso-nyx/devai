import type { SpawnSyncReturns } from 'node:child_process';
import * as authorityModule from '@devai-nyx/authority';
import { describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { runCommand } from '../../src/run-command.js';

type SpawnResult = SpawnSyncReturns<string | null>;

function spawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    pid: 1,
    output: ['', ''],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides,
  };
}

function withSpawnResult<T>(result: SpawnResult, callback: () => T): T {
  const spy = vi.spyOn(authorityModule, 'spawnSync').mockReturnValue(result as never);
  try {
    return callback();
  } finally {
    spy.mockRestore();
  }
}

describe('runCommand boundary pilot', () => {
  it('returns the empty-command contract without invoking a child process', async () => {
    const result = await withAuthorityHostTestScope(() => runCommand([]));

    expect(result).toEqual({
      stdout: '',
      stderr: 'empty command',
      exit_code: -1,
      duration_ms: 0,
      killed: false,
    });
  });

  it('captures stdout and the successful exit status from a real permitted child', async () => {
    const result = await withAuthorityHostTestScope(() =>
      runCommand([process.execPath, '-e', "console.log('Mutation score: 100.0%')"]),
    );

    expect(result.stdout).toBe('Mutation score: 100.0%\n');
    expect(result.stderr).toBe('');
    expect(result.exit_code).toBe(0);
    expect(result.killed).toBe(false);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('reports a real child with no output as successful and not killed', async () => {
    const result = await withAuthorityHostTestScope(() =>
      runCommand([process.execPath, '-e', 'process.exit(0)']),
    );

    expect(result).toMatchObject({
      stdout: '',
      stderr: '',
      exit_code: 0,
      killed: false,
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('forwards cwd, timeout, merged env, and input through the authority seam', () => {
    const spawnSync = vi
      .spyOn(authorityModule, 'spawnSync')
      .mockReturnValue(spawnResult({ stdout: 'ok' }) as never);
    try {
      const result = runCommand(['fixture-command', '--flag'], {
        cwd: '/fixture/worktree',
        timeoutMs: 42,
        env: { PILOT_COMMAND_TEST: 'present' },
        input: 'stdin payload',
      });

      expect(result.stdout).toBe('ok');
      expect(spawnSync).toHaveBeenCalledWith(
        'fixture-command',
        ['--flag'],
        expect.objectContaining({
          cwd: '/fixture/worktree',
          encoding: 'utf8',
          timeout: 42,
          input: 'stdin payload',
          env: expect.objectContaining({
            PILOT_COMMAND_TEST: 'present',
            PATH: expect.any(String),
          }),
        }),
      );
    } finally {
      spawnSync.mockRestore();
    }
  });

  it('surfaces a nonzero status and captured stderr', () => {
    const result = withSpawnResult(spawnResult({ status: 3, stderr: 'child failed\n' }), () =>
      runCommand(['fixture-command']),
    );

    expect(result).toMatchObject({
      stdout: '',
      stderr: 'child failed\n',
      exit_code: 3,
      killed: false,
    });
  });

  it('normalizes null output streams and a missing status', () => {
    const result = withSpawnResult(
      spawnResult({ stdout: null, stderr: null, status: null, signal: null }),
      () => runCommand(['fixture-command']),
    );

    expect(result).toMatchObject({
      stdout: '',
      stderr: '',
      exit_code: -1,
      killed: false,
    });
  });

  it('turns a spawn error into exit code 127 and its error message', () => {
    const result = withSpawnResult(
      spawnResult({
        error: new Error('spawn fixture failed'),
        stdout: 'partial',
        stderr: 'discarded child stderr',
      }),
      () => runCommand(['fixture-command']),
    );

    expect(result).toMatchObject({
      stdout: 'partial',
      stderr: 'spawn fixture failed',
      exit_code: 127,
      killed: false,
    });
  });

  it.each([
    ['SIGTERM', true],
    [null, false],
    [undefined, false],
  ] as const)('derives killed from a returned signal (%s)', (signal, killed) => {
    const result = withSpawnResult(
      spawnResult({ status: null, signal: signal as unknown as SpawnResult['signal'] }),
      () => runCommand(['fixture-command']),
    );

    expect(result.killed).toBe(killed);
  });

  it('marks a timeout error with a termination signal as killed', () => {
    // Node reports timed-out spawnSync calls with both an error and a signal.
    const result = withSpawnResult(
      spawnResult({
        error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        status: null,
        signal: 'SIGTERM',
      }),
      () => runCommand(['fixture-command'], { timeoutMs: 1 }),
    );

    expect(result).toMatchObject({ killed: true, exit_code: 127, stderr: 'spawnSync ETIMEDOUT' });
  });
});
